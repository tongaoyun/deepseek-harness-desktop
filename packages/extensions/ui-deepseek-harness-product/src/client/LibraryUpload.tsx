/** Native file selection and per-file receipts retain successful uploads during retries. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { z } from 'zod'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { LibrarySelectionSchema, type LibrarySelection } from '@deepseek-harness/product/library'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useLibraryRequests } from './library-data.ts'
import type { LibraryLocation, LibraryText } from './LibraryBrowser.tsx'
import { productErrorMessage } from './product-errors.ts'
import { useResultFocus } from './useResultFocus.ts'
import css from '../DeepSeekHarnessProduct.module.css'
/** Retry uses the original key for the same selected file; confirmed files are never submitted twice.
 * @param props Authorized destination and close/commit callbacks.
 * @returns Upload modal without document parsing or indexing settings.
 */
export function LibraryUpload({
  location,
  t,
  onClose,
  onCommitted,
}: {
  readonly location: LibraryLocation
  readonly t: LibraryText
  readonly onClose: () => void
  readonly onCommitted: () => void
}): ReactNode {
  const request = useLibraryRequests()
  const [files, setFiles] = useState<readonly LibrarySelection[]>([])
  const [pending, setPending] = useState<string>()
  const [selectionError, setSelectionError] = useState<unknown>()
  const [uploadError, setUploadError] = useState<unknown>()
  const busy = useRef(false)
  const writing = useRef(false)
  const lifetime = useRef(new AbortController())
  const owned = useRef<readonly LibrarySelection[]>([])
  const keys = useRef(new Map<string, string>())
  const confirmed = useRef(false)
  const chooseButton = useRef<HTMLButtonElement>(null)
  const selectionList = useRef<HTMLUListElement>(null)
  const capture = useResultFocus(selectionList, chooseButton)
  const feedback = useRef<HTMLDivElement>(null)
  const captureFeedback = useResultFocus(feedback, chooseButton)
  useEffect(
    () => {
      if (lifetime.current.signal.aborted) lifetime.current = new AbortController()
      const owner = lifetime.current
      return () => {
        owner.abort()
        for (const file of owned.current)
          void request('library.files.upload.discard', { selectionId: file.selectionId }).catch((failure: unknown) => {
            console.warn('Library selection cleanup failed', failure)
          })
      }
    },
    [request],
  )
  const choose = async () => {
    const signal = lifetime.current.signal
    if (busy.current) return
    busy.current = true
    setPending('select')
    try {
      signal.throwIfAborted()
      const selected = z
        .array(LibrarySelectionSchema)
        .parse(await request('library.files.upload.select', {}, signal))
      signal.throwIfAborted()
      if (selected.length === 0) return
      owned.current = [...owned.current, ...selected]
      setFiles(owned.current)
      captureFeedback()
      setSelectionError(undefined)
    } catch (failure) {
      if (!signal.aborted) setSelectionError(failure)
    } finally {
      busy.current = false
      if (!signal.aborted) setPending(undefined)
    }
  }
  const upload = async () => {
    const signal = lifetime.current.signal
    if (busy.current || files.length === 0) return
    busy.current = true
    writing.current = true
    try {
      signal.throwIfAborted()
      for (const file of files) {
        setPending(file.selectionId)
        const key = keys.current.get(file.selectionId) ?? randomUUID()
        keys.current.set(file.selectionId, key)
        await request(
          'library.files.upload',
          { selectionId: file.selectionId, libraryId: location.library.id, parentId: location.parentId, key },
          signal,
        )
        signal.throwIfAborted()
        void request('library.files.upload.discard', { selectionId: file.selectionId }).catch((failure: unknown) => {
          console.warn('Library selection cleanup failed', failure)
        })
        confirmed.current = true
        capture()
        owned.current = owned.current.filter(value => value.selectionId !== file.selectionId)
        setFiles(owned.current)
      }
      signal.throwIfAborted()
      onCommitted()
    } catch (failure) {
      if (!signal.aborted) setUploadError(failure)
    } finally {
      busy.current = false
      writing.current = false
      if (!signal.aborted) setPending(undefined)
    }
  }
  const remove = (selectionId: string) => {
    if (busy.current) return
    capture()
    owned.current = owned.current.filter(file => file.selectionId !== selectionId)
    keys.current.delete(selectionId)
    setFiles(owned.current)
    void request('library.files.upload.discard', { selectionId }).catch((failure: unknown) => {
      console.warn('Library selection cleanup failed', failure)
    })
  }
  const close = () => {
    if (!writing.current) {
      lifetime.current.abort()
      if (confirmed.current) onCommitted()
      else onClose()
    }
  }
  return (
    <Modal
      open
      title={t('libraryUpload')}
      closeLabel={t('close')}
      onClose={close}
      className={css.detailModal as string}
      contentClassName={css.detailModalContent as string}
      footer={
        <div className={css.libraryMutationFooter}>
          <div ref={feedback} className={css.libraryErrorStack}>
            <div className={css.feedbackResult}>
              <span aria-hidden="true">{t('librarySelectionFailed')}</span>
              {selectionError !== undefined && <div role="region" aria-label={t('librarySelectionFailed')} tabIndex={0} className={css.catalogError}>
                <p role="alert">{productErrorMessage(selectionError, t, 'librarySelectionFailed')}</p></div>}
            </div>
            <div className={css.feedbackResult}>
              <span aria-hidden="true">{t('saveFailed')}</span>
              {uploadError !== undefined && <div role="region" aria-label={t('saveFailed')} tabIndex={0} className={css.catalogError}>
                <p role="alert">{productErrorMessage(uploadError, t, 'saveFailed')}</p></div>}
            </div>
          </div>
          <div className={css.detailActions}>
            <Button variant="outline" aria-disabled={pending !== undefined && pending !== 'select'} onClick={close}>
              {t('close')}
            </Button>
            <Button
              variant="primary"
              aria-disabled={pending !== undefined || files.length === 0}
              aria-busy={pending !== undefined && pending !== 'select'}
              onClick={() => {
                void upload()
              }}
            >
              {t('libraryUpload')}
            </Button>
          </div>
        </div>
      }
    >
      <p className={css.libraryNavNote}>{location.library.name}{location.parentName && ` / ${location.parentName}`}</p>
      <Button
        ref={chooseButton}
        variant="outline"
        aria-disabled={pending !== undefined}
        aria-busy={pending === 'select'}
        onClick={() => {
          void choose()
        }}
      >
        {t('libraryChooseLocalFiles')}
      </Button>
      <ul ref={selectionList} className={css.libraryUploadFiles}>
        {files.map(file => (
          <li key={file.selectionId} aria-busy={pending === file.selectionId}>
            <span>{file.name} · {Math.ceil(file.sizeBytes / 1024)} KB</span>
            <Button variant="ghost" size="sm" aria-label={`${t('remove')}: ${file.name}`} aria-disabled={pending !== undefined}
              onClick={() => { remove(file.selectionId) }}>
              {t('remove')}
            </Button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
