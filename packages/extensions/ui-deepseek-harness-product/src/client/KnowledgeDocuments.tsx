/** Paginated library materials and manager actions, independent of task selection. */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button, FileTypeIcon, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconEditOutlineRegular, IconFolderOpenOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, Modal, SegmentedControl, Tooltip, fileSizeText, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import type { KnowledgeUploadPending } from '@deepseek-harness/product/bridge'
import { ProductError } from '@deepseek-harness/product/errors'
import type { KnowledgePdfParseMode } from '@deepseek-harness/product/protocol'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { formatDate, knowledgeScopeLabel, type ProductDetail } from './catalog-shared.tsx'
import { isKnowledgeAccessDenied, knowledgeDocument, knowledgeFolder, knowledgePage, useKnowledgeRequests, type KnowledgeDocument, type KnowledgeFolder, type KnowledgePage } from './knowledge-data.ts'
import { KnowledgeLibraryActions } from './KnowledgeLibraryActions.tsx'
import { KnowledgeAddMenu, KnowledgeDocumentActions, KnowledgeFolderActions } from './KnowledgeMaterialActions.tsx'
import { KnowledgeDocumentReader } from './KnowledgeDocumentReader.tsx'
import { KnowledgeContentSearch } from './KnowledgeContentSearch.tsx'
import { KnowledgeParsedContent } from './KnowledgeParsedContent.tsx'
import { KnowledgeProcessingDetails } from './KnowledgeProcessingDetails.tsx'
import { ProductLoading } from './ProductLoading.tsx'
import { KnowledgeEditor, type KnowledgeEditorTarget } from './KnowledgeEditor.tsx'
import { useKnowledgeFolderLocation } from './knowledge-folder-location.ts'
import { KnowledgeFolderPicker } from './KnowledgeFolderPicker.tsx'
import { KnowledgeUploadDialog } from './KnowledgeUploadDialog.tsx'
import { uploadSelections } from './knowledge-upload-selections.ts'
import { KnowledgeBatchDialog, type KnowledgeBatchAction } from './KnowledgeBatchDialog.tsx'
import { productErrorMessage, type ProductFailureReport } from './product-errors.ts'
import { readMaterialDocuments } from './knowledge-materials.ts'
import { confirmKnowledgeDocumentMutation, confirmKnowledgeFolderDeletion } from './knowledge-mutation-receipts.ts'
import { usePendingPageLayout } from './usePendingPageLayout.ts'
import { useResultFocus } from './useResultFocus.ts'

type Confirmation = { readonly kind: 'document'; readonly document: KnowledgeDocument; readonly operationId: string }
  | { readonly kind: 'folder'; readonly folder: KnowledgeFolder }
type MoveSelection = {
  readonly folderId: string | null
  readonly expectedFolderId: string | null
  readonly expectedUpdatedAt: string
  readonly operationId: string
}

/** Display authorized documents with server-side filters and paginated results.
 * Removed read controls and confirmed document deletions return their owned focus to the materials heading without scrolling.
 * Focus already moved to another region remains there.
 * @param props Library permissions, labels, optional directory return, and library actions.
 * @returns A single-column materials browser with inline reading and manager actions.
 */
export function KnowledgeDocuments({
  product, onBack, onEditLibrary, onDeleteLibrary, deletePending = false, directoryError, directoryLoading = false,
  onRefreshDirectory, refreshRevision = 0, renderFactorySlot, t,
}: PropsRenderFactories & {
  readonly product: ProductDetail
  readonly onBack?: () => void
  readonly onEditLibrary?: (() => void) | undefined
  readonly onDeleteLibrary?: (() => void) | undefined
  readonly deletePending?: boolean
  readonly directoryError?: string | undefined
  readonly directoryLoading?: boolean
  readonly onRefreshDirectory?: () => void
  readonly refreshRevision?: number
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  return <KnowledgeDocumentsScope key={product.id} product={product} onBack={onBack}
    onEditLibrary={onEditLibrary} onDeleteLibrary={onDeleteLibrary} deletePending={deletePending}
    directoryError={directoryError} directoryLoading={directoryLoading}
    onRefreshDirectory={onRefreshDirectory} refreshRevision={refreshRevision} renderFactorySlot={renderFactorySlot} t={t} />
}

function KnowledgeDocumentsScope({ product, onBack, onEditLibrary, onDeleteLibrary, deletePending, directoryError, directoryLoading,
  onRefreshDirectory, refreshRevision, renderFactorySlot, t }: PropsRenderFactories & {
    readonly product: ProductDetail
    readonly onBack: (() => void) | undefined
    readonly onEditLibrary: (() => void) | undefined
    readonly onDeleteLibrary: (() => void) | undefined
    readonly deletePending: boolean
    readonly directoryError: string | undefined
    readonly directoryLoading: boolean
    readonly onRefreshDirectory: (() => void) | undefined
    readonly refreshRevision: number
    readonly t: (key: DeepSeekHarnessProductKey) => string
  }): ReactNode {
  const request = useKnowledgeRequests()
  const browseId = useId()
  const [data, setData] = useState<KnowledgePage<KnowledgeDocument>>()
  const [materialFolderPage, setMaterialFolderPage] = useState<{ selection: string; value: KnowledgePage<KnowledgeFolder> }>()
  const [folderError, setFolderError] = useState<ProductFailureReport>()
  const [folderId, setFolderId] = useState<string | null | undefined>(null)
  const previousFolder = useRef<string | null>(null)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [format, setFormat] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [pagination, setPagination] = useState<{ selection: string; folderId: string | null | undefined; total: number; page: number }>()
  const [revision, setRevision] = useState(0)
  const [folderRevision, setFolderRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ProductFailureReport>()
  const [mutationError, setMutationError] = useState<ProductFailureReport>()
  const [pending, setPending] = useState(false)
  const [uploads, setUploads] = useState<readonly KnowledgeUploadPending[]>([])
  const [uploadsOpen, setUploadsOpen] = useState(false)
  const [uploadRecoveryReady, setUploadRecoveryReady] = useState(false)
  const [uploadRecoveryRevision, setUploadRecoveryRevision] = useState(0)
  const [accessDenied, setAccessDenied] = useState(false)
  const [reader, setReader] = useState<KnowledgeDocument>()
  const [readerView, setReaderView] = useState<'original' | 'parsed' | 'processing'>('original')
  const [contentSearchOpen, setContentSearchOpen] = useState(false)
  const [settledReaderCheck, setSettledReaderCheck] = useState<{ readonly id: string; readonly data: KnowledgePage<KnowledgeDocument> }>()
  const [editor, setEditor] = useState<KnowledgeEditorTarget>()
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [move, setMove] = useState<KnowledgeDocument>()
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [batch, setBatch] = useState<{ readonly action: KnowledgeBatchAction; readonly documents: readonly KnowledgeDocument[] }>()
  const [deleted, setDeleted] = useState<readonly string[]>([])
  const operation = useRef(new AbortController())
  const write = useRef<AbortSignal>()
  const accessOperation = useRef(new AbortController())
  const reindexOperations = useRef(new Map<string, string>())
  const cancelOperations = useRef(new Map<string, string>())
  const loadedPage = useRef<number>()
  const folderCache = useRef<{ key: string; value: KnowledgePage<KnowledgeFolder> }>()
  const main = useRef<HTMLElement>(null)
  const materialsHeading = useRef<HTMLHeadingElement>(null)
  const preserveReadFocus = useResultFocus(main, materialsHeading)
  const deleteDialog = useRef<HTMLElement | null>(null)
  const bindDeleteDialog = useCallback((node: HTMLParagraphElement | null) => {
    deleteDialog.current = node?.closest<HTMLElement>('[role="dialog"]') ?? null
  }, [])
  const preserveDeleteFocus = useResultFocus(deleteDialog, materialsHeading)
  const batchFocusArea = useRef<HTMLElement | null>(null)
  const preserveBatchFocus = useResultFocus(batchFocusArea, materialsHeading)
  const materialsScrollTop = useRef(0)
  const previousView = useRef<{ folderId: string | null | undefined; documentId: string | undefined; contentSearchOpen: boolean }>()
  useLayoutEffect(() => {
    const previous = previousView.current
    previousView.current = { folderId, documentId: reader?.id, contentSearchOpen }
    if (previous === undefined || accessDenied || previous.folderId === folderId && previous.documentId === reader?.id
      && previous.contentSearchOpen === contentSearchOpen) return
    const returning = reader === undefined && !contentSearchOpen && previous.folderId === folderId
      && (previous.documentId !== undefined || previous.contentSearchOpen)
    const destination = contentSearchOpen ? undefined : reader
      ? main.current?.querySelector<HTMLElement>('[data-knowledge-reader-back]')
      : previous.contentSearchOpen && returning
        ? main.current?.querySelector<HTMLElement>('[data-knowledge-content-search]')
        : previous.documentId !== undefined && returning
          ? [...main.current?.querySelectorAll<HTMLButtonElement>('[data-knowledge-document]') ?? []]
            .find(button => button.dataset.knowledgeDocument === previous.documentId)
          ?? main.current?.querySelector<HTMLElement>('[data-knowledge-materials-heading]')
          : main.current?.querySelector<HTMLElement>('[data-knowledge-materials-heading]')
    const area = main.current
    const focused = area?.ownerDocument.activeElement
    if (destination && (focused === area?.ownerDocument.body || !returning && area?.contains(focused ?? null))) {
      focusWithoutRing(destination, { preventScroll: returning })
    }
    if (main.current && (returning || reader !== undefined || contentSearchOpen)) {
      main.current.scrollTop = returning ? materialsScrollTop.current : 0
    }
  }, [folderId, reader?.id, contentSearchOpen, accessDenied])
  useEffect(() => {
    const controller = new AbortController()
    operation.current = controller
    write.current = undefined
    setPending(false)
    return () => {
      controller.abort(); accessOperation.current.abort()
    }
  }, [request, product.id])
  const denyAccess = useCallback(() => {
    accessOperation.current.abort()
    folderCache.current = undefined
    setContentSearchOpen(false); setAccessDenied(true); setData(undefined); setMaterialFolderPage(undefined)
    setReader(undefined); setLoading(false)
    setEditor(undefined); setConfirmation(undefined); setMove(undefined); setBatch(undefined)
    setUploadsOpen(false); setUploads([]); setSelectedIds(new Set())
  }, [])
  const readAccessDenied = useCallback((failure: unknown) => {
    setError({ failure, fallback: 'knowledgeReadFailed' }); denyAccess()
  }, [denyAccess])
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
      else setMutationError({ failure, fallback: 'knowledgeUploadRecoveryFailed' })
    })
    return () => { controller.abort() }
  }, [canManage, recoverUpload, readAccessDenied, uploadRecoveryRevision, refreshRevision])
  const canOpenExternal = globalThis.location.protocol === 'dsh-app:' && globalThis.location.hostname === 'app'
  // Refresh invalidates requests, while displayed rows remain scoped to their location and filters.
  const materialScopeKey = JSON.stringify([folderId === undefined ? 'all-materials' : folderId, search, format, status])
  const pageLayout = usePendingPageLayout(materialScopeKey, loading || error !== undefined || folderError !== undefined)
  const materialSelectionKey = JSON.stringify([folderId === undefined ? 'all-materials' : folderId, page, search, format, status])
  const displayedFolders = accessDenied || materialFolderPage?.selection !== materialSelectionKey ? undefined : materialFolderPage.value
  useEffect(() => { setFolderError(undefined); setError(undefined) }, [materialSelectionKey])
  useEffect(() => {
    if (!canManage) { setEditor(undefined); setConfirmation(undefined); setMove(undefined); setBatch(undefined); setUploadsOpen(false) }
  }, [canManage])
  useEffect(() => { setSelectedIds(new Set()) }, [folderId, page, search, format, status, refreshRevision])
  useEffect(() => {
    if (accessDenied) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, accessOperation.current.signal])
    setLoading(true)
    let failedFolders = false
    const folderKey = JSON.stringify([materialSelectionKey, folderRevision, refreshRevision])
    const cachedFolders = folderCache.current?.key === folderKey ? folderCache.current.value : undefined
    const folders: Promise<KnowledgePage<KnowledgeFolder>> = cachedFolders ? Promise.resolve(cachedFolders)
      : folderId === undefined || search || format || status
        ? Promise.resolve({ items: [], page, size: 20, total: 0 })
        : request('knowledge.folders.list', { knowledgeBaseId: product.id, parentId: folderId, page, size: 20 }, signal)
          .then((value) => {
            const result = knowledgePage(value, knowledgeFolder)
            if (result.page !== page || result.size !== 20
              || result.items.some(folder => folder.parentId !== folderId || folder.id === folderId)
              || new Set(result.items.map(folder => folder.id)).size !== result.items.length) {
              throw new ProductError('INVALID_SERVER_RESPONSE', 'Mismatched knowledge folder page')
            }
            return result
          }).catch((failure: unknown) => { failedFolders = true; throw failure })
    void readMaterialDocuments(request, { knowledgeBaseId: product.id,
      ...(folderId === undefined ? {} : { folderId }), ...(search ? { query: search } : {}),
      ...(format ? { format } : {}), ...(status ? { status } : {}),
    }, folders, page, signal).then(async (result) => {
      const folderPage = await folders
      if (signal.aborted) return
      preserveReadFocus()
      const total = result.total + folderPage.total
      setPagination({ selection: materialScopeKey, folderId, total, page })
      if (page > 1 && (page - 1) * 20 >= total) { setData(undefined); setPage(Math.max(1, Math.ceil(total / 20))); return }
      const previousPage = loadedPage.current
      loadedPage.current = result.page
      folderCache.current = { key: folderKey, value: folderPage }
      setMaterialFolderPage({ selection: materialSelectionKey, value: folderPage })
      setData(result)
      setFolderError(undefined); setError(undefined)
      setReader((current) => {
        if (current === undefined) return current
        const latest = result.items.find(row => row.id === current.id)
        // A filtered page can lose a readable file when its status changes.
        // Missing filtered rows require an independent authorization read.
        return latest === undefined && previousPage === result.page && !search && !format && !status ? undefined
          : latest?.status === 'DELETING' ? undefined : latest ?? current
      })
      setLoading(false)
    }).catch((failure: unknown) => {
      if (signal.aborted) return
      preserveReadFocus()
      setFolderError(failedFolders ? { failure, fallback: 'knowledgeFoldersFailed' } : undefined)
      setError(failedFolders ? undefined : { failure, fallback: 'knowledgeListFailed' })
      setLoading(false)
      if (isKnowledgeAccessDenied(failure)) denyAccess()
      controller.abort()
    })
    return () => { controller.abort() }
  }, [request, product.id, folderId, page, search, format, status, revision, folderRevision, refreshRevision,
    materialSelectionKey, materialScopeKey, accessDenied, denyAccess, preserveReadFocus])
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
      setError({ failure, fallback: 'knowledgeReadFailed' })
      if (isKnowledgeAccessDenied(failure)) denyAccess()
    }).finally(() => { if (!signal.aborted) setSettledReaderCheck({ id: filteredReaderId, data }) })
    return () => { controller.abort() }
  }, [request, product.id, filteredReaderId, data, accessDenied, denyAccess])
  useEffect(() => {
    if (loading || accessDenied || readerChecking) return
    if (!data?.items.some(row => ['QUEUED', 'PROCESSING', 'FINALIZING', 'DELETING'].includes(deleted.includes(row.id) ? 'DELETING' : row.status))
      && !(reader && ['QUEUED', 'PROCESSING', 'FINALIZING'].includes(reader.status))) return
    const timer = globalThis.setTimeout(() => { setRevision(value => value + 1) }, 3_000)
    return () => { globalThis.clearTimeout(timer) }
  }, [data, deleted, revision, loading, accessDenied, reader?.status, readerChecking])
  const mutate = async (method: string, payload: unknown, onCommitted: (receipt: unknown) => void): Promise<void> => {
    if (write.current !== undefined && !write.current.aborted) return
    const controller = operation.current
    const signal = AbortSignal.any([controller.signal, accessOperation.current.signal])
    write.current = signal
    setPending(true)
    try {
      const receipt = await request(method, payload, signal)
      if (!signal.aborted) {
        onCommitted(receipt); setMutationError(undefined); setRevision(value => value + 1)
        if (method.startsWith('knowledge.folders.')) setFolderRevision(value => value + 1)
      }
    } catch (failure) {
      if (signal.aborted) return
      if (isKnowledgeAccessDenied(failure)) readAccessDenied(failure)
      else setMutationError({ failure, fallback: 'knowledgeChangeFailed' })
    }
    finally { if (write.current === signal) { write.current = undefined; if (!controller.signal.aborted) setPending(false) } }
  }
  const upload = async (pdfParseMode: KnowledgePdfParseMode, destination = folderId): Promise<void> => {
    if (write.current !== undefined && !write.current.aborted) return
    if (!uploadRecoveryReady) { setMutationError({ failure: undefined, fallback: 'knowledgeUploadRecoveryFailed' }); return }
    if (uploads.length > 0) { setUploadsOpen(true); return }
    const controller = operation.current
    const signal = AbortSignal.any([controller.signal, accessOperation.current.signal])
    write.current = signal
    setPending(true)
    try {
      const value = await request('knowledge.documents.upload.select', { knowledgeBaseId: product.id, pdfParseMode,
        ...(destination === undefined ? {} : { folderId: destination }) }, signal)
      signal.throwIfAborted()
      const selected = uploadSelections(value)
      setMutationError(undefined)
      setUploads(selected); setUploadsOpen(selected.length > 0)
    } catch (failure) {
      if (!signal.aborted) {
        if (isKnowledgeAccessDenied(failure)) readAccessDenied(failure)
        else {
          setMutationError({ failure, fallback: 'knowledgeUploadFailed' })
          setUploadRecoveryReady(false); setUploadRecoveryRevision(value => value + 1)
        }
      }
    } finally { if (write.current === signal) { write.current = undefined; if (!controller.signal.aborted) setPending(false) } }
  }
  const selectFolder = (value: string | null | undefined) => {
    if (value !== undefined) previousFolder.current = value
    else if (folderId !== undefined) previousFolder.current = folderId
    setReader(undefined); setContentSearchOpen(false)
    if (value !== folderId || page !== 1) { setFolderId(value); setPage(1); setData(undefined) }
    if (value !== folderId) { setQuery(''); setSearch(''); setFormat(''); setStatus('') }
  }
  const closeConfirmation = () => {
    if (write.current !== undefined && !write.current.aborted) return
    setConfirmation(undefined); setMutationError(undefined)
  }
  const beginMutation = () => { setMutationError(undefined) }
  const clearFilters = () => {
    setQuery(''); setSearch(''); setFormat(''); setStatus(''); setPage(1); setData(undefined)
    const heading = main.current?.querySelector<HTMLElement>('[data-knowledge-materials-heading]')
    if (heading) focusWithoutRing(heading)
  }
  const openReader = (row: KnowledgeDocument) => {
    if (accessDenied) return
    if (reader === undefined) materialsScrollTop.current = main.current?.scrollTop ?? 0
    setReader(row); setReaderView('original')
  }
  const materialTotal = !accessDenied && pagination?.selection === materialScopeKey ? pagination.total : 0
  const emptyMaterials = !accessDenied && !folderError && !error && !query && !search && !format && !status
    && page === 1 && availableData?.total === 0 && displayedFolders?.total === 0
  const filteredEmpty = availableData?.items.length === 0 && displayedFolders?.total === 0 && Boolean(search || format || status)
  const showToolbar = !accessDenied
  const initialLoading = !accessDenied && !folderError && !error && loading && availableData === undefined
    && (pagination === undefined || pagination.folderId !== folderId)
  const pages = Math.max(1, Math.ceil(materialTotal / 20))
  const currentFolder = reader ? undefined : location.trail?.at(-1)
  const atLibraryRoot = folderId == null
  const materialTitle = atLibraryRoot ? product.name : currentFolder?.name
    ?? materialFolderPage?.value.items.find(folder => folder.id === folderId)?.name ?? t('knowledgeFolderType')
  const changingPage = loading && pageLayout.style !== undefined
  const canAdd = (availableData !== undefined || changingPage) && location.trail !== undefined && location.failure === undefined
  const breadcrumbTrail = location.trail ?? []
  const childFolders = displayedFolders?.items ?? []
  const showSelection = canManage && (availableData?.items.length ?? 0) > 0
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
    if (!pending && selectedDocuments.length > 0) { beginMutation(); setBatch({ action, documents: selectedDocuments }) }
  }
  const documentAction = (id: string, row: KnowledgeDocument) => {
    if (id === 'read' || id === 'processing' || id === 'parsed') { openReader(row); setReaderView(id === 'read' ? 'original' : id) }
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
    if (write.current !== undefined && !write.current.aborted) return
    const controller = operation.current
    const signal = AbortSignal.any([controller.signal, accessOperation.current.signal])
    write.current = signal
    setPending(true)
    try {
      await request(`knowledge.documents.${action}`, { knowledgeBaseId: product.id, documentId: row.id }, signal)
      if (!signal.aborted) setMutationError(undefined)
    } catch (failure) {
      if (!signal.aborted) {
        setMutationError({ failure, fallback: action === 'download' ? 'knowledgeDownloadFailed' : 'knowledgeOpenExternalFailed' })
        if (isKnowledgeAccessDenied(failure)) denyAccess()
      }
    } finally { if (write.current === signal) { write.current = undefined; if (!controller.signal.aborted) setPending(false) } }
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
    setReader(undefined)
  }}>
    <label className={css.searchField}><IconSearchOutlineRegular size={16} /><span className={css.visuallyHidden}>{t('knowledgeFindFiles')}</span>
      <input type="search" value={query} maxLength={120} placeholder={t(folderId === undefined ? 'knowledgeSearchLibrary' : 'knowledgeSearchFolder')}
        onChange={(event) => { setQuery(event.currentTarget.value) }} /></label>
    <Button variant="outline" size="sm" type="submit">{t('search')}</Button>
  </form>
  const addActions = canManage && <KnowledgeAddMenu disabled={!canAdd} pending={pending || changingPage}
    uploadDisabled={!uploadRecoveryReady || uploads.length > 0}
    onUpload={() => { void upload('STANDARD') }} onSelect={(kind) => {
      beginMutation(); setEditor(kind === 'folder' ? { kind, parentId: folderId ?? null } : { kind, folderId: folderId ?? null })
    }} t={t} />
  const refreshMaterials = () => {
    if (loading || pending) return
    accessOperation.current.abort(); accessOperation.current = new AbortController()
    setAccessDenied(false); setRevision(value => value === revision ? value + 1 : value)
    setFolderRevision(value => value === folderRevision ? value + 1 : value)
    setUploadRecoveryRevision(value => value === uploadRecoveryRevision ? value + 1 : value)
  }
  const refreshAction = <Tooltip label={t('refresh')} side="bottom" align="end" gap={2} portal delayMs={350} disabled={loading || pending}>
    <button type="button" className={`${css.iconButton}${loading || pending ? ' product-control-pending' : ''}`} aria-disabled={loading || pending}
      aria-label={t('refresh')} aria-busy={loading} onClick={refreshMaterials}>
      <IconRefreshOutlineRegular size={16} />
      {loading && availableData !== undefined && <span className={css.visuallyHidden} role="status" aria-label={t('loading')} />}
    </button></Tooltip>
  const failure = folderError ?? error ?? (confirmation || move ? undefined : mutationError)
  const mutationMessage = mutationError === undefined ? '' : productErrorMessage(mutationError.failure, t, mutationError.fallback)
  const feedback = failure && <div role="alert" className={css.knowledgeDirectoryError}>
    <p>{productErrorMessage(failure.failure, t, failure.fallback)}</p>
    {(folderError || error) && <Button variant="outline" size="sm" aria-disabled={loading || pending} aria-busy={loading}
      className={loading || pending ? 'product-control-pending' : undefined} onClick={refreshMaterials}>{t('retry')}</Button>}
    {accessDenied && onBack && <Button variant="ghost" size="sm" onClick={onBack}>{t('knowledgeBackToLibraries')}</Button>}
  </div>
  const toolbar = <>
    {(atLibraryRoot || !emptyMaterials && (!initialLoading || query || search || format || status)) && <div
      className={css.knowledgeMaterialsToolbar}
      data-empty={emptyMaterials || initialLoading}>
      {atLibraryRoot && <SegmentedControl className={css.knowledgeBrowseControl} id={browseId} value={folderId === undefined ? 'all' : 'folders'}
        options={[{ value: 'folders', label: t('knowledgeFolderView') }, { value: 'all', label: t('knowledgeAllMaterials') }]}
        onChange={(value) => { selectFolder(value === 'all' ? undefined : previousFolder.current) }} label={t('knowledgeBrowseMode')} />}
      {!emptyMaterials && (!initialLoading || query || search || format || status) && <>{materialSearch}
        <div className={css.knowledgeFilters}>
          <label><span className={css.visuallyHidden}>{t('knowledgeFormat')}</span><select aria-label={t('knowledgeFormat')} value={format}
            onChange={(event) => { setFormat(event.currentTarget.value); setPage(1); setData(undefined) }}>
            <option value="">{t('knowledgeAllFormats')}</option><option value="manual">{t('knowledgeOnlineDocument')}</option>
            <option value="url">{t('knowledgeWebsite')}</option>{['pdf', 'docx', 'xlsx', 'md', 'txt'].map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}
          </select></label>
          <label><span className={css.visuallyHidden}>{t('status')}</span><select aria-label={t('status')} value={status}
            onChange={(event) => { setStatus(event.currentTarget.value); setPage(1); setData(undefined) }}>
            <option value="">{t('knowledgeAllStatuses')}</option>{['READY', 'QUEUED', 'PROCESSING', 'FINALIZING', 'FAILED', 'CANCELLED', 'DELETING']
              .map(value => <option key={value} value={value}>{knowledgeStatus(value, t)}</option>)}
          </select></label>
          {(search || format || status) && !filteredEmpty && <Button variant="ghost" size="sm" className={css.knowledgeClearFilters}
            onClick={clearFilters}>{t('knowledgeClearFilters')}</Button>}
        </div></>}
    </div>}
    {canManage && selectedDocuments.length > 0 && <div className={css.knowledgeBatchToolbar} role="group" aria-label={t('knowledgeBatchActions')}>
      <span role="status">{t('knowledgeSelectedCount').replace('{count}', String(selectedDocuments.length))}</span>
      <Button variant="ghost" size="sm" className={pending ? 'product-control-pending' : undefined} disabled={pending} onClick={() => { beginBatch('move') }}>{t('knowledgeBatchMove')}</Button>
      <Tooltip label={t(canReindexSelection ? 'knowledgeReindex' : 'knowledgeBatchProcessingHint')} side="bottom" portal delayMs={350}>
        <Button variant="ghost" size="sm" className={pending && canReindexSelection ? 'product-control-pending' : undefined} disabled={pending || !canReindexSelection} onClick={() => { beginBatch('reindex') }}>{t('knowledgeBatchReindex')}</Button>
      </Tooltip>
      <Button variant="ghost" size="sm" className={pending ? 'product-control-pending' : undefined} disabled={pending} onClick={() => { beginBatch('delete') }}>{t('knowledgeBatchDelete')}</Button>
      <Button variant="ghost" size="sm" className={pending ? 'product-control-pending' : undefined} disabled={pending} onClick={() => { setSelectedIds(new Set()) }}>{t('knowledgeClearSelection')}</Button>
    </div>}
  </>
  const uploadRecovery = canManage && uploads.length > 0 && <div className={css.knowledgeAddActions}>
    <span role="status">{t('knowledgeUploadsPending').replace('{count}', String(uploads.length))}</span>
    <Button variant="outline" size="sm" className={pending ? 'product-control-pending' : undefined} disabled={pending} onClick={() => { setUploadsOpen(true) }}>{t('knowledgeUploadViewQueue')}</Button>
  </div>
  const materials = <section className={css.knowledgeMaterialsRegion}
    data-compact-state={!atLibraryRoot && (emptyMaterials || initialLoading)}
    role={showToolbar && atLibraryRoot ? 'tabpanel' : 'region'} id={`${browseId}-${folderId === undefined ? 'all' : 'folders'}-panel`}
    aria-label={showToolbar && atLibraryRoot ? undefined : materialTitle}
    aria-labelledby={showToolbar && atLibraryRoot ? `${browseId}-${folderId === undefined ? 'all' : 'folders'}` : undefined}>
    {feedback}
    {uploadRecovery}
    <div ref={pageLayout.area} style={pageLayout.style} className={css.knowledgeTableScroll} aria-busy={loading}>
      {(childFolders.length > 0 || (availableData?.items.length ?? 0) > 0) && <table className={css.knowledgeTable}>
        <thead><tr><th><div className={css.knowledgeSelectableName}>
          {showSelection && <input type="checkbox" aria-label={t('knowledgeSelectPage')} checked={allSelected} disabled={pending || selectableDocuments.length === 0}
            ref={(node) => { if (node) node.indeterminate = selectedDocuments.length > 0 && !allSelected }}
            onChange={(event) => { setSelectedIds(new Set(event.currentTarget.checked ? selectableDocuments.map(row => row.id) : [])) }} />}
          {t('knowledgeDocumentTitle')}</div></th><th>{t('status')}</th><th>{t('knowledgeFormat')}</th>
        <th>{t('knowledgeSize')}</th><th>{t('updatedAt')}</th>
        <th><span className={css.visuallyHidden}>{t('resourceActions')}</span></th></tr></thead>
        <tbody>{childFolders.map(folder => <tr key={`folder:${folder.id}`} data-knowledge-child-folder={folder.id}>
          <td><div className={css.knowledgeSelectableName} data-selectable={showSelection}>
            <button type="button" className={css.knowledgeDocumentName} onClick={() => { selectFolder(folder.id) }}>
              <IconFolderOpenOutlineRegular size={18} /><span>{folder.name}</span></button></div></td>
          <td>—</td><td>{t('knowledgeFolderType')}</td><td>—</td><td>{formatDate(folder.updatedAt)}</td>
          <td>{canManage && <KnowledgeFolderActions folder={folder} disabled={false} pending={pending}
            onSelect={(id) => { folderAction(id, folder) }} t={t} />}</td>
        </tr>)}{availableData?.items.map((row) => {
          const deleting = deleted.includes(row.id) || row.status === 'DELETING'
          return <tr key={row.id}>
            <td><div className={css.knowledgeSelectableName}>
              {canManage && <input type="checkbox" aria-label={t('knowledgeSelectDocument').replace('{name}', row.filename)}
                checked={selectedIds.has(row.id) && !deleting} disabled={pending || deleting}
                onChange={(event) => { selectDocument(row.id, event.currentTarget.checked) }} />}
              <button type="button" className={css.knowledgeDocumentName} data-knowledge-document={row.id} disabled={deleting} onClick={() => { openReader(row) }}>
                <FileTypeIcon path={row.filename} size={18} /><span>{row.filename}</span></button></div></td>
            <td><KnowledgeDocumentStatus status={deleting ? 'DELETING' : row.status} sourceType={row.sourceType} t={t} /></td>
            <td>{row.sourceType === 'manual' ? t('knowledgeOnlineDocument') : row.sourceType === 'url' ? t('knowledgeWebsite') : row.filename.split('.').at(-1)?.toUpperCase()}</td>
            <td>{fileSizeText(row.sizeBytes)}</td><td>{formatDate(row.updatedAt)}</td>
            <td><KnowledgeDocumentActions document={row} disabled={deleting} pending={pending}
              canManage={canManage} canOpenExternal={canOpenExternal}
              onSelect={(id) => { documentAction(id, row) }} t={t} /></td>
          </tr>
        })}</tbody>
      </table>}
      {initialLoading && <div className={css.knowledgeMaterialsLoading} role="status" aria-label={t('knowledgeLoadingMaterials')}>
        <div className={css.knowledgeLoadingHeading}><span>{t('knowledgeLoadingMaterials')}</span></div>
        <div className={css.knowledgeLoadingRows} aria-hidden="true">
          {[0, 1, 2].map(row => <div key={row}><span /><span /></div>)}
        </div>
      </div>}
      {!folderError && !error && availableData?.items.length === 0 && displayedFolders?.total === 0
        && <div className={css.knowledgeMaterialsEmpty} data-knowledge-empty={emptyMaterials ? 'materials' : 'filtered'}>
          <IconFolderOpenOutlineRegular size={30} /><strong>{t(search || format || status ? 'noSearchResults'
            : atLibraryRoot ? 'knowledgeNoMaterials' : 'knowledgeEmptyFolder')}</strong>
          <span>{t(search || format || status ? 'knowledgeFilterEmptyHint'
            : canManage ? 'knowledgeEmptyManageHint' : 'knowledgeEmptyReadHint')}</span>
          {!emptyMaterials && (search || format || status) && <Button variant="outline" size="sm" onClick={clearFilters}>{t('knowledgeClearFilters')}</Button>}
        </div>}
    </div>
    {!accessDenied && pagination?.selection === materialScopeKey && (page > 1 || materialTotal > 0)
      && <div className={css.knowledgePagination} aria-busy={loading}>
        <span>{t('itemCount').replace('{count}', String(materialTotal))}</span>
        <div>
          <Button variant="ghost" size="sm" className={loading && pagination.page > 1 ? 'product-control-pending' : undefined} aria-disabled={loading || page <= 1} aria-label={t('previousPage')} onClick={() => {
            if (loading || page <= 1) return
            pageLayout.reserve()
            setLoading(true); setPage(current => current === page ? page - 1 : current); setData(undefined)
          }}><IconChevronLeftOutlineRegular size={16} /></Button>
          <span>{t('knowledgePageCount').replace('{page}', String(page)).replace('{pages}', String(pages))}</span>
          <Button variant="ghost" size="sm" className={loading && pagination.page < pages ? 'product-control-pending' : undefined} aria-disabled={loading || page >= pages} aria-label={t('nextPage')} onClick={() => {
            if (loading || page >= pages) return
            pageLayout.reserve()
            setLoading(true); setPage(current => current === page ? page + 1 : current); setData(undefined)
          }}><IconChevronRightOutlineRegular size={16} /></Button>
        </div>
      </div>}
  </section>
  const documentReader = reader && <KnowledgeDocumentReader key={reader.id} knowledgeBaseId={product.id} documentId={reader.id}
    title={reader.filename} inline refreshRevision={refreshRevision}
    renderFactorySlot={renderFactorySlot} onAccessDenied={readAccessDenied} onClose={() => { setReader(undefined) }} t={t} />
  const readerStatusHint = reader && knowledgeStatusHint(reader.status, reader.sourceType, t)
  return <>
    <div className={css.knowledgeWorkspace} data-knowledge-workspace-content>
      <main ref={main} className={css.knowledgeWorkspaceMain} data-knowledge-content>
        <div className={css.knowledgeWorkspaceBody}>
          <header className={css.knowledgeWorkspaceDocumentHeader}>
            <nav className={css.knowledgeWorkspaceBreadcrumb} aria-label={t('knowledgeLocation')}>
              {onBack && <button type="button" className={css.knowledgeDirectoryBack} onClick={onBack}>
                <IconChevronLeftOutlineRegular size={14} />{t('knowledge')}
              </button>}
              {(reader || folderId !== null) && <>
                {onBack && <IconChevronRightOutlineRegular size={14} />}
                <button type="button" onClick={() => { selectFolder(null) }}>{product.name}</button>
              </>}
              {location.loading && location.trail === undefined && <ProductLoading label={t('loading')} />}
              {location.failure !== undefined && <span role="alert" className={css.catalogError}>{productErrorMessage(location.failure, t, 'knowledgeFoldersFailed')}</span>}
              {breadcrumbTrail.filter(folder => reader || folder.id !== folderId).map(folder => <span key={folder.id}
                className={css.knowledgeBreadcrumbPart}>
                <IconChevronRightOutlineRegular size={14} /><button type="button" aria-current={!reader && folder.id === folderId ? 'page' : undefined}
                  onClick={() => { selectFolder(folder.id) }}>{folder.name}</button></span>)}
            </nav>
          </header>
          {directoryError !== undefined && <div role="alert" className={css.catalogError}>
            <p>{directoryError}</p><Button variant="outline" size="sm" aria-disabled={directoryLoading} aria-busy={directoryLoading}
              className={directoryLoading ? 'product-control-pending' : undefined}
              onClick={() => { if (!directoryLoading) onRefreshDirectory?.() }}>{t('retry')}</Button>
          </div>}
          <div hidden={reader !== undefined}><div className={css.knowledgeMaterialsHeading}>
            <div className={css.knowledgeMaterialsTitle}>
              <div><h1 ref={materialsHeading} tabIndex={-1} aria-current="page" data-knowledge-materials-heading>{contentSearchOpen ? product.name : materialTitle}</h1>
                {!contentSearchOpen && !atLibraryRoot && <Button variant="ghost" size="sm" onClick={() => { selectFolder(undefined) }}>{t('knowledgeAllMaterials')}</Button>}
                {atLibraryRoot && product.scope !== undefined && <span className={css.knowledgeMaterialsScope}>
                  {knowledgeScopeLabel(product.scope, t)}</span>}
              </div>
              {atLibraryRoot && product.summary && <p>{product.summary}</p>}
            </div><div className={css.knowledgeHeaderActions}>
              <div hidden={contentSearchOpen}><div className={css.knowledgeHeaderActions}>
                <Button variant="outline" size="sm" disabled={accessDenied} data-knowledge-content-search
                  onClick={() => { materialsScrollTop.current = main.current?.scrollTop ?? 0; setContentSearchOpen(true) }}>
                  <IconSearchOutlineRegular size={16} />{t('knowledgeContentSearch')}</Button>{addActions}{refreshAction}
              </div></div>
              {currentFolder && canManage ? <KnowledgeFolderActions folder={currentFolder} disabled={false} pending={pending} current
                onSelect={(id) => { folderAction(id, currentFolder) }} t={t} />
                : atLibraryRoot && canManage && (onEditLibrary || onDeleteLibrary) && <KnowledgeLibraryActions name={product.name}
                  disabled={deletePending} onEdit={onEditLibrary} onDelete={onDeleteLibrary} t={t} />}
            </div>
          </div></div>
          {reader ? <>{feedback}
            <div className={css.knowledgeMaterialsHeading}>
              <div className={css.knowledgeMaterialsTitle}>
                <div><FileTypeIcon path={reader.filename} size={22} /><h1>{reader.filename}</h1></div>
                <div className={css.knowledgeReaderProcessing} role="status">
                  <KnowledgeDocumentStatus status={reader.status} sourceType={reader.sourceType} t={t} />
                  {readerStatusHint && <span>{readerStatusHint}</span>}</div>
              </div>
              <div className={css.knowledgeHeaderActions}>
                <Button variant="ghost" size="sm" data-knowledge-reader-back onClick={() => { setReader(undefined) }}><IconChevronLeftOutlineRegular size={16} />{t('knowledgeBackToFolder')}</Button>
                {canManage && reader.sourceType === 'manual' && !['QUEUED', 'PROCESSING', 'FINALIZING'].includes(reader.status)
                  && <Button variant="outline" size="sm" className={pending ? 'product-control-pending' : undefined} disabled={pending} onClick={() => { documentAction('edit', reader) }}><IconEditOutlineRegular size={14} />{t('modifyResource')}</Button>}
                <KnowledgeDocumentActions document={reader} disabled={deleted.includes(reader.id) || accessDenied} pending={pending}
                  canManage={canManage} canOpenExternal={canOpenExternal} onSelect={(id) => { documentAction(id, reader) }} t={t} />
              </div>
            </div>
            <SegmentedControl className={css.knowledgeReaderTabs} id={`${browseId}-reader`} value={readerView} label={t('knowledgeReaderView')}
              options={[{ value: 'original', label: t('knowledgeOriginalFile') }, { value: 'parsed', label: t('knowledgeParsedContent') },
                { value: 'processing', label: t('knowledgeProcessingDetails') }]}
              onChange={(value) => { setReaderView(value) }} />
            <div role="tabpanel" id={`${browseId}-reader-${readerView}-panel`} aria-labelledby={`${browseId}-reader-${readerView}`}>
              {uploadRecovery}{readerView === 'processing' ? <KnowledgeProcessingDetails key={reader.id}
                knowledgeBaseId={product.id} documentId={reader.id} canManage={canManage} refreshRevision={refreshRevision}
                onAccessDenied={readAccessDenied} t={t} /> : readerView === 'parsed' ? <KnowledgeParsedContent key={reader.id}
                knowledgeBaseId={product.id} documentId={reader.id} ready={reader.status === 'READY'} refreshRevision={refreshRevision}
                onAccessDenied={readAccessDenied} t={t} /> : documentReader}</div></>
            : contentSearchOpen && !accessDenied ? <KnowledgeContentSearch knowledgeBaseId={product.id} refreshRevision={refreshRevision}
              onBack={() => { setContentSearchOpen(false) }} onAccessDenied={readAccessDenied}
              renderFactorySlot={renderFactorySlot} t={t} /> : null}
          <div hidden={reader !== undefined || contentSearchOpen}>{!accessDenied && toolbar}{materials}</div>
        </div>
      </main>
    </div>
    {editor && <KnowledgeEditor knowledgeBaseId={product.id} libraryName={product.name} target={editor}
      onClose={() => { setEditor(undefined) }}
      onSaved={(folder) => {
        if (folder && editor.kind === 'folder' && !editor.folder) {
          setFolderId(folder.id)
          setQuery(''); setSearch(''); setFormat(''); setStatus(''); setData(undefined)
        }
        if (editor.kind === 'folder') setFolderRevision(value => value + 1)
        setEditor(undefined); setReader(undefined); setPage(1); setRevision(value => value + 1)
      }} t={t} />}
    {confirmation && <Modal open title={t(confirmation.kind === 'document' ? 'knowledgeDeleteDocument' : 'knowledgeDeleteFolder')}
      closeLabel={t('close')} onClose={closeConfirmation} footer={<>
        <Button variant="ghost" size="sm" className={pending ? 'product-control-pending' : undefined} aria-disabled={pending} onClick={closeConfirmation}>{t('cancel')}</Button>
        <Button variant="primary" className={`${css.knowledgeDanger}${pending ? ' product-control-pending' : ''}`} size="sm" aria-disabled={pending} aria-busy={pending} onClick={() => {
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
              preserveDeleteFocus()
              setConfirmation(undefined); setDeleted(value => [...value, id]); setReader(value => value?.id === id ? undefined : value)
            })
          }
        }}>{t(pending ? 'deletingResource' : 'deleteResource')}</Button>
      </>}>
      <p ref={bindDeleteDialog} className={css.knowledgeConfirmation}>{t(confirmation.kind === 'document' ? 'knowledgeDeleteDocumentConfirmation' : 'knowledgeDeleteFolderConfirmation')
        .replace('{name}', confirmation.kind === 'document' ? confirmation.document.filename : confirmation.folder.name)}</p>
      {mutationMessage && <p role="alert" className={css.catalogError}>{mutationMessage}</p>}
    </Modal>}
    {move && <KnowledgeMoveDialog knowledgeBaseId={product.id} document={move} pending={pending} error={mutationMessage}
      onClose={() => {
        if (write.current !== undefined && !write.current.aborted) return
        setMove(undefined); setMutationError(undefined)
      }}
      onMove={(selection) => { void mutate('knowledge.documents.move', { knowledgeBaseId: product.id, documentId: move.id, ...selection }, (receipt) => {
        confirmKnowledgeDocumentMutation('move', receipt, { knowledgeBaseId: product.id, documentId: move.id, folderId: selection.folderId })
        setMove(undefined); setReader(undefined)
      }) }} t={t} />}
    {uploadsOpen && canManage && <KnowledgeUploadDialog knowledgeBaseId={product.id} libraryName={product.name} selections={uploads}
      onBusyChange={setPending} onAccepted={() => { setRevision(value => value + 1) }}
      onDenied={(failure) => {
        if (isKnowledgeAccessDenied(failure)) readAccessDenied(failure)
        else { setUploadsOpen(false); setMutationError({ failure, fallback: 'knowledgeChangeFailed' }) }
      }}
      onClose={() => {
        setUploadsOpen(false); setUploadRecoveryReady(false); setUploadRecoveryRevision(value => value + 1)
      }} t={t} />}
    {batch && <KnowledgeBatchDialog knowledgeBaseId={product.id} action={batch.action} documents={batch.documents}
      onBusyChange={setPending} onAccessDenied={readAccessDenied}
      onAccepted={(document, action) => {
        if (action === 'delete') setDeleted(previous => [...previous, document.id])
        setReader(current => current?.id === document.id ? undefined : current)
      }} onClose={(submitted) => {
        if (submitted) {
          // Native dialog return and selection removal can displace focus anywhere on the page.
          batchFocusArea.current = main.current?.ownerDocument.body ?? null
          preserveBatchFocus()
        }
        setBatch(undefined)
        if (submitted) { setSelectedIds(new Set()); setRevision(value => value + 1) }
      }} t={t} />}
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
  const attempt = useRef<MoveSelection>()
  return <Modal open title={t('knowledgeMoveDocument')} closeLabel={t('close')} onClose={onClose} footer={<>
    <Button variant="ghost" size="sm" aria-disabled={pending} className={pending ? 'product-control-pending' : undefined} onClick={onClose}>{t('cancel')}</Button>
    <Button variant="primary" size="sm" disabled={!ready} aria-disabled={pending || !ready} aria-busy={pending}
      className={pending && ready ? 'product-control-pending' : undefined} onClick={() => {
        if (pending || !ready) return
        const selection = attempt.current ??= { folderId: destination || null, expectedFolderId: document.folderId ?? null,
          expectedUpdatedAt: document.updatedAt, operationId: globalThis.crypto.randomUUID() }
        onMove(selection)
      }}>{t('knowledgeMove')}</Button>
  </>}><KnowledgeFolderPicker knowledgeBaseId={knowledgeBaseId} label={t('knowledgeDestinationFolder')} value={destination || null}
      disabled={attempt.current !== undefined} pending={pending} onReady={setReady} onChange={(id) => {
        if (attempt.current !== undefined) return
        setDestination(id ?? ''); setReady(false)
      }} t={t} />
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
