/** Confirm a bounded file selection and retain each write identity through partial failure. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, FileTypeIcon, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { productFailure } from '@deepseek-harness/product/errors'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { isKnowledgeAccessDenied, useKnowledgeRequests, type KnowledgeDocument } from './knowledge-data.ts'
import { KnowledgeFolderPicker } from './KnowledgeFolderPicker.tsx'
import { isKnowledgeSaveUnconfirmed, productErrorMessage } from './product-errors.ts'
import { confirmKnowledgeDocumentMutation } from './knowledge-mutation-receipts.ts'

/** File operations use the same authenticated, idempotent endpoints as individual actions. */
export type KnowledgeBatchAction = 'move' | 'delete' | 'reindex'

type Entry = {
  readonly document: KnowledgeDocument
  readonly operationId: string
  readonly result: { readonly kind: 'waiting' | 'running' | 'accepted' } | { readonly kind: 'failed'; readonly message: string; readonly retryable: boolean }
}

/** Keep partial results visible; retry only unconfirmed writes with the original payloads.
 * @param props Captured files, operation, library identity, lifecycle callbacks, and labels.
 * @returns Confirmation, destination selection for moves, and per-file submission results.
 */
export function KnowledgeBatchDialog({ knowledgeBaseId, action, documents, onBusyChange, onAccepted, onAccessDenied, onClose, t }: {
  readonly knowledgeBaseId: string
  readonly action: KnowledgeBatchAction
  readonly documents: readonly KnowledgeDocument[]
  readonly onBusyChange: (busy: boolean) => void
  readonly onAccepted: (document: KnowledgeDocument, action: KnowledgeBatchAction) => void
  readonly onAccessDenied: (failure: unknown) => void
  readonly onClose: () => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const [entries, setEntries] = useState<readonly Entry[]>(() => documents.map(document => ({
    document, operationId: globalThis.crypto.randomUUID(), result: { kind: 'waiting' },
  })))
  const [destination, setDestination] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const operation = useRef<AbortController>()
  useEffect(() => () => {
    operation.current?.abort()
    onBusyChange(false)
  }, [onBusyChange])
  const running = entries.some(entry => entry.result.kind === 'running')
  const started = entries.some(entry => entry.result.kind !== 'waiting')
  const accepted = entries.filter(entry => entry.result.kind === 'accepted').length
  const hasRetry = entries.some(entry => entry.result.kind === 'waiting' || entry.result.kind === 'failed' && entry.result.retryable)
  const title = t(action === 'move' ? 'knowledgeBatchMove' : action === 'delete' ? 'knowledgeBatchDelete' : 'knowledgeBatchReindex')
  const close = () => { if (operation.current === undefined) onClose() }
  const submit = async (): Promise<void> => {
    if (operation.current !== undefined || action === 'move' && !ready) return
    const controller = new AbortController()
    operation.current = controller
    onBusyChange(true)
    const update = (id: string, result: Entry['result']) => {
      setEntries(current => current.map(entry => entry.document.id === id ? { ...entry, result } : entry))
    }
    try {
      for (const entry of entries) {
        if (entry.result.kind === 'accepted' || entry.result.kind === 'failed' && !entry.result.retryable) continue
        const document = entry.document
        update(document.id, { kind: 'running' })
        try {
          controller.signal.throwIfAborted()
          if (action !== 'move' || (document.folderId ?? null) !== destination) {
            const target = {
              knowledgeBaseId, documentId: document.id, operationId: entry.operationId,
              ...(action === 'move' ? { folderId: destination, expectedFolderId: document.folderId ?? null, expectedUpdatedAt: document.updatedAt } : {}),
            }
            const receipt = await request(`knowledge.documents.${action}`, target, controller.signal)
            controller.signal.throwIfAborted()
            confirmKnowledgeDocumentMutation(action, receipt, target)
          }
          controller.signal.throwIfAborted()
          update(document.id, { kind: 'accepted' }); onAccepted(document, action)
        } catch (failure) {
          if (controller.signal.aborted) return
          update(document.id, { kind: 'failed', message: productErrorMessage(failure, t, 'knowledgeChangeFailed'), retryable: isKnowledgeSaveUnconfirmed(failure) })
          if (isKnowledgeAccessDenied(failure)) { onAccessDenied(failure); return }
          if (productFailure(failure).code === 'KNOWLEDGE_MANAGEMENT_FORBIDDEN') {
            setEntries(current => current.map(row => row.result.kind === 'accepted' ? row : {
              ...row, result: { kind: 'failed', message: productErrorMessage(failure, t, 'knowledgeChangeFailed'), retryable: false },
            }))
            return
          }
        }
      }
    } finally {
      if (!controller.signal.aborted) { operation.current = undefined; onBusyChange(false) }
    }
  }
  return <Modal open title={title} closeLabel={t('close')} onClose={close} footer={<>
    <Button variant="ghost" size="sm" disabled={running} onClick={close}>{t(started ? 'close' : 'cancel')}</Button>
    {hasRetry && <Button variant="primary" size="sm" className={action === 'delete' ? css.knowledgeDanger : undefined}
      disabled={running || action === 'move' && !ready} onClick={() => { void submit() }}>
      {t(running ? 'knowledgeBatchSubmitting' : started ? 'knowledgeBatchRetry' : action === 'move' ? 'knowledgeMove'
        : action === 'delete' ? 'deleteResource' : 'knowledgeReindex')}</Button>}
  </>}>
    <p className={css.knowledgeConfirmation}>{t(action === 'delete' ? 'knowledgeBatchDeleteConfirmation'
      : action === 'move' ? 'knowledgeBatchMoveConfirmation' : 'knowledgeBatchReindexConfirmation').replace('{count}', String(entries.length))}</p>
    {action === 'move' && <KnowledgeFolderPicker knowledgeBaseId={knowledgeBaseId} label={t('knowledgeDestinationFolder')}
      value={destination} disabled={started} onChange={(value) => { setDestination(value); setReady(false) }} onReady={setReady} t={t} />}
    {started && <p role="status" className={css.knowledgeBatchSummary}>{t('knowledgeBatchProgress')
      .replace('{count}', String(accepted)).replace('{total}', String(entries.length))}</p>}
    {started && action !== 'move' && <p className={css.knowledgeBrowseHint}>{t('knowledgeBatchBackgroundHint')}</p>}
    {started && accepted < entries.length && !running && <p className={css.knowledgeBrowseHint}>{t(hasRetry ? 'knowledgeBatchRetryHint' : 'knowledgeBatchReviewHint')}</p>}
    <ul className={css.knowledgeBatchResults} aria-label={t('knowledgeBatchFiles')} aria-busy={running}>
      {entries.map(entry => <li key={entry.document.id}>
        <div><FileTypeIcon path={entry.document.filename} size={16} /><span>{entry.document.filename}</span></div>
        <span role={entry.result.kind === 'failed' ? 'alert' : undefined} className={entry.result.kind === 'failed' ? css.catalogError : undefined}>
          {entry.result.kind === 'failed' ? entry.result.message : t(entry.result.kind === 'accepted' ? 'knowledgeBatchAccepted'
            : entry.result.kind === 'running' ? 'knowledgeBatchSubmitting' : 'knowledgeBatchWaiting')}</span>
      </li>)}
    </ul>
  </Modal>
}
