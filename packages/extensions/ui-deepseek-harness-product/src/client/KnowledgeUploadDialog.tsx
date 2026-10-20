/** Per-file upload outcomes with main-owned selections and stable retry identities. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, FileTypeIcon, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { KnowledgeUploadPending } from '@deepseek-harness/product/bridge'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { isKnowledgeAccessDenied, useKnowledgeRequests } from './knowledge-data.ts'
import { isKnowledgeSaveUnconfirmed, productErrorMessage } from './product-errors.ts'
import { confirmKnowledgeDocumentUpload } from './knowledge-mutation-receipts.ts'

type Entry = KnowledgeUploadPending & {
  readonly stage: 'upload' | 'release' | 'discard'
  readonly result: { readonly kind: 'waiting' | 'running' | 'accepted' | 'discarded' }
    | { readonly kind: 'failed'; readonly message: string; readonly retryable: boolean }
}

/** Upload sequentially and keep partial results available for explicit retry or removal.
 * @param props Captured file identities, owning library, lifecycle callbacks, and localized labels.
 * @returns Upload queue; closing cancels requests and retains unconfirmed native selections.
 */
export function KnowledgeUploadDialog({ knowledgeBaseId, selections, onBusyChange, onAccepted, onDenied, onClose, t }: {
  readonly knowledgeBaseId: string
  readonly selections: readonly KnowledgeUploadPending[]
  readonly onBusyChange: (busy: boolean) => void
  readonly onAccepted: () => void
  readonly onDenied: (failure: unknown) => void
  readonly onClose: () => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const [entries, setEntries] = useState<readonly Entry[]>(() => selections.map(selection => ({ ...selection, stage: 'upload', result: { kind: 'waiting' } })))
  const [busy, setBusy] = useState(false)
  const operation = useRef<AbortController>()
  useEffect(() => () => { operation.current?.abort(); onBusyChange(false) }, [onBusyChange])
  const update = (operationId: string, result: Entry['result'], stage?: Entry['stage']) => {
    setEntries(current => current.map(entry => entry.operationId === operationId
      ? { ...entry, result, stage: stage ?? entry.stage } : entry))
  }
  const runnable = (entry: Entry) => entry.result.kind === 'waiting' || entry.result.kind === 'failed' && entry.result.retryable
  const submit = async (only?: string, discard = false): Promise<void> => {
    if (operation.current !== undefined) return
    const controller = new AbortController()
    operation.current = controller; setBusy(true); onBusyChange(true)
    try {
      for (const entry of entries) {
        if (only !== undefined && entry.operationId !== only || !discard && !runnable(entry)) continue
        const removing = discard || entry.stage === 'discard'
        let stage: Entry['stage'] = removing ? 'discard' : entry.stage
        update(entry.operationId, { kind: 'running' }, stage)
        try {
          const payload = { knowledgeBaseId, operationId: entry.operationId }
          if (!removing && entry.stage === 'upload') {
            const result = await request('knowledge.documents.upload', { ...payload, pdfParseMode: entry.pdfParseMode,
              ...(entry.folderId === undefined ? {} : { folderId: entry.folderId }) }, controller.signal)
            controller.signal.throwIfAborted()
            confirmKnowledgeDocumentUpload(result, { knowledgeBaseId, folderId: entry.folderId })
            stage = 'release'
            update(entry.operationId, { kind: 'running' }, stage)
            onAccepted()
          }
          const release = await request('knowledge.documents.upload.discard', payload, controller.signal)
          controller.signal.throwIfAborted()
          if (typeof release !== 'object' || release === null || !('discarded' in release) || release.discarded !== true) {
            throw new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Upload release receipt is invalid', true)
          }
          if (removing) onAccepted()
          update(entry.operationId, { kind: removing ? 'discarded' : 'accepted' })
        } catch (failure) {
          if (controller.signal.aborted) return
          update(entry.operationId, { kind: 'failed', message: productErrorMessage(failure, t,
            stage === 'upload' ? 'knowledgeUploadFailed' : stage === 'release' ? 'knowledgeUploadReleaseFailed' : 'knowledgeUploadRemoveFailed'),
          retryable: isKnowledgeSaveUnconfirmed(failure) })
          if (isKnowledgeAccessDenied(failure) || productFailure(failure).code === 'KNOWLEDGE_MANAGEMENT_FORBIDDEN') {
            onDenied(failure); return
          }
        }
      }
    } finally {
      if (!controller.signal.aborted) { operation.current = undefined; setBusy(false); onBusyChange(false) }
    }
  }
  const accepted = entries.filter(entry => entry.result.kind === 'accepted' || entry.stage === 'release').length
  const started = entries.some(entry => entry.result.kind !== 'waiting')
  const retryLabelKey = entries.some(entry => runnable(entry) && entry.stage === 'upload') ? 'knowledgeRetryUpload' : 'retry'
  return <Modal open title={t('knowledgeUploadFiles')} closeLabel={t('close')} onClose={onClose} footer={<>
    <Button variant="ghost" size="sm" onClick={onClose}>{t(busy ? 'knowledgeUploadPause' : 'close')}</Button>
    {entries.some(runnable) && <Button variant="primary" size="sm" disabled={busy} onClick={() => { void submit() }}>
      {t(busy ? 'knowledgeUploadRunning' : started ? retryLabelKey : 'knowledgeUpload')}</Button>}
  </>}>
    <p role="status" className={css.knowledgeBatchSummary}>{t('knowledgeUploadProgress')
      .replace('{count}', String(accepted)).replace('{total}', String(entries.length))}</p>
    <p className={css.knowledgeBrowseHint}>{t('knowledgeUploadQueueHint')}</p>
    <ul className={css.knowledgeBatchResults} aria-label={t('knowledgeUploadFiles')} aria-busy={busy}>
      {entries.map(entry => <li key={entry.operationId}>
        <div><FileTypeIcon path={entry.filename} size={16} /><span>{entry.filename}</span></div>
        <span role={entry.result.kind === 'failed' ? 'alert' : undefined} className={entry.result.kind === 'failed' ? css.catalogError : undefined}>
          {entry.result.kind === 'failed' ? entry.result.message : t(entry.result.kind === 'accepted' ? 'knowledgeUploadAccepted'
            : entry.result.kind === 'discarded' ? 'knowledgeUploadRemoved' : entry.result.kind === 'running' ? 'knowledgeUploadRunning' : 'knowledgeBatchWaiting')}</span>
        {entry.result.kind !== 'accepted' && entry.result.kind !== 'discarded' && <div>
          {entry.result.kind === 'failed' && entry.result.retryable && <Button variant="ghost" size="sm" disabled={busy}
            onClick={() => { void submit(entry.operationId) }}>{t(entry.stage === 'upload' ? 'knowledgeRetryUpload' : 'retry')}</Button>}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void submit(entry.operationId, true) }}>{t('knowledgeUploadRemove')}</Button>
        </div>}
      </li>)}
    </ul>
  </Modal>
}
