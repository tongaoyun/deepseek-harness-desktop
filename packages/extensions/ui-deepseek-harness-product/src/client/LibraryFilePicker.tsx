/** Read-only attachment selection across recent, personal and shared files. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, Checkbox, FileTypeIcon, IconSearchOutlineRegular, Input, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import { LibraryEntryPageSchema, LibraryFilePageSchema, LibraryPageSchema, LibrarySchema, type Library, type LibraryEntry } from '@deepseek-harness/product/library'
import type { LibraryLocation, LibraryText } from './LibraryBrowser.tsx'
import { readLibraryTrail, useLibraryRequests } from './library-data.ts'
import { LibraryLoading } from './LibraryLoading.tsx'
import { productErrorMessage } from './product-errors.ts'
import { useResultFocus } from './useResultFocus.ts'
import css from '../DeepSeekHarnessProduct.module.css'

type Source = 'recent' | 'mine' | 'shared'
type Directory = { readonly location: LibraryLocation; readonly trail: readonly LibraryEntry[] }
type Row = { readonly entry: LibraryEntry; readonly libraryName: string; readonly date: string | null } | { readonly library: Library }
type Result = { readonly rows: readonly Row[]; readonly pages: number; readonly directory?: Directory }

/**
 * @param props Employee-authorized selection and the owning attachment operation's lock.
 * @returns Source tabs and a checkbox table retaining each directory's latest confirmed rows through reads and retries.
 */
export function LibraryFilePicker({ t, selected, onSelect, navigationLocked }: {
  readonly t: LibraryText
  readonly selected: ReadonlyMap<string, LibraryEntry>
  readonly onSelect: (entry: LibraryEntry) => void
  readonly navigationLocked: boolean
}): ReactNode {
  const request = useLibraryRequests()
  const id = useId()
  const [source, setSource] = useState<Source>('recent')
  const [locations, setLocations] = useState<Partial<Record<Source, Directory>>>({})
  const [queries, setQueries] = useState<Record<Source, string>>({ recent: '', mine: '', shared: '' })
  const query = queries[source]
  const target = locations[source]
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [results, setResults] = useState<Readonly<Record<string, Result>>>({})
  const directoryKey = JSON.stringify([source, target?.location.library.id, target?.location.parentId])
  const result = results[directoryKey]
  const personal = useRef<Library>()
  const [pending, setPending] = useState(true)
  const [failure, setFailure] = useState<{ readonly key: string; readonly error: unknown; readonly folder?: LibraryEntry }>()
  const failureRevision = useRef(0)
  const error = failure?.key === directoryKey ? failure.error : undefined
  const active = useRef<AbortController>()
  const opening = useRef<AbortController>()
  const [openingId, setOpeningId] = useState<string>()
  const root = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const searchSelections = useRef<Partial<Record<Source, {
    readonly value: string
    readonly start: number
    readonly end: number
    readonly direction: HTMLInputElement['selectionDirection']
  }>>>({})
  const capture = useResultFocus(root, search)
  const directory = result?.directory ?? target
  const locked = navigationLocked || openingId !== undefined
  useEffect(() => {
    const controller = new AbortController()
    active.current = controller
    setPending(true)
    const feedbackRevision = failureRevision.current
    let correcting = false
    const read = async (): Promise<Result> => {
      if (source === 'recent') {
        const value = LibraryFilePageSchema.parse(await request('library.files.list', {
          view: 'recent', query, sort: 'accessed', direction: 'desc', page, size: 20,
        }, controller.signal))
        return { pages: value.totalPages, rows: value.data.map(file => ({
          entry: file.entry, libraryName: file.libraryName, date: file.lastAccessedAt,
        })) }
      }
      if (source === 'shared' && !target) {
        const value = LibraryPageSchema.parse(await request('library.list', { query, page, size: 20 }, controller.signal))
        return { pages: value.totalPages, rows: value.data.filter(library => library.scope === 'TEAM').map(library => ({ library })) }
      }
      const known = target?.location.library ?? personal.current
      const library = LibrarySchema.parse(await (known
        ? request('library.get', { libraryId: known.id }, controller.signal)
        : request('library.personal.ensure', {}, controller.signal)))
      controller.signal.throwIfAborted()
      if (source === 'mine') personal.current = library
      const parentId = target?.location.parentId ?? null
      const value = LibraryEntryPageSchema.parse(await request('library.entries.list', {
        libraryId: library.id, parentId, view: 'folder', query, page, size: 20,
      }, controller.signal))
      return { pages: value.totalPages,
        directory: { location: { library, parentId }, trail: target?.trail ?? [] },
        rows: value.data.map(entry => ({ entry, libraryName: target?.trail.at(-1)?.name ?? library.name, date: entry.updatedAt })) }
    }
    void read().then((value) => {
      controller.signal.throwIfAborted()
      if (page > Math.max(1, value.pages)) { correcting = true; setPage(Math.max(1, value.pages)); return }
      capture()
      setResults(current => ({ ...current, [directoryKey]: value }))
      if (failureRevision.current === feedbackRevision) setFailure(undefined)
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && failureRevision.current === feedbackRevision) {
        capture(); failureRevision.current++; setFailure({ key: directoryKey, error })
      }
    }).finally(() => {
      if (active.current === controller) active.current = undefined
      if (!controller.signal.aborted && !correcting) setPending(false)
    })
    return () => { controller.abort(); if (active.current === controller) active.current = undefined }
    // Labels are resolved at render time; changing language must not restart file reads.
  }, [request, source, target?.location.library.id, target?.location.parentId, query, page, revision, directoryKey, capture])
  useEffect(() => () => { opening.current?.abort() }, [])
  useEffect(() => {
    if (!navigationLocked) return
    opening.current?.abort()
    opening.current = undefined
    setOpeningId(undefined)
  }, [navigationLocked])
  const navigate = (next?: Directory) => {
    if (navigationLocked || opening.current) return
    capture()
    setLocations(current => ({ ...current, [source]: next }))
    setQueries(current => ({ ...current, [source]: '' }))
    setPage(1)
  }
  const openFolder = async (entry: LibraryEntry) => {
    if (navigationLocked || opening.current || !directory) return
    if (entry.parentId === directory.location.parentId) {
      navigate({ location: { library: directory.location.library, parentId: entry.id }, trail: [...directory.trail, entry] })
      return
    }
    const controller = new AbortController()
    opening.current = controller
    setOpeningId(entry.id)
    try {
      const trail = await readLibraryTrail(request, entry, controller.signal)
      controller.signal.throwIfAborted()
      opening.current = undefined
      navigate({ location: { library: directory.location.library, parentId: entry.id }, trail })
    } catch (error) {
      if (!controller.signal.aborted) { capture(); failureRevision.current++; setFailure({ key: directoryKey, error, folder: entry }) }
    } finally {
      if (opening.current === controller) opening.current = undefined
      if (!controller.signal.aborted) setOpeningId(undefined)
    }
  }
  const sources = [{ value: 'recent', label: t('libraryRecent') }, { value: 'mine', label: t('libraryPersonal') },
    { value: 'shared', label: t('libraryShared') }] as const
  return <section ref={root} className={css.libraryFilePicker} aria-label={t('library')}>
    <div className={css.libraryPickerToolbar}>
      <div className={css.libraryPickerTabs} aria-disabled={locked}><SegmentedTabs<Source> size="sm" label={t('libraryFileViews')} value={source}
        items={[
          { value: 'recent', label: t('libraryRecent'), id: `${id}-recent`, panelId: `${id}-files` },
          { value: 'mine', label: t('libraryPersonal'), id: `${id}-mine`, panelId: `${id}-files` },
          { value: 'shared', label: t('libraryShared'), id: `${id}-shared`, panelId: `${id}-files` },
        ]} onChange={(next) => {
          if (locked || next === source) return
          capture(); setSource(next); setPage(1)
        }} /></div>
      <Input ref={search} type="search" maxLength={180} value={query} readOnly={locked} className={css.libraryPickerSearch as string}
        icon={<IconSearchOutlineRegular size={16} />} aria-label={t('librarySearch')} placeholder={t('librarySearch')}
        onBlur={(event) => {
          const input = event.currentTarget
          if (input.selectionStart !== null && input.selectionEnd !== null) searchSelections.current[source] = {
            value: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection,
          }
        }}
        onFocus={(event) => {
          const input = event.currentTarget, selection = searchSelections.current[source]
          if (input.selectionStart === input.selectionEnd && selection?.value === input.value)
            input.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined)
        }}
        onChange={(event) => { if (!locked) { setQueries(current => ({ ...current, [source]: event.target.value })); setPage(1) } }} />
    </div>
    <nav className={css.libraryPickerPath} aria-label={t('libraryPath')}
      hidden={!directory?.trail.length && !(source === 'shared' && directory)}>
      <Button variant="ghost" size="sm" aria-disabled={locked} onClick={() => { navigate() }}>{sources.find(item => item.value === source)?.label}</Button>
      {source === 'shared' && directory && <><span aria-hidden="true">/</span><Button variant="ghost" size="sm" aria-disabled={locked}
        onClick={() => { navigate({ location: { library: directory.location.library, parentId: null }, trail: [] }) }}>
        {directory.location.library.name}</Button></>}
      {directory?.trail.map((folder, index) => <span key={folder.id}><span aria-hidden="true">/</span><Button variant="ghost" size="sm"
        aria-disabled={locked} onClick={() => {
          navigate({ location: { library: directory.location.library, parentId: folder.id }, trail: directory.trail.slice(0, index + 1) })
        }}>{folder.name}</Button></span>)}
    </nav>
    <div className={css.libraryPickerFeedback}>
      {error !== undefined && <><p role="alert" tabIndex={0}>{productErrorMessage(error, t, 'libraryLoadFailed')}</p><Button variant="ghost" size="sm"
        aria-disabled={pending || locked} aria-busy={pending || openingId !== undefined} onClick={() => {
          if (active.current || locked) return
          if (failure?.folder) void openFolder(failure.folder)
          else setRevision(value => value + 1)
        }}>{t('retry')}</Button></>}
    </div>
    <div id={`${id}-files`} role="tabpanel" aria-labelledby={`${id}-${source}`} className={css.libraryPickerTable} aria-busy={pending}>
      <table aria-label={t('libraryFiles')}>
        <thead><tr><th scope="col">{t('libraryName')}</th><th scope="col">{t('libraryLocation')}</th><th scope="col">{t(source === 'recent' ? 'libraryAccessed' : 'updatedAt')}</th></tr></thead>
        <tbody>
          {!result && error === undefined && <tr><td colSpan={3}><LibraryLoading label={t('loading')} /></td></tr>}
          {result?.rows.map((row) => {
            const entry = 'entry' in row ? row.entry : undefined
            const library = 'library' in row ? row.library : undefined
            const name = entry?.name ?? library?.name ?? ''
            const folder = entry?.kind === 'FOLDER' || library !== undefined
            const date = 'date' in row ? row.date : library?.updatedAt
            return <tr key={entry?.id ?? library?.id} aria-selected={entry?.kind === 'FILE' ? selected.has(entry.id) : undefined}>
              <td><div className={css.libraryPickerName}>
                {entry?.kind === 'FILE' ? <Checkbox className={css.libraryPickerCheck} checked={selected.has(entry.id)} label={name} disabled={navigationLocked}
                  onChange={() => { if (!navigationLocked) onSelect(entry) }} /> : <span className={css.libraryPickerCheckSpace} />}
                <button type="button" className={css.libraryFileName} aria-disabled={locked} aria-busy={openingId !== undefined && openingId === entry?.id}
                  onClick={() => {
                    if (locked) return
                    if (library) navigate({ location: { library, parentId: null }, trail: [] })
                    else if (entry?.kind === 'FOLDER') void openFolder(entry)
                    else if (entry) onSelect(entry)
                  }}><FileTypeIcon {...(folder ? { kind: 'folder' } : { path: name })} size={22} /><span>{name}</span></button>
              </div></td>
              <td>{'libraryName' in row ? row.libraryName : t('libraryShared')}</td>
              <td><time dateTime={date ?? undefined}>{date ? new Date(date).toLocaleDateString() : '—'}</time></td>
            </tr>
          })}
          {result?.rows.length === 0 && <tr><td colSpan={3}><p className={css.libraryHomeEmpty}>{t(query ? 'libraryNoMatches' : source === 'shared' && !directory ? 'librarySharedEmpty' : 'libraryEmpty')}</p></td></tr>}
        </tbody>
      </table>
    </div>
    <div className={css.libraryPagination} hidden={page <= 1 && (result?.pages ?? 0) <= 1}>
      <Button variant="outline" size="sm" aria-disabled={pending || locked || page <= 1}
        onClick={() => { if (!pending && !locked && page > 1) setPage(value => value - 1) }}>{t('libraryPrevious')}</Button>
      <span>{page} / {Math.max(1, result?.pages ?? 0)}</span>
      <Button variant="outline" size="sm" aria-disabled={pending || locked || page >= (result?.pages ?? 0)}
        onClick={() => { if (!pending && !locked && page < (result?.pages ?? 0)) setPage(value => value + 1) }}>{t('libraryNext')}</Button>
    </div>
  </section>
}
