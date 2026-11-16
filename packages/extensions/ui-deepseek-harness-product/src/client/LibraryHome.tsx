/** File-first product navigation, backed by employee-authorized server pagination. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconSearchOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { LibraryEntryPageSchema, LibraryEntrySchema, LibraryFilePageSchema, LibrarySchema, type Library, type LibraryEntry } from '@deepseek-harness/product/library'
import type { LibraryText, LibraryLocation } from './LibraryBrowser.tsx'
import { LibraryMutation } from './LibraryMutation.tsx'
import { LibraryPreview } from './LibraryPreview.tsx'
import { LibraryDestination } from './LibraryDestination.tsx'
import { LibraryFileList, type LibraryItem } from './LibraryFileList.tsx'
import { LibraryMembers } from './LibraryMembers.tsx'
import { LibrarySidebar } from './LibrarySidebar.tsx'
import { LibraryPageHeader } from './LibraryPageHeader.tsx'
import { ProductLoading } from './ProductLoading.tsx'
import { productErrorMessage, type ProductFailureReport } from './product-errors.ts'
import { readLibraryTrail, useLibraryRequests } from './library-data.ts'
import { useResultFocus } from './useResultFocus.ts'
import css from '../DeepSeekHarnessProduct.module.css'
/** Native navigation actions supplied at the slot boundary. */
export interface LibraryNavigation {
  readonly startLibraryCreation?: () => void
  readonly openLibrarySource?: (sessionId: string) => void
}
type View = 'recent' | 'mine'
type Edit = { readonly kind: 'rename' | 'move' | 'delete'; readonly file: LibraryItem; readonly location?: LibraryLocation }
type Directory = { readonly location: LibraryLocation; readonly trail?: readonly LibraryEntry[] }
type Result = { readonly data: readonly LibraryItem[]; readonly totalPages: number; readonly directory?: Directory }
/** Keep rows, search and dialogs mounted while refreshing confirmed data.
 * @param props Native previews and conversation navigation.
 * @returns File navigation, authorized directories and native file actions.
 */
export function LibraryHome({ t, renderFactorySlot, startLibraryCreation, openLibrarySource }: PropsRenderFactories & LibraryNavigation & {
  readonly t: LibraryText
}): ReactNode {
  const request = useLibraryRequests()
  const [view, setView] = useState<View>('recent')
  const [query, setQuery] = useState('')
  const [layout, setLayout] = useState<'list' | 'grid'>('list')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<Result>()
  const [directory, setDirectory] = useState<Directory>()
  const personalRoot = useRef<Library>()
  const confirmedTrail = useRef<{
    readonly libraryId: string
    readonly parentId: string | null
    readonly revision: number
    readonly trail: readonly LibraryEntry[]
  }>()
  const [pending, setPending] = useState(true)
  const [readError, setReadError] = useState<unknown>()
  const [writeError, setWriteError] = useState<ProductFailureReport>()
  const [revision, setRevision] = useState(0)
  const [busyId, setBusyId] = useState<string>()
  const [preview, setPreview] = useState<LibraryItem>()
  const [editor, setEditor] = useState<Edit>()
  const [teamEditor, setTeamEditor] = useState<{ kind: 'createLibrary' | 'editLibrary' | 'deleteLibrary'; library?: Library }>()
  const [membersLibrary, setMembersLibrary] = useState<Library>()
  const [creating, setCreating] = useState<'upload' | 'folder'>()
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
    const controller = new AbortController()
    activeRead.current = controller
    let correcting = false
    setPending(true)
    const read = async (): Promise<Result> => {
      if (view !== 'mine') return LibraryFilePageSchema.parse(await request('library.files.list', {
        view, query, sort: 'accessed', direction: 'desc', page, size: 20,
      }, controller.signal))
      const libraryId = directory?.location.library.id ?? personalRoot.current?.id
      const library = LibrarySchema.parse(await (libraryId
        ? request('library.get', { libraryId }, controller.signal)
        : request('library.personal.ensure', {}, controller.signal)))
      controller.signal.throwIfAborted()
      if (!directory) personalRoot.current = library
      const parentId = directory?.location.parentId ?? null
      const readTrail = async () => {
        if (parentId === null) return []
        const cached = confirmedTrail.current
        if (cached?.libraryId === library.id && cached.parentId === parentId && cached.revision === revision) return cached.trail
        const folder = LibraryEntrySchema.parse(await request('library.entries.get', { libraryId: library.id, entryId: parentId }, controller.signal))
        if (folder.id !== parentId || folder.libraryId !== library.id || folder.kind !== 'FOLDER') throw new Error('Invalid library folder ancestry')
        const trail = await readLibraryTrail(request, folder, controller.signal)
        controller.signal.throwIfAborted()
        confirmedTrail.current = { libraryId: library.id, parentId, revision, trail }
        return trail
      }
      const [value, trail] = await Promise.all([
        request('library.entries.list', { libraryId: library.id, parentId, query, view: 'folder', page, size: 20 }, controller.signal),
        readTrail(),
      ])
      const entries = LibraryEntryPageSchema.parse(value)
      const parentName = trail.at(-1)?.name
      return { totalPages: entries.totalPages,
        data: entries.data.map(entry => ({ entry, libraryName: library.name,
          canManage: library.canManage, lastAccessedAt: entry.updatedAt })),
        directory: { location: { library, parentId, ...(parentName ? { parentName } : {}) }, trail } }
    }
    void read()
      .then((next) => {
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
  }, [request, view, directory, query, page, revision, capture])
  const refresh = () => {
    if (activeRead.current || writing.current) return
    setRevision(value => value + 1)
  }
  const edit = async (file: LibraryItem, kind: Edit['kind']) => {
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
    } catch (error) { if (!controller.signal.aborted) setWriteError({ failure: error, fallback: 'saveFailed' }) }
    finally {
      if (activeOpen.current === controller) {
        activeOpen.current = undefined
        writing.current = false; setBusyId(undefined)
      }
    }
  }
  const allowNavigation = () => {
    if (activeOpen.current) {
      activeOpen.current.abort(); activeOpen.current = undefined
      writing.current = false; setBusyId(undefined)
    }
    return !writing.current
  }
  const navigate = (location: LibraryLocation, trail?: readonly LibraryEntry[]) => {
    const current = result?.directory?.location
    if (view === 'mine' && current?.library.id === location.library.id && current.parentId === location.parentId && query === '' && page === 1) return
    if (!allowNavigation()) return
    capture()
    activeRead.current?.abort()
    confirmedTrail.current = trail ? { libraryId: location.library.id, parentId: location.parentId, revision, trail } : undefined
    setDirectory({ location, ...(trail ? { trail } : {}) })
    setView('mine'); setQuery(''); setPage(1)
    setResult(undefined); setPending(true); setReadError(undefined)
  }
  const open = (file: LibraryItem) => {
    if (file.entry.kind === 'FILE') {
      if (allowNavigation()) setPreview(file)
      return
    }
    const current = result?.directory
    if (!current) return
    navigate({ library: current.location.library, parentId: file.entry.id, parentName: file.entry.name },
      file.entry.parentId === current.location.parentId ? [...(current.trail ?? []), file.entry] : undefined)
  }
  const committed = (location?: LibraryLocation) => {
    prepareClose()
    activeRead.current?.abort()
    setEditor(undefined)
    setCreating(undefined)
    if (creating === 'folder' && location) {
      const current = result?.directory
      const sameDirectory = current?.location.library.id === location.library.id && current.location.parentId === location.parentId
      const trail = sameDirectory ? current.trail : undefined
      const filesBelongHere = result?.data.every(file =>
        file.entry.libraryId === location.library.id && file.entry.parentId === location.parentId)
      if (!sameDirectory && (current !== undefined || !filesBelongHere)) {
        setResult(undefined); setPending(true); setReadError(undefined)
      }
      setDirectory({ location, ...(trail ? { trail } : {}) })
      setView('mine'); setQuery(''); setPage(1)
    }
    setRevision(value => value + 1)
  }
  const teamChanged = (library: Library) => {
    activeRead.current?.abort()
    setDirectory(current => current?.location.library.id === library.id
      ? { ...current, location: { ...current.location, library } } : current)
    setResult(current => current?.directory?.location.library.id === library.id ? { ...current, directory: {
      ...current.directory, location: { ...current.directory.location, library },
    } } : current)
    setRevision(value => value + 1)
  }
  const teamCommitted = (location?: LibraryLocation) => {
    prepareClose(); activeRead.current?.abort()
    if (teamEditor?.kind === 'deleteLibrary') {
      const deletedId = teamEditor.library?.id
      if (directory?.location.library.id === deletedId || result?.directory?.location.library.id === deletedId) {
        setDirectory(undefined); setResult(undefined); setPending(true); setReadError(undefined); setView('mine'); setPage(1); setQuery('')
      }
    } else if (location) {
      if (teamEditor?.kind === 'createLibrary') navigate(location, [])
      else teamChanged(location.library)
    }
    setTeamEditor(undefined); setRevision(value => value + 1)
  }
  const visibleDirectory = result?.directory ?? directory
  const selectedLibrary = visibleDirectory?.location.library
  const title = view === 'mine'
    ? visibleDirectory?.location.parentName ?? (selectedLibrary?.scope === 'PERSONAL' ? t('libraryPersonal') : selectedLibrary?.name) ?? t('libraryPersonal')
    : t('libraryRecent')
  const canUploadHere = view !== 'mine' || selectedLibrary?.canManage !== false
  return <section ref={root} className={css.libraryHome} aria-label={t('libraryFiles')}>
    <LibrarySidebar t={t} view={view} revision={revision} renderFactorySlot={renderFactorySlot}
      {...(view === 'mine' && visibleDirectory ? { location: visibleDirectory.location, trail: visibleDirectory.trail } : {})}
      onCreateTeam={() => { if (!writing.current) setTeamEditor({ kind: 'createLibrary' }) }}
      onMembers={(library) => { if (!writing.current) setMembersLibrary(library) }}
      onEditTeam={(library, kind) => { if (!writing.current) setTeamEditor({ kind, library }) }}
      onNavigate={navigate} onOpen={open} onUpload={() => { if (!writing.current) setCreating('upload') }}
      {...(startLibraryCreation ? { onGenerate: startLibraryCreation } : {})}
      onCreateFolder={() => { if (!writing.current) setCreating('folder') }}
      onView={(value) => {
        if (!allowNavigation()) return
        if (value === view && (value !== 'mine' || !directory)) return
        if (value === 'mine') {
          setDirectory(undefined)
          const current = result?.directory?.location
          if (current && (current.library.scope !== 'PERSONAL' || current.parentId !== null)) {
            capture(); activeRead.current?.abort()
            setResult(undefined); setPending(true); setReadError(undefined)
          }
        }
        setView(value); setPage(1)
      }} />
    <div className={css.libraryMain}>
      <LibraryPageHeader t={t} busy={busyId !== undefined}
        title={title}
        {...(canUploadHere ? { onUpload: () => { if (!writing.current) setCreating('upload') } } : {})}
        {...(startLibraryCreation ? { onGenerate: startLibraryCreation } : {})} />
      <div className={css.libraryHomeTop}>
        <div className={css.libraryHomeFilters}>
          <Input ref={search} type="search" className={css.libraryHomeSearch as string} icon={<IconSearchOutlineRegular size={16} />}
            aria-label={t('librarySearch')} placeholder={t('librarySearch')}
            maxLength={180} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} />
          <div className={css.libraryHomeOptions}>
            <div className={css.libraryLayout} role="group" aria-label={t('libraryLayout')}>
              <Button variant="ghost" size="sm" aria-pressed={layout === 'list'} onClick={() => { setLayout('list') }}>{t('libraryList')}</Button>
              <Button variant="ghost" size="sm" aria-pressed={layout === 'grid'} onClick={() => { setLayout('grid') }}>{t('libraryGrid')}</Button>
            </div>
          </div>
        </div>
      </div>
      <div role="region" aria-label={t('libraryFiles')}>
        {view === 'mine' && visibleDirectory && visibleDirectory.location.parentId !== null && <nav className={`${css.libraryBreadcrumbs} ${css.libraryHomePath}`} aria-label={t('libraryPath')}>
          <Button variant="ghost" size="sm" onClick={() => { navigate({ library: visibleDirectory.location.library, parentId: null }, []) }}>{visibleDirectory.location.library.scope === 'PERSONAL' ? t('libraryPersonal') : visibleDirectory.location.library.name}</Button>
          {(visibleDirectory.trail ?? []).map((folder, index, trail) => <span key={folder.id}>
            <span aria-hidden="true"> / </span>
            <Button variant="ghost" size="sm" aria-current={folder.id === visibleDirectory.location.parentId ? 'page' : undefined}
              onClick={() => {
                if (folder.id !== visibleDirectory.location.parentId) {
                  navigate({ library: visibleDirectory.location.library, parentId: folder.id }, trail.slice(0, index + 1))
                }
              }}>{folder.name}</Button>
          </span>)}
        </nav>}
        <div className={css.libraryFeedback}>
          <div className={css.libraryErrorStack}>
            <div className={css.feedbackResult}>
              <span aria-hidden="true">{t('libraryLoadFailed')}</span>
              {readError !== undefined && <div role="region" aria-label={t('libraryLoadFailed')} tabIndex={0} className={css.catalogError}>
                <p role="alert">{productErrorMessage(readError, t, 'libraryLoadFailed')}</p>
              </div>}
            </div>
            <div className={css.feedbackResult}>
              <span aria-hidden="true">{t(writeError?.fallback ?? 'saveFailed')}</span>
              {writeError !== undefined && <div role="region" aria-label={t(writeError.fallback)} tabIndex={0} className={css.catalogError}>
                <p role="alert">{productErrorMessage(writeError.failure, t, writeError.fallback)}</p>
              </div>}
            </div>
          </div>
          {readError !== undefined && <Button variant="outline" aria-disabled={pending} aria-busy={pending} onClick={refresh}>{t('retry')}</Button>}
        </div>
        {result === undefined && pending && readError === undefined && <ProductLoading label={t('loading')} />}
        {result?.data.length === 0 && <p className={css.libraryHomeEmpty}>{t(query ? 'libraryNoMatches' : 'libraryEmpty')}</p>}
        {result !== undefined && <LibraryFileList files={result.data} layout={layout} t={t} pending={busyId !== undefined}
          directory={result.directory !== undefined} onOpen={open} {...(openLibrarySource ? { onSource: openLibrarySource } : {})}
          onEdit={(file, kind) => { void edit(file, kind) }} />}
        <div className={css.libraryPagination} hidden={page <= 1 && (result?.totalPages ?? 0) <= 1}>
          <Button variant="ghost" aria-disabled={page <= 1 || pending} onClick={() => { if (page > 1 && !pending) setPage(page - 1) }}>{t('libraryPrevious')}</Button>
          <span>{page} / {Math.max(1, result?.totalPages ?? 0)}</span>
          <Button variant="ghost" aria-disabled={pending || page >= (result?.totalPages ?? 0)} onClick={() => {
            if (!pending && page < (result?.totalPages ?? 0)) setPage(page + 1)
          }}>{t('libraryNext')}</Button>
        </div>
      </div>
    </div>
    {teamEditor && <LibraryMutation kind={teamEditor.kind} t={t}
      {...(teamEditor.library ? { location: { library: teamEditor.library, parentId: null } } : {})}
      onClose={() => { prepareClose(); setTeamEditor(undefined) }} onCommitted={teamCommitted} />}
    {membersLibrary && <LibraryMembers library={membersLibrary} t={t} onChanged={teamChanged}
      onClose={() => { prepareClose(); setMembersLibrary(undefined) }} />}
    {preview && <LibraryPreview entry={preview.entry} t={t} renderFactorySlot={renderFactorySlot} onClose={() => {
      prepareClose(); setPreview(undefined); setRevision(value => value + 1)
    }} />}
    {editor && <LibraryMutation kind={editor.kind} entry={editor.file.entry}
      {...(editor.location ? { location: editor.location } : {})} t={t} onClose={() => {
        prepareClose(); setEditor(undefined)
      }} onCommitted={committed} />}
    {creating && <LibraryDestination kind={creating} t={t} renderFactorySlot={renderFactorySlot}
      {...(view === 'mine' && visibleDirectory?.location.library.canManage && (creating === 'upload' || visibleDirectory.location.library.scope === 'PERSONAL') ? { initialLocation: visibleDirectory.location } : {})} onClose={() => {
        prepareClose(); setCreating(undefined)
      }} onCommitted={committed} />}
  </section>
}
