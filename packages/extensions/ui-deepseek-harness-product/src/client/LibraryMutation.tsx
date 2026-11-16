/** Native modal forms keep draft nodes mounted through discard confirmation. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { LibrarySchema, type LibraryEntry } from '@deepseek-harness/product/library'
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
  entry,
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
  const [folderLocation, setFolderLocation] = useState<LibraryLocation>()
  const location = folderLocation ?? initialLocation ?? personalRoot
  const nameInput = useRef<HTMLInputElement>(null)
  const rootFeedback = useRef<HTMLDivElement>(null)
  const captureRootResult = useResultFocus(rootFeedback, nameInput)
  const [rootPending, setRootPending] = useState(kind === 'folder' && !initialLocation)
  const [rootError, setRootError] = useState<unknown>()
  const [rootRevision, setRootRevision] = useState(0)
  const rootRead = useRef(false)
  const [choosingLocation, setChoosingLocation] = useState(false)
  const locationButton = useRef<HTMLButtonElement>(null)
  const locationPicker = useRef<HTMLDivElement>(null)
  const locationFocusArea = useRef<HTMLElement | null>(null)
  const captureLocationClose = useResultFocus(locationFocusArea, locationButton)
  const closeLocation = () => {
    locationFocusArea.current = locationPicker.current?.closest<HTMLElement>('[role="dialog"]') ?? null
    captureLocationClose()
    setChoosingLocation(false)
  }
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
  const [description, setDescription] = useState(kind === 'editLibrary' ? (location?.library.description ?? '') : '')
  const [destination, setDestination] = useState<LibraryLocation>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>()
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
  const initialName = entry?.name ?? (kind === 'editLibrary' ? location?.library.name : '') ?? ''
  const initialDescription = kind === 'editLibrary' ? (location?.library.description ?? '') : ''
  const deleted = kind === 'delete' || kind === 'deleteLibrary'
  const guard = useEditorCloseGuard(
    !deleted && kind !== 'move' && (name !== initialName || description !== initialDescription),
    () => writing.current,
    onClose,
  )
  const captureLocationOpen = useResultFocus(guard.editorProps.ref, () => {
    locationPicker.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
  })
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
    if (guard.confirming || choosingLocation || writing.current || !canSave) return
    const invoke = (method: string, payload: unknown) => request(method, payload, signal)
    guard.clearBlocked()
    writing.current = true
    setPending(true)
    try {
      signal.throwIfAborted()
      const savedName = name.trim()
      const fingerprint = JSON.stringify([
        kind,
        savedName,
        description,
        entry?.id,
        kind === 'move' ? destination?.parentId : location?.parentId,
        location?.library.id,
      ])
      if (operationKey.current?.fingerprint !== fingerprint) operationKey.current = { fingerprint, key: randomUUID() }
      const key = operationKey.current.key
      let committedLocation = location
      if (kind === 'createLibrary') {
        const library = LibrarySchema.parse(await invoke('library.create', { name: savedName, description, key }))
        committedLocation = { library, parentId: null }
      } else if (kind === 'editLibrary' && location) {
        const library = LibrarySchema.parse(await invoke('library.update', {
          libraryId: location.library.id,
          name: savedName,
          description,
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
      if (!signal.aborted) setError(failure)
    } finally {
      writing.current = false
      if (!signal.aborted) setPending(false)
    }
  }
  const changeLocation = useCallback((value: LibraryLocation | undefined) => {
    setDestination(value)
  }, [])
  return (
    <Modal
      open
      title={choosingLocation ? t('libraryFolderDestination') : title}
      closeLabel={t('close')}
      onClose={choosingLocation ? closeLocation : guard.requestClose}
      className={`${css.detailModal} ${choosingLocation || kind === 'move' ? css.libraryPicker : css.libraryDialog}`}
      contentClassName={css.detailModalContent as string}
      footer={
        choosingLocation ? <div className={css.libraryPickerActions}>
          <Button variant="outline" onClick={closeLocation}>{t('cancel')}</Button>
          <Button variant="primary" aria-disabled={!destination?.library.canManage} onClick={() => {
            if (!destination?.library.canManage) return
            setFolderLocation(destination)
            closeLocation()
          }}>{t('libraryChoose')}</Button>
        </div> : <div className={css.libraryMutationFooter} hidden={guard.confirming}>
          <div ref={rootFeedback} className={css.libraryMutationFeedback}>
            <div className={css.feedbackResult}>
              <span aria-hidden="true">{t('saveFailed')}</span>
              {(error !== undefined || rootError !== undefined) && <p role="alert" tabIndex={0} className={css.catalogError}>
                {productErrorMessage(error ?? rootError, t, error !== undefined ? 'saveFailed' : 'libraryLoadFailed')}
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
          </div>
          <div className={css.detailActions}>
            <Button variant="outline" aria-disabled={pending} onClick={guard.requestClose}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              aria-disabled={pending || !canSave}
              aria-busy={pending}
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
      <div {...guard.editorProps} hidden={guard.confirming || choosingLocation}>
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
            {kind === 'folder' && <div className={css.libraryFolderLocation}>
              <span>{t('librarySaveLocation')}</span>
              <span>{location?.library.name ?? t('libraryPersonal')}{location?.parentName && ` / ${location.parentName}`}</span>
              <Button ref={locationButton} variant="ghost" size="sm" aria-disabled={pending || !location} onClick={() => {
                if (pending || !location) return
                setDestination(undefined)
                captureLocationOpen()
                setChoosingLocation(true)
              }}>{t('libraryChangeLocation')}</Button>
            </div>}
            {kind === 'createLibrary' && <p>{t('libraryTeamPrivate')}</p>}
            {(kind === 'editLibrary' || kind === 'createLibrary') && (
              <label className={css.libraryField}>
                {t('libraryDescription')}
                <textarea
                  value={description}
                  maxLength={1000}
                  onChange={(event) => {
                    setDescription(event.target.value)
                  }}
                  readOnly={pending}
                />
              </label>
            )}
          </>
        )}
      </div>
      {choosingLocation && <div ref={locationPicker}>
        <LibraryBrowser t={t} foldersOnly onLocation={changeLocation} allowFolderCreation={false}
          renderFactorySlot={(_name, _props, options) => options?.fallback ?? null} />
      </div>}
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
