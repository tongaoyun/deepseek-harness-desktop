/** Confirm a bounded file selection and retain each write identity through partial failure. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, FileTypeIcon, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { productFailure, type ProductFailure } from '@deepseek-harness/product/errors'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { isKnowledgeAccessDenied, useKnowledgeRequests, type KnowledgeDocument } from './knowledge-data.ts'
import { KnowledgeFolderPicker } from './KnowledgeFolderPicker.tsx'
import { isKnowledgeSaveUnconfirmed, productErrorMessage } from './product-errors.ts'
import { confirmKnowledgeDocumentMutation } from './knowledge-mutation-receipts.ts'
import { useResultFocus } from './useResultFocus.ts'

/** File operations use the same authenticated, idempotent endpoints as individual actions. */
export type KnowledgeBatchAction = 'move' | 'delete' | 'reindex'

type Entry = {
  readonly document: KnowledgeDocument
  readonly operationId: string
  readonly result: { readonly kind: 'waiting' | 'accepted' } | { readonly kind: 'failed'; readonly failure: ProductFailure; readonly retryable: boolean }
}

/** Keep partial results and retry identities; removed actions hand owned focus to Close without scrolling.
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
  readonly onClose: (submitted: boolean) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const actionRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const preserveActionFocus = useResultFocus(actionRef, closeRef)
  const [entries, setEntries] = useState<readonly Entry[]>(() => documents.map(document => ({
    document, operationId: globalThis.crypto.randomUUID(), result: { kind: 'waiting' },
  })))
  const [destination, setDestination] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [activeId, setActiveId] = useState<string>()
  const operation = useRef<{ readonly destination: string | null; controller?: AbortController }>()
  useEffect(() => () => {
    operation.current?.controller?.abort()
    onBusyChange(false)
  }, [onBusyChange])
  const running = activeId !== undefined
  const started = operation.current !== undefined
  const accepted = entries.filter(entry => entry.result.kind === 'accepted').length
  const hasRetry = entries.some(entry => entry.result.kind === 'waiting' || entry.result.kind === 'failed' && entry.result.retryable)
  const title = t(action === 'move' ? 'knowledgeBatchMove' : action === 'delete' ? 'knowledgeBatchDelete' : 'knowledgeBatchReindex')
  const close = () => { if (operation.current?.controller === undefined) onClose(operation.current !== undefined) }
  const submit = async (): Promise<void> => {
    if (operation.current?.controller !== undefined || action === 'move' && !ready) return
    const attempt = operation.current ??= { destination }
    const controller = new AbortController()
    attempt.controller = controller
    onBusyChange(true)
    const update = (id: string, result: Entry['result']) => {
      setEntries(current => current.map(entry => entry.document.id === id ? { ...entry, result } : entry))
    }
    try {
      for (const entry of entries) {
        if (entry.result.kind === 'accepted' || entry.result.kind === 'failed' && !entry.result.retryable) continue
        const document = entry.document
        setActiveId(document.id)
        try {
          controller.signal.throwIfAborted()
          if (action !== 'move' || (document.folderId ?? null) !== attempt.destination) {
            const target = {
              knowledgeBaseId, documentId: document.id, operationId: entry.operationId,
              ...(action === 'move' ? { folderId: attempt.destination, expectedFolderId: document.folderId ?? null, expectedUpdatedAt: document.updatedAt } : {}),
            }
            const receipt = await request(`knowledge.documents.${action}`, target, controller.signal)
            controller.signal.throwIfAborted()
            confirmKnowledgeDocumentMutation(action, receipt, target)
          }
          controller.signal.throwIfAborted()
          update(document.id, { kind: 'accepted' }); onAccepted(document, action)
        } catch (failure) {
          if (controller.signal.aborted) return
          update(document.id, { kind: 'failed', failure: productFailure(failure), retryable: isKnowledgeSaveUnconfirmed(failure) })
          if (isKnowledgeAccessDenied(failure)) { onAccessDenied(failure); return }
          if (productFailure(failure).code === 'KNOWLEDGE_MANAGEMENT_FORBIDDEN') {
            setEntries(current => current.map(row => row.result.kind === 'accepted' ? row : {
              ...row, result: { kind: 'failed', failure: productFailure(failure), retryable: false },
            }))
            return
          }
        }
      }
    } finally {
      if (!controller.signal.aborted) {
        preserveActionFocus()
        delete attempt.controller; setActiveId(undefined); onBusyChange(false)
      }
    }
  }
  return <Modal open title={title} closeLabel={t('close')} onClose={close} footer={<>
    <Button ref={closeRef} variant="ghost" size="sm" aria-disabled={running} className={running ? 'product-control-pending' : undefined} onClick={close}>{t(started ? 'close' : 'cancel')}</Button>
    {(hasRetry || running) && <Button ref={actionRef} variant="primary" size="sm"
      className={[action === 'delete' ? css.knowledgeDanger : '', running ? 'product-control-pending' : ''].filter(Boolean).join(' ')}
      aria-busy={running} disabled={action === 'move' && !ready} aria-disabled={running || action === 'move' && !ready} onClick={() => { void submit() }}>
      {t(running ? 'knowledgeBatchSubmitting' : started ? 'knowledgeBatchRetry' : action === 'move' ? 'knowledgeMove'
        : action === 'delete' ? 'deleteResource' : 'knowledgeReindex')}</Button>}
  </>}>
    <p className={css.knowledgeConfirmation}>{t(action === 'delete' ? 'knowledgeBatchDeleteConfirmation'
      : action === 'move' ? 'knowledgeBatchMoveConfirmation' : 'knowledgeBatchReindexConfirmation').replace('{count}', String(entries.length))}</p>
    {action === 'move' && <KnowledgeFolderPicker knowledgeBaseId={knowledgeBaseId} label={t('knowledgeDestinationFolder')}
      value={destination} disabled={started} pending={running} onChange={(value) => {
        if (operation.current !== undefined) return
        setDestination(value); setReady(false)
      }} onReady={setReady} t={t} />}
    {started && <p role="status" className={css.knowledgeBatchSummary}>{t('knowledgeBatchProgress')
      .replace('{count}', String(accepted)).replace('{total}', String(entries.length))}</p>}
    {started && action !== 'move' && <p className={css.knowledgeBrowseHint}>{t('knowledgeBatchBackgroundHint')}</p>}
    {started && accepted < entries.length && !running && <p className={css.knowledgeBrowseHint}>{t(hasRetry ? 'knowledgeBatchRetryHint' : 'knowledgeBatchReviewHint')}</p>}
    <ul className={css.knowledgeBatchResults} aria-label={t('knowledgeBatchFiles')} aria-busy={running}>
      {entries.map(entry => <li key={entry.document.id}>
        <div><FileTypeIcon path={entry.document.filename} size={16} /><span>{entry.document.filename}</span></div>
        <span role={entry.result.kind === 'failed' ? 'alert' : undefined} className={entry.result.kind === 'failed' ? css.catalogError : undefined}>
          {entry.result.kind === 'failed' ? productErrorMessage(entry.result.failure, t, 'knowledgeChangeFailed') : t(entry.result.kind === 'accepted' ? 'knowledgeBatchAccepted'
            : activeId === entry.document.id ? 'knowledgeBatchSubmitting' : 'knowledgeBatchWaiting')}</span>
      </li>)}
    </ul>
  </Modal>
}
