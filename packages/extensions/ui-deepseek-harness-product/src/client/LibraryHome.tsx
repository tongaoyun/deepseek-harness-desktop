/** File-first product navigation, backed by employee-authorized server pagination. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, FileTypeIcon, IconSearchOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { LibraryEntryPageSchema, LibraryEntrySchema, LibraryFilePageSchema, LibrarySchema, type Library, type LibraryEntry } from '@deepseek-harness/product/library'
import { ProductError } from '@deepseek-harness/product/errors'
import type { LibraryText, LibraryLocation } from './LibraryBrowser.tsx'
import { LibraryMutation } from './LibraryMutation.tsx'
import { LibraryPreview } from './LibraryPreview.tsx'
import { LibraryDestination } from './LibraryDestination.tsx'
import { LibraryFileList, type LibraryItem } from './LibraryFileList.tsx'
import { LibraryMembers } from './LibraryMembers.tsx'
import { LibrarySidebar } from './LibrarySidebar.tsx'
import { LibraryPageHeader } from './LibraryPageHeader.tsx'
import { LibraryLoading } from './LibraryLoading.tsx'
import { useLibraryDrag } from './useLibraryDrag.ts'
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
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<Result>()
  const directoryPages = useRef(new Map<string, { readonly revision: number; readonly result: Result }>())
  const confirmedLibraries = useRef(new Map<string, Library>())
  const [confirmedLibrary, setConfirmedLibrary] = useState<Library>()
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
  const [creating, setCreating] = useState<{ readonly kind: 'upload' | 'folder'; readonly location?: LibraryLocation }>()
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
  const dragProps = useLibraryDrag({
    isBusy: () => writing.current || creating !== undefined || editor !== undefined,
    onStart: (file) => { writing.current = true; setBusyId(file.entry.id) },
    onSuccess: () => { capture(); setWriteError(undefined); activeRead.current?.abort(); setRevision(value => value + 1) },
    onFailure: (failure) => { setWriteError({ failure, fallback: 'saveFailed' }) },
    onFinish: () => { writing.current = false; setBusyId(undefined) },
  })
  const directoryId = directory?.location.library.id
  const directoryParentId = directory?.location.parentId
  useEffect(() => {
    activeOpen.current?.abort()
    const controller = new AbortController()
    activeRead.current = controller
    const metadataBaseline = new Map(confirmedLibraries.current)
    let correcting = false
    setPending(true)
    const read = async (): Promise<Result> => {
      if (view !== 'mine') return LibraryFilePageSchema.parse(await request('library.files.list', {
        view, query, sort: 'accessed', direction: 'desc', page, size: 20,
      }, controller.signal))
      const libraryId = directoryId ?? personalRoot.current?.id
      const baseline = libraryId ? confirmedLibraries.current.get(libraryId) : undefined
      const received = LibrarySchema.parse(await (libraryId
        ? request('library.get', { libraryId }, controller.signal)
        : request('library.personal.ensure', {}, controller.signal)))
      controller.signal.throwIfAborted()
      const confirmed = confirmedLibraries.current.get(received.id)
      // Versions remain monotonic; at the same version retain access confirmed during this request.
      const library = confirmed && (confirmed.version > received.version
        || confirmed.version === received.version && confirmed !== baseline) ? confirmed : received
      confirmedLibraries.current.set(library.id, library)
      if (directoryId === undefined || personalRoot.current?.id === library.id) personalRoot.current = library
      const withLibrary = (current: Result): Result => current.directory?.location.library.id === library.id
        ? { ...current, directory: { ...current.directory, location: { ...current.directory.location, library } },
          data: current.data.map(item => ({ ...item, libraryName: library.name, canManage: library.canManage })) }
        : current
      capture()
      setResult(current => current ? withLibrary(current) : current)
      setDirectory(current => current?.location.library.id === library.id
        ? { ...current, location: { ...current.location, library } } : current)
      for (const [key, cached] of directoryPages.current) {
        const updated = withLibrary(cached.result)
        if (updated !== cached.result) directoryPages.current.set(key, { ...cached, result: updated })
      }
      const parentId = directoryParentId ?? null
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
      const latestLibrary = confirmedLibraries.current.get(library.id) ?? library
      const parentName = trail.at(-1)?.name
      return { totalPages: entries.totalPages,
        data: entries.data.map(entry => ({ entry, libraryName: latestLibrary.name,
          canManage: latestLibrary.canManage, lastAccessedAt: entry.updatedAt })),
        directory: { location: { library: latestLibrary, parentId, ...(parentName ? { parentName } : {}) }, trail } }
    }
    void read()
      .then((received) => {
        controller.signal.throwIfAborted()
        const next = view === 'mine' ? received : { ...received, data: received.data.map((file) => {
          const library = confirmedLibraries.current.get(file.entry.libraryId)
          return library && library !== metadataBaseline.get(file.entry.libraryId)
            ? { ...file, libraryName: library.name, canManage: library.canManage } : file
        }) }
        if (page > Math.max(1, next.totalPages)) {
          correcting = true
          setPage(Math.max(1, next.totalPages))
          return
        }
        capture()
        if (next.directory && query === '' && page === 1) {
          const { library, parentId } = next.directory.location
          directoryPages.current.set(`${library.id}/${parentId ?? ''}`, { revision, result: next })
        }
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
  }, [request, view, directoryId, directoryParentId, query, page, revision, capture])
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
      const received = LibrarySchema.parse(await request('library.get', { libraryId: file.entry.libraryId }, controller.signal))
      controller.signal.throwIfAborted()
      if (received.id !== file.entry.libraryId) throw new Error('Invalid library identity')
      const library = teamConfirmed(received)
      if (!library.canManage) throw new ProductError('LIBRARY_MANAGEMENT_FORBIDDEN', 'Library management unavailable', false)
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
    const current = directory?.location ?? result?.directory?.location
    const sameDirectory = view === 'mine' && current?.library.id === location.library.id && current.parentId === location.parentId
    if (sameDirectory && query === '' && page === 1) return
    if (!allowNavigation()) return
    capture()
    activeRead.current?.abort()
    confirmedTrail.current = trail ? { libraryId: location.library.id, parentId: location.parentId, revision, trail } : undefined
    setDirectory({ location, ...(trail ? { trail } : {}) })
    setView('mine'); setQuery(''); setPage(1)
    if (!sameDirectory) {
      const cached = directoryPages.current.get(`${location.library.id}/${location.parentId ?? ''}`)
      setResult(cached?.revision === revision ? cached.result : undefined)
      setReadError(undefined)
    }
    setPending(true)
  }
  const create = (kind: 'upload' | 'folder', target?: LibraryLocation | 'personal') => {
    if (writing.current) return
    if (target !== 'personal') {
      const location = target ?? (view === 'mine' && visibleDirectory?.location.library.canManage
        ? visibleDirectory.location : undefined)
      setCreating({ kind, ...(location ? { location } : {}) })
      return
    }
    const controller = new AbortController()
    activeOpen.current = controller
    writing.current = true; setBusyId('personal')
    void request('library.personal.ensure', {}, controller.signal).then((value) => {
      const library = LibrarySchema.parse(value)
      controller.signal.throwIfAborted()
      personalRoot.current = library
      setCreating({ kind, location: { library, parentId: null } })
      setWriteError(undefined)
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setWriteError({ failure, fallback: 'saveFailed' })
    }).finally(() => {
      if (activeOpen.current === controller) {
        activeOpen.current = undefined; writing.current = false; setBusyId(undefined)
      }
    })
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
    const current = result?.directory ?? directory
    const removedFolder = editor?.file.entry
    const ancestorIndex = current?.trail?.findIndex(folder => folder.id === removedFolder?.id) ?? -1
    if ((editor?.kind === 'delete' || editor?.kind === 'move') && removedFolder?.kind === 'FOLDER'
      && current?.location.library.id === removedFolder.libraryId
      && (current.location.parentId === removedFolder.id || ancestorIndex >= 0)) {
      const trail = ancestorIndex >= 0 ? current.trail?.slice(0, ancestorIndex) ?? [] : []
      const parentId = ancestorIndex >= 0 ? removedFolder.parentId : null
      const parentName = trail.at(-1)?.name
      setDirectory({ location: { library: current.location.library, parentId, ...(parentName ? { parentName } : {}) }, trail })
      setResult(undefined); setPending(true); setReadError(undefined); setQuery(''); setPage(1)
    }
    if (creating && location) {
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
  const teamConfirmed = useCallback((library: Library) => {
    const previous = confirmedLibraries.current.get(library.id)
    if (previous && previous.version > library.version) return previous
    confirmedLibraries.current.set(library.id, library)
    setConfirmedLibrary(library)
    if (personalRoot.current?.id === library.id) personalRoot.current = library
    capture()
    setDirectory(current => current?.location.library.id === library.id
      ? { ...current, location: { ...current.location, library } } : current)
    setResult(current => current ? { ...current,
      data: current.data.map(file => file.entry.libraryId === library.id
        ? { ...file, libraryName: library.name, canManage: library.canManage } : file),
      ...(current.directory?.location.library.id === library.id ? { directory: {
        ...current.directory, location: { ...current.directory.location, library },
      } } : {}),
    } : current)
    for (const [key, cached] of directoryPages.current) {
      if (cached.result.directory?.location.library.id !== library.id) continue
      directoryPages.current.set(key, { ...cached, result: { ...cached.result,
        directory: { ...cached.result.directory, location: { ...cached.result.directory.location, library } },
        data: cached.result.data.map(file => ({ ...file, libraryName: library.name, canManage: library.canManage })),
      } })
    }
    return library
  }, [capture])
  const teamChanged = (library: Library) => {
    activeRead.current?.abort()
    teamConfirmed(library)
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
  const currentFolder = visibleDirectory?.trail?.at(-1)
  const selectedLibrary = visibleDirectory?.location.library
  const title = view === 'mine'
    ? visibleDirectory?.location.parentName ?? (selectedLibrary?.scope === 'PERSONAL' ? t('libraryPersonal') : selectedLibrary?.name) ?? t('libraryPersonal')
    : t('libraryRecent')
  const canUploadHere = view !== 'mine' || selectedLibrary?.canManage !== false
  return <section ref={root} className={css.libraryHome} aria-label={t('libraryFiles')}>
    <LibrarySidebar t={t} view={view} revision={revision} renderFactorySlot={renderFactorySlot}
      {...(confirmedLibrary ? { confirmedLibrary } : {})}
      {...(view === 'mine' && visibleDirectory ? { location: visibleDirectory.location, trail: visibleDirectory.trail } : {})}
      onCreateTeam={() => { if (!writing.current) setTeamEditor({ kind: 'createLibrary' }) }}
      onMembers={(library) => { if (!writing.current) setMembersLibrary(library) }}
      onEditTeam={(library, kind) => { if (!writing.current) setTeamEditor({ kind, library }) }}
      onNavigate={navigate} onOpen={open} onEdit={(file, kind) => { void edit(file, kind) }} onUpload={(target) => { create('upload', target) }} dragProps={dragProps}
      {...(startLibraryCreation ? { onGenerate: startLibraryCreation } : {})}
      onCreateFolder={(target) => { create('folder', target) }}
      onView={(value) => {
        if (!allowNavigation()) return
        if (value === view && (value !== 'mine' || !directory)) return
        if (value === 'mine') {
          setDirectory(undefined)
          const current = result?.directory?.location
          if (view !== 'mine' || current && (current.library.scope !== 'PERSONAL' || current.parentId !== null)) {
            capture(); activeRead.current?.abort()
            const cached = query === '' && personalRoot.current && directoryPages.current.get(`${personalRoot.current.id}/`)
            setResult(cached && cached.revision === revision ? cached.result : undefined)
            setPending(true); setReadError(undefined)
          }
        } else {
          capture(); activeRead.current?.abort()
          setResult(undefined); setPending(true); setReadError(undefined)
        }
        setView(value); setPage(1)
      }} />
    <div className={css.libraryMain}>
      <nav className={css.libraryLocationBar} aria-label={t('libraryPath')}>
        {view === 'mine' && visibleDirectory ? <>
          {visibleDirectory.location.parentId === null ? <span aria-current="page">{title}</span> : <Button variant="ghost" size="sm" {...dragProps({ library: visibleDirectory.location.library, parentId: null })}
            onClick={() => { navigate({ library: visibleDirectory.location.library, parentId: null }, []) }}>{visibleDirectory.location.library.scope === 'PERSONAL' ? t('libraryPersonal') : visibleDirectory.location.library.name}</Button>}
          {(visibleDirectory.trail ?? []).map((folder, index, trail) => <span key={folder.id}>
            <span aria-hidden="true"> / </span>
            <Button variant="ghost" size="sm" aria-current={folder.id === visibleDirectory.location.parentId ? 'page' : undefined}
              {...dragProps({ library: visibleDirectory.location.library, parentId: folder.id, parentName: folder.name },
                undefined, trail.slice(0, index + 1).map(entry => entry.id))}
              onClick={() => {
                if (folder.id !== visibleDirectory.location.parentId) {
                  navigate({ library: visibleDirectory.location.library, parentId: folder.id }, trail.slice(0, index + 1))
                }
              }}>{folder.name}</Button>
          </span>)}
        </> : <span aria-current="page">{title}</span>}
      </nav>
      <LibraryPageHeader t={t} busy={busyId !== undefined}
        title={title}
        {...(view === 'mine' && selectedLibrary?.scope === 'TEAM' ? { onMembers: () => {
          if (!writing.current) setMembersLibrary(selectedLibrary)
        } } : {})}
        {...(view === 'mine' && selectedLibrary?.canManage && currentFolder
          && currentFolder.id === visibleDirectory?.location.parentId ? { onRename: () => {
            void edit({ entry: currentFolder, libraryName: selectedLibrary.name, canManage: true, lastAccessedAt: null }, 'rename')
          } } : {})}
        {...(view === 'mine' ? { icon: <FileTypeIcon kind="folder" size={24} /> } : {})}
        {...(canUploadHere ? { onUpload: () => { create('upload') } } : {})}
        {...(startLibraryCreation ? { onGenerate: startLibraryCreation } : {})} />
      <div className={css.libraryHomeTop}>
        <Input ref={search} type="search" className={css.libraryHomeSearch as string} icon={<IconSearchOutlineRegular size={16} />}
          aria-label={t('librarySearch')} placeholder={t('librarySearch')}
          maxLength={180} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} />
      </div>
      <div {...dragProps(view === 'mine' ? visibleDirectory?.location : undefined, undefined, visibleDirectory?.trail?.map(folder => folder.id))}
        role="region" aria-label={t('libraryFiles')} aria-busy={pending}>
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
        {result === undefined && pending && readError === undefined && <LibraryLoading label={t('loading')} />}
        {result?.data.length === 0 && <p className={css.libraryHomeEmpty}>{t(query ? 'libraryNoMatches' : 'libraryEmpty')}</p>}
        {result !== undefined && <LibraryFileList files={result.data} t={t} pending={busyId !== undefined}
          {...(result.directory ? { location: result.directory.location, trail: result.directory.trail ?? [] } : {})} dragProps={dragProps}
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
    {membersLibrary && <LibraryMembers library={membersLibrary} t={t} onChanged={teamChanged} onConfirmed={teamConfirmed}
      onClose={() => { prepareClose(); setMembersLibrary(undefined) }} />}
    {preview && <LibraryPreview entry={preview.entry} t={t} renderFactorySlot={renderFactorySlot} onClose={() => {
      prepareClose(); setPreview(undefined); setRevision(value => value + 1)
    }} />}
    {editor && <LibraryMutation kind={editor.kind} entry={editor.file.entry}
      {...(editor.location ? { location: editor.location } : {})} t={t} onClose={() => {
        prepareClose(); setEditor(undefined)
      }} onCommitted={committed} />}
    {creating && <LibraryDestination kind={creating.kind} t={t} renderFactorySlot={renderFactorySlot}
      {...(creating.location ? { initialLocation: creating.location } : {})} onClose={() => {
        prepareClose(); setCreating(undefined)
      }} onCommitted={committed} />}
  </section>
}
