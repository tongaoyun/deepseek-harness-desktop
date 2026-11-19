/** Directory navigation and destination selection for library mutations. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  Input,
  IconDatabaseOutlineRegular,
  IconFolderCloseRegular,
  IconDeliverDocRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  LibrarySchema,
  LibraryEntryPageSchema,
  LibraryPageSchema,
  type Library,
  type LibraryEntry,
} from '@deepseek-harness/product/library'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { readLibraryTrail, useLibraryRequests } from './library-data.ts'
import { useResultFocus } from './useResultFocus.ts'
import { productErrorMessage } from './product-errors.ts'
import { LibraryLoading } from './LibraryLoading.tsx'
import { LibraryMutation } from './LibraryMutation.tsx'
import { LibraryPreview } from './LibraryPreview.tsx'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { LibraryUpload } from './LibraryUpload.tsx'
type View = 'folder' | 'recent'
export type LibraryText = (key: DeepSeekHarnessProductKey) => string
export interface LibraryLocation {
  readonly library: Library
  readonly parentId: string | null
  /** Display name of the confirmed destination folder; absent for a library root. */
  readonly parentName?: string
}
/** Confirmed rows remain mounted while a request refreshes them.
 * @param props Destination navigation and native preview factory.
 * @returns Paginated libraries, folders and immutable files.
 */
export function LibraryBrowser({
  t,
  renderFactorySlot,
  onLocation,
  foldersOnly = false,
  allowFolderCreation = true,
  rootLibrary,
  navigationLocked = false,
}: PropsRenderFactories & {
  readonly t: LibraryText
  readonly foldersOnly?: boolean
  readonly allowFolderCreation?: boolean
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
  const [personalReady, setPersonalReady] = useState(!foldersOnly || rootLibrary !== undefined)
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
  const [error, setError] = useState<{ readonly failure: unknown; readonly folder?: LibraryEntry }>()
  const errorRevision = useRef(0)
  const pageCorrection = useRef<{ key: string; feedbackRevision: number }>()
  const reportError = useCallback((failure?: unknown, folder?: LibraryEntry) => {
    errorRevision.current++
    setError(failure === undefined ? undefined : { failure, ...(folder ? { folder } : {}) })
  }, [])
  const [editor, setEditor] = useState<{
    kind: 'folder' | 'rename' | 'delete' | 'deleteLibrary' | 'move' | 'editLibrary'
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
  const operation = useRef<AbortController>()
  const [openingId, setOpeningId] = useState<string>()
  const operationPending = openingId !== undefined
  useEffect(
    () => {
      if (navigationLocked) setOpeningId(undefined)
      return () => {
        operation.current?.abort()
        operation.current = undefined
      }
    },
    [navigationLocked],
  )
  const refresh = () => {
    if (navigationLocked || operation.current || activeRead.current) return
    setRevision(value => value + 1)
  }
  useEffect(() => {
    onLocation?.(location)
  }, [location, onLocation])
  useEffect(() => {
    if (operation.current) {
      operation.current.abort()
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
      !personalReady
        ? request('library.personal.ensure', {}, controller.signal).then((value) => {
          const library = LibrarySchema.parse(value)
          controller.signal.throwIfAborted()
          capture()
          correctingPage = true
          setLocation({ library, parentId: null })
          setPersonalReady(true)
        })
        : location === undefined
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
            request('library.get', { libraryId: location.library.id }, controller.signal).then((value) => {
              const library = LibrarySchema.parse(value)
              controller.signal.throwIfAborted()
              capture()
              setLocation(current => (current?.library.id === library.id ? { ...current, library } : current))
            }),
            request(
              'library.entries.list',
              { libraryId: location.library.id, parentId: location.parentId, page, size: 20, query, view: foldersOnly ? 'folders' : view },
              controller.signal,
            ),
          ]).then(([, value]) => {
            const result = LibraryEntryPageSchema.parse(value)
            controller.signal.throwIfAborted()
            if (page > Math.max(1, result.totalPages)) {
              correctingPage = true
              const nextPage = Math.max(1, result.totalPages)
              pageCorrection.current = { key: readKey(libraryPage, nextPage), feedbackRevision }
              setPage(nextPage)
              return
            }
            capture()
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
  }, [request, personalReady, location?.library.id, location?.parentId, libraryPage, page, query, view, foldersOnly,
    revision, capture, reportError])
  const navigate = (next: LibraryLocation | undefined, breadcrumbs: readonly LibraryEntry[] = []) => {
    if (navigationLocked || operation.current) return
    const target = next ?? (rootLibrary ? {
      library: location?.library.id === rootLibrary.id ? location.library : rootLibrary, parentId: null,
    } : undefined)
    const sameDirectory = target?.library.id === location?.library.id && target?.parentId === location?.parentId
    if (sameDirectory && page === 1 && entryQuery === '' && view === 'folder') return
    capture()
    const parentName = breadcrumbs.at(-1)?.name
    setLocation(target && { ...target, ...(parentName ? { parentName } : {}) })
    setTrail(breadcrumbs)
    if (!sameDirectory) { setEntries(undefined); reportError() }
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
    const currentOperation = controller
    operation.current = currentOperation
    setOpeningId(entry.id)
    try {
      const ancestors = await readLibraryTrail(request, entry, controller.signal)
      controller.signal.throwIfAborted()
      operation.current = undefined
      navigate({ library: location.library, parentId: entry.id }, ancestors)
    } catch (failure) {
      if (!controller.signal.aborted) {
        capture()
        reportError(failure, entry)
      }
    } finally {
      if (operation.current === currentOperation) operation.current = undefined
      if (!controller.signal.aborted) setOpeningId(undefined)
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
        {!foldersOnly && <Button
          variant="outline"
          size="sm"
          aria-disabled={pending || navigationLocked || operationPending}
          aria-busy={pending}
          onClick={() => {
            if (!pending) refresh()
          }}
        >
          {t('refresh')}
        </Button>}
      </div>
      <div className={css.libraryToolbar}>
        <Input
          ref={search}
          className={css.librarySearch as string}
          type="search"
          maxLength={180}
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
                {(['folder', 'recent'] as const).map(value => (
                  <Button
                    key={value}
                    variant={view === value ? 'outline' : 'ghost'}
                    size="sm"
                    aria-pressed={view === value}
                    aria-disabled={navigationLocked || operationPending}
                    onClick={() => {
                      if (!navigationLocked && !operation.current) {
                        setView(value)
                        setPage(1)
                      }
                    }}
                  >
                    {t(value === 'folder' ? 'libraryFiles' : 'libraryRecent')}
                  </Button>
                ))}
              </div>
            )}
            {allowFolderCreation && location.library.canManage && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  aria-disabled={navigationLocked || operationPending}
                  onClick={() => {
                    if (navigationLocked || operation.current) return
                    setEditor({ kind: 'folder' })
                  }}
                >
                  {t('libraryNewFolder')}
                </Button>
                {!foldersOnly && <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setUploading(true)
                  }}
                >
                  {t('libraryUpload')}
                </Button>}
              </>
            )}
          </>
        )}
      </div>
      <div className={css.libraryFeedback}>
        {error !== undefined && <>
          <div className={css.feedbackResult}>
            <span aria-hidden="true">{t('libraryLoadFailed')}</span>
            <div role="region" aria-label={t('libraryLoadFailed')} tabIndex={0} className={css.catalogError}>
              <p role="alert">{productErrorMessage(error.failure, t, 'libraryLoadFailed')}</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            aria-disabled={pending || navigationLocked || operationPending}
            aria-busy={pending || operationPending}
            onClick={() => {
              if (pending || navigationLocked || operation.current) return
              if (error.folder) void openFolder(error.folder)
              else refresh()
            }}
          >
            {t('retry')}
          </Button>
        </>}
      </div>
      <div className={css.libraryRows} aria-busy={pending}>
        {displayed === undefined && error === undefined && <LibraryLoading label={t('loading')} />}
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
              </Button>
              <span>
                {t(
                  library.scope === 'PERSONAL'
                    ? 'scopePersonal'
                    : 'libraryShared',
                )}
              </span>
              {!foldersOnly && library.scope === 'TEAM' && library.role === 'OWNER' && (
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
              {!foldersOnly && (
                <>
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
              )}
            </article>
          ))}
        {displayed?.length === 0 && <p className={css.libraryDirectoryEmpty}>{t(
          location === undefined ? 'libraryDirectoryEmpty' : foldersOnly ? 'libraryFoldersEmpty' : 'libraryEmpty',
        )}</p>}
      </div>
      <div className={css.libraryPagination} hidden={(location ? page : libraryPage) <= 1 && (location ? pages : libraryPages) <= 1}>
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
