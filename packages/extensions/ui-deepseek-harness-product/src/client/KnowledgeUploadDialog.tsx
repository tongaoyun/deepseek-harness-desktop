/** Per-file upload outcomes with main-owned selections and stable retry identities. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, FileTypeIcon, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { KnowledgeUploadPending } from '@deepseek-harness/product/bridge'
import type { KnowledgePdfParseMode } from '@deepseek-harness/product/protocol'
import { ProductError, productFailure, type ProductFailure } from '@deepseek-harness/product/errors'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { isKnowledgeAccessDenied, useKnowledgeRequests } from './knowledge-data.ts'
import { isKnowledgeSaveUnconfirmed, productErrorMessage } from './product-errors.ts'
import { confirmKnowledgeDocumentWrite } from './knowledge-mutation-receipts.ts'
import { KnowledgeDestination } from './KnowledgeDestination.tsx'
import { uploadSelections } from './knowledge-upload-selections.ts'
import { useResultFocus } from './useResultFocus.ts'

type Entry = KnowledgeUploadPending & {
  readonly viewKey: string
  readonly stage: 'upload' | 'release' | 'discard'
  readonly result: { readonly kind: 'waiting' | 'accepted' | 'discarded' }
    | { readonly kind: 'failed'; readonly failure: ProductFailure; readonly retryable: boolean; readonly stage: 'upload' | 'release' | 'discard' }
}

/** Keep sequential upload results; removed row and queue actions hand owned focus to Close without scrolling.
 * @param props Captured file identities, owning library, lifecycle callbacks, and localized labels.
 * @returns Upload queue; closing cancels requests and retains unconfirmed native selections.
 */
export function KnowledgeUploadDialog({ knowledgeBaseId, libraryName, selections, onBusyChange, onAccepted, onDenied, onClose, t }: {
  readonly knowledgeBaseId: string
  readonly libraryName?: string
  readonly selections: readonly KnowledgeUploadPending[]
  readonly onBusyChange: (busy: boolean) => void
  readonly onAccepted: () => void
  readonly onDenied: (failure: unknown) => void
  readonly onClose: () => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const actions = useRef<HTMLUListElement>(null)
  const actionRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const preserveRowFocus = useResultFocus(actions, closeRef)
  const preserveActionFocus = useResultFocus(actionRef, closeRef)
  const [entries, setEntries] = useState<readonly Entry[]>(() => selections.map(selection => ({ ...selection, viewKey: selection.operationId, stage: 'upload', result: { kind: 'waiting' } })))
  const [busy, setBusy] = useState<{ readonly kind: 'upload' | 'configure'; readonly only?: string; readonly activeId?: string; readonly discard?: boolean }>()
  const [configurationUnconfirmed, setConfigurationUnconfirmed] = useState(false)
  const operation = useRef<AbortController>()
  useEffect(() => () => { operation.current?.abort(); onBusyChange(false) }, [onBusyChange])
  const update = (operationId: string, result: Entry['result'] | undefined, stage?: Entry['stage']) => {
    preserveRowFocus()
    setEntries(current => current.map(entry => entry.operationId === operationId
      ? { ...entry, result: result ?? entry.result, stage: stage ?? entry.stage } : entry))
  }
  const runnable = (entry: Entry) => entry.result.kind === 'waiting' || entry.result.kind === 'failed' && entry.result.retryable
  const configure = async (entry: Entry, pdfParseMode: KnowledgePdfParseMode): Promise<void> => {
    if (operation.current || configurationUnconfirmed || !entry.canConfigure || entry.result.kind !== 'waiting') return
    const controller = new AbortController()
    operation.current = controller; setBusy({ kind: 'configure', only: entry.operationId }); onBusyChange(true)
    try {
      const value = await request('knowledge.documents.upload.configure', { knowledgeBaseId, operationId: entry.operationId, pdfParseMode }, controller.signal)
      controller.signal.throwIfAborted()
      const [selection] = uploadSelections([value])
      if (!selection || selection.operationId === entry.operationId || selection.filename !== entry.filename
        || selection.folderId !== entry.folderId || selection.pdfParseMode !== pdfParseMode || !selection.canConfigure) {
        throw new Error('PDF configuration receipt does not match its selection')
      }
      setEntries(current => current.map(row => row.operationId === entry.operationId ? { ...selection, viewKey: row.viewKey, stage: 'upload', result: { kind: 'waiting' } } : row))
    } catch (failure) {
      if (controller.signal.aborted) return
      setConfigurationUnconfirmed(true)
      if (isKnowledgeAccessDenied(failure)) onDenied(failure)
    } finally {
      if (!controller.signal.aborted) { operation.current = undefined; setBusy(undefined); onBusyChange(false) }
    }
  }
  const submit = async (only?: string, discard = false): Promise<void> => {
    if (operation.current !== undefined || configurationUnconfirmed) return
    const controller = new AbortController()
    const activity = { kind: 'upload' as const, discard, ...only === undefined ? {} : { only } }
    operation.current = controller; setBusy(activity); onBusyChange(true)
    try {
      for (const entry of entries) {
        if (only !== undefined && entry.operationId !== only || !discard && !runnable(entry)) continue
        const removing = discard || entry.stage === 'discard'
        let stage: Entry['stage'] = removing ? 'discard' : entry.stage
        setBusy({ ...activity, activeId: entry.operationId })
        update(entry.operationId, undefined, stage)
        try {
          const payload = { knowledgeBaseId, operationId: entry.operationId }
          if (!removing && entry.stage === 'upload') {
            const result = await request('knowledge.documents.upload', { ...payload, pdfParseMode: entry.pdfParseMode,
              ...(entry.folderId === undefined ? {} : { folderId: entry.folderId }) }, controller.signal)
            controller.signal.throwIfAborted()
            confirmKnowledgeDocumentWrite(result, { knowledgeBaseId, folderId: entry.folderId })
            stage = 'release'
            update(entry.operationId, undefined, stage)
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
          update(entry.operationId, { kind: 'failed', failure: productFailure(failure), retryable: isKnowledgeSaveUnconfirmed(failure), stage })
          if (isKnowledgeAccessDenied(failure) || productFailure(failure).code === 'KNOWLEDGE_MANAGEMENT_FORBIDDEN') {
            onDenied(failure); return
          }
        }
      }
    } finally {
      if (!controller.signal.aborted) {
        preserveActionFocus()
        operation.current = undefined; setBusy(undefined); onBusyChange(false)
      }
    }
  }
  const accepted = entries.filter(entry => entry.result.kind === 'accepted' || entry.stage === 'release').length
  const hasFailedRetry = entries.some(entry => entry.result.kind === 'failed' && entry.result.retryable)
  const queueBusy = busy?.kind === 'upload' && busy.only === undefined
  const retryLabelKey = entries.some(entry => runnable(entry) && entry.stage === 'upload') ? 'knowledgeRetryUpload' : 'retry'
  return <Modal open title={t('knowledgeUploadFiles')} closeLabel={t('close')} onClose={onClose} footer={<>
    <Button ref={closeRef} variant="ghost" size="sm" onClick={onClose}>{t(busy ? 'knowledgeUploadPause' : 'close')}</Button>
    {(entries.some(runnable) || queueBusy) && <Button ref={actionRef} variant="primary" size="sm" disabled={configurationUnconfirmed} aria-disabled={Boolean(busy) || configurationUnconfirmed}
      aria-busy={queueBusy} className={busy && !configurationUnconfirmed ? 'product-control-pending' : undefined} onClick={() => { void submit() }}>
      {t(queueBusy ? 'knowledgeUploadRunning' : hasFailedRetry ? retryLabelKey : 'knowledgeUpload')}</Button>}
  </>}>
    <p role="status" className={css.knowledgeBatchSummary}>{t('knowledgeUploadProgress')
      .replace('{count}', String(accepted)).replace('{total}', String(entries.length))}</p>
    <p className={css.knowledgeBrowseHint}>{t('knowledgeUploadQueueHint')}</p>
    {configurationUnconfirmed && <p role="alert" className={css.catalogError}>{t('knowledgeUploadOptionsUnconfirmed')}</p>}
    <ul ref={actions} className={css.knowledgeBatchResults} aria-label={t('knowledgeUploadFiles')} aria-busy={Boolean(busy)}>
      {entries.map(entry => <li key={entry.viewKey}>
        <div><FileTypeIcon path={entry.filename} size={16} /><span>{entry.filename}</span></div>
        <KnowledgeDestination knowledgeBaseId={knowledgeBaseId} libraryName={libraryName} folderId={entry.folderId} t={t} />
        {entry.canConfigure && entry.result.kind === 'waiting' ? <details className={css.knowledgeUploadOptions}>
          <summary>{t('knowledgePdfHandling')}</summary>
          <div className={css.knowledgeFilters}><label><span className={css.visuallyHidden}>{t('knowledgePdfHandling')}</span>
            <select aria-label={t('knowledgePdfHandling')} value={entry.pdfParseMode} disabled={Boolean(busy) || configurationUnconfirmed}
              aria-busy={busy?.kind === 'configure' && busy.only === entry.operationId}
              onChange={(event) => { const mode = event.currentTarget.value; if (mode === 'STANDARD' || mode === 'TEXT') void configure(entry, mode) }}>
              <option value="STANDARD">{t('knowledgeUploadStandard')}</option><option value="TEXT">{t('knowledgeUploadTextPdf')}</option>
            </select></label></div>
          {entry.pdfParseMode === 'TEXT' && <p>{t('knowledgePdfTextHint')}</p>}
        </details> : entry.pdfParseMode === 'TEXT' && <span>{t('knowledgeUploadTextPdf')}</span>}
        <span role={entry.result.kind === 'failed' ? 'alert' : undefined} className={entry.result.kind === 'failed' ? css.catalogError : undefined}>
          {entry.result.kind === 'failed' ? productErrorMessage(entry.result.failure, t,
            entry.result.stage === 'upload' ? 'knowledgeUploadFailed' : entry.result.stage === 'release' ? 'knowledgeUploadReleaseFailed' : 'knowledgeUploadRemoveFailed')
            : t(entry.result.kind === 'accepted' ? 'knowledgeUploadAccepted'
              : entry.result.kind === 'discarded' ? 'knowledgeUploadRemoved' : busy?.activeId === entry.operationId
                ? entry.stage === 'discard' ? 'knowledgeUploadRemoving' : 'knowledgeUploadRunning' : 'knowledgeBatchWaiting')}</span>
        {entry.result.kind !== 'accepted' && entry.result.kind !== 'discarded' && <div>
          {entry.result.kind === 'failed' && entry.result.retryable && <Button variant="ghost" size="sm" disabled={configurationUnconfirmed} aria-disabled={Boolean(busy) || configurationUnconfirmed}
            aria-busy={busy?.kind === 'upload' && busy.only === entry.operationId && !busy.discard}
            className={busy && !configurationUnconfirmed ? 'product-control-pending' : undefined}
            onClick={() => { void submit(entry.operationId) }}>{t(entry.result.stage === 'upload' ? 'knowledgeRetryUpload' : 'retry')}</Button>}
          <Button variant="ghost" size="sm" disabled={configurationUnconfirmed} aria-disabled={Boolean(busy) || configurationUnconfirmed}
            aria-busy={busy?.kind === 'upload' && busy.only === entry.operationId && busy.discard === true}
            className={busy && !configurationUnconfirmed ? 'product-control-pending' : undefined}
            onClick={() => { void submit(entry.operationId, true) }}>{t('knowledgeUploadRemove')}</Button>
        </div>}
      </li>)}
    </ul>
  </Modal>
}
