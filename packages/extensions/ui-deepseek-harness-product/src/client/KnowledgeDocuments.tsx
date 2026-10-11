/** Paginated library materials and manager actions, independent of task selection. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, FileTypeIcon, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconDownloadOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular, IconFolderOpenOutlineRegular, IconLinkOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, IconTrashOutlineRegular, Menu, Modal, Tooltip, fileSizeText, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { KnowledgePdfParseMode } from '@deepseek-harness/product/protocol'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { formatDate, type ProductDetail } from './catalog-shared.tsx'
import { isKnowledgeAccessDenied, knowledgeDocument, knowledgeFolder, knowledgePage, useKnowledgeRequests, type KnowledgeDocument, type KnowledgeFolder, type KnowledgePage } from './knowledge-data.ts'
import { KnowledgeDocumentReader } from './KnowledgeDocumentReader.tsx'
import { KnowledgeEditor, type KnowledgeEditorTarget } from './KnowledgeEditor.tsx'
import { productErrorMessage } from './product-errors.ts'

type Confirmation = { readonly kind: 'document'; readonly document: KnowledgeDocument; readonly operationId: string }
  | { readonly kind: 'folder'; readonly folder: KnowledgeFolder }

/** Display authorized documents with server-side filters and paginated results.
 * @param props Library permissions, labels, optional workspace navigation, and selection callback.
 * @returns Materials table and manager actions, with inline reading when navigation is supplied.
 */
export function KnowledgeDocuments({
  product, renderNavigation, onNavigate, refreshRevision = 0, renderFactorySlot, t,
}: PropsRenderFactories & {
  readonly product: ProductDetail
  readonly renderNavigation?: (children: ReactNode) => ReactNode
  readonly onNavigate?: () => void
  readonly refreshRevision?: number
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  return <KnowledgeDocumentsScope key={product.id} product={product} renderNavigation={renderNavigation}
    onNavigate={onNavigate} refreshRevision={refreshRevision} renderFactorySlot={renderFactorySlot} t={t} />
}

function KnowledgeDocumentsScope({ product, renderNavigation, onNavigate, refreshRevision, renderFactorySlot, t }: PropsRenderFactories & {
  readonly product: ProductDetail
  readonly renderNavigation: ((children: ReactNode) => ReactNode) | undefined
  readonly onNavigate: (() => void) | undefined
  readonly refreshRevision: number
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const [data, setData] = useState<KnowledgePage<KnowledgeDocument>>()
  const [folders, setFolders] = useState<readonly KnowledgeFolder[]>([])
  const [folderId, setFolderId] = useState<string | null>()
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [format, setFormat] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [folderError, setFolderError] = useState('')
  const [mutationError, setMutationError] = useState('')
  const [pending, setPending] = useState(false)
  const [accessDenied, setAccessDenied] = useState(false)
  const [reader, setReader] = useState<KnowledgeDocument>()
  const [editor, setEditor] = useState<KnowledgeEditorTarget>()
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [move, setMove] = useState<KnowledgeDocument>()
  const [deleted, setDeleted] = useState<readonly string[]>([])
  const operation = useRef(new AbortController())
  const accessOperation = useRef(new AbortController())
  const reindexOperations = useRef(new Map<string, string>())
  const loadedPage = useRef<number>()
  useEffect(() => {
    const controller = new AbortController()
    operation.current = controller
    return () => { controller.abort(); accessOperation.current.abort() }
  }, [])
  const denyAccess = useCallback(() => {
    accessOperation.current.abort()
    setAccessDenied(true); setData(undefined); setFolders([]); setReader(undefined); setLoading(false)
    setEditor(undefined); setConfirmation(undefined); setMove(undefined)
  }, [])
  const readAccessDenied = useCallback((failure: unknown) => {
    setError(productErrorMessage(failure, t, 'knowledgeReadFailed')); denyAccess()
  }, [denyAccess, t])
  useEffect(() => {
    accessOperation.current.abort(); accessOperation.current = new AbortController()
    setData(undefined); setFolders([]); setAccessDenied(false)
  }, [refreshRevision])
  const availableData = accessDenied ? undefined : data
  const availableFolders = accessDenied ? [] : folders
  const canManage = product.canManage === true && !accessDenied
  const canOpenExternal = globalThis.location.protocol === 'dsh-app:' && globalThis.location.hostname === 'app'
  useEffect(() => {
    if (!canManage) { setEditor(undefined); setConfirmation(undefined); setMove(undefined) }
  }, [canManage])
  useEffect(() => {
    if (accessDenied) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, accessOperation.current.signal])
    setLoading(true); setError('')
    void request('knowledge.documents.list', { knowledgeBaseId: product.id, page, size: 20,
      ...(folderId === undefined ? {} : { folderId }), ...(search ? { query: search } : {}),
      ...(format ? { format } : {}), ...(status ? { status } : {}),
    }, signal).then((value) => {
      if (signal.aborted) return
      const result = knowledgePage(value, knowledgeDocument)
      if (page > 1 && result.items.length === 0) { setPage(Math.max(1, Math.ceil(result.total / 20))); return }
      const previousPage = loadedPage.current
      loadedPage.current = result.page
      setData(result)
      setReader((current) => {
        if (current === undefined) return current
        const latest = result.items.find(row => row.id === current.id)
        // Pagination can legitimately move the reader's row off the current
        // page. Only close it when a refresh of the same page no longer
        // authorizes the document, avoiding stale content after revocation or
        // deletion while preserving the reader during page navigation.
        return latest === undefined && previousPage === result.page ? undefined
          : latest?.status === 'DELETING' ? undefined : latest ?? current
      })
    }).catch((failure: unknown) => {
      if (signal.aborted) return
      setError(productErrorMessage(failure, t, 'knowledgeListFailed'))
      if (isKnowledgeAccessDenied(failure)) denyAccess()
    })
      .finally(() => { if (!signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [request, product.id, folderId, page, search, format, status, revision, refreshRevision, accessDenied, denyAccess, t])
  useEffect(() => {
    if (accessDenied) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, accessOperation.current.signal])
    setFolderError('')
    void (async () => {
      const values: KnowledgeFolder[] = []
      let next = 1
      let total = 1
      while (values.length < total) {
        const result = knowledgePage(await request('knowledge.folders.list', { knowledgeBaseId: product.id, page: next, size: 100 }, signal), knowledgeFolder)
        values.push(...result.items); total = result.total; next += 1
        if (result.items.length === 0) break
      }
      return values
    })().then((value) => {
      if (signal.aborted) return
      setFolders(value)
      // Folder deletion or a permission refresh can invalidate the selected
      // stable ID. Fall back to the library root rather than showing an empty
      // view for a folder that no longer exists.
      if (typeof folderId === 'string' && !value.some(folder => folder.id === folderId)) {
        setFolderId(undefined); setPage(1); setData(undefined); setReader(undefined)
      }
    })
      .catch((failure: unknown) => {
        if (signal.aborted) return
        setFolderError(productErrorMessage(failure, t, 'knowledgeFoldersFailed'))
        if (isKnowledgeAccessDenied(failure)) denyAccess()
      })
    return () => { controller.abort() }
  }, [request, product.id, folderId, revision, refreshRevision, accessDenied, denyAccess, t])
  useEffect(() => {
    if (loading || accessDenied) return
    if (!data?.items.some(row => ['QUEUED', 'PROCESSING', 'FINALIZING', 'DELETING'].includes(deleted.includes(row.id) ? 'DELETING' : row.status))) return
    const timer = globalThis.setTimeout(() => { setRevision(value => value + 1) }, 3_000)
    return () => { globalThis.clearTimeout(timer) }
  }, [data, deleted, revision, loading, accessDenied])
  const mutate = async (method: string, payload: unknown, onCommitted?: () => void): Promise<void> => {
    if (pending) return
    const controller = operation.current
    setPending(true); setMutationError('')
    try {
      await request(method, payload, controller.signal)
      if (!controller.signal.aborted) { onCommitted?.(); setRevision(value => value + 1) }
    } catch (failure) { if (!controller.signal.aborted) setMutationError(productErrorMessage(failure, t, 'knowledgeChangeFailed')) }
    finally { if (!controller.signal.aborted) setPending(false) }
  }
  const upload = async (pdfParseMode: KnowledgePdfParseMode, destination = folderId): Promise<void> => {
    if (pending) return
    const controller = operation.current
    setPending(true); setMutationError('')
    try {
      const value = await request('knowledge.documents.upload', { knowledgeBaseId: product.id,
        operationId: globalThis.crypto.randomUUID(), pdfParseMode,
        ...(destination === undefined ? {} : { folderId: destination }) }, controller.signal)
      if (!controller.signal.aborted && !(typeof value === 'object' && value !== null && 'cancelled' in value && value.cancelled === true)) {
        knowledgeDocument(value); setRevision(row => row + 1)
      }
    } catch (failure) { if (!controller.signal.aborted) setMutationError(productErrorMessage(failure, t, 'knowledgeUploadFailed')) }
    finally { if (!controller.signal.aborted) setPending(false) }
  }
  const selectFolder = (value: string | null | undefined) => {
    setReader(undefined)
    if (value !== folderId || page !== 1) { setFolderId(value); setPage(1); setData(undefined) }
    onNavigate?.()
  }
  const closeConfirmation = () => {
    if (pending) return
    setConfirmation(undefined); setMutationError('')
  }
  const beginMutation = () => { setMutationError('') }
  const openReader = (row: KnowledgeDocument) => { if (!accessDenied) { setReader(row); onNavigate?.() } }
  const pages = Math.max(1, Math.ceil((availableData?.total ?? 0) / 20))
  const currentFolder = availableFolders.find(row => row.id === folderId)
  const breadcrumbFolderId = reader ? reader.folderId : folderId
  const breadcrumbFolder = availableFolders.find(row => row.id === breadcrumbFolderId)
  const documentAction = (id: string, row: KnowledgeDocument) => {
    if (id === 'read') openReader(row)
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
        () => { reindexOperations.current.delete(row.id) })
    }
  }
  const fileAction = async (action: 'download' | 'openExternal', row: KnowledgeDocument): Promise<void> => {
    if (pending) return
    const controller = operation.current
    setPending(true); setMutationError('')
    try {
      await request(`knowledge.documents.${action}`, { knowledgeBaseId: product.id, documentId: row.id }, controller.signal)
    } catch (failure) {
      if (!controller.signal.aborted) {
        setMutationError(productErrorMessage(failure, t, action === 'download' ? 'knowledgeDownloadFailed' : 'knowledgeOpenExternalFailed'))
        if (isKnowledgeAccessDenied(failure)) denyAccess()
      }
    } finally { if (!controller.signal.aborted) setPending(false) }
  }
  const folderAction = (id: string, folder: KnowledgeFolder) => {
    if (id === 'rename') { beginMutation(); setEditor({ kind: 'folder', folder }) }
    else if (id === 'delete') { beginMutation(); setConfirmation({ kind: 'folder', folder }) }
    else if (id === 'upload') void upload('STANDARD', folder.id)
  }
  const materialSearch = <form className={css.knowledgeFilterSearch} onSubmit={(event) => {
    event.preventDefault(); setSearch(query.trim()); setPage(1)
    if (search !== query.trim() || page !== 1) setData(undefined)
    setReader(undefined); onNavigate?.()
  }}>
    <label className={css.searchField}><IconSearchOutlineRegular size={16} /><span className={css.visuallyHidden}>{t('knowledgeFindFiles')}</span>
      <input type="search" value={query} maxLength={120} placeholder={t('knowledgeFindFiles')}
        onChange={(event) => { setQuery(event.currentTarget.value) }} /></label>
    <Tooltip label={t('search')}><button className={css.iconButton} type="submit" aria-label={t('search')}><IconSearchOutlineRegular size={16} /></button></Tooltip>
  </form>
  const toolbar = <>
    <div className={css.knowledgeMaterialsToolbar}>
      {!renderNavigation && materialSearch}
      {canManage && <div className={css.knowledgeAddActions}>
        <KnowledgeUploadMenu disabled={pending} onSelect={(mode) => { void upload(mode) }} t={t} />
        <KnowledgeAddMenu disabled={pending} withinFolder={typeof folderId === 'string'} onSelect={(kind) => {
          beginMutation(); setEditor({ kind })
        }} t={t} />
      </div>}
    </div>
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
      <Tooltip label={t('refresh')}><button type="button" className={css.iconButton} disabled={loading || pending}
        aria-label={t('refresh')} onClick={() => {
          accessOperation.current.abort(); accessOperation.current = new AbortController()
          setData(undefined); setFolders([]); setAccessDenied(false); setRevision(value => value + 1)
        }}><IconRefreshOutlineRegular size={16} /></button></Tooltip>
    </div>
  </>
  const navigation = <nav className={css.knowledgeFolderNavigation} aria-label={t('knowledgeFolders')}>
    <button type="button" aria-current={folderId === undefined ? 'page' : undefined} onClick={() => { selectFolder(undefined) }}>{t('knowledgeAllMaterials')}</button>
    <button type="button" aria-current={folderId === null ? 'page' : undefined} onClick={() => { selectFolder(null) }}>{t('knowledgeRootFolder')}</button>
    {availableFolders.map(row => <button type="button" key={row.id} aria-current={folderId === row.id ? 'page' : undefined}
      onClick={() => { selectFolder(row.id) }}><IconFolderOpenOutlineRegular size={14} /><span>{row.name}</span></button>)}
  </nav>
  const folderHeading = currentFolder && canManage && <div className={css.knowledgeFolderHeading}><strong>{currentFolder.name}</strong>
    <Tooltip label={t('knowledgeRenameFolder')}><button className={css.iconButton} disabled={pending} type="button" aria-label={t('knowledgeRenameFolder')}
      onClick={() => { beginMutation(); setEditor({ kind: 'folder', folder: currentFolder }) }}><IconEditOutlineRegular size={14} /></button></Tooltip>
    <Tooltip label={t('knowledgeDeleteFolder')}><button className={css.iconButton} disabled={pending} type="button" aria-label={t('knowledgeDeleteFolder')}
      onClick={() => { beginMutation(); setConfirmation({ kind: 'folder', folder: currentFolder }) }}><IconTrashOutlineRegular size={14} /></button></Tooltip>
  </div>
  const materials = <>
    {(error || mutationError) && <p role="alert" className={css.catalogError}>{error || mutationError}</p>}
    <div className={css.knowledgeTableScroll} aria-busy={loading}>
      <table className={css.knowledgeTable}>
        <thead><tr><th>{t('knowledgeDocumentTitle')}</th><th>{t('status')}</th><th>{t('knowledgeFormat')}</th>
          <th>{t('knowledgeSize')}</th><th>{t('updatedAt')}</th>
          <th><span className={css.visuallyHidden}>{t('resourceActions')}</span></th></tr></thead>
        <tbody>{availableData?.items.map((row) => {
          const deleting = deleted.includes(row.id) || row.status === 'DELETING'
          return <tr key={row.id}>
            <td><button type="button" className={css.knowledgeDocumentName} disabled={deleting} onClick={() => { openReader(row) }}>
              <FileTypeIcon path={row.filename} size={18} /><span>{row.filename}</span></button></td>
            <td><span className={css.knowledgeDocumentStatus} data-status={deleting ? 'DELETING' : row.status}>{knowledgeStatus(deleting ? 'DELETING' : row.status, t)}</span></td>
            <td>{row.sourceType === 'manual' ? t('knowledgeOnlineDocument') : row.sourceType === 'url' ? t('knowledgeWebsite') : row.filename.split('.').at(-1)?.toUpperCase()}</td>
            <td>{fileSizeText(row.sizeBytes)}</td><td>{formatDate(row.updatedAt)}</td>
            <td><KnowledgeDocumentActions document={row} disabled={pending || deleting}
              canManage={canManage} canOpenExternal={canOpenExternal}
              onSelect={(id) => { documentAction(id, row) }} t={t} /></td>
          </tr>
        })}</tbody>
      </table>
      {loading && availableData === undefined && <p role="status" className={css.catalogStatus}>{t('loading')}</p>}
      {!loading && !error && availableData?.items.length === 0 && <p className={css.catalogStatus}>{t(search || format || status ? 'noSearchResults' : 'knowledgeNoMaterials')}</p>}
    </div>
    <div className={css.knowledgePagination}>
      <span>{t('itemCount').replace('{count}', String(availableData?.total ?? 0))}</span>
      <div><Button variant="ghost" size="sm" disabled={loading || page <= 1} aria-label={t('previousPage')} onClick={() => { setPage(value => value - 1) }}><IconChevronLeftOutlineRegular size={16} /></Button>
        <span>{t('knowledgePageCount').replace('{page}', String(page)).replace('{pages}', String(pages))}</span>
        <Button variant="ghost" size="sm" disabled={loading || page >= pages} aria-label={t('nextPage')} onClick={() => { setPage(value => value + 1) }}><IconChevronRightOutlineRegular size={16} /></Button></div>
    </div>
  </>
  const documentReader = reader && <KnowledgeDocumentReader key={reader.id} knowledgeBaseId={product.id} documentId={reader.id}
    title={reader.filename} inline={renderNavigation !== undefined} refreshRevision={refreshRevision}
    renderFactorySlot={renderFactorySlot} onAccessDenied={readAccessDenied} onClose={() => { setReader(undefined) }} t={t} />
  const documentRows = (rows: readonly KnowledgeDocument[]) => rows.map((row) => {
    const deleting = deleted.includes(row.id) || row.status === 'DELETING'
    return <div key={row.id}>
      <button type="button" className={css.knowledgeWorkspaceTreeRow} data-kind="document" title={row.filename} aria-label={row.filename}
        aria-current={reader?.id === row.id ? 'page' : undefined} disabled={deleting} onClick={() => { openReader(row) }}>
        <FileTypeIcon path={row.filename} size={16} /><span className={css.knowledgeWorkspaceTreeLabel}>{row.filename}</span>
        {(deleting || row.status !== 'READY') && <span className={css.knowledgeWorkspaceTreeStatus} data-status={deleting ? 'DELETING' : row.status}>
          {knowledgeStatus(deleting ? 'DELETING' : row.status, t)}</span>}
      </button>
    </div>
  })
  const tree = <nav className={css.knowledgeWorkspaceTree} aria-label={t('knowledgeFolders')} aria-busy={loading}>
    <div className={css.knowledgeWorkspaceTreeToolbar}>{materialSearch}{canManage && <Tooltip label={t('knowledgeCreateFolder')}>
      <button type="button" disabled={pending} className={css.iconButton} aria-label={t('knowledgeCreateFolder')}
        onClick={() => { beginMutation(); setEditor({ kind: 'folder' }) }}><IconPlusOutlineRegular size={16} /></button></Tooltip>}</div>
    <button type="button" className={css.knowledgeWorkspaceTreeRow} aria-current={folderId === undefined && !reader ? 'page' : undefined}
      onClick={() => { selectFolder(undefined) }}><IconFolderOpenOutlineRegular size={16} /><span className={css.knowledgeWorkspaceTreeLabel}>{t('knowledgeAllMaterials')}</span></button>
    <div data-knowledge-folder="root">
      <button type="button" className={css.knowledgeWorkspaceTreeRow} aria-current={folderId === null && !reader ? 'page' : undefined}
        onClick={() => { selectFolder(null) }}><IconFolderOpenOutlineRegular size={16} /><span className={css.knowledgeWorkspaceTreeLabel}>{t('knowledgeRootFolder')}</span></button>
      {documentRows(availableData?.items.filter(row => row.folderId === null || row.folderId === undefined) ?? [])}
    </div>
    {availableFolders.map(row => <div key={row.id} data-knowledge-folder={row.id}>
      <div className={css.knowledgeWorkspaceFolderRow}><button type="button" className={css.knowledgeWorkspaceTreeRow}
        aria-current={folderId === row.id && !reader ? 'page' : undefined} onClick={() => { selectFolder(row.id) }}>
        <IconFolderOpenOutlineRegular size={16} /><span className={css.knowledgeWorkspaceTreeLabel}>{row.name}</span></button>
      {canManage && <KnowledgeFolderActions folder={row} disabled={pending} onSelect={(id) => { folderAction(id, row) }} t={t} />}</div>
      {documentRows(availableData?.items.filter(document => document.folderId === row.id) ?? [])}
    </div>)}
    {availableData?.items.some(row => typeof row.folderId === 'string' && !availableFolders.some(folder => folder.id === row.folderId)) && <div data-knowledge-folder="unknown">
      <p className={css.knowledgeWorkspaceTreeLabel}>{t('knowledgeMaterials')}</p>
      {documentRows(availableData.items.filter(row => typeof row.folderId === 'string' && !availableFolders.some(folder => folder.id === row.folderId)))}
    </div>}
    {folderError && <p role="alert" className={css.catalogError}>{folderError}</p>}
    {pages > 1 && <div className={css.knowledgeWorkspaceTreePagination}>
      <Button variant="ghost" size="sm" disabled={loading || page <= 1} aria-label={t('knowledgeBrowsePreviousPage')}
        onClick={() => { setPage(value => value - 1) }}><IconChevronLeftOutlineRegular size={16} /></Button>
      <span>{t('knowledgePageCount').replace('{page}', String(page)).replace('{pages}', String(pages))}</span>
      <Button variant="ghost" size="sm" disabled={loading || page >= pages} aria-label={t('knowledgeBrowseNextPage')}
        onClick={() => { setPage(value => value + 1) }}><IconChevronRightOutlineRegular size={16} /></Button>
    </div>}
  </nav>
  return <>
    {renderNavigation ? <div className={css.knowledgeWorkspace} data-knowledge-workspace-content>
      <aside className={css.knowledgeWorkspaceNavigation} id="knowledge-workspace-navigation" data-knowledge-navigation>{renderNavigation(tree)}</aside>
      <main className={css.knowledgeWorkspaceMain} data-knowledge-content>
        <header className={css.knowledgeWorkspaceDocumentHeader}>
          <nav className={css.knowledgeWorkspaceBreadcrumb} aria-label={t('knowledgeAllMaterials')}>
            <button type="button" onClick={() => { selectFolder(undefined) }}>{product.name}</button>
            {(breadcrumbFolderId === null || breadcrumbFolder) && <><IconChevronRightOutlineRegular size={14} />
              <button type="button" onClick={() => { selectFolder(breadcrumbFolderId) }}>{breadcrumbFolder?.name ?? t('knowledgeRootFolder')}</button></>}
            {reader && <><IconChevronRightOutlineRegular size={14} /><span aria-current="page">{reader.filename}</span></>}
          </nav>
          {reader && <div className={css.knowledgeWorkspaceDocumentActions}>
            <Button variant="ghost" size="sm" onClick={() => { setReader(undefined); onNavigate?.() }}><IconChevronLeftOutlineRegular size={16} />{t('knowledgeAllMaterials')}</Button>
            <KnowledgeDocumentActions document={reader} disabled={pending || deleted.includes(reader.id) || accessDenied}
              canManage={canManage} canOpenExternal={canOpenExternal} onSelect={(id) => { documentAction(id, reader) }} t={t} />
          </div>}
        </header>
        <div className={css.knowledgeWorkspaceBody}>
          {reader ? <>{(error || mutationError) && <p role="alert" className={css.catalogError}>{error || mutationError}</p>}{documentReader}</>
            : <>{toolbar}{folderHeading}{materials}</>}
        </div>
      </main>
    </div> : <>{toolbar}{navigation}
      {folderError && <p role="alert" className={css.catalogError}>{folderError}</p>}{folderHeading}{materials}{documentReader}</>}
    {editor && <KnowledgeEditor knowledgeBaseId={product.id} target={editor} onClose={() => { setEditor(undefined) }}
      onSaved={() => {
        setEditor(undefined); setReader(undefined); setPage(1); setRevision(value => value + 1)
      }} t={t} />}
    {confirmation && <Modal open title={t(confirmation.kind === 'document' ? 'knowledgeDeleteDocument' : 'knowledgeDeleteFolder')}
      closeLabel={t('close')} onClose={closeConfirmation} footer={<>
        <Button variant="ghost" size="sm" disabled={pending} onClick={closeConfirmation}>{t('cancel')}</Button>
        <Button variant="primary" className={css.knowledgeDanger} size="sm" disabled={pending} onClick={() => {
          if (confirmation.kind === 'folder') void mutate('knowledge.folders.delete',
            { knowledgeBaseId: product.id, folderId: confirmation.folder.id }, () => {
              setConfirmation(undefined); selectFolder(undefined)
            })
          else {
            const id = confirmation.document.id
            void mutate('knowledge.documents.delete', { knowledgeBaseId: product.id, documentId: id, operationId: confirmation.operationId }, () => {
              setConfirmation(undefined); setDeleted(value => [...value, id]); setReader(value => value?.id === id ? undefined : value)
            })
          }
        }}>{t(pending ? 'deletingResource' : 'deleteResource')}</Button>
      </>}>
      <p className={css.knowledgeConfirmation}>{t(confirmation.kind === 'document' ? 'knowledgeDeleteDocumentConfirmation' : 'knowledgeDeleteFolderConfirmation')
        .replace('{name}', confirmation.kind === 'document' ? confirmation.document.filename : confirmation.folder.name)}</p>
      {mutationError && <p role="alert" className={css.catalogError}>{mutationError}</p>}
    </Modal>}
    {move && <KnowledgeMoveDialog document={move} folders={availableFolders} pending={pending} error={mutationError}
      onClose={() => { if (!pending) setMove(undefined) }}
      onMove={(id) => { void mutate('knowledge.documents.move', { knowledgeBaseId: product.id, documentId: move.id, folderId: id }, () => { setMove(undefined); setReader(undefined) }) }} t={t} />}
  </>
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

function KnowledgeAddMenu({ disabled, withinFolder, onSelect, t }: {
  readonly disabled: boolean
  readonly withinFolder: boolean
  readonly onSelect: (kind: 'markdown' | 'url' | 'folder') => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [open, setOpen] = useState(false)
  return <Menu open={open && !disabled} onClose={() => { setOpen(false) }} portal align="end" items={[
    { id: 'markdown', label: t('knowledgeNewDocument'), icon: <IconEditOutlineRegular size={16} />, disabled: withinFolder },
    { id: 'url', label: t('knowledgeImportUrl'), icon: <IconLinkOutlineRegular size={16} />, disabled: withinFolder },
    { type: 'separator', id: 'folders' }, { id: 'folder', label: t('knowledgeCreateFolder'), icon: <IconFolderOpenOutlineRegular size={16} /> },
  ]} onSelect={(id) => { setOpen(false); if (id === 'markdown' || id === 'url' || id === 'folder') onSelect(id) }}
  anchor={<Button variant="outline" size="sm" disabled={disabled} title={withinFolder ? t('knowledgeCreationAtRoot') : undefined} aria-haspopup="menu" aria-expanded={open}
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
  items.push({ id: 'download', label: t('knowledgeDownloadOriginal'), icon: <IconDownloadOutlineRegular size={16} /> })
  if (canOpenExternal) items.push({ id: 'openExternal', label: t('knowledgeOpenExternal'), icon: <IconLinkOutlineRegular size={16} /> })
  if (canManage && document.sourceType === 'manual') items.push({ id: 'edit', label: t('modifyResource'), icon: <IconEditOutlineRegular size={16} />, disabled: processing })
  if (canManage) items.push({ id: 'move', label: t('knowledgeMoveDocument'), icon: <IconFolderOpenOutlineRegular size={16} /> },
    { id: 'reindex', label: t('knowledgeReindex'), icon: <IconRefreshOutlineRegular size={16} />, disabled: processing },
    { type: 'separator', id: 'delete-separator' }, { id: 'delete', label: t('deleteResource'), icon: <IconTrashOutlineRegular size={16} />, danger: true })
  return <Menu open={open && !disabled} items={items} portal align="end" onClose={() => { setOpen(false) }}
    onSelect={(id) => { setOpen(false); onSelect(id) }} anchor={<Tooltip label={t('resourceActions')}>
      <button type="button" disabled={disabled} className={css.iconButton} aria-label={t('knowledgeDocumentActions').replace('{name}', document.filename)}
        aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open) }}><IconEllipsisOutlineRegular size={16} /></button></Tooltip>} />
}

function KnowledgeFolderActions({ folder, disabled, onSelect, t }: {
  readonly folder: KnowledgeFolder
  readonly disabled: boolean
  readonly onSelect: (id: string) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [open, setOpen] = useState(false)
  return <Menu open={open && !disabled} portal align="end" onClose={() => { setOpen(false) }} items={[
    { id: 'upload', label: t('knowledgeUpload'), icon: <IconDownloadOutlineRegular size={16} /> },
    { type: 'separator', id: 'manage-folder' },
    { id: 'rename', label: t('knowledgeRenameFolder'), icon: <IconEditOutlineRegular size={16} /> },
    { id: 'delete', label: t('knowledgeDeleteFolder'), icon: <IconTrashOutlineRegular size={16} />, danger: true },
  ]} onSelect={(id) => { setOpen(false); onSelect(id) }} anchor={<Tooltip label={t('resourceActions')}>
    <button type="button" className={css.iconButton} disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      aria-label={t('knowledgeFolderActions').replace('{name}', folder.name)} onClick={() => { setOpen(!open) }}>
      <IconEllipsisOutlineRegular size={16} /></button></Tooltip>} />
}

function KnowledgeMoveDialog({ document, folders, pending, error, onClose, onMove, t }: {
  readonly document: KnowledgeDocument
  readonly folders: readonly KnowledgeFolder[]
  readonly pending: boolean
  readonly error: string
  readonly onClose: () => void
  readonly onMove: (folderId: string | null) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [destination, setDestination] = useState(document.folderId ?? '')
  return <Modal open title={t('knowledgeMoveDocument')} closeLabel={t('close')} onClose={onClose} footer={<>
    <Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>{t('cancel')}</Button>
    <Button variant="primary" size="sm" disabled={pending} onClick={() => { onMove(destination || null) }}>{t('knowledgeMove')}</Button>
  </>}><label className={css.knowledgeMoveLabel}>{t('knowledgeDestinationFolder')}<select value={destination} disabled={pending}
      onChange={(event) => { setDestination(event.currentTarget.value) }}><option value="">{t('knowledgeRootFolder')}</option>
      {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
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
