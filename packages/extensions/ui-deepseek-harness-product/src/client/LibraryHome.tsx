/** File-first product navigation, backed by employee-authorized server pagination. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconUploadOutlineRegular,
  Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { LibraryFilePageSchema, LibrarySchema, type LibraryFile } from '@deepseek-harness/product/library'
import { LibraryBrowser, type LibraryText, type LibraryLocation } from './LibraryBrowser.tsx'
import { LibraryMutation } from './LibraryMutation.tsx'
import { LibraryPreview } from './LibraryPreview.tsx'
import { LibraryUploadDestination } from './LibraryUploadDestination.tsx'
import { LibraryFileList } from './LibraryFileList.tsx'
import { ProductLoading } from './ProductLoading.tsx'
import { productErrorMessage } from './product-errors.ts'
import { useLibraryRequests } from './library-data.ts'
import { useResultFocus } from './useResultFocus.ts'
import css from '../DeepSeekHarnessProduct.module.css'
/** Native navigation actions supplied at the slot boundary. */
export interface LibraryNavigation {
  readonly startLibraryCreation?: (kind: 'document' | 'presentation' | 'spreadsheet' | 'html') => void
  readonly openLibrarySource?: (sessionId: string) => void
}
type View = 'recent' | 'mine' | 'favorites' | 'directory'
type Category = 'all' | 'document' | 'media' | 'html' | 'other'
type Sort = 'accessed' | 'updated' | 'name' | 'size'
type Edit = { readonly kind: 'rename' | 'move' | 'delete'; readonly file: LibraryFile; readonly location?: LibraryLocation }
const views = ['recent', 'mine', 'favorites', 'directory'] as const
const viewKeys = { recent: 'libraryRecent', mine: 'libraryMine', favorites: 'libraryFavorites', directory: 'libraryDirectory' } as const
const categories = ['all', 'document', 'media', 'html', 'other'] as const
const categoryKeys = { all: 'libraryCategoryAll', document: 'libraryCategoryDocument', media: 'libraryCategoryMedia', html: 'libraryCategoryHtml', other: 'libraryCategoryOther' } as const
/** Keep rows, search and dialogs mounted while refreshing confirmed data.
 * @param props Native previews and conversation navigation.
 * @returns Recent, own and favorite files plus the shared library directory.
 */
export function LibraryHome({ t, renderFactorySlot, startLibraryCreation, openLibrarySource }: PropsRenderFactories & LibraryNavigation & {
  readonly t: LibraryText
}): ReactNode {
  const request = useLibraryRequests()
  const [view, setView] = useState<View>('recent')
  const [directoryVisited, setDirectoryVisited] = useState(false)
  const [category, setCategory] = useState<Category>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('accessed')
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')
  const [layout, setLayout] = useState<'list' | 'grid'>('list')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<ReturnType<typeof LibraryFilePageSchema.parse>>()
  const [pending, setPending] = useState(true)
  const [readError, setReadError] = useState<unknown>()
  const [writeError, setWriteError] = useState<unknown>()
  const [revision, setRevision] = useState(0)
  const [busyId, setBusyId] = useState<string>()
  const [preview, setPreview] = useState<LibraryFile>()
  const [editor, setEditor] = useState<Edit>()
  const [uploading, setUploading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const activeRead = useRef<AbortController>()
  const writing = useRef(false)
  const activeOpen = useRef<AbortController>()
  const root = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const body = useRef<HTMLElement | null>(null)
  const capture = useResultFocus(root, search)
  const captureClose = useResultFocus(body, search)
  const prepareClose = () => {
    body.current = root.current?.ownerDocument.body ?? null
    captureClose()
  }
  useEffect(() => {
    activeOpen.current?.abort()
    if (view === 'directory') return
    const controller = new AbortController()
    activeRead.current = controller
    let correcting = false
    setPending(true)
    void request('library.files.list', { view, category, query, sort, direction, page, size: 20 }, controller.signal)
      .then((value) => {
        const next = LibraryFilePageSchema.parse(value)
        controller.signal.throwIfAborted()
        if (page > Math.max(1, next.totalPages)) {
          correcting = true
          setPage(Math.max(1, next.totalPages))
          return
        }
        capture()
        setResult(next)
        setReadError(undefined)
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) { capture(); setReadError(error) }
      }).finally(() => {
        if (activeRead.current === controller) activeRead.current = undefined
        if (!controller.signal.aborted && !correcting) setPending(false)
      })
    return () => {
      controller.abort(); activeOpen.current?.abort()
      if (activeRead.current === controller) activeRead.current = undefined
    }
  }, [request, view, category, query, sort, direction, page, revision, capture])
  const refresh = () => {
    if (activeRead.current || writing.current) return
    setRevision(value => value + 1)
  }
  const favorite = async (file: LibraryFile) => {
    if (writing.current) return
    writing.current = true
    setBusyId(file.entry.id)
    try {
      await request('library.entries.favorite', { libraryId: file.entry.libraryId, entryId: file.entry.id, value: !file.entry.favorite })
      // A read started before the write must not restore the previous favorite state.
      activeRead.current?.abort()
      capture()
      setResult(current => current ? { ...current, data: current.data.map(row => row.entry.id === file.entry.id
        ? { ...row, entry: { ...row.entry, favorite: !file.entry.favorite } } : row) } : current)
      setWriteError(undefined)
      setRevision(value => value + 1)
    } catch (error) { setWriteError(error) }
    finally { writing.current = false; setBusyId(undefined) }
  }
  const edit = async (file: LibraryFile, kind: Edit['kind']) => {
    if (writing.current) return
    if (kind !== 'move') { setEditor({ file, kind }); return }
    writing.current = true
    setBusyId(file.entry.id)
    const controller = new AbortController()
    activeOpen.current = controller
    try {
      const library = LibrarySchema.parse(await request('library.get', { libraryId: file.entry.libraryId }, controller.signal))
      controller.signal.throwIfAborted()
      if (library.id !== file.entry.libraryId || !library.canManage) throw new Error('Library management unavailable')
      setEditor({ file, kind, location: { library, parentId: file.entry.parentId } })
      setWriteError(undefined)
    } catch (error) { if (!controller.signal.aborted) setWriteError(error) }
    finally {
      if (activeOpen.current === controller) activeOpen.current = undefined
      writing.current = false; setBusyId(undefined)
    }
  }
  const committed = () => {
    prepareClose()
    activeRead.current?.abort()
    setEditor(undefined)
    setUploading(false)
    setRevision(value => value + 1)
  }
  const generateItems: MenuEntry[] = [
    { id: 'document', label: t('libraryGenerateDocument') },
    { id: 'presentation', label: t('libraryGeneratePresentation') },
    { id: 'spreadsheet', label: t('libraryGenerateSpreadsheet') },
    { id: 'html', label: t('libraryGenerateHtml') },
  ]
  return <section ref={root} className={css.libraryHome} aria-label={t('libraryFiles')}>
    <div className={css.libraryHomeTop}>
      <nav className={css.libraryViews} aria-label={t('libraryFileViews')}>
        {views.map(value => <Button key={value} variant="ghost" aria-pressed={view === value}
          className={view === value ? css.libraryViewActive : undefined} onClick={() => {
            if (view === value) return
            if (value === 'directory') setDirectoryVisited(true)
            setView(value); setPage(1)
          }}>{t(viewKeys[value])}</Button>)}
      </nav>
      <div className={css.detailActions} hidden={view === 'directory'}>
        <Button variant="outline" aria-disabled={busyId !== undefined} onClick={() => { if (!writing.current) setUploading(true) }}>
          <IconUploadOutlineRegular size={16} />{t('libraryUpload')}
        </Button>
        {startLibraryCreation && <Menu open={generating} portal align="end" items={generateItems}
          onClose={() => { setGenerating(false) }} onSelect={(id) => {
            if (!['document', 'presentation', 'spreadsheet', 'html'].includes(id)) return
            setGenerating(false)
            startLibraryCreation(id as 'document' | 'presentation' | 'spreadsheet' | 'html')
          }} anchor={<Button variant="primary" aria-haspopup="menu" aria-expanded={generating}
            onClick={() => { setGenerating(!generating) }}>{t('libraryGenerate')}</Button>} />}
      </div>
    </div>
    <div hidden={view === 'directory'}>
      <div className={css.libraryHomeFilters}>
        <nav className={css.libraryCategories} aria-label={t('libraryFileCategory')}>
          {categories.map(value => <button key={value} type="button" aria-pressed={category === value} onClick={() => {
            if (value !== category) { setCategory(value); setPage(1) }
          }}>{t(categoryKeys[value])}</button>)}
        </nav>
        <input ref={search} type="search" aria-label={t('librarySearch')} placeholder={t('librarySearch')}
          maxLength={180} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} />
      </div>
      <div className={css.libraryHomeOptions}>
        <label>{t('librarySort')} <select value={sort} onChange={(event) => { setSort(event.target.value as Sort); setPage(1) }}>
          <option value="accessed">{t('libraryAccessed')}</option><option value="updated">{t('libraryUpdated')}</option>
          <option value="name">{t('libraryName')}</option><option value="size">{t('librarySize')}</option>
        </select></label>
        <Button variant="ghost" onClick={() => { setDirection(value => value === 'asc' ? 'desc' : 'asc'); setPage(1) }}>
          {t(direction === 'asc' ? 'libraryAscending' : 'libraryDescending')}
        </Button>
        <div className={css.libraryLayout} role="group" aria-label={t('libraryLayout')}>
          <Button variant="ghost" aria-pressed={layout === 'list'} onClick={() => { setLayout('list') }}>{t('libraryList')}</Button>
          <Button variant="ghost" aria-pressed={layout === 'grid'} onClick={() => { setLayout('grid') }}>{t('libraryGrid')}</Button>
        </div>
        <Button variant="outline" aria-busy={pending} aria-disabled={pending || busyId !== undefined} onClick={refresh}>{t('refresh')}</Button>
      </div>
      <div className={css.libraryFeedback}>
        <div className={css.feedbackResult}>
          <span aria-hidden="true">{t('loadFailed')}</span>
          {readError !== undefined && <div role="region" aria-label={t('loadFailed')} tabIndex={0} className={css.catalogError}>
            <p role="alert">{productErrorMessage(readError, t, 'loadFailed')}</p>
          </div>}
          {writeError !== undefined && <div role="region" aria-label={t('saveFailed')} tabIndex={0} className={css.catalogError}>
            <p role="alert">{productErrorMessage(writeError, t, 'saveFailed')}</p>
          </div>}
        </div>
        {readError !== undefined && <Button variant="outline" aria-disabled={pending} aria-busy={pending} onClick={refresh}>{t('retry')}</Button>}
      </div>
      {result === undefined && pending && readError === undefined && <ProductLoading label={t('loading')} />}
      {result?.data.length === 0 && <p className={css.libraryHomeEmpty}>{t(query ? 'libraryNoMatches' : 'libraryEmpty')}</p>}
      {result !== undefined && <LibraryFileList files={result.data} layout={layout} t={t} pending={busyId !== undefined}
        onOpen={setPreview} {...(openLibrarySource ? { onSource: openLibrarySource } : {})}
        onFavorite={(file) => { void favorite(file) }} onEdit={(file, kind) => { void edit(file, kind) }} />}
      <div className={css.libraryPagination}>
        <Button variant="ghost" aria-disabled={page <= 1 || pending} onClick={() => { if (page > 1 && !pending) setPage(page - 1) }}>{t('libraryPrevious')}</Button>
        <span>{page} / {Math.max(1, result?.totalPages ?? 0)}</span>
        <Button variant="ghost" aria-disabled={pending || page >= (result?.totalPages ?? 0)} onClick={() => {
          if (!pending && page < (result?.totalPages ?? 0)) setPage(page + 1)
        }}>{t('libraryNext')}</Button>
      </div>
    </div>
    <div hidden={view !== 'directory'}>{directoryVisited && <LibraryBrowser t={t} renderFactorySlot={renderFactorySlot} />}</div>
    {preview && <LibraryPreview entry={preview.entry} t={t} renderFactorySlot={renderFactorySlot} onClose={() => {
      prepareClose(); setPreview(undefined); setRevision(value => value + 1)
    }} />}
    {editor && <LibraryMutation kind={editor.kind} entry={editor.file.entry}
      {...(editor.location ? { location: editor.location } : {})} t={t} onClose={() => {
        prepareClose(); setEditor(undefined)
      }} onCommitted={committed} />}
    {uploading && <LibraryUploadDestination t={t} renderFactorySlot={renderFactorySlot} onClose={() => {
      prepareClose(); setUploading(false)
    }} onCommitted={committed} />}
  </section>
}
