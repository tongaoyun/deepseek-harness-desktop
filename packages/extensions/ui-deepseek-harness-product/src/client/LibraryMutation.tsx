/** Native modal forms keep draft nodes mounted through discard confirmation. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LibraryEntry } from '@deepseek-harness/product/library'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { LibraryBrowser, type LibraryLocation, type LibraryText } from './LibraryBrowser.tsx'
import { useEditorCloseGuard } from './useEditorCloseGuard.ts'
import { useLibraryRequests } from './library-data.ts'
import { productErrorMessage } from './product-errors.ts'
import css from '../DeepSeekHarnessProduct.module.css'
/** Save once; a later directory refresh is owned by the parent and cannot repeat the write.
 * @param props One metadata edit or explicit deletion and its immutable resource version.
 * @returns Native modal with retained inputs and scoped pending state.
 */
export function LibraryMutation({
  kind,
  location,
  entry,
  t,
  onClose,
  onCommitted,
}: {
  readonly kind: 'library' | 'folder' | 'rename' | 'move' | 'delete' | 'deleteLibrary' | 'editLibrary'
  readonly location?: LibraryLocation
  readonly entry?: LibraryEntry
  readonly t: LibraryText
  readonly onClose: () => void
  readonly onCommitted: () => void
}): ReactNode {
  const request = useLibraryRequests()
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
  const canSave = kind === 'move'
    ? entry !== undefined && destination !== undefined && destination.library.id === entry.libraryId
      && destination.library.canManage && destination.parentId !== entry.parentId && destination.parentId !== entry.id
    : deleted || name.trim().length > 0
  const title = t(
    kind === 'editLibrary'
      ? 'libraryEdit'
      : kind === 'library'
        ? 'libraryCreate'
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
    if (guard.confirming || writing.current || !canSave) return
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
        destination?.parentId,
        location?.library.id,
      ])
      if (operationKey.current?.fingerprint !== fingerprint) operationKey.current = { fingerprint, key: randomUUID() }
      const key = operationKey.current.key
      if (kind === 'editLibrary' && location)
        await invoke('library.update', {
          libraryId: location.library.id,
          name: savedName,
          description,
          scope: location.library.scope,
          version: location.library.version,
        })
      else if (kind === 'library')
        await invoke('library.create', { name: savedName, description, scope: 'PERSONAL', key })
      else if (kind === 'folder' && location)
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
      onCommitted()
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
      title={title}
      closeLabel={t('close')}
      onClose={guard.requestClose}
      className={`${css.detailModal} ${css.libraryDialog}`}
      contentClassName={css.detailModalContent as string}
      footer={
        <div className={css.libraryMutationFooter} hidden={guard.confirming}>
          <div className={css.feedbackResult}>
            <span aria-hidden="true">{t('libraryWait')}</span>
            {guard.blocked && pending && <p role="status" className={css.catalogStatus}>{t('libraryWait')}</p>}
          </div>
          <div className={css.feedbackResult}>
            <span aria-hidden="true">{t('saveFailed')}</span>
            {error !== undefined && <p role="alert" tabIndex={0} className={css.catalogError}>{productErrorMessage(error, t, 'saveFailed')}</p>}
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
                value={name}
                maxLength={180}
                onChange={(event) => {
                  setName(event.target.value)
                }}
                readOnly={pending}
              />
            </label>
            {(kind === 'library' || kind === 'editLibrary') && (
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
