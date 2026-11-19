/** Native file selection and per-file receipts retain successful uploads during retries. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { z } from 'zod'
import { Button, IconFolderCloseRegular, IconUploadOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { LibraryEntrySchema, LibrarySelectionSchema, type LibrarySelection } from '@deepseek-harness/product/library'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { ProductError } from '@deepseek-harness/product/errors'
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
  const [reviewing, setReviewing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [selectionError, setSelectionError] = useState<unknown>()
  const [uploadError, setUploadError] = useState<unknown>()
  const busy = useRef(false)
  const writing = useRef(false)
  const lifetime = useRef(new AbortController())
  const owned = useRef<readonly LibrarySelection[]>([])
  const keys = useRef(new Map<string, string>())
  const folders = useRef(new Map<string, { readonly key: string; id?: string }>())
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
  const choose = async (input: { readonly mode?: 'folder'; readonly paths?: readonly string[] } = {}) => {
    const signal = lifetime.current.signal
    if (busy.current) return
    busy.current = true
    setPending(input.paths ? 'drop' : input.mode ?? 'select')
    try {
      signal.throwIfAborted()
      const selected = z
        .array(LibrarySelectionSchema)
        .parse(await request('library.files.upload.select', input, signal))
      signal.throwIfAborted()
      if (selected.length === 0) return
      const names = new Set(owned.current.map(file => JSON.stringify([...file.folders ?? [], file.name].map(name => name.trim()))))
      const conflict = selected.some((file) => {
        const path = JSON.stringify([...file.folders ?? [], file.name].map(name => name.trim()))
        if (names.has(path)) return true
        names.add(path)
        return false
      })
      if (conflict) {
        for (const file of selected) void request('library.files.upload.discard', { selectionId: file.selectionId }).catch((failure: unknown) => {
          console.warn('Library selection cleanup failed', failure)
        })
        throw new ProductError('LIBRARY_SELECTION_CONFLICT', 'Selected paths have the same destination', false)
      }
      setReviewing(true)
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
        let parentId = location.parentId
        const segments: string[] = []
        for (const name of [...file.folders ?? [], ...(file.kind === 'FOLDER' ? [file.name] : [])]) {
          segments.push(name)
          const path = JSON.stringify(segments)
          let folder = folders.current.get(path)
          if (!folder) { folder = { key: randomUUID() }; folders.current.set(path, folder) }
          if (!folder.id) {
            const entry = LibraryEntrySchema.parse(await request('library.folders.create', {
              libraryId: location.library.id, parentId, name, key: folder.key,
            }, signal))
            signal.throwIfAborted()
            if (entry.kind !== 'FOLDER' || entry.libraryId !== location.library.id || entry.parentId !== parentId || entry.name !== name.trim())
              throw new Error('Invalid folder creation receipt')
            folder.id = entry.id
            confirmed.current = true
          }
          parentId = folder.id
        }
        if (file.kind === 'FILE') {
          const key = keys.current.get(file.selectionId) ?? randomUUID()
          keys.current.set(file.selectionId, key)
          await request(
            'library.files.upload',
            { selectionId: file.selectionId, libraryId: location.library.id, parentId, key },
            signal,
          )
        }
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
    const selected = owned.current.find(file => file.selectionId === selectionId)
    const path = selected?.kind === 'FOLDER' ? [...selected.folders ?? [], selected.name] : undefined
    const removed = owned.current.filter(file => file.selectionId === selectionId
      || path && path.every((name, index) => file.folders?.[index] === name))
    const ids = new Set(removed.map(file => file.selectionId))
    capture()
    owned.current = owned.current.filter(file => !ids.has(file.selectionId))
    for (const id of ids) keys.current.delete(id)
    setFiles(owned.current)
    for (const id of ids) void request('library.files.upload.discard', { selectionId: id }).catch((failure: unknown) => {
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
  const selecting = pending === 'select' || pending === 'folder' || pending === 'drop'
  return (
    <Modal
      open
      title={t('libraryUpload')}
      closeLabel={t('close')}
      onClose={close}
      className={`${css.detailModal} ${css.libraryModal} ${css.libraryUploadDialog}`}
      contentClassName={css.detailModalContent as string}
      footer={!reviewing && selectionError === undefined && uploadError === undefined ? undefined :
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
            <Button variant="outline" aria-disabled={pending !== undefined && !selecting} onClick={close}>
              {t('close')}
            </Button>
            <Button
              variant="primary"
              aria-disabled={pending !== undefined || files.length === 0}
              aria-busy={pending !== undefined && !selecting}
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
      <div className={css.libraryUploadDrop} data-dragging={dragging || undefined}
        role="group" aria-label={t('libraryDropFiles')}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault(); event.stopPropagation()
          if (busy.current) { event.dataTransfer.dropEffect = 'none'; return }
          event.dataTransfer.dropEffect = 'copy'; setDragging(true)
        }} onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false)
        }} onDrop={(event) => {
          event.preventDefault(); event.stopPropagation(); setDragging(false)
          if (busy.current || event.dataTransfer.files.length === 0) return
          try {
            const bridge = (globalThis as { __DSH_HOST_PATHS__?: { pathFor: (file: File) => string } }).__DSH_HOST_PATHS__
            const paths = Array.from(event.dataTransfer.files, file => bridge?.pathFor(file) ?? '')
            if (paths.some(path => path === '')) throw new Error('Native file path unavailable')
            void choose({ paths })
          } catch (failure) { setSelectionError(failure) }
        }}>
        <IconUploadOutlineRegular size={40} />
        <p>{t('libraryDropFiles')}</p>
        <Button ref={chooseButton} variant="primary" aria-disabled={pending !== undefined} aria-busy={pending === 'select'}
          onClick={() => { void choose() }}>{t('libraryChooseLocalFiles')}</Button>
        <Button variant="ghost" aria-disabled={pending !== undefined} aria-busy={pending === 'folder'}
          onClick={() => { void choose({ mode: 'folder' }) }}>{t('libraryChooseLocalFolder')}</Button>
      </div>
      <ul ref={selectionList} className={css.libraryUploadFiles}>
        {files.map(file => (
          <li key={file.selectionId} aria-busy={pending === file.selectionId}>
            <span>{file.kind === 'FOLDER' && <IconFolderCloseRegular size={16} />}
              {[...file.folders ?? [], file.name].join('/')}{file.kind === 'FILE' && ` · ${Math.ceil(file.sizeBytes / 1024)} KB`}</span>
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
