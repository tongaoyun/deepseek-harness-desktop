/** Organization libraries and their materials share one navigation and reading surface. */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Button, Modal, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { localDetail, type ProductItem } from './catalog-shared.tsx'
import { KnowledgeDocuments } from './KnowledgeDocuments.tsx'
import { KnowledgeLibraryDirectory } from './KnowledgeLibraryDirectory.tsx'
import { ProductSignIn } from './ProductSignIn.tsx'
import { KnowledgeLibraryActions } from './KnowledgeLibraryActions.tsx'
import { KnowledgeBaseEditor } from './KnowledgeBaseEditor.tsx'
import { useKnowledgeRequests } from './knowledge-data.ts'
import { productErrorMessage } from './product-errors.ts'
import { useResultFocus } from './useResultFocus.ts'

/** Browse authorized library trees and read materials without opening a task.
 * Removed libraries return to the directory without taking focus from another region.
 * @param props The authenticated catalog state, refresh commands, and optional region ref for read-result focus recovery.
 * @returns A searchable directory, or the selected library's folders and materials.
 */
export function KnowledgeWorkspace({ entries: directoryEntries, loading, loaded = !loading, refreshRevision = 0, error,
  authRequired, onRefresh, onSignIn, renderFactorySlot, workspaceRef, t }: PropsRenderFactories & {
    readonly entries: readonly ProductItem[]
    readonly loading: boolean
    readonly loaded?: boolean
    readonly refreshRevision?: number
    readonly error?: string
    readonly authRequired: boolean
    readonly onRefresh: () => void
    readonly onSignIn: () => void
    readonly workspaceRef?: RefObject<HTMLElement>
    readonly t: (key: DeepSeekHarnessProductKey) => string
  }): ReactNode {
  const localRoot = useRef<HTMLElement>(null)
  const root = workspaceRef ?? localRoot
  const deleteDialog = useRef<HTMLElement | null>(null)
  const bindDeleteDialog = useCallback((node: HTMLParagraphElement | null) => {
    deleteDialog.current = node?.closest<HTMLElement>('[role="dialog"]') ?? null
  }, [])
  const preserveDeleteFocus = useResultFocus(deleteDialog, () => {
    const heading = root.current?.querySelector<HTMLElement>('[data-knowledge-directory] h1')
    if (heading) focusWithoutRing(heading, { preventScroll: true })
  })
  const focusedLibrary = useRef<string>()
  const [selectedId, setSelectedId] = useState<string>()
  const [directoryQuery, setDirectoryQuery] = useState('')
  const [directoryScope, setDirectoryScope] = useState('all')
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const [deleting, setDeleting] = useState<ProductItem>()
  const [deletePending, setDeletePending] = useState(false)
  const deleteWriting = useRef(false)
  const [deleteError, setDeleteError] = useState<unknown>()
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(new Set())
  const entries = authRequired ? [] : directoryEntries.filter(entry => !deletedIds.has(entry.id))
  const currentEntries = useRef(entries)
  currentEntries.current = entries
  const request = useKnowledgeRequests()
  const selected = entries.find(entry => entry.id === selectedId)
  const activeLibraryId = selected?.id
  useLayoutEffect(() => {
    const previousId = focusedLibrary.current
    focusedLibrary.current = activeLibraryId
    if (previousId !== undefined && activeLibraryId === undefined && selectedId === previousId) setSelectedId(undefined)
    if (authRequired || previousId === activeLibraryId) return
    const destination = activeLibraryId !== undefined
      ? root.current?.querySelector<HTMLElement>('[data-knowledge-materials-heading]')
      : [...root.current?.querySelectorAll<HTMLButtonElement>('[data-knowledge-base]') ?? []]
        .find(button => button.dataset.knowledgeBase === previousId)
        ?? root.current?.querySelector<HTMLElement>('[data-knowledge-directory] h1')
    const area = root.current
    const focused = area?.ownerDocument.activeElement
    if (destination && (focused === area?.ownerDocument.body || activeLibraryId !== undefined && area?.contains(focused ?? null))) {
      focusWithoutRing(destination, { preventScroll: activeLibraryId === undefined })
    }
  }, [activeLibraryId, authRequired, selectedId])
  const confirmDelete = async (): Promise<void> => {
    if (deleting === undefined || deleteWriting.current) return
    deleteWriting.current = true
    setDeletePending(true)
    try {
      await request('knowledge.bases.delete', { knowledgeBaseId: deleting.id })
      preserveDeleteFocus()
      setDeleteError(undefined)
      setDeleting(undefined)
      setDeletedIds(previous => new Set([...previous, deleting.id]))
      setSelectedId((current) => {
        const latest = currentEntries.current
        return current === deleting.id || !latest.some(entry => entry.id === current) ? undefined : current
      })
      onRefresh()
    } catch (failure) {
      setDeleteError(failure)
    } finally { deleteWriting.current = false; setDeletePending(false) }
  }
  const closeDelete = () => {
    if (deleteWriting.current) return
    setDeleting(undefined); setDeleteError(undefined)
  }
  return <><section ref={root} tabIndex={-1} className={css.knowledgeWorkspacePage} data-knowledge-workspace aria-label={t('knowledge')}>
    {!authRequired ? <>
      <KnowledgeLibraryDirectory hidden={selected !== undefined} entries={entries} loading={loading} loaded={loaded} error={error}
        query={directoryQuery} scope={directoryScope} onQueryChange={setDirectoryQuery} onScopeChange={setDirectoryScope}
        onOpen={setSelectedId} onCreate={() => { setCreating(true) }} onRefresh={onRefresh} t={t}
        renderActions={entry => entry.canManage === true
          ? <KnowledgeLibraryActions name={entry.label} disabled={deletePending} onEdit={() => { setEditingId(entry.id) }} onDelete={entry.scope === 'PERSONAL' ? () => { setDeleteError(undefined); setDeleting(entry) } : undefined} t={t} /> : null} />
      {selected && <KnowledgeDocuments key={selected.id} product={localDetail(selected)} t={t}
        refreshRevision={refreshRevision} renderFactorySlot={renderFactorySlot}
        onBack={() => { setSelectedId(undefined) }}
        onEditLibrary={selected.canManage === true ? () => { setEditingId(selected.id) } : undefined}
        onDeleteLibrary={selected.scope === 'PERSONAL' && selected.canManage === true
          ? () => { setDeleteError(undefined); setDeleting(selected) } : undefined}
        deletePending={deletePending} directoryError={error} directoryLoading={loading} onRefreshDirectory={onRefresh} />}
    </> : <div className={css.catalogScroll}><div className="product-capability-content">
      <header className={`${css.catalogHeader} product-capability-header`}>
        <div className="product-capability-heading">
          <h1 className="product-capability-title">{t('knowledge')}</h1>
          <p className="product-capability-description">{t('knowledgeDirectoryHint')}</p>
        </div>
      </header>
      <ProductSignIn onSignIn={onSignIn} t={t} />
    </div>
    </div>}
  </section>{creating && <KnowledgeBaseEditor t={t} onClose={() => { setCreating(false) }} onSaved={(id) => {
    setCreating(false); setSelectedId(id); onRefresh()
  }} />}{editingId && <KnowledgeBaseEditor key={editingId} knowledgeBaseId={editingId} t={t}
    onClose={() => { setEditingId(undefined) }} onSaved={() => { setEditingId(undefined); onRefresh() }} />}{deleting && <Modal open title={t('knowledgeDeleteBase')} closeLabel={t('close')} onClose={closeDelete} footer={<>
    <Button variant="ghost" size="sm" aria-disabled={deletePending} className={deletePending ? 'product-control-pending' : undefined} onClick={closeDelete}>{t('cancel')}</Button>
    <Button variant="primary" className={`${css.knowledgeDanger}${deletePending ? ' product-control-pending' : ''}`} size="sm" aria-disabled={deletePending}
      aria-busy={deletePending} onClick={() => { void confirmDelete() }}>
      {t(deletePending ? 'deletingResource' : 'deleteResource')}
    </Button>
  </>}><p ref={bindDeleteDialog} className={css.knowledgeConfirmation}>{t('knowledgeDeleteBaseConfirmation').replace('{name}', deleting.label)}</p>
    {deleteError !== undefined && <p role="alert" className={css.catalogError}>{productErrorMessage(deleteError, t, 'knowledgeDeleteBaseFailed')}</p>}
  </Modal>}</>
}
