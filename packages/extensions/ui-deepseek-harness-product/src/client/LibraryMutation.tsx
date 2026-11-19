/** Native modal forms keep draft nodes mounted through discard confirmation. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { LibraryEntrySchema, LibrarySchema, type Library, type LibraryEntry } from '@deepseek-harness/product/library'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { LibraryBrowser, type LibraryLocation, type LibraryText } from './LibraryBrowser.tsx'
import { useEditorCloseGuard } from './useEditorCloseGuard.ts'
import { useResultFocus } from './useResultFocus.ts'
import { useLibraryRequests } from './library-data.ts'
import { productErrorMessage } from './product-errors.ts'
import css from '../DeepSeekHarnessProduct.module.css'
/** Save once; a later directory refresh is owned by the parent and cannot repeat the write.
 * @param props One metadata edit or explicit deletion and its immutable resource version.
 * @returns Native modal with retained inputs and scoped pending state.
 */
export function LibraryMutation({
  kind,
  location: initialLocation,
  entry: initialEntry,
  t,
  onClose,
  onCommitted,
}: {
  readonly kind: 'createLibrary' | 'folder' | 'rename' | 'move' | 'delete' | 'deleteLibrary' | 'editLibrary'
  readonly location?: LibraryLocation
  readonly entry?: LibraryEntry
  readonly t: LibraryText
  readonly onClose: () => void
  readonly onCommitted: (location?: LibraryLocation) => void
}): ReactNode {
  const request = useLibraryRequests()
  const [personalRoot, setPersonalRoot] = useState<LibraryLocation>()
  const [checkedEntry, setCheckedEntry] = useState<LibraryEntry>()
  const [checkedLibrary, setCheckedLibrary] = useState<Library>()
  const entry = checkedEntry ?? initialEntry
  const sourceLocation = initialLocation ?? personalRoot
  const location = checkedLibrary && sourceLocation ? { ...sourceLocation, library: checkedLibrary } : sourceLocation
  const nameInput = useRef<HTMLInputElement>(null)
  const saveButton = useRef<HTMLButtonElement>(null)
  const rootFeedback = useRef<HTMLDivElement>(null)
  const captureRootResult = useResultFocus(rootFeedback, kind === 'delete' || kind === 'deleteLibrary' ? saveButton : nameInput)
  const [rootPending, setRootPending] = useState(kind === 'folder' && !initialLocation)
  const [rootError, setRootError] = useState<unknown>()
  const [rootRevision, setRootRevision] = useState(0)
  const rootRead = useRef(false)
  useEffect(() => {
    if (kind !== 'folder' || initialLocation) return
    const controller = new AbortController()
    rootRead.current = true
    setRootPending(true)
    void request('library.personal.ensure', {}, controller.signal).then((value) => {
      const library = LibrarySchema.parse(value)
      controller.signal.throwIfAborted()
      captureRootResult()
      setPersonalRoot({ library, parentId: null })
      setRootError(undefined)
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setRootError(failure)
    }).finally(() => {
      if (!controller.signal.aborted) { rootRead.current = false; setRootPending(false) }
    })
    return () => { controller.abort() }
  }, [request, kind, initialLocation, rootRevision, captureRootResult])
  const [name, setName] = useState(entry?.name ?? (kind === 'editLibrary' ? location?.library.name : '') ?? '')
  const [destination, setDestination] = useState<LibraryLocation>()
  const [operation, setOperation] = useState<'save' | 'reread'>()
  const pending = operation !== undefined
  const [error, setError] = useState<unknown>()
  const [conflict, setConflict] = useState(false)
  const [errorFallback, setErrorFallback] = useState<'saveFailed' | 'libraryLoadFailed'>('saveFailed')
  const lifetime = useRef(new AbortController())
  useEffect(
    () => {
      if (lifetime.current.signal.aborted) lifetime.current = new AbortController()
      const owner = lifetime.current
      return () => { owner.abort() }
    },
    [],
  )
  const writing = useRef(false)
  const operationKey = useRef<{ fingerprint: string; key: string }>()
  const initialName = initialEntry?.name ?? (kind === 'editLibrary' ? initialLocation?.library.name : '') ?? ''
  const deleted = kind === 'delete' || kind === 'deleteLibrary'
  const guard = useEditorCloseGuard(
    !deleted && kind !== 'move' && kind !== 'createLibrary' && name !== initialName,
    () => writing.current,
    onClose,
  )
  const canSave = kind === 'move'
    ? entry !== undefined && destination !== undefined && destination.library.id === entry.libraryId
      && destination.library.canManage && destination.parentId !== entry.parentId && destination.parentId !== entry.id
    : deleted || (name.trim().length > 0 && (kind !== 'folder' || location?.library.canManage === true))
  const title = t(
    kind === 'createLibrary' ? 'libraryNewTeam' : kind === 'editLibrary'
      ? 'libraryEdit'
      : kind === 'folder'
        ? 'libraryNewFolder'
        : kind === 'rename'
          ? 'libraryRename'
          : kind === 'move'
            ? 'libraryMove'
            : 'deleteResource',
  )
  const save = async () => {
    const signal = lifetime.current.signal
    if (guard.confirming || writing.current || conflict || !canSave) return
    const invoke = (method: string, payload: unknown) => request(method, payload, signal)
    guard.clearBlocked()
    writing.current = true
    setOperation('save')
    try {
      signal.throwIfAborted()
      const savedName = name.trim()
      const fingerprint = JSON.stringify([
        kind,
        savedName,
        entry?.id,
        kind === 'move' ? destination?.parentId : location?.parentId,
        location?.library.id,
      ])
      if (operationKey.current?.fingerprint !== fingerprint) operationKey.current = { fingerprint, key: randomUUID() }
      const key = operationKey.current.key
      let committedLocation = location
      if (kind === 'createLibrary') {
        const library = LibrarySchema.parse(await invoke('library.create', { name: savedName, key }))
        committedLocation = { library, parentId: null }
      } else if (kind === 'editLibrary' && location) {
        const library = LibrarySchema.parse(await invoke('library.update', {
          libraryId: location.library.id,
          name: savedName,
          version: location.library.version,
        }))
        committedLocation = { ...location, library }
      } else if (kind === 'folder' && location)
        await invoke('library.folders.create', {
          libraryId: location.library.id,
          parentId: location.parentId,
          name: savedName,
          key,
        })
      else if ((kind === 'rename' || kind === 'move') && entry)
        await invoke('library.entries.update', {
          libraryId: entry.libraryId,
          entryId: entry.id,
          name: kind === 'move' ? entry.name : savedName,
          parentId: kind === 'move' ? destination?.parentId : entry.parentId,
          version: entry.version,
        })
      else if (kind === 'delete' && entry)
        await invoke('library.entries.delete', {
          libraryId: entry.libraryId,
          entryId: entry.id,
          version: entry.version,
        })
      else if (kind === 'deleteLibrary' && location)
        await invoke('library.delete', { libraryId: location.library.id, version: location.library.version })
      else throw new Error('Missing library selection')
      signal.throwIfAborted()
      onCommitted(committedLocation)
    } catch (failure) {
      if (!signal.aborted) {
        setError(failure); setErrorFallback('saveFailed')
        if (productFailure(failure).code === 'LIBRARY_CONFLICT') setConflict(true)
      }
    } finally {
      writing.current = false
      if (!signal.aborted) setOperation(undefined)
    }
  }
  const reread = async () => {
    const signal = lifetime.current.signal
    const libraryId = entry?.libraryId ?? location?.library.id
    if (!libraryId || !conflict || writing.current || guard.confirming) return
    writing.current = true; setOperation('reread'); guard.clearBlocked()
    try {
      const library = LibrarySchema.parse(await request('library.get', { libraryId }, signal))
      signal.throwIfAborted()
      if (!library.canManage || (!entry && library.role !== 'OWNER'))
        throw new ProductError('LIBRARY_MANAGEMENT_FORBIDDEN', 'Library management unavailable', false)
      const latest = entry ? LibraryEntrySchema.parse(await request('library.entries.get', { libraryId, entryId: entry.id }, signal)) : undefined
      signal.throwIfAborted()
      captureRootResult(); setCheckedEntry(latest); setCheckedLibrary(library); setConflict(false); setError(undefined)
    } catch (failure) {
      if (!signal.aborted) { setError(failure); setErrorFallback('libraryLoadFailed') }
    } finally {
      writing.current = false
      if (!signal.aborted) setOperation(undefined)
    }
  }
  const changeLocation = useCallback((value: LibraryLocation | undefined) => {
    setDestination(value)
  }, [])
  return (
    <Modal
      open
      title={title}
      closeLabel={t('close')}
      onClose={guard.requestClose}
      className={`${css.detailModal} ${css.libraryModal} ${kind === 'move' ? css.libraryPicker : css.libraryDialog}`}
      contentClassName={css.detailModalContent as string}
      footer={
        <div className={css.libraryMutationFooter} hidden={guard.confirming}>
          <div ref={rootFeedback} className={css.libraryMutationFeedback}>
            <div className={css.feedbackResult}>
              <span aria-hidden="true">{t('saveFailed')}</span>
              {(error !== undefined || rootError !== undefined) && <p role="alert" tabIndex={0} className={css.catalogError}>
                {productErrorMessage(error ?? rootError, t, error !== undefined ? errorFallback : 'libraryLoadFailed')}
              </p>}
            </div>
            {guard.blocked && pending && <div role="region" aria-label={t('libraryWait')} tabIndex={0} className={css.libraryWaitStatus}>
              <p role="status">{t('libraryWait')}</p>
            </div>}
            {rootError !== undefined && <Button variant="outline" size="sm" aria-disabled={rootPending} aria-busy={rootPending} onClick={() => {
              if (rootRead.current) return
              rootRead.current = true
              setRootRevision(value => value + 1)
            }}>{t('retry')}</Button>}
            {conflict && <Button variant="outline" size="sm" aria-disabled={pending} aria-busy={operation === 'reread'}
              onClick={() => { void reread() }}>{t('libraryReread')}</Button>}
          </div>
          <div className={css.detailActions}>
            <Button variant="outline" aria-disabled={pending} onClick={guard.requestClose}>
              {t('cancel')}
            </Button>
            <Button
              ref={saveButton}
              variant="primary"
              aria-disabled={pending || conflict || !canSave}
              aria-busy={operation === 'save'}
              onClick={() => {
                void save()
              }}
            >
              {t(deleted ? 'deleteResource' : 'saveResource')}
            </Button>
          </div>
        </div>
      }
    >
      <div {...guard.editorProps} hidden={guard.confirming}>
        {deleted ? (
          <p>
            {t(kind === 'deleteLibrary' ? 'libraryDeleteLibraryConfirm' : 'libraryDeleteConfirm').replace(
              '{name}',
              entry?.name ?? location?.library.name ?? '',
            )}
          </p>
        ) : kind === 'move' ? (
          <LibraryBrowser
            t={t}
            foldersOnly
            navigationLocked={pending}
            {...(location ? { rootLibrary: location.library } : {})}
            onLocation={changeLocation}
            renderFactorySlot={(_name, _props, options) => options?.fallback ?? null}
          />
        ) : (
          <>
            <label className={css.libraryField}>
              {t('libraryName')}
              <input
                ref={nameInput}
                data-modal-autofocus
                value={name}
                maxLength={180}
                onChange={(event) => {
                  setName(event.target.value)
                }}
                readOnly={pending}
              />
            </label>
            {kind === 'createLibrary' && <p>{t('libraryTeamPrivate')}</p>}

          </>
        )}
      </div>
      {guard.confirming && (
        <div>
          <p>{t('libraryDiscardConfirm')}</p>
          <Button ref={guard.keepEditingRef} variant="outline" onClick={guard.keepEditing}>
            {t('libraryKeepEditing')}
          </Button>
          <Button variant="primary" onClick={guard.discard}>
            {t('libraryDiscard')}
          </Button>
        </div>
      )}
    </Modal>
  )
}
