/** One directory browser shared by the library page and native attachment picker. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  IconDatabaseOutlineRegular,
  IconFolderCloseRegular,
  IconDeliverDocRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  LibrarySchema,
  LibraryEntrySchema,
  LibraryEntryPageSchema,
  LibraryPageSchema,
  type Library,
  type LibraryEntry,
} from '@deepseek-harness/product/library'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { useLibraryRequests } from './library-data.ts'
import { useResultFocus } from './useResultFocus.ts'
import { productErrorMessage } from './product-errors.ts'
import { ProductLoading } from './ProductLoading.tsx'
import { ProductActionLabel } from './ProductActionLabel.tsx'
import { LibraryMutation } from './LibraryMutation.tsx'
import { LibraryPreview } from './LibraryPreview.tsx'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { LibraryUpload } from './LibraryUpload.tsx'
type View = 'folder' | 'recent' | 'favorites'
export type LibraryText = (key: DeepSeekHarnessProductKey) => string
export interface LibraryLocation {
  readonly library: Library
  readonly parentId: string | null
}
/** Confirmed rows remain mounted while a request refreshes them; search and pagination do not cancel favorite writes.
 * @param props Optional file selection and native preview factory.
 * @returns Paginated libraries, folders and immutable files.
 */
export function LibraryBrowser({
  t,
  renderFactorySlot,
  selected,
  onSelect,
  onLocation,
  foldersOnly = false,
  rootLibrary,
  navigationLocked = false,
}: PropsRenderFactories & {
  readonly t: LibraryText
  readonly selected?: ReadonlyMap<string, LibraryEntry>
  readonly onSelect?: (entry: LibraryEntry) => void
  readonly foldersOnly?: boolean
  readonly rootLibrary?: Library
  /** Keep the selected destination and its controls mounted during a parent-owned write. */
  readonly navigationLocked?: boolean
  readonly onLocation?: (location: LibraryLocation | undefined) => void
}): ReactNode {
  const request = useLibraryRequests()
  const [libraries, setLibraries] = useState<readonly Library[]>()
  const [libraryPage, setLibraryPage] = useState(1)
  const [libraryPages, setLibraryPages] = useState(0)
  const [location, setLocation] = useState<LibraryLocation | undefined>(() =>
    rootLibrary ? { library: rootLibrary, parentId: null } : undefined,
  )
  const [trail, setTrail] = useState<readonly LibraryEntry[]>([])
  const [entries, setEntries] = useState<readonly LibraryEntry[]>()
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(0)
  const [libraryQuery, setLibraryQuery] = useState('')
  const [entryQuery, setEntryQuery] = useState('')
  const query = location === undefined ? libraryQuery : entryQuery
  const [view, setView] = useState<View>('folder')
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState(true)
  const activeRead = useRef<AbortController>()
  const [error, setError] = useState<unknown>()
  const errorRevision = useRef(0)
  const pageCorrection = useRef<{ key: string; feedbackRevision: number }>()
  const reportError = useCallback((failure?: unknown) => {
    errorRevision.current++
    setError(failure)
  }, [])
  const [favoriteFailure, setFavoriteFailure] = useState<{
    readonly entry: LibraryEntry
    readonly value: boolean
    readonly cause: unknown
  }>()
  const [editor, setEditor] = useState<{
    kind: 'library' | 'folder' | 'rename' | 'delete' | 'deleteLibrary' | 'move' | 'editLibrary'
    entry?: LibraryEntry
    library?: Library
  }>()
  const [uploading, setUploading] = useState(false)
  const [preview, setPreview] = useState<LibraryEntry>()
  const root = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const capture = useResultFocus(root, () => search.current?.focus({ preventScroll: true }))
  const modalArea = useRef<HTMLElement | null>(null)
  const captureModalClose = useResultFocus(modalArea, search)
  const preserveModalCloseFocus = () => {
    modalArea.current = root.current?.ownerDocument.body ?? null
    captureModalClose()
  }
  const operation = useRef<{ readonly kind: 'folder' | 'favorite'; readonly controller: AbortController }>()
  const [favoriteId, setFavoriteId] = useState<string>()
  const [openingId, setOpeningId] = useState<string>()
  const operationPending = favoriteId !== undefined || openingId !== undefined
  useEffect(
    () => () => {
      operation.current?.controller.abort()
      operation.current = undefined
    },
    [],
  )
  const refresh = () => {
    if (navigationLocked || operation.current || activeRead.current) return
    setRevision(value => value + 1)
  }
  useEffect(() => {
    onLocation?.(location)
  }, [location, onLocation])
  useEffect(() => {
    if (operation.current?.kind === 'folder') {
      operation.current.controller.abort()
      operation.current = undefined
    }
    setOpeningId(undefined)
    const controller = new AbortController()
    activeRead.current = controller
    let correctingPage = false
    const readKey = (nextLibraryPage = libraryPage, nextPage = page) =>
      JSON.stringify([location?.library.id, location?.parentId, nextLibraryPage, nextPage, query, view, foldersOnly, revision])
    const feedbackRevision = pageCorrection.current?.key === readKey() ? pageCorrection.current.feedbackRevision : errorRevision.current
    pageCorrection.current = undefined
    setPending(true)
    const read =
      location === undefined
        ? request('library.list', { page: libraryPage, size: 20, query }, controller.signal).then((value) => {
          const result = LibraryPageSchema.parse(value)
          controller.signal.throwIfAborted()
          if (libraryPage > Math.max(1, result.totalPages)) {
            correctingPage = true
            const nextPage = Math.max(1, result.totalPages)
            pageCorrection.current = { key: readKey(nextPage), feedbackRevision }
            setLibraryPage(nextPage)
            return
          }
          capture()
          setLibraries(result.data)
          setLibraryPages(result.totalPages)
        })
        : Promise.all([
          request('library.get', { libraryId: location.library.id }, controller.signal),
          request(
            'library.entries.list',
            { libraryId: location.library.id, parentId: location.parentId, page, size: 20, query, view: foldersOnly ? 'folders' : view },
            controller.signal,
          ),
        ]).then(([meta, value]) => {
          const library = LibrarySchema.parse(meta),
            result = LibraryEntryPageSchema.parse(value)
          controller.signal.throwIfAborted()
          if (page > Math.max(1, result.totalPages)) {
            correctingPage = true
            const nextPage = Math.max(1, result.totalPages)
            pageCorrection.current = { key: readKey(libraryPage, nextPage), feedbackRevision }
            setPage(nextPage)
            return
          }
          capture()
          setLocation(current => (current?.library.id === library.id ? { ...current, library } : current))
          setEntries(result.data)
          setPages(result.totalPages)
        })
    void read
      .then(() => {
        if (!controller.signal.aborted && !correctingPage && errorRevision.current === feedbackRevision) {
          capture()
          reportError()
        }
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted || errorRevision.current !== feedbackRevision) return
        capture()
        reportError(failure)
      })
      .finally(() => {
        if (activeRead.current === controller) activeRead.current = undefined
        if (!controller.signal.aborted && !correctingPage) setPending(false)
      })
    return () => {
      controller.abort()
      if (activeRead.current === controller) activeRead.current = undefined
    }
  }, [request, location?.library.id, location?.parentId, libraryPage, page, query, view, foldersOnly, revision, capture, reportError])
  const navigate = (next: LibraryLocation | undefined, breadcrumbs: readonly LibraryEntry[] = []) => {
    if (navigationLocked || operation.current) return
    const target = next ?? (rootLibrary ? { library: rootLibrary, parentId: null } : undefined)
    if (target?.library.id === location?.library.id && target?.parentId === location?.parentId
      && page === 1 && entryQuery === '' && view === 'folder') return
    capture()
    setLocation(target)
    setTrail(breadcrumbs)
    setEntries(undefined)
    reportError()
    setFavoriteFailure(undefined)
    setPage(1)
    setEntryQuery('')
    setView('folder')
  }
  const openFolder = async (entry: LibraryEntry) => {
    if (navigationLocked || operation.current || !location) return
    if (entry.parentId === location.parentId) {
      navigate({ library: location.library, parentId: entry.id }, [...trail, entry])
      return
    }
    const controller = new AbortController()
    const currentOperation = { kind: 'folder' as const, controller }
    operation.current = currentOperation
    setOpeningId(entry.id)
    try {
      const ancestors = [entry]
      const visited = new Set([entry.id])
      let parentId = entry.parentId
      while (parentId !== null) {
        if (visited.has(parentId)) throw new Error('Invalid library folder ancestry')
        visited.add(parentId)
        const parent = LibraryEntrySchema.parse(await request('library.entries.get', {
          libraryId: entry.libraryId, entryId: parentId,
        }, controller.signal))
        controller.signal.throwIfAborted()
        if (parent.id !== parentId || parent.libraryId !== entry.libraryId || parent.kind !== 'FOLDER') {
          throw new Error('Invalid library folder ancestry')
        }
        ancestors.unshift(parent)
        parentId = parent.parentId
      }
      controller.signal.throwIfAborted()
      operation.current = undefined
      navigate({ library: location.library, parentId: entry.id }, ancestors)
    } catch (failure) {
      if (!controller.signal.aborted) {
        capture()
        reportError(failure)
      }
    } finally {
      if (operation.current === currentOperation) operation.current = undefined
      if (!controller.signal.aborted) setOpeningId(undefined)
    }
  }
  const favorite = async (entry: LibraryEntry, value = !entry.favorite) => {
    if (operation.current) return
    const controller = new AbortController()
    const currentOperation = { kind: 'favorite' as const, controller }
    operation.current = currentOperation
    setFavoriteId(entry.id)
    try {
      await request(
        'library.entries.favorite',
        { libraryId: entry.libraryId, entryId: entry.id, value },
        controller.signal,
      )
      controller.signal.throwIfAborted()
      capture()
      setEntries(rows =>
        rows?.flatMap(row =>
          row.id !== entry.id
            ? [row]
            : view === 'favorites' && !value
              ? []
              : [{ ...row, favorite: value }],
        ),
      )
      setFavoriteFailure(current => current?.entry.id === entry.id ? undefined : current)
      setRevision(current => current + 1)
    } catch (failure) {
      if (!controller.signal.aborted) setFavoriteFailure({ entry, value, cause: failure })
    } finally {
      if (operation.current === currentOperation) {
        operation.current = undefined
        if (!controller.signal.aborted) setFavoriteId(undefined)
      }
    }
  }
  const committed = () => {
    preserveModalCloseFocus()
    if (editor?.kind === 'deleteLibrary' && location?.library.id === editor.library?.id) navigate(undefined)
    setEditor(undefined)
    setUploading(false)
    setRevision(value => value + 1)
  }
  const visibleEntries = entries?.filter(entry => !foldersOnly || entry.kind === 'FOLDER')
  const displayed = location === undefined ? libraries : visibleEntries
  return (
    <section ref={root} tabIndex={-1} className={css.libraryBrowser} aria-label={t('library')}>
      <div className={css.libraryToolbar}>
        <div className={css.libraryBreadcrumbs}>
          <Button
            variant="ghost"
            size="sm"
            aria-disabled={navigationLocked || operationPending}
            onClick={() => {
              navigate(undefined)
            }}
          >
            {t('library')}
          </Button>
          {location && (
            <>
              <span aria-hidden="true">/</span>
              <Button
                variant="ghost"
                size="sm"
                aria-disabled={navigationLocked || operationPending}
                onClick={() => {
                  navigate({ library: location.library, parentId: null })
                }}
              >
                {location.library.name}
              </Button>
            </>
          )}
          {trail.map((folder, index) => (
            <span key={folder.id}>
              <span aria-hidden="true"> / </span>
              <Button
                variant="ghost"
                size="sm"
                aria-disabled={navigationLocked || operationPending}
                onClick={() => {
                  if (location) navigate({ library: location.library, parentId: folder.id }, trail.slice(0, index + 1))
                }}
              >
                {folder.name}
              </Button>
            </span>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-disabled={pending || navigationLocked || operationPending}
          aria-busy={pending}
          onClick={() => {
            if (!pending) refresh()
          }}
        >
          {t('refresh')}
        </Button>
        {!onSelect && !foldersOnly && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setEditor({ kind: 'library' })
            }}
          >
            {t('libraryCreate')}
          </Button>
        )}
      </div>
      <div className={css.libraryToolbar}>
        <input
          ref={search}
          className={css.librarySearch}
          type="search"
          value={query}
          readOnly={navigationLocked}
          aria-label={t('librarySearch')}
          placeholder={t('librarySearch')}
          onChange={(event) => {
            if (navigationLocked) return
            if (location === undefined) {
              setLibraryQuery(event.target.value)
              setLibraryPage(1)
            } else {
              setEntryQuery(event.target.value)
              setPage(1)
            }
          }}
        />
        {location && (
          <>
            {!foldersOnly && (
              <div className={css.libraryTabs}>
                {(['folder', 'recent', 'favorites'] as const).map(value => (
                  <Button
                    key={value}
                    variant={view === value ? 'outline' : 'ghost'}
                    size="sm"
                    aria-pressed={view === value}
                    aria-disabled={operationPending}
                    onClick={() => {
                      if (!operation.current) {
                        setView(value)
                        setPage(1)
                      }
                    }}
                  >
                    {t(value === 'folder' ? 'libraryFiles' : value === 'recent' ? 'libraryRecent' : 'libraryFavorites')}
                  </Button>
                ))}
              </div>
            )}
            {!onSelect && !foldersOnly && location.library.canManage && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditor({ kind: 'folder' })
                  }}
                >
                  {t('libraryNewFolder')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setUploading(true)
                  }}
                >
                  {t('libraryUpload')}
                </Button>
              </>
            )}
          </>
        )}
      </div>
      <div className={css.libraryFeedback}>
        {error !== undefined && <>
          <div className={css.feedbackResult}>
            <span aria-hidden="true">{t('loadFailed')}</span>
            <div role="region" aria-label={t('loadFailed')} tabIndex={0} className={css.catalogError}>
              <p role="alert">{productErrorMessage(error, t, 'loadFailed')}</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            aria-disabled={pending || navigationLocked || operationPending}
            aria-busy={pending}
            onClick={() => {
              if (!pending) refresh()
            }}
          >
            {t('retry')}
          </Button>
        </>}
      </div>
      {!onSelect && !foldersOnly && location && (
        <div className={css.libraryFeedback}>
          {favoriteFailure && <>
            <div className={css.feedbackResult}>
              <span aria-hidden="true">{t('saveFailed')}</span>
              <div role="region" aria-label={t('saveFailed')} tabIndex={0} className={css.catalogError}>
                <p role="alert">{productErrorMessage(favoriteFailure.cause, t, 'saveFailed')}</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              aria-disabled={operationPending}
              aria-busy={favoriteId === favoriteFailure.entry.id}
              onClick={() => {
                void favorite(favoriteFailure.entry, favoriteFailure.value)
              }}
            >
              {t('retry')}
            </Button>
          </>}
        </div>
      )}
      <div className={css.libraryRows} aria-busy={pending}>
        {displayed === undefined && error === undefined && <ProductLoading label={t('loading')} />}
        {location === undefined
          ? libraries?.map(library => (
            <article key={library.id} className={css.libraryRow}>
              <IconDatabaseOutlineRegular size={22} />
              <Button
                variant="ghost"
                className={css.libraryRowTitle}
                aria-disabled={navigationLocked || operationPending}
                onClick={() => {
                  navigate({ library, parentId: null })
                }}
              >
                <strong>{library.name}</strong>
                <span>{library.description}</span>
              </Button>
              <span>
                {t(
                  library.scope === 'PERSONAL'
                    ? 'scopePersonal'
                    : library.scope === 'DEPARTMENT'
                      ? 'scopeDepartment'
                      : 'scopeCompany',
                )}
              </span>
              {!onSelect && !foldersOnly && library.canManage && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditor({ kind: 'editLibrary', library })
                    }}
                  >
                    {t('libraryEdit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditor({ kind: 'deleteLibrary', library })
                    }}
                  >
                    {t('deleteResource')}
                  </Button>
                </>
              )}
            </article>
          ))
          : visibleEntries?.map(entry => (
            <article key={entry.id} className={css.libraryRow}>
              {entry.kind === 'FOLDER' ? <IconFolderCloseRegular size={22} /> : <IconDeliverDocRegular size={22} />}
              <Button
                variant="ghost"
                className={css.libraryRowTitle}
                aria-disabled={navigationLocked || (entry.kind === 'FOLDER' && operationPending)}
                aria-busy={openingId === entry.id}
                onClick={() => {
                  if (navigationLocked) return
                  if (entry.kind === 'FOLDER')
                    void openFolder(entry)
                  else setPreview(entry)
                }}
              >
                <strong>{entry.name}</strong>
                <span>{entry.kind === 'FILE' ? `${Math.ceil(entry.sizeBytes / 1024)} KB` : t('libraryFolder')}</span>
              </Button>
              {entry.kind === 'FILE' && onSelect ? (
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={selected?.has(entry.id) === true}
                  onClick={() => {
                    onSelect(entry)
                  }}
                >
                  {t(selected?.has(entry.id) ? 'librarySelected' : 'libraryChoose')}
                </Button>
              ) : (
                !onSelect &&
                  !foldersOnly && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-pressed={entry.favorite}
                      aria-disabled={operationPending}
                      aria-busy={favoriteId === entry.id}
                      onClick={() => {
                        void favorite(entry)
                      }}
                    >
                      <ProductActionLabel pending={false} label={t(entry.favorite ? 'libraryUnfavorite' : 'libraryFavorite')}
                        pendingLabel={t(entry.favorite ? 'libraryFavorite' : 'libraryUnfavorite')} />
                    </Button>
                    {location.library.canManage && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditor({ kind: 'rename', entry })
                          }}
                        >
                          {t('libraryRename')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditor({ kind: 'move', entry })
                          }}
                        >
                          {t('libraryMove')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditor({ kind: 'delete', entry })
                          }}
                        >
                          {t('deleteResource')}
                        </Button>
                      </>
                    )}
                  </>
                )
              )}
            </article>
          ))}
        {displayed?.length === 0 && <p className={css.catalogStatus}>{t(
          location === undefined ? 'libraryDirectoryEmpty' : foldersOnly ? 'libraryFoldersEmpty' : 'libraryEmpty',
        )}</p>}
      </div>
      <div className={css.libraryPagination}>
        <Button
          variant="outline"
          size="sm"
          aria-disabled={(location ? page : libraryPage) <= 1 || pending || navigationLocked}
          onClick={() => {
            if (navigationLocked || pending || (location ? page : libraryPage) <= 1) return
            if (location) setPage(value => Math.max(1, value - 1))
            else setLibraryPage(value => Math.max(1, value - 1))
          }}
        >
          {t('libraryPrevious')}
        </Button>
        <span>
          {location ? page : libraryPage} / {Math.max(1, location ? pages : libraryPages)}
        </span>
        <Button
          variant="outline"
          size="sm"
          aria-disabled={(location ? page >= pages : libraryPage >= libraryPages) || pending || navigationLocked}
          onClick={() => {
            if (navigationLocked || pending) return
            if (location && page < pages) setPage(value => value + 1)
            else if (!location && libraryPage < libraryPages) setLibraryPage(value => value + 1)
          }}
        >
          {t('libraryNext')}
        </Button>
      </div>
      {editor && (
        <LibraryMutation
          kind={editor.kind}
          {...(editor.library
            ? { location: { library: editor.library, parentId: null } }
            : location
              ? { location }
              : {})}
          {...(editor.entry ? { entry: editor.entry } : {})}
          t={t}
          onClose={() => {
            preserveModalCloseFocus()
            setEditor(undefined)
          }}
          onCommitted={committed}
        />
      )}
      {uploading && location && (
        <LibraryUpload
          location={location}
          t={t}
          onClose={() => {
            preserveModalCloseFocus()
            setUploading(false)
          }}
          onCommitted={committed}
        />
      )}
      {preview && (
        <LibraryPreview
          entry={preview}
          renderFactorySlot={renderFactorySlot}
          t={t}
          onClose={() => {
            preserveModalCloseFocus()
            setPreview(undefined)
          }}
        />
      )}
    </section>
  )
}
