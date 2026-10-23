/** Paginated library materials and manager actions, independent of task selection. */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, FileTypeIcon, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconDownloadOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular, IconFolderOpenOutlineRegular, IconLinkOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, IconStopFillRegular, IconTrashOutlineRegular, Menu, Modal, SegmentedControl, Tooltip, fileSizeText, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { KnowledgeUploadPending } from '@deepseek-harness/product/bridge'
import type { KnowledgePdfParseMode } from '@deepseek-harness/product/protocol'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { formatDate, type ProductDetail } from './catalog-shared.tsx'
import { isKnowledgeAccessDenied, knowledgeDocument, knowledgeFolder, knowledgePage, useKnowledgeRequests, type KnowledgeDocument, type KnowledgeFolder, type KnowledgePage } from './knowledge-data.ts'
import { KnowledgeDocumentReader } from './KnowledgeDocumentReader.tsx'
import { ProductLoading } from './ProductLoading.tsx'
import { KnowledgeEditor, type KnowledgeEditorTarget } from './KnowledgeEditor.tsx'
import { useKnowledgeFolderLocation } from './knowledge-folder-location.ts'
import { KnowledgeFolderPicker } from './KnowledgeFolderPicker.tsx'
import { KnowledgeUploadDialog } from './KnowledgeUploadDialog.tsx'
import { KnowledgeBatchDialog, type KnowledgeBatchAction } from './KnowledgeBatchDialog.tsx'
import { productErrorMessage } from './product-errors.ts'
import { readMaterialDocuments } from './knowledge-materials.ts'
import { confirmKnowledgeDocumentMutation, confirmKnowledgeFolderDeletion } from './knowledge-mutation-receipts.ts'

type Confirmation = { readonly kind: 'document'; readonly document: KnowledgeDocument; readonly operationId: string }
  | { readonly kind: 'folder'; readonly folder: KnowledgeFolder }
type MoveSelection = {
  readonly folderId: string | null
  readonly expectedFolderId: string | null
  readonly expectedUpdatedAt: string
  readonly operationId: string
}

/** Display authorized documents with server-side filters and paginated results.
 * @param props Library permissions, labels, optional workspace navigation, and selection callback.
 * @returns Materials table and manager actions, with inline reading when navigation is supplied.
 */
export function KnowledgeDocuments({
  product, renderNavigation, onNavigate, refreshRevision = 0, renderFactorySlot, t,
}: PropsRenderFactories & {
  readonly product: ProductDetail
  readonly renderNavigation?: (children: ReactNode, openLibrary: () => void) => ReactNode
  readonly onNavigate?: () => void
  readonly refreshRevision?: number
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  return <KnowledgeDocumentsScope key={product.id} product={product} renderNavigation={renderNavigation}
    onNavigate={onNavigate} refreshRevision={refreshRevision} renderFactorySlot={renderFactorySlot} t={t} />
}

function KnowledgeDocumentsScope({ product, renderNavigation, onNavigate, refreshRevision, renderFactorySlot, t }: PropsRenderFactories & {
  readonly product: ProductDetail
  readonly renderNavigation: ((children: ReactNode, openLibrary: () => void) => ReactNode) | undefined
  readonly onNavigate: (() => void) | undefined
  readonly refreshRevision: number
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const browseId = useId()
  const [data, setData] = useState<KnowledgePage<KnowledgeDocument>>()
  const [materialFolderPage, setMaterialFolderPage] = useState<{ key: string; selection: string; value: KnowledgePage<KnowledgeFolder> }>()
  const [folderError, setFolderError] = useState('')
  const [folderId, setFolderId] = useState<string | null | undefined>(null)
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [format, setFormat] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [folderRevision, setFolderRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mutationError, setMutationError] = useState('')
  const [pending, setPending] = useState(false)
  const [uploads, setUploads] = useState<readonly KnowledgeUploadPending[]>([])
  const [uploadsOpen, setUploadsOpen] = useState(false)
  const [uploadRecoveryReady, setUploadRecoveryReady] = useState(false)
  const [uploadRecoveryRevision, setUploadRecoveryRevision] = useState(0)
  const [accessDenied, setAccessDenied] = useState(false)
  const [reader, setReader] = useState<KnowledgeDocument>()
  const [settledReaderCheck, setSettledReaderCheck] = useState<{ readonly id: string; readonly data: KnowledgePage<KnowledgeDocument> }>()
  const [editor, setEditor] = useState<KnowledgeEditorTarget>()
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [move, setMove] = useState<KnowledgeDocument>()
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [batch, setBatch] = useState<{ readonly action: KnowledgeBatchAction; readonly documents: readonly KnowledgeDocument[] }>()
  const [deleted, setDeleted] = useState<readonly string[]>([])
  const operation = useRef(new AbortController())
  const accessOperation = useRef(new AbortController())
  const reindexOperations = useRef(new Map<string, string>())
  const cancelOperations = useRef(new Map<string, string>())
  const loadedPage = useRef<number>()
  useEffect(() => {
    const controller = new AbortController()
    operation.current = controller
    return () => {
      controller.abort(); accessOperation.current.abort()
    }
  }, [request, product.id])
  const denyAccess = useCallback(() => {
    accessOperation.current.abort()
    setAccessDenied(true); setData(undefined); setMaterialFolderPage(undefined); setReader(undefined); setLoading(false)
    setEditor(undefined); setConfirmation(undefined); setMove(undefined); setBatch(undefined)
    setUploadsOpen(false); setUploads([]); setSelectedIds(new Set())
  }, [])
  const readAccessDenied = useCallback((failure: unknown) => {
    setError(productErrorMessage(failure, t, 'knowledgeReadFailed')); denyAccess()
  }, [denyAccess, t])
  useEffect(() => {
    accessOperation.current.abort(); accessOperation.current = new AbortController()
    setAccessDenied(false)
  }, [refreshRevision])
  const availableData = accessDenied ? undefined : data
  const breadcrumbFolderId = reader ? reader.folderId : folderId
  const location = useKnowledgeFolderLocation(product.id, accessDenied ? null : breadcrumbFolderId, `${folderRevision}:${refreshRevision}`)
  useEffect(() => {
    if (location.failure !== undefined && isKnowledgeAccessDenied(location.failure)) readAccessDenied(location.failure)
  }, [location.failure, readAccessDenied])
  useEffect(() => {
    if (typeof folderId !== 'string' || reader || location.trail === undefined) return
    const ancestors = location.trail.map(folder => folder.id)
    setExpandedFolders(previous => ancestors.every(id => previous.has(id)) ? previous : new Set([...previous, ...ancestors]))
  }, [folderId, reader, location.trail])
  const canManage = product.canManage === true && !accessDenied
  const recoverUpload = useCallback(async (signal: AbortSignal) => {
    const value = await request('knowledge.documents.upload.pending', { knowledgeBaseId: product.id }, signal)
    signal.throwIfAborted()
    setUploads(uploadSelections(value)); setUploadRecoveryReady(true)
  }, [request, product.id])
  useEffect(() => {
    if (!canManage) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, accessOperation.current.signal])
    setUploadRecoveryReady(false)
    void recoverUpload(signal).catch((failure: unknown) => {
      if (signal.aborted) return
      if (isKnowledgeAccessDenied(failure)) readAccessDenied(failure)
      else setMutationError(productErrorMessage(failure, t, 'knowledgeUploadRecoveryFailed'))
    })
    return () => { controller.abort() }
  }, [canManage, recoverUpload, readAccessDenied, t, uploadRecoveryRevision, refreshRevision])
  const canOpenExternal = globalThis.location.protocol === 'dsh-app:' && globalThis.location.hostname === 'app'
  // Refresh invalidates requests, while displayed rows remain scoped to their location and filters.
  const materialSelectionKey = JSON.stringify([folderId === undefined ? 'all-materials' : folderId, page, search, format, status])
  const folderSelectionKey = JSON.stringify([materialSelectionKey, folderRevision, refreshRevision])
  const materialFolders = accessDenied || materialFolderPage?.key !== folderSelectionKey ? undefined : materialFolderPage.value
  const displayedFolders = accessDenied || materialFolderPage?.selection !== materialSelectionKey ? undefined : materialFolderPage.value
  useEffect(() => {
    if (!canManage) { setEditor(undefined); setConfirmation(undefined); setMove(undefined); setBatch(undefined); setUploadsOpen(false) }
  }, [canManage])
  useEffect(() => { setSelectedIds(new Set()) }, [folderId, page, search, format, status, refreshRevision])
  useEffect(() => {
    if (accessDenied) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, accessOperation.current.signal])
    setFolderError(''); setError(''); setLoading(true)
    if (folderId === undefined || search || format || status) {
      setMaterialFolderPage({ key: folderSelectionKey, selection: materialSelectionKey, value: { items: [], page, size: 20, total: 0 } })
    } else {
      void request('knowledge.folders.list', { knowledgeBaseId: product.id, parentId: folderId, page, size: 20 }, signal)
        .then((value) => {
          if (signal.aborted) return
          const result = knowledgePage(value, knowledgeFolder)
          if (result.items.some(folder => folder.parentId !== folderId || folder.id === folderId)) throw new Error('Invalid knowledge folder branch')
          setMaterialFolderPage({ key: folderSelectionKey, selection: materialSelectionKey, value: result })
        }).catch((failure: unknown) => {
          if (signal.aborted) return
          setFolderError(productErrorMessage(failure, t, 'knowledgeFoldersFailed'))
          setLoading(false)
          if (isKnowledgeAccessDenied(failure)) denyAccess()
        })
    }
    return () => { controller.abort() }
  }, [request, product.id, folderSelectionKey, materialSelectionKey, accessDenied, denyAccess, t])
  useEffect(() => {
    if (accessDenied || materialFolders === undefined) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, accessOperation.current.signal])
    setLoading(true); setError('')
    void readMaterialDocuments(request, { knowledgeBaseId: product.id,
      ...(folderId === undefined ? {} : { folderId }), ...(search ? { query: search } : {}),
      ...(format ? { format } : {}), ...(status ? { status } : {}),
    }, materialFolders, page, signal).then((result) => {
      if (signal.aborted) return
      const total = result.total + materialFolders.total
      if (page > 1 && (page - 1) * 20 >= total) { setPage(Math.max(1, Math.ceil(total / 20))); return }
      const previousPage = loadedPage.current
      loadedPage.current = result.page
      setData(result)
      setReader((current) => {
        if (current === undefined) return current
        const latest = result.items.find(row => row.id === current.id)
        // A filtered page can lose a readable file when its status changes.
        // Missing filtered rows require an independent authorization read.
        return latest === undefined && previousPage === result.page && !search && !format && !status ? undefined
          : latest?.status === 'DELETING' ? undefined : latest ?? current
      })
    }).catch((failure: unknown) => {
      if (signal.aborted) return
      setError(productErrorMessage(failure, t, 'knowledgeListFailed'))
      if (isKnowledgeAccessDenied(failure)) denyAccess()
    })
      .finally(() => { if (!signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [request, product.id, folderId, page, search, format, status, revision, refreshRevision, materialFolders, accessDenied, denyAccess, t])
  const filteredReaderId = reader && data && (search || format || status) && !data.items.some(row => row.id === reader.id)
    ? reader.id : undefined
  const readerChecking = filteredReaderId !== undefined && (settledReaderCheck?.id !== filteredReaderId || settledReaderCheck.data !== data)
  useEffect(() => {
    if (filteredReaderId === undefined || data === undefined || accessDenied) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, accessOperation.current.signal])
    void request('knowledge.documents.previewMetadata', { knowledgeBaseId: product.id, documentId: filteredReaderId }, signal).then((value) => {
      if (signal.aborted) return
      const latest = knowledgeDocument(value)
      if (latest.id !== filteredReaderId || latest.knowledgeBaseId !== product.id) throw new Error('Knowledge document identity changed')
      setReader(current => current?.id !== filteredReaderId ? current : latest.status === 'DELETING' ? undefined : latest)
    }).catch((failure: unknown) => {
      if (signal.aborted) return
      setError(productErrorMessage(failure, t, 'knowledgeReadFailed'))
      if (isKnowledgeAccessDenied(failure)) denyAccess()
    }).finally(() => { if (!signal.aborted) setSettledReaderCheck({ id: filteredReaderId, data }) })
    return () => { controller.abort() }
  }, [request, product.id, filteredReaderId, data, accessDenied, denyAccess, t])
  useEffect(() => {
    if (loading || accessDenied || readerChecking) return
    if (!data?.items.some(row => ['QUEUED', 'PROCESSING', 'FINALIZING', 'DELETING'].includes(deleted.includes(row.id) ? 'DELETING' : row.status))
      && !(reader && ['QUEUED', 'PROCESSING', 'FINALIZING'].includes(reader.status))) return
    const timer = globalThis.setTimeout(() => { setRevision(value => value + 1) }, 3_000)
    return () => { globalThis.clearTimeout(timer) }
  }, [data, deleted, revision, loading, accessDenied, reader?.status, readerChecking])
  const mutate = async (method: string, payload: unknown, onCommitted: (receipt: unknown) => void): Promise<void> => {
    if (pending) return
    const controller = operation.current
    const signal = AbortSignal.any([controller.signal, accessOperation.current.signal])
    setPending(true); setMutationError('')
    try {
      const receipt = await request(method, payload, signal)
      if (!signal.aborted) {
        onCommitted(receipt); setRevision(value => value + 1)
        if (method.startsWith('knowledge.folders.')) setFolderRevision(value => value + 1)
      }
    } catch (failure) {
      if (signal.aborted) return
      if (isKnowledgeAccessDenied(failure)) readAccessDenied(failure)
      else setMutationError(productErrorMessage(failure, t, 'knowledgeChangeFailed'))
    }
    finally { if (!controller.signal.aborted) setPending(false) }
  }
  const upload = async (pdfParseMode: KnowledgePdfParseMode, destination = folderId): Promise<void> => {
    if (pending) return
    if (!uploadRecoveryReady) { setMutationError(t('knowledgeUploadRecoveryFailed')); return }
    if (uploads.length > 0) { setUploadsOpen(true); return }
    const controller = operation.current
    const signal = AbortSignal.any([controller.signal, accessOperation.current.signal])
    setPending(true); setMutationError('')
    try {
      const value = await request('knowledge.documents.upload.select', { knowledgeBaseId: product.id, pdfParseMode,
        ...(destination === undefined ? {} : { folderId: destination }) }, signal)
      signal.throwIfAborted()
      const selected = uploadSelections(value)
      setUploads(selected); setUploadsOpen(selected.length > 0)
    } catch (failure) {
      if (!signal.aborted) {
        if (isKnowledgeAccessDenied(failure)) readAccessDenied(failure)
        else {
          setMutationError(productErrorMessage(failure, t, 'knowledgeUploadFailed'))
          setUploadRecoveryReady(false); setUploadRecoveryRevision(value => value + 1)
        }
      }
    } finally { if (!controller.signal.aborted) setPending(false) }
  }
  const selectFolder = (value: string | null | undefined) => {
    setReader(undefined)
    if (value !== folderId || page !== 1) { setFolderId(value); setPage(1); setData(undefined) }
    if (value !== folderId) { setQuery(''); setSearch(''); setFormat(''); setStatus('') }
    onNavigate?.()
  }
  const closeConfirmation = () => {
    if (pending) return
    setConfirmation(undefined); setMutationError('')
  }
  const beginMutation = () => { setMutationError('') }
  const clearFilters = () => {
    setQuery(''); setSearch(''); setFormat(''); setStatus(''); setPage(1); setData(undefined)
  }
  const openReader = (row: KnowledgeDocument) => { if (!accessDenied) { setReader(row); onNavigate?.() } }
  const materialTotal = (availableData?.total ?? 0) + (displayedFolders?.total ?? 0)
  const pages = Math.max(1, Math.ceil(materialTotal / 20))
  const currentFolder = reader ? undefined : location.trail?.at(-1)
  const breadcrumbTrail = location.trail ?? []
  const childFolders = displayedFolders?.items ?? []
  const selectableDocuments = canManage ? (availableData?.items ?? []).filter(row => row.status !== 'DELETING' && !deleted.includes(row.id)) : []
  const selectedDocuments = selectableDocuments.filter(row => selectedIds.has(row.id))
  const allSelected = selectableDocuments.length > 0 && selectedDocuments.length === selectableDocuments.length
  const canReindexSelection = selectedDocuments.every(row => !['QUEUED', 'PROCESSING', 'FINALIZING'].includes(row.status))
  const selectDocument = (id: string, checked: boolean) => { setSelectedIds((previous) => {
    const next = new Set(previous)
    if (checked) next.add(id)
    else next.delete(id)
    return next
  }) }
  const beginBatch = (action: KnowledgeBatchAction) => {
    if (!pending && !loading && selectedDocuments.length > 0) { beginMutation(); setBatch({ action, documents: selectedDocuments }) }
  }
  const documentAction = (id: string, row: KnowledgeDocument) => {
    if (id === 'read') openReader(row)
    else if (id === 'locate') selectFolder(row.folderId)
    else if (id === 'edit') { beginMutation(); setEditor({ kind: 'markdown', document: row }) }
    else if (id === 'move') { beginMutation(); setMove(row) }
    else if (id === 'delete') {
      beginMutation(); setConfirmation({ kind: 'document', document: row, operationId: globalThis.crypto.randomUUID() })
    }
    else if (id === 'download' || id === 'openExternal') void fileAction(id, row)
    else if (id === 'reindex') {
      const operationId = reindexOperations.current.get(row.id) ?? globalThis.crypto.randomUUID()
      reindexOperations.current.set(row.id, operationId)
      void mutate('knowledge.documents.reindex', { knowledgeBaseId: product.id, documentId: row.id, operationId },
        (receipt) => {
          confirmKnowledgeDocumentMutation('reindex', receipt, { knowledgeBaseId: product.id, documentId: row.id })
          reindexOperations.current.delete(row.id); cancelOperations.current.delete(row.id)
        })
    }
    else if (id === 'cancel') {
      const operationId = cancelOperations.current.get(row.id) ?? globalThis.crypto.randomUUID()
      cancelOperations.current.set(row.id, operationId)
      void mutate('knowledge.documents.cancel', { knowledgeBaseId: product.id, documentId: row.id, operationId },
        (receipt) => {
          confirmKnowledgeDocumentMutation('cancel', receipt, { knowledgeBaseId: product.id, documentId: row.id })
          cancelOperations.current.delete(row.id)
        })
    }
  }
  const fileAction = async (action: 'download' | 'openExternal', row: KnowledgeDocument): Promise<void> => {
    if (pending) return
    const controller = operation.current
    const signal = AbortSignal.any([controller.signal, accessOperation.current.signal])
    setPending(true); setMutationError('')
    try {
      await request(`knowledge.documents.${action}`, { knowledgeBaseId: product.id, documentId: row.id }, signal)
    } catch (failure) {
      if (!signal.aborted) {
        setMutationError(productErrorMessage(failure, t, action === 'download' ? 'knowledgeDownloadFailed' : 'knowledgeOpenExternalFailed'))
        if (isKnowledgeAccessDenied(failure)) denyAccess()
      }
    } finally { if (!controller.signal.aborted) setPending(false) }
  }
  const folderAction = (id: string, folder: KnowledgeFolder) => {
    if (id === 'rename') { beginMutation(); setEditor({ kind: 'folder', folder }) }
    else if (id === 'create') { beginMutation(); setEditor({ kind: 'folder', parentId: folder.id }) }
    else if (id === 'delete') { beginMutation(); setConfirmation({ kind: 'folder', folder }) }
    else if (id === 'upload') void upload('STANDARD', folder.id)
  }
  const materialSearch = <form className={css.knowledgeFilterSearch} onSubmit={(event) => {
    event.preventDefault(); setSearch(query.trim()); setPage(1)
    if (search !== query.trim() || page !== 1) setData(undefined)
    setReader(undefined); onNavigate?.()
  }}>
    <label className={css.searchField}><IconSearchOutlineRegular size={16} /><span className={css.visuallyHidden}>{t('knowledgeFindFiles')}</span>
      <input type="search" value={query} maxLength={120} placeholder={t(folderId === undefined ? 'knowledgeSearchLibrary' : 'knowledgeSearchFolder')}
        onChange={(event) => { setQuery(event.currentTarget.value) }} /></label>
    <Tooltip label={t('search')}><button className={css.iconButton} type="submit" aria-label={t('search')}><IconSearchOutlineRegular size={16} /></button></Tooltip>
  </form>
  const toolbar = <>
    <div className={css.knowledgeBrowseToolbar}>
      <SegmentedControl id={browseId} value={folderId === undefined ? 'all' : 'folders'}
        options={[{ value: 'folders', label: t('knowledgeFolderView') }, { value: 'all', label: t('knowledgeAllMaterials') }]}
        onChange={(value) => { selectFolder(value === 'all' ? undefined : null) }} label={t('knowledgeBrowseMode')} />
      {folderId === undefined && canManage && <span className={css.knowledgeBrowseHint}>{t('knowledgeLibrarySaveLocation')}</span>}
    </div>
    {!renderNavigation && folderId !== null && <Button variant="ghost" size="sm" onClick={() => { selectFolder(null) }}>
      <IconChevronLeftOutlineRegular size={14} />{t('knowledgeRootFolder')}</Button>}
    <div className={css.knowledgeMaterialsToolbar}>
      {materialSearch}
      {canManage && <div className={css.knowledgeAddActions}>
        <KnowledgeUploadMenu disabled={pending || !uploadRecoveryReady || uploads.length > 0}
          onSelect={(mode) => { void upload(mode) }} t={t} />
        <KnowledgeAddMenu disabled={pending} onSelect={(kind) => {
          beginMutation(); setEditor(kind === 'folder' ? { kind, parentId: folderId ?? null } : { kind, folderId: folderId ?? null })
        }} t={t} />
      </div>}
    </div>
    <div className={css.knowledgeFilters}>
      <label><span className={css.visuallyHidden}>{t('knowledgeFormat')}</span><select aria-label={t('knowledgeFormat')} value={format}
        onChange={(event) => { setFormat(event.currentTarget.value); setPage(1); setData(undefined) }}>
        <option value="">{t('knowledgeAllFormats')}</option><option value="manual">{t('knowledgeOnlineDocument')}</option>
        <option value="url">{t('knowledgeWebsite')}</option>{['pdf', 'docx', 'xlsx', 'md', 'txt'].map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}
      </select></label>
      {(search || format || status) && <Button variant="ghost" size="sm" onClick={clearFilters}>{t('knowledgeClearFilters')}</Button>}
      <label><span className={css.visuallyHidden}>{t('status')}</span><select aria-label={t('status')} value={status}
        onChange={(event) => { setStatus(event.currentTarget.value); setPage(1); setData(undefined) }}>
        <option value="">{t('knowledgeAllStatuses')}</option>{['READY', 'QUEUED', 'PROCESSING', 'FINALIZING', 'FAILED', 'CANCELLED', 'DELETING']
          .map(value => <option key={value} value={value}>{knowledgeStatus(value, t)}</option>)}
      </select></label>
      <Tooltip label={t('refresh')}><button type="button" className={css.iconButton} disabled={loading || pending}
        aria-label={t('refresh')} onClick={() => {
          accessOperation.current.abort(); accessOperation.current = new AbortController()
          setAccessDenied(false); setRevision(value => value + 1)
          setFolderRevision(value => value + 1)
          setUploadRecoveryRevision(value => value + 1)
        }}><IconRefreshOutlineRegular size={16} /></button></Tooltip>
    </div>
    {canManage && selectedDocuments.length > 0 && <div className={css.knowledgeBatchToolbar} role="group" aria-label={t('knowledgeBatchActions')}>
      <span role="status">{t('knowledgeSelectedCount').replace('{count}', String(selectedDocuments.length))}</span>
      <Button variant="ghost" size="sm" disabled={pending || loading} onClick={() => { beginBatch('move') }}>{t('knowledgeBatchMove')}</Button>
      <Tooltip label={t(canReindexSelection ? 'knowledgeReindex' : 'knowledgeBatchProcessingHint')}>
        <Button variant="ghost" size="sm" disabled={pending || loading || !canReindexSelection} onClick={() => { beginBatch('reindex') }}>{t('knowledgeBatchReindex')}</Button>
      </Tooltip>
      <Button variant="ghost" size="sm" disabled={pending || loading} onClick={() => { beginBatch('delete') }}>{t('knowledgeBatchDelete')}</Button>
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => { setSelectedIds(new Set()) }}>{t('knowledgeClearSelection')}</Button>
    </div>}
  </>
  const uploadRecovery = canManage && uploads.length > 0 && <div className={css.knowledgeAddActions}>
    <span role="status">{t('knowledgeUploadsPending').replace('{count}', String(uploads.length))}</span>
    <Button variant="outline" size="sm" disabled={pending} onClick={() => { setUploadsOpen(true) }}>{t('knowledgeUploadViewQueue')}</Button>
  </div>
  const materials = <section role="tabpanel" id={`${browseId}-${folderId === undefined ? 'all' : 'folders'}-panel`}
    aria-labelledby={`${browseId}-${folderId === undefined ? 'all' : 'folders'}`}>
    {(folderError || error || mutationError) && <p role="alert" className={css.catalogError}>{folderError || error || mutationError}</p>}
    {uploadRecovery}
    <div className={css.knowledgeTableScroll} aria-busy={loading}>
      {(childFolders.length > 0 || (availableData?.items.length ?? 0) > 0) && <table className={css.knowledgeTable}>
        <thead><tr><th><div className={css.knowledgeSelectableName}>
          {canManage && <input type="checkbox" aria-label={t('knowledgeSelectPage')} checked={allSelected} disabled={pending || loading || selectableDocuments.length === 0}
            ref={(node) => { if (node) node.indeterminate = selectedDocuments.length > 0 && !allSelected }}
            onChange={(event) => { setSelectedIds(new Set(event.currentTarget.checked ? selectableDocuments.map(row => row.id) : [])) }} />}
          {t('knowledgeDocumentTitle')}</div></th><th>{t('status')}</th><th>{t('knowledgeFormat')}</th>
        <th>{t('knowledgeSize')}</th><th>{t('updatedAt')}</th>
        <th><span className={css.visuallyHidden}>{t('resourceActions')}</span></th></tr></thead>
        <tbody>{childFolders.map(folder => <tr key={`folder:${folder.id}`} data-knowledge-child-folder={folder.id}>
          <td><div className={css.knowledgeSelectableName} data-selectable={canManage}>
            <button type="button" className={css.knowledgeDocumentName} onClick={() => { selectFolder(folder.id) }}>
              <IconFolderOpenOutlineRegular size={18} /><span>{folder.name}</span></button></div></td>
          <td></td><td>{t('knowledgeFolderType')}</td><td></td><td></td>
          <td>{canManage && <KnowledgeFolderActions folder={folder} disabled={pending}
            onSelect={(id) => { folderAction(id, folder) }} t={t} />}</td>
        </tr>)}{availableData?.items.map((row) => {
          const deleting = deleted.includes(row.id) || row.status === 'DELETING'
          return <tr key={row.id}>
            <td><div className={css.knowledgeSelectableName}>
              {canManage && <input type="checkbox" aria-label={t('knowledgeSelectDocument').replace('{name}', row.filename)}
                checked={selectedIds.has(row.id) && !deleting} disabled={pending || deleting}
                onChange={(event) => { selectDocument(row.id, event.currentTarget.checked) }} />}
              <button type="button" className={css.knowledgeDocumentName} disabled={deleting} onClick={() => { openReader(row) }}>
                <FileTypeIcon path={row.filename} size={18} /><span>{row.filename}</span></button></div></td>
            <td><KnowledgeDocumentStatus status={deleting ? 'DELETING' : row.status} sourceType={row.sourceType} t={t} /></td>
            <td>{row.sourceType === 'manual' ? t('knowledgeOnlineDocument') : row.sourceType === 'url' ? t('knowledgeWebsite') : row.filename.split('.').at(-1)?.toUpperCase()}</td>
            <td>{fileSizeText(row.sizeBytes)}</td><td>{formatDate(row.updatedAt)}</td>
            <td><KnowledgeDocumentActions document={row} disabled={pending || deleting}
              canManage={canManage} canOpenExternal={canOpenExternal}
              onSelect={(id) => { documentAction(id, row) }} t={t} /></td>
          </tr>
        })}</tbody>
      </table>}
      {!accessDenied && !folderError && (loading || materialFolders === undefined) && availableData === undefined
        && <div className={css.knowledgeMaterialsEmpty}><ProductLoading label={t('loading')} /></div>}
      {!folderError && !error && availableData?.items.length === 0 && displayedFolders?.total === 0
        && <div className={css.knowledgeMaterialsEmpty}>
          <IconFolderOpenOutlineRegular size={30} /><strong>{t(search || format || status ? 'noSearchResults' : 'knowledgeNoMaterials')}</strong>
          <span>{t(search || format || status ? 'knowledgeFilterEmptyHint'
            : canManage ? 'knowledgeEmptyManageHint' : 'knowledgeEmptyReadHint')}</span>
        </div>}
    </div>
    {(page > 1 || materialTotal > 0) && <div className={css.knowledgePagination}>
      <span>{t('itemCount').replace('{count}', String(materialTotal))}</span>
      <div><Button variant="ghost" size="sm" disabled={loading || page <= 1} aria-label={t('previousPage')} onClick={() => { setPage(value => value - 1); setData(undefined) }}><IconChevronLeftOutlineRegular size={16} /></Button>
        <span>{t('knowledgePageCount').replace('{page}', String(page)).replace('{pages}', String(pages))}</span>
        <Button variant="ghost" size="sm" disabled={loading || page >= pages} aria-label={t('nextPage')} onClick={() => { setPage(value => value + 1); setData(undefined) }}><IconChevronRightOutlineRegular size={16} /></Button></div>
    </div>}
  </section>
  const documentReader = reader && <KnowledgeDocumentReader key={reader.id} knowledgeBaseId={product.id} documentId={reader.id}
    title={reader.filename} inline={renderNavigation !== undefined} refreshRevision={refreshRevision}
    renderFactorySlot={renderFactorySlot} onAccessDenied={readAccessDenied} onClose={() => { setReader(undefined) }} t={t} />
  const readerStatusHint = reader && knowledgeStatusHint(reader.status, reader.sourceType, t)
  const tree = <nav className={css.knowledgeWorkspaceTree} aria-label={t('knowledgeFolders')} aria-busy={loading}>
    <div className={css.knowledgeWorkspaceTreeToolbar}><span>{t('knowledgeFolders')}</span>{canManage && <Tooltip label={t('knowledgeCreateFolder')}>
      <button type="button" disabled={pending} className={css.iconButton} aria-label={t('knowledgeCreateFolder')}
        onClick={() => { beginMutation(); setEditor({ kind: 'folder', parentId: null }) }}><IconPlusOutlineRegular size={16} /></button></Tooltip>}</div>
    {!accessDenied && <KnowledgeFolderBranch baseId={product.id} parentId={null} depth={0}
      revision={`${folderRevision}:${refreshRevision}`} selectedId={folderId} expanded={expandedFolders}
      onExpand={(id) => { setExpandedFolders((previous) => {
        const next = new Set(previous)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }) }}
      onSelect={selectFolder} onAction={folderAction} onAccessDenied={readAccessDenied}
      canManage={canManage} pending={pending} t={t} />}
  </nav>
  return <>
    {renderNavigation ? <div className={css.knowledgeWorkspace} data-knowledge-workspace-content>
      <aside className={css.knowledgeWorkspaceNavigation} id="knowledge-workspace-navigation" data-knowledge-navigation>{renderNavigation(tree, () => { selectFolder(null) })}</aside>
      <main className={css.knowledgeWorkspaceMain} data-knowledge-content>
        <header className={css.knowledgeWorkspaceDocumentHeader}>
          <nav className={css.knowledgeWorkspaceBreadcrumb} aria-label={t('knowledgeLocation')}>
            <button type="button" onClick={() => { selectFolder(null) }}>{product.name}</button>
            {breadcrumbFolderId === undefined && <><IconChevronRightOutlineRegular size={14} /><span aria-current={reader ? undefined : 'page'}>{t('knowledgeAllMaterials')}</span></>}
            {location.loading && <ProductLoading label={t('loading')} />}
            {location.failure !== undefined && <span role="alert" className={css.catalogError}>{productErrorMessage(location.failure, t, 'knowledgeFoldersFailed')}</span>}
            {breadcrumbTrail.map(folder => <span key={folder.id} className={css.knowledgeBreadcrumbPart}>
              <IconChevronRightOutlineRegular size={14} /><button type="button" aria-current={!reader && folder.id === folderId ? 'page' : undefined}
                onClick={() => { selectFolder(folder.id) }}>{folder.name}</button></span>)}
            {reader && <><IconChevronRightOutlineRegular size={14} /><span aria-current="page">{reader.filename}</span></>}
          </nav>
          {reader && <div className={css.knowledgeWorkspaceDocumentActions}>
            <Button variant="ghost" size="sm" onClick={() => { setReader(undefined); onNavigate?.() }}><IconChevronLeftOutlineRegular size={16} />{t('knowledgeBackToFolder')}</Button>
            <KnowledgeDocumentActions document={reader} disabled={pending || deleted.includes(reader.id) || accessDenied}
              canManage={canManage} canOpenExternal={canOpenExternal} onSelect={(id) => { documentAction(id, reader) }} t={t} />
          </div>}
          {!reader && currentFolder && canManage && <KnowledgeFolderActions folder={currentFolder} disabled={pending}
            onSelect={(id) => { folderAction(id, currentFolder) }} t={t} />}
        </header>
        <div className={css.knowledgeWorkspaceBody}>
          {reader ? <>{(folderError || error || mutationError) && <p role="alert" className={css.catalogError}>{folderError || error || mutationError}</p>}
            <div className={css.knowledgeReaderProcessing} role="status">
              <KnowledgeDocumentStatus status={reader.status} sourceType={reader.sourceType} t={t} />
              {readerStatusHint && <span>{readerStatusHint}</span>}</div>
            {uploadRecovery}{documentReader}</>
            : <>{toolbar}{materials}</>}
        </div>
      </main>
    </div> : <>{toolbar}{tree}{materials}{documentReader}</>}
    {editor && <KnowledgeEditor knowledgeBaseId={product.id} target={editor}
      onClose={() => { setEditor(undefined) }}
      onSaved={(folder) => {
        if (folder && editor.kind === 'folder' && !editor.folder) {
          setFolderId(folder.id)
          setQuery(''); setSearch(''); setFormat(''); setStatus(''); setData(undefined)
          setExpandedFolders(previous => new Set([...previous, folder.id, ...folder.parentId === null ? [] : [folder.parentId]]))
          onNavigate?.()
        }
        if (editor.kind === 'folder') setFolderRevision(value => value + 1)
        setEditor(undefined); setReader(undefined); setPage(1); setRevision(value => value + 1)
      }} t={t} />}
    {confirmation && <Modal open title={t(confirmation.kind === 'document' ? 'knowledgeDeleteDocument' : 'knowledgeDeleteFolder')}
      closeLabel={t('close')} onClose={closeConfirmation} footer={<>
        <Button variant="ghost" size="sm" disabled={pending} onClick={closeConfirmation}>{t('cancel')}</Button>
        <Button variant="primary" className={css.knowledgeDanger} size="sm" disabled={pending} onClick={() => {
          if (confirmation.kind === 'folder') void mutate('knowledge.folders.delete',
            { knowledgeBaseId: product.id, folderId: confirmation.folder.id }, (receipt) => {
              confirmKnowledgeFolderDeletion(receipt, confirmation.folder.id)
              setConfirmation(undefined)
              if (folderId === confirmation.folder.id) selectFolder(confirmation.folder.parentId)
            })
          else {
            const id = confirmation.document.id
            void mutate('knowledge.documents.delete', { knowledgeBaseId: product.id, documentId: id, operationId: confirmation.operationId }, (receipt) => {
              confirmKnowledgeDocumentMutation('delete', receipt, { knowledgeBaseId: product.id, documentId: id })
              setConfirmation(undefined); setDeleted(value => [...value, id]); setReader(value => value?.id === id ? undefined : value)
            })
          }
        }}>{t(pending ? 'deletingResource' : 'deleteResource')}</Button>
      </>}>
      <p className={css.knowledgeConfirmation}>{t(confirmation.kind === 'document' ? 'knowledgeDeleteDocumentConfirmation' : 'knowledgeDeleteFolderConfirmation')
        .replace('{name}', confirmation.kind === 'document' ? confirmation.document.filename : confirmation.folder.name)}</p>
      {mutationError && <p role="alert" className={css.catalogError}>{mutationError}</p>}
    </Modal>}
    {move && <KnowledgeMoveDialog knowledgeBaseId={product.id} document={move} pending={pending} error={mutationError}
      onClose={() => { if (!pending) setMove(undefined) }}
      onMove={(selection) => { void mutate('knowledge.documents.move', { knowledgeBaseId: product.id, documentId: move.id, ...selection }, (receipt) => {
        confirmKnowledgeDocumentMutation('move', receipt, { knowledgeBaseId: product.id, documentId: move.id, folderId: selection.folderId })
        setMove(undefined); setReader(undefined)
      }) }} t={t} />}
    {uploadsOpen && canManage && <KnowledgeUploadDialog knowledgeBaseId={product.id} selections={uploads}
      onBusyChange={setPending} onAccepted={() => { setRevision(value => value + 1) }}
      onDenied={(failure) => {
        if (isKnowledgeAccessDenied(failure)) readAccessDenied(failure)
        else { setUploadsOpen(false); setMutationError(productErrorMessage(failure, t, 'knowledgeChangeFailed')) }
      }}
      onClose={() => {
        setUploadsOpen(false); setUploadRecoveryReady(false); setUploadRecoveryRevision(value => value + 1)
      }} t={t} />}
    {batch && <KnowledgeBatchDialog knowledgeBaseId={product.id} action={batch.action} documents={batch.documents}
      onBusyChange={setPending} onAccessDenied={readAccessDenied}
      onAccepted={(document, action) => {
        if (action === 'delete') setDeleted(previous => [...previous, document.id])
        setReader(current => current?.id === document.id ? undefined : current)
      }} onClose={() => { setBatch(undefined); setSelectedIds(new Set()); setRevision(value => value + 1) }} t={t} />}
  </>
}

function KnowledgeDocumentStatus({ status, sourceType, t }: {
  readonly status: string
  readonly sourceType: string | undefined
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  return <span className={css.knowledgeDocumentStatus} data-status={status}
    title={knowledgeStatusHint(status, sourceType, t)}>{knowledgeStatus(status, t)}</span>
}

function knowledgeStatusHint(status: string, sourceType: string | undefined,
  t: (key: DeepSeekHarnessProductKey) => string): string | undefined {
  if (sourceType === 'url') return undefined
  if (['QUEUED', 'PROCESSING', 'FINALIZING'].includes(status)) return t('knowledgeProcessingHint')
  if (status === 'FAILED') return t('knowledgeFailedHint')
  if (status === 'CANCELLED') return t('knowledgeCancelledHint')
  return undefined
}

function KnowledgeUploadMenu({ disabled, onSelect, t }: {
  readonly disabled: boolean
  readonly onSelect: (mode: KnowledgePdfParseMode) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [open, setOpen] = useState(false)
  return <Menu open={open && !disabled} onClose={() => { setOpen(false) }} portal align="end" items={[
    { id: 'STANDARD', label: t('knowledgeUploadStandard'), icon: <IconDownloadOutlineRegular size={16} /> },
    { id: 'TEXT', label: t('knowledgeUploadTextPdf'), icon: <FileTypeIcon path="document.pdf" size={16} /> },
  ]} onSelect={(id) => { setOpen(false); if (id === 'STANDARD' || id === 'TEXT') onSelect(id) }}
  anchor={<Button variant="outline" size="sm" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
    onClick={() => { setOpen(!open) }}><IconDownloadOutlineRegular size={14} />{t('knowledgeUpload')}</Button>} />
}

function KnowledgeAddMenu({ disabled, onSelect, t }: {
  readonly disabled: boolean
  readonly onSelect: (kind: 'markdown' | 'url' | 'folder') => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [open, setOpen] = useState(false)
  return <Menu open={open && !disabled} onClose={() => { setOpen(false) }} portal align="end" items={[
    { id: 'markdown', label: t('knowledgeNewDocument'), icon: <IconEditOutlineRegular size={16} /> },
    { id: 'url', label: t('knowledgeImportUrl'), icon: <IconLinkOutlineRegular size={16} /> },
    { type: 'separator', id: 'folders' }, { id: 'folder', label: t('knowledgeCreateFolder'), icon: <IconFolderOpenOutlineRegular size={16} /> },
  ]} onSelect={(id) => { setOpen(false); if (id === 'markdown' || id === 'url' || id === 'folder') onSelect(id) }}
  anchor={<Button variant="outline" size="sm" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
    onClick={() => { setOpen(!open) }}><IconPlusOutlineRegular size={14} />{t('knowledgeAddMaterial')}</Button>} />
}

function KnowledgeDocumentActions({ document, disabled, canManage, canOpenExternal, onSelect, t }: {
  readonly document: KnowledgeDocument
  readonly disabled: boolean
  readonly canManage: boolean
  readonly canOpenExternal: boolean
  readonly onSelect: (id: string) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const processing = ['QUEUED', 'PROCESSING', 'FINALIZING'].includes(document.status)
  const items: MenuEntry[] = [{ id: 'read', label: t('knowledgeReadDocument'), disabled: document.status === 'DELETING' }]
  items.push({ id: 'locate', label: t('knowledgeShowInFolder'), icon: <IconFolderOpenOutlineRegular size={16} /> })
  items.push({ id: 'download', label: t('knowledgeDownloadOriginal'), icon: <IconDownloadOutlineRegular size={16} /> })
  if (canOpenExternal) items.push({ id: 'openExternal', label: t('knowledgeOpenExternal'), icon: <IconLinkOutlineRegular size={16} /> })
  if (canManage && document.sourceType === 'manual') items.push({ id: 'edit', label: t('modifyResource'), icon: <IconEditOutlineRegular size={16} />, disabled: processing })
  if (canManage && processing) items.push({ id: 'cancel', label: t('knowledgeStopProcessing'), icon: <IconStopFillRegular size={16} /> })
  if (canManage) items.push({ id: 'move', label: t('knowledgeMoveDocument'), icon: <IconFolderOpenOutlineRegular size={16} /> },
    { id: 'reindex', label: t('knowledgeReindex'), icon: <IconRefreshOutlineRegular size={16} />, disabled: processing },
    { type: 'separator', id: 'delete-separator' }, { id: 'delete', label: t('deleteResource'), icon: <IconTrashOutlineRegular size={16} />, danger: true })
  return <Menu open={open && !disabled} items={items} portal align="end" onClose={() => { setOpen(false) }}
    onSelect={(id) => { setOpen(false); onSelect(id) }} anchor={<Tooltip label={t('resourceActions')}>
      <button type="button" disabled={disabled} className={css.iconButton} aria-label={t('knowledgeDocumentActions').replace('{name}', document.filename)}
        aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open) }}><IconEllipsisOutlineRegular size={16} /></button></Tooltip>} />
}

function KnowledgeFolderBranch(props: {
  readonly baseId: string
  readonly parentId: string | null
  readonly depth: number
  readonly revision: string
  readonly selectedId: string | null | undefined
  readonly expanded: ReadonlySet<string>
  readonly onExpand: (id: string) => void
  readonly onSelect: (id: string) => void
  readonly onAction: (action: string, folder: KnowledgeFolder) => void
  readonly onAccessDenied: (failure: unknown) => void
  readonly canManage: boolean
  readonly pending: boolean
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const { baseId, parentId, revision, onAccessDenied, t } = props
  const request = useKnowledgeRequests()
  const [page, setPage] = useState(1)
  const [retry, setRetry] = useState(0)
  const [folderPage, setFolderPage] = useState<{ key: string; value: KnowledgePage<KnowledgeFolder> }>()
  const selectionKey = JSON.stringify([baseId, parentId, page])
  const result = folderPage?.key === selectionKey ? folderPage.value : undefined
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void request('knowledge.folders.list', { knowledgeBaseId: baseId, parentId, page, size: 20 }, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return
        const result = knowledgePage(value, knowledgeFolder)
        const last = Math.max(1, Math.ceil(result.total / result.size))
        if (page > last) { setPage(last); return }
        if (result.items.some(folder => folder.parentId !== parentId || folder.id === parentId)) throw new Error('Invalid knowledge folder branch')
        setFolderPage({ key: selectionKey, value: result })
      }).catch((failure: unknown) => {
        if (controller.signal.aborted) return
        setError(productErrorMessage(failure, t, 'knowledgeFoldersFailed'))
        if (isKnowledgeAccessDenied(failure)) onAccessDenied(failure)
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [request, baseId, parentId, page, selectionKey, retry, revision, onAccessDenied, t])
  const pages = Math.max(1, Math.ceil((result?.total ?? 0) / 20))
  return <div aria-busy={loading}>
    {loading && result === undefined && <ProductLoading label={t('loading')} />}
    {!error && result?.total === 0 && <p className={css.knowledgeFolderEmpty}>{t('knowledgeNoFolders')}</p>}
    {error && <p role="alert" className={css.catalogError}>{error}<Button size="sm" onClick={() => { setRetry(value => value + 1) }}>{t('retry')}</Button></p>}
    {result?.items.map((folder) => {
      const expanded = props.expanded.has(folder.id)
      return <div key={folder.id} data-knowledge-folder={folder.id}>
        <div className={css.knowledgeWorkspaceFolderRow} style={{ paddingLeft: Math.min(props.depth, 5) * 12 }}>
          <button type="button" className={`${css.iconButton} ${css.knowledgeFolderExpander}`} disabled={props.pending}
            aria-label={t(expanded ? 'knowledgeCollapseFolder' : 'knowledgeExpandFolder').replace('{name}', folder.name)}
            aria-expanded={expanded} onClick={() => { props.onExpand(folder.id) }}>
            {expanded ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}</button>
          <button type="button" className={css.knowledgeWorkspaceTreeRow} disabled={props.pending}
            aria-current={props.selectedId === folder.id ? 'page' : undefined} onClick={() => { props.onSelect(folder.id) }}>
            <IconFolderOpenOutlineRegular size={16} /><span className={css.knowledgeWorkspaceTreeLabel}>{folder.name}</span></button>
          {props.canManage && <KnowledgeFolderActions folder={folder} disabled={props.pending}
            onSelect={(id) => { props.onAction(id, folder) }} t={t} />}
        </div>
        {expanded && <KnowledgeFolderBranch {...props} parentId={folder.id} depth={props.depth + 1} />}
      </div>
    })}
    {(pages > 1 || page > 1) && <div className={css.knowledgePagination}>
      <Button size="sm" disabled={loading || page === 1} onClick={() => { setPage(value => value - 1) }} aria-label={t('previousPage')}><IconChevronLeftOutlineRegular size={14} /></Button>
      <span>{page} / {pages}</span>
      <Button size="sm" disabled={loading || page >= pages} onClick={() => { setPage(value => value + 1) }} aria-label={t('nextPage')}><IconChevronRightOutlineRegular size={14} /></Button>
    </div>}
  </div>
}

function KnowledgeFolderActions({ folder, disabled, onSelect, t }: {
  readonly folder: KnowledgeFolder
  readonly disabled: boolean
  readonly onSelect: (id: string) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [open, setOpen] = useState(false)
  return <Menu open={open && !disabled} portal align="end" onClose={() => { setOpen(false) }} items={[
    { id: 'create', label: t('knowledgeCreateSubfolder'), icon: <IconPlusOutlineRegular size={16} /> },
    { id: 'upload', label: t('knowledgeUpload'), icon: <IconDownloadOutlineRegular size={16} /> },
    { type: 'separator', id: 'manage-folder' },
    { id: 'rename', label: t('knowledgeRenameFolder'), icon: <IconEditOutlineRegular size={16} /> },
    { id: 'delete', label: t('knowledgeDeleteFolder'), icon: <IconTrashOutlineRegular size={16} />, danger: true },
  ]} onSelect={(id) => { setOpen(false); onSelect(id) }} anchor={<Tooltip label={t('resourceActions')}>
    <button type="button" className={css.iconButton} disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      aria-label={t('knowledgeFolderActions').replace('{name}', folder.name)} onClick={() => { setOpen(!open) }}>
      <IconEllipsisOutlineRegular size={16} /></button></Tooltip>} />
}

function KnowledgeMoveDialog({ knowledgeBaseId, document, pending, error, onClose, onMove, t }: {
  readonly knowledgeBaseId: string
  readonly document: KnowledgeDocument
  readonly pending: boolean
  readonly error: string
  readonly onClose: () => void
  readonly onMove: (selection: MoveSelection) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [destination, setDestination] = useState(document.folderId ?? '')
  const [ready, setReady] = useState(false)
  const [attempt, setAttempt] = useState<MoveSelection>()
  return <Modal open title={t('knowledgeMoveDocument')} closeLabel={t('close')} onClose={onClose} footer={<>
    <Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>{t('cancel')}</Button>
    <Button variant="primary" size="sm" disabled={pending || !ready} onClick={() => {
      const selection = attempt ?? { folderId: destination || null, expectedFolderId: document.folderId ?? null,
        expectedUpdatedAt: document.updatedAt, operationId: globalThis.crypto.randomUUID() }
      setAttempt(selection); onMove(selection)
    }}>{t('knowledgeMove')}</Button>
  </>}><KnowledgeFolderPicker knowledgeBaseId={knowledgeBaseId} label={t('knowledgeDestinationFolder')} value={destination || null}
      disabled={pending || attempt !== undefined} onReady={setReady} onChange={(id) => { setDestination(id ?? ''); setReady(false) }} t={t} />
    {error && <p className={css.catalogError} role="alert">{error}</p>}
  </Modal>
}

/** Map document processing states to locale-owned labels.
 * @param status Document processing state from WeKnora.
 * @param t Locale dictionary.
 * @returns Human-readable processing state.
 */
export function knowledgeStatus(status: string, t: (key: DeepSeekHarnessProductKey) => string): string {
  return t(status === 'READY' ? 'knowledgeIndexed' : status === 'QUEUED' ? 'knowledgeQueued'
    : status === 'PROCESSING' ? 'knowledgeProcessing' : status === 'FAILED' ? 'knowledgeIndexFailed'
      : status === 'DELETING' ? 'knowledgeDeleting' : status === 'FINALIZING' ? 'knowledgeFinalizing'
        : status === 'CANCELLED' ? 'knowledgeCancelled' : 'statusUnavailable')
}

function uploadSelections(value: unknown): readonly KnowledgeUploadPending[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid pending uploads')
  const selections = value.map((row: unknown): KnowledgeUploadPending => {
    if (typeof row !== 'object' || row === null || !('operationId' in row) || typeof row.operationId !== 'string'
      || !/^[A-Za-z0-9._~-]{16,128}$/u.test(row.operationId) || !('pdfParseMode' in row)
      || row.pdfParseMode !== 'STANDARD' && row.pdfParseMode !== 'TEXT'
      || !('filename' in row) || typeof row.filename !== 'string' || row.filename.length === 0 || /[\\/\0]/u.test(row.filename)
      || 'folderId' in row && row.folderId !== null && (typeof row.folderId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(row.folderId))) {
      throw new Error('Invalid pending upload')
    }
    return { operationId: row.operationId, filename: row.filename, pdfParseMode: row.pdfParseMode,
      ...('folderId' in row ? { folderId: row.folderId as string | null } : {}) }
  })
  if (new Set(selections.map(row => row.operationId)).size !== selections.length) throw new Error('Duplicate upload identities')
  return selections
}
