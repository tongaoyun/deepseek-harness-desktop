/** Authorized personal and shared directories rendered with the native file tree. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconClockOutlineRegular, IconFolderCloseRegular, IconEllipsisOutlineRegular, IconPlusOutlineRegular, Menu, Tooltip, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderFactories, FactoryLocalComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { TreeEntry, TreeDirectoryState } from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import { LibraryEntryPageSchema, LibraryPageSchema, type Library, type LibraryEntry } from '@deepseek-harness/product/library'
import type { LibraryLocation, LibraryText } from './LibraryBrowser.tsx'
import { LibraryFileActions, type LibraryItem } from './LibraryFileList.tsx'
import { useLibraryRequests } from './library-data.ts'
import { productErrorMessage } from './product-errors.ts'
import { useResultFocus } from './useResultFocus.ts'
import { LibraryCreateMenu } from './LibraryCreateMenu.tsx'
import type { LibraryDragProps } from './useLibraryDrag.ts'
import css from '../DeepSeekHarnessProduct.module.css'

type View = 'recent' | 'mine'
type Control = { readonly label: string; readonly busy: boolean; readonly run: () => void }
interface NavigationEntry extends TreeEntry {
  readonly actions?: { readonly t: LibraryText; readonly file: LibraryItem; readonly run: (kind: 'rename' | 'move' | 'delete') => void }
  readonly control?: Control
  readonly create?: { readonly t: LibraryText; readonly label: string; readonly run: (kind: 'upload' | 'folder') => void }
}
type Level = {
  readonly data?: readonly LibraryEntry[]
  readonly revision?: number
  readonly page: number
  readonly pages: number
  readonly attempt: number
  readonly through: number
  readonly pending: boolean
  readonly error?: unknown
}

function TreeAccessory({ entry }: FactoryLocalComponentPropsOf<'sidebar.files.tree', 'accessory'>): ReactNode {
  // These entries and their local accessory are supplied together by LibraryTree.
  const { control, create, actions } = entry as NavigationEntry
  return <>{control && <Button variant="ghost" size="sm" aria-disabled={control.busy} aria-busy={control.busy}
    onClick={control.run}>{control.label}</Button>}
  {actions && <div className={css.libraryTreeActions}><LibraryFileActions file={actions.file} t={actions.t}
    pending={false} onEdit={actions.run} /></div>}
  {create && <LibraryCreateMenu t={create.t} label={create.label} onCreate={create.run} />}</>
}
const TREE_OPTIONS = { slots: { accessory: TreeAccessory }, fallback: null }

function LibraryTree({
  library, selected, trail, revision, t, renderFactorySlot, onNavigate, onOpen, onCreate, onEdit, dragProps,
}: PropsRenderFactories & {
  readonly library: Library
  readonly selected?: LibraryLocation
  readonly trail: readonly LibraryEntry[]
  readonly revision: number
  readonly t: LibraryText
  readonly onNavigate: (location: LibraryLocation, trail: readonly LibraryEntry[]) => void
  readonly onOpen: (file: LibraryItem) => void
  readonly onEdit?: (file: LibraryItem, kind: 'rename' | 'move' | 'delete') => void
  readonly onCreate: (kind: 'upload' | 'folder', location: LibraryLocation) => void
  readonly dragProps?: LibraryDragProps
}): ReactNode {
  const request = useLibraryRequests()
  const [levels, setLevels] = useState<Readonly<Record<string, Level>>>(() => ({
    [library.id]: { page: 0, pages: 0, attempt: 1, through: 1, pending: true },
  }))
  const cache = useRef(levels)
  const currentRevision = useRef(revision)
  currentRevision.current = revision
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const active = useRef(new Map<string, AbortController>())
  const area = useRef<HTMLDivElement>(null)
  const capture = useResultFocus(area, () => {
    const target = (area.current?.closest('[data-library-branch]') ?? area.current?.closest('nav'))
      ?.querySelector<HTMLButtonElement>('[data-library-root]')
    if (target) focusWithoutRing(target, { preventScroll: true })
  })
  const load = useCallback((path: string, page = 1, through = page) => {
    if (active.current.has(path)) return
    const requestedRevision = currentRevision.current
    const controller = new AbortController()
    active.current.set(path, controller)
    setLevels((current) => {
      const next = { ...current, [path]: {
        ...current[path], page: current[path]?.page ?? 0, pages: current[path]?.pages ?? 0, attempt: page, through, pending: true,
      } }
      cache.current = next
      return next
    })
    const parentId = path === library.id ? null : path.slice(path.lastIndexOf('/') + 1)
    const read = async () => {
      const data: LibraryEntry[] = []
      let last
      for (let index = page; index <= through; index++) {
        const result = LibraryEntryPageSchema.parse(await request('library.entries.list', {
          libraryId: library.id, parentId, view: 'folder', query: '', page: index, size: 50,
        }, controller.signal))
        controller.signal.throwIfAborted()
        if (result.data.some(entry => entry.libraryId !== library.id || entry.parentId !== parentId)) {
          throw new Error('Invalid library tree listing')
        }
        data.push(...result.data)
        last = result
        if (index >= result.totalPages) break
      }
      if (!last) throw new Error('Invalid library tree page')
      return { ...last, data }
    }
    void read().then((result) => {
      controller.signal.throwIfAborted()
      capture()
      setLevels((current) => {
        const data = page === 1 ? result.data : [...(current[path]?.data ?? []), ...result.data]
        const next = { ...current, [path]: {
          data: [...new Map(data.map(entry => [entry.id, entry])).values()],
          revision: requestedRevision, page: result.pageIndex, pages: result.totalPages, attempt: page, through, pending: false,
        } }
        cache.current = next
        return next
      })
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setLevels((current) => {
        const next = { ...current, [path]: {
          ...current[path], page: current[path]?.page ?? 0, pages: current[path]?.pages ?? 0, attempt: page, through,
          pending: false, error,
        } }
        cache.current = next
        return next
      })
    }).finally(() => { if (active.current.get(path) === controller) active.current.delete(path) })
  }, [request, library.id, capture])
  useEffect(() => {
    for (const controller of active.current.values()) controller.abort()
    active.current.clear()
    load(library.id, 1, Math.max(1, cache.current[library.id]?.page ?? 1))
    for (const path of expanded) load(path, 1, Math.max(1, cache.current[path]?.page ?? 1))
    return () => {
      for (const controller of active.current.values()) controller.abort()
      active.current.clear()
    }
    // Expansion reads independently; a mutation refreshes the directories already open.
  }, [load, library.id, revision])
  const trailKey = trail.map(folder => folder.id).join('/')
  useEffect(() => {
    let path = library.id
    const paths: string[] = []
    for (const folderId of trailKey ? trailKey.split('/') : []) {
      path += `/${folderId}`
      paths.push(path)
      if ((!cache.current[path]?.data || cache.current[path]?.revision !== currentRevision.current) && !cache.current[path]?.error)
        load(path, 1, Math.max(1, cache.current[path]?.page ?? 1))
    }
    if (paths.length) setExpanded(current => [...new Set([...current, ...paths])])
  }, [library.id, trailKey, load])
  const controlFor = (path: string): Control | undefined => {
    const state = levels[path]
    if (state?.error !== undefined) return { label: t('retry'), busy: state.pending, run: () => { load(path, state.attempt, state.through) } }
    if (state && state.page < state.pages) return { label: t('libraryMore'), busy: state.pending, run: () => { load(path, state.page + 1) } }
    return undefined
  }
  const entries: NavigationEntry[] = []
  const records = new Map<string, { entry: LibraryEntry; trail: readonly LibraryEntry[] }>()
  const directories: Record<string, TreeDirectoryState> = {}
  const collect = (path: string, ancestors: readonly LibraryEntry[]) => {
    const state = levels[path]
    directories[path] = {
      ...(state?.error !== undefined ? { failure: productErrorMessage(state.error, t, 'libraryLoadFailed') } : {}),
      ...(!state?.data?.length ? { omitted: 'unmatched' } : {}),
    }
    const known = state?.data ?? []
    const parentId = path === library.id ? null : path.slice(path.lastIndexOf('/') + 1)
    const ancestor = trail.find(folder => folder.parentId === parentId)
    const children = ancestor && state && state.page < state.pages && !known.some(entry => entry.id === ancestor.id)
      ? [...known, ancestor] : known
    for (const entry of children) {
      const key = `${path}/${entry.id}`
      const nextTrail = entry.kind === 'FOLDER' ? [...ancestors, entry] : ancestors
      records.set(key, { entry, trail: nextTrail })
      const control = entry.kind === 'FOLDER' && expanded.includes(key) ? controlFor(key) : undefined
      entries.push({ path: key, name: entry.name, meta: { kind: entry.kind === 'FOLDER' ? 'directory' : 'file' }, ...(control ? { control } : {}),
        ...(entry.kind === 'FOLDER' && library.canManage && onEdit ? { actions: { t,
          file: { entry, libraryName: library.name, canManage: true, lastAccessedAt: null },
          run: (kind: 'rename' | 'move' | 'delete') => { onEdit({ entry, libraryName: library.name, canManage: true, lastAccessedAt: null }, kind) } } } : {}),
        ...(entry.kind === 'FOLDER' && library.canManage ? { create: { t, label: `${t('libraryNew')}: ${entry.name}`,
          run: (kind: 'upload' | 'folder') => { onCreate(kind, { library, parentId: entry.id, parentName: entry.name }) } } } : {}) })
      if (entry.kind === 'FOLDER' && expanded.includes(key)) collect(key, nextTrail)
    }
  }
  collect(library.id, [])
  const rootControl = controlFor(library.id)
  return <div ref={area} className={css.libraryTree}>
    {renderFactorySlot('sidebar.files.tree', { root: library.id, entries, expanded, directories,
      rowTriggerProps: (entry) => {
        const record = records.get(entry.path)
        const item = record && { entry: record.entry, libraryName: library.name, canManage: library.canManage, lastAccessedAt: null }
        return { ...(item ? dragProps?.(item.entry.kind === 'FOLDER'
          ? { library, parentId: item.entry.id, parentName: item.entry.name } : undefined, item,
        record.trail.map(folder => folder.id)) : {}),
        tabIndex: 0, 'aria-current': record?.entry.kind === 'FOLDER' && selected?.parentId === record.entry.id ? 'page' : undefined,
        ...(levels[entry.path]?.pending ? { 'aria-busy': true } : {}) }
      },
      onToggle: (entry, expand) => {
        const record = records.get(entry.path)
        if (!record) return
        const enter = expand || selected?.parentId !== record.entry.id
        setExpanded(current => enter ? [...new Set([...current, entry.path])] : current.filter(path => path !== entry.path))
        if (enter && (!levels[entry.path]?.data || levels[entry.path]?.revision !== revision))
          load(entry.path, 1, Math.max(1, levels[entry.path]?.page ?? 1))
        if (enter) onNavigate({ library, parentId: record.entry.id, parentName: record.entry.name }, record.trail)
      },
      onOpen: (entry) => {
        const record = records.get(entry.path)
        if (record) onOpen({ entry: record.entry, libraryName: library.name, canManage: library.canManage, lastAccessedAt: null })
      },
    }, TREE_OPTIONS)}
    {rootControl && <Button variant="ghost" size="sm" aria-disabled={rootControl.busy} aria-busy={rootControl.busy}
      onClick={rootControl.run}>{rootControl.label}</Button>}
  </div>
}

function TeamActions({ library, t, onMembers, onEdit }: {
  readonly library: Library
  readonly t: LibraryText
  readonly onMembers?: (library: Library) => void
  readonly onEdit?: (library: Library, kind: 'editLibrary' | 'deleteLibrary') => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return <Menu portal align="end" open={open} onClose={() => { setOpen(false) }} items={[
    { id: 'members', label: t('libraryMembers') },
    ...(library.role === 'OWNER' ? [{ id: 'edit', label: t('libraryEdit') }, { id: 'delete', label: t('deleteResource'), danger: true }] : []),
  ]} onSelect={(id) => {
    if (trigger.current) focusWithoutRing(trigger.current)
    setOpen(false)
    if (id === 'members') onMembers?.(library)
    if (library.role === 'OWNER' && id === 'edit') onEdit?.(library, 'editLibrary')
    if (library.role === 'OWNER' && id === 'delete') onEdit?.(library, 'deleteLibrary')
  }} anchor={<Button ref={trigger} variant="ghost" size="sm" className={css.libraryNavAction}
    aria-label={`${t('libraryTeamActions')}: ${library.name}`}
    aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open) }}><IconEllipsisOutlineRegular size={16} /></Button>} />
}

const NO_TRAIL: readonly LibraryEntry[] = []
/**
 * @param props Current directory and native navigation callbacks; mutations invalidate loaded trees.
 * @returns Personal and shared navigation with server-paginated, lazily expanded native file trees.
 */
export function LibrarySidebar({
  t, view, location, confirmedLibrary, trail = NO_TRAIL, revision, renderFactorySlot, onView, onNavigate, onOpen,
  onCreateFolder, onUpload, onGenerate, onCreateTeam, onMembers, onEditTeam, onEdit,
  dragProps,
}: PropsRenderFactories & {
  readonly t: LibraryText
  readonly view: View
  readonly location?: LibraryLocation
  /** Metadata confirmed outside the currently selected directory, including recent-file actions. */
  readonly confirmedLibrary?: Library
  readonly trail?: readonly LibraryEntry[]
  readonly revision: number
  readonly onView: (view: View) => void
  readonly onNavigate: (location: LibraryLocation, trail: readonly LibraryEntry[]) => void
  readonly onOpen: (file: LibraryItem) => void
  readonly onEdit?: (file: LibraryItem, kind: 'rename' | 'move' | 'delete') => void
  readonly onCreateFolder: (location?: LibraryLocation | 'personal') => void
  readonly onUpload: (location?: LibraryLocation | 'personal') => void
  readonly dragProps?: LibraryDragProps
  readonly onCreateTeam?: () => void
  readonly onMembers?: (library: Library) => void
  readonly onEditTeam?: (library: Library, kind: 'editLibrary' | 'deleteLibrary') => void
  readonly onGenerate?: () => void
}): ReactNode {
  const request = useLibraryRequests()
  const navigation = useRef<HTMLElement>(null)
  const [libraries, setLibraries] = useState<readonly Library[]>()
  const librarySnapshot = useRef(libraries)
  librarySnapshot.current = libraries
  const projectedLibrary = useRef<Library>()
  const projectedConfirmation = useRef<Library>()
  const confirmedMetadata = useRef(new Map<string, Library>())
  const confirmed = location?.library
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(0)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState<unknown>()
  const [retry, setRetry] = useState(0)
  const active = useRef<AbortController>()
  const [newOpen, setNewOpen] = useState(false)
  const newTrigger = useRef<HTMLButtonElement>(null)
  const capture = useResultFocus(navigation, newTrigger)
  const createAt = (kind: 'upload' | 'folder', target: LibraryLocation | 'personal') => {
    if (kind === 'folder') onCreateFolder(target)
    else onUpload(target)
  }
  useEffect(() => {
    const baseline = new Map(librarySnapshot.current?.map(library => [library.id, library]))
    const metadataBaseline = new Map(confirmedMetadata.current)
    const controller = new AbortController()
    active.current = controller
    setPending(true)
    const read = async () => {
      const data: Library[] = []
      let totalPages = 0
      for (let index = 1; index <= page; index++) {
        const result = LibraryPageSchema.parse(await request('library.list', { page: index, size: 20, query: '' }, controller.signal))
        controller.signal.throwIfAborted()
        data.push(...result.data)
        totalPages = result.totalPages
        if (index >= totalPages) break
      }
      return { data, totalPages }
    }
    void read().then((result) => {
      controller.signal.throwIfAborted()
      capture()
      setLibraries((current) => {
        const confirmed = new Map(current?.map(library => [library.id, library]))
        return [...new Map(result.data.map((library) => {
          const previous = confirmed.get(library.id)
          const changed = previous !== baseline.get(library.id)
          const current = previous && (previous.version > library.version
            || previous.version === library.version && changed) ? previous : library
          const metadata = confirmedMetadata.current.get(library.id)
          const latest = metadata && (metadata.version > current.version || metadata.version === current.version
            && metadata !== metadataBaseline.get(library.id)) ? metadata : current
          return [library.id, latest] as const
        })).values()]
      })
      setPages(result.totalPages); setError(undefined)
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(failure) })
      .finally(() => { if (active.current === controller) active.current = undefined; if (!controller.signal.aborted) setPending(false) })
    return () => { controller.abort(); if (active.current === controller) active.current = undefined }
  }, [request, page, retry, revision, capture])
  useEffect(() => {
    // Effective employee access can change without a resource version increment.
    const updates = [confirmed !== projectedLibrary.current ? confirmed : undefined,
      confirmedLibrary !== projectedConfirmation.current ? confirmedLibrary : undefined]
    projectedLibrary.current = confirmed
    projectedConfirmation.current = confirmedLibrary
    if (!updates.some(library => library !== undefined)) return
    for (const library of updates) {
      if (library && (confirmedMetadata.current.get(library.id)?.version ?? 0) <= library.version)
        confirmedMetadata.current.set(library.id, library)
    }
    capture()
    setLibraries((current) => {
      const next = current?.map(library => updates.reduce<Library>((latest, update) =>
        update?.id === latest.id && update.version >= latest.version ? update : latest, library))
      return next?.some((library, index) => library !== current?.[index]) ? next : current
    })
  }, [confirmed, confirmedLibrary, capture])
  const draw = (library: Library) => {
    const selected = view === 'mine' && location?.library.id === library.id
    return <div key={library.id} data-library-branch className={css.libraryNavBranch}>
      <div className={css.libraryTeamRow}>
        <Button variant="ghost" data-library-root aria-current={selected && location.parentId === null ? 'page' : undefined}
          {...dragProps?.({ library, parentId: null })} onClick={() => { onNavigate({ library, parentId: null }, []) }}>
          <IconFolderCloseRegular size={16} /><span>{library.name}</span></Button>
        {library.canManage && <LibraryCreateMenu t={t} label={`${t('libraryNew')}: ${library.name}`}
          onCreate={(kind) => { createAt(kind, { library, parentId: null }) }} />}
        <TeamActions library={library} t={t} {...(onMembers ? { onMembers } : {})} {...(onEditTeam ? { onEdit: onEditTeam } : {})} /></div>
      <LibraryTree library={library} revision={revision} t={t} renderFactorySlot={renderFactorySlot}
        {...(selected ? { selected: location } : {})} trail={selected ? trail : NO_TRAIL} onNavigate={onNavigate} onOpen={onOpen}
        onCreate={createAt} {...(onEdit ? { onEdit } : {})} {...(dragProps ? { dragProps } : {})} />
    </div>
  }
  const incoming = [confirmed !== projectedLibrary.current ? confirmed : undefined,
    confirmedLibrary !== projectedConfirmation.current ? confirmedLibrary : undefined]
  const available = libraries?.map(library => incoming.reduce<Library>((latest, update) =>
    update?.id === latest.id && update.version >= latest.version ? update : latest, library))
  if (confirmed?.scope === 'PERSONAL' && available && !available.some(library => library.id === confirmed.id)) available.push(confirmed)
  const personal = available?.filter(library => library.scope === 'PERSONAL') ?? []
  const shared = available?.filter(library => library.scope !== 'PERSONAL') ?? []
  return <nav ref={navigation} className={css.libraryNavigation} aria-label={t('libraryNavigation')}>
    <h1 className={css.libraryPageTitle}>{t('library')}</h1>
    <div className={css.libraryNavShortcuts}>
      <Menu portal open={newOpen} onClose={() => { setNewOpen(false) }} items={[
        { id: 'folder', label: t('libraryNewFolder') }, { id: 'upload', label: t('libraryUpload') },
        ...(onGenerate ? [{ id: 'generate', label: t('libraryGenerate') }] : []),
      ]} onSelect={(id) => {
        if (newTrigger.current) focusWithoutRing(newTrigger.current)
        setNewOpen(false)
        if (id === 'folder') onCreateFolder()
        if (id === 'upload') onUpload()
        if (id === 'generate') onGenerate?.()
      }} anchor={<Button ref={newTrigger} variant="ghost" aria-haspopup="menu" aria-expanded={newOpen}
        onClick={() => { setNewOpen(value => !value) }}><IconPlusOutlineRegular size={16} />{t('libraryNew')}</Button>} />
      <Button variant="ghost" aria-current={view === 'recent' ? 'page' : undefined} onClick={() => { onView('recent') }}><IconClockOutlineRegular size={16} />{t('libraryRecent')}</Button>
    </div>
    <div className={css.libraryNavGroup}>
      <Button variant="ghost" data-library-root aria-current={view === 'mine' && (!location || location.library.scope === 'PERSONAL') && !location?.parentId ? 'page' : undefined}
        {...(personal[0] ? dragProps?.({ library: personal[0], parentId: null }) : {})}
        onClick={() => { onView('mine') }}>{t('libraryPersonal')}</Button>
      <LibraryCreateMenu t={t} label={`${t('libraryNew')}: ${t('libraryPersonal')}`}
        onCreate={(kind) => { createAt(kind, personal[0] ? { library: personal[0], parentId: null } : 'personal') }} />
    </div>
    {personal.map(library => <LibraryTree key={library.id} library={library} revision={revision} t={t} renderFactorySlot={renderFactorySlot}
      {...(view === 'mine' && location?.library.id === library.id ? { selected: location } : {})}
      trail={view === 'mine' && location?.library.id === library.id ? trail : NO_TRAIL} onNavigate={onNavigate} onOpen={onOpen}
      onCreate={createAt} {...(onEdit ? { onEdit } : {})} {...(dragProps ? { dragProps } : {})} />)}
    <div className={css.libraryNavGroup}><h2>{t('libraryShared')}</h2>
      {onCreateTeam && <Tooltip portal label={t('libraryNewTeam')}><Button variant="ghost" size="sm" aria-label={t('libraryNewTeam')} className={css.libraryAddAction} onClick={onCreateTeam}><IconPlusOutlineRegular size={16} /></Button></Tooltip>}
    </div>
    {shared.map(draw)}
    {libraries !== undefined && !shared.length && <p className={css.libraryNavNote}>{t('librarySharedEmpty')}</p>}
    {libraries === undefined && pending && <p className={css.libraryNavNote}>{t('loading')}</p>}
    {error !== undefined && <div className={css.libraryNavFailure}><p role="alert">{productErrorMessage(error, t, 'libraryLoadFailed')}</p>
      <Button variant="ghost" size="sm" aria-disabled={pending} aria-busy={pending} onClick={() => { if (!active.current) setRetry(value => value + 1) }}>{t('retry')}</Button></div>}
    {error === undefined && page < pages && <Button variant="ghost" size="sm" aria-disabled={pending} onClick={() => { if (!active.current) setPage(value => value + 1) }}>{t('libraryMore')}</Button>}
  </nav>
}
