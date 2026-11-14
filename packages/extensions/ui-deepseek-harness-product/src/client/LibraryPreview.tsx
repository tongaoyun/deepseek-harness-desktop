/** The upstream preview factory owns document rendering and Office conversion. */
import { useCallback, useRef, useState, type ReactNode } from 'react'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LibraryEntry } from '@deepseek-harness/product/library'
import type { LibraryText } from './LibraryBrowser.tsx'
import { readLibraryFile, useLibraryRequests } from './library-data.ts'
import { useResultFocus } from './useResultFocus.ts'
import { productErrorMessage } from './product-errors.ts'
import css from '../DeepSeekHarnessProduct.module.css'
/** Preview an immutable selected file without replacing the original preview implementation.
 * @param props Exact library entry and native document factory.
 * @returns Read-only preview and a separate native save action.
 */
export function LibraryPreview({
  entry,
  renderFactorySlot,
  t,
  onClose,
}: PropsRenderFactories & {
  readonly entry: LibraryEntry
  readonly t: LibraryText
  readonly onClose: () => void
}): ReactNode {
  const request = useLibraryRequests()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>()
  const writing = useRef(false)
  const feedback = useRef<HTMLDivElement>(null)
  const downloadButton = useRef<HTMLButtonElement>(null)
  const captureFeedback = useResultFocus(feedback, downloadButton)
  const read = useCallback(
    (signal: AbortSignal) =>
      readLibraryFile(
        request,
        { libraryId: entry.libraryId, entryId: entry.id, ...(entry.sha256 ? { sha256: entry.sha256 } : {}) },
        signal,
      ),
    [request, entry.libraryId, entry.id, entry.sha256],
  )
  const renderOffice = useCallback(
    (signal: AbortSignal) =>
      readLibraryFile(
        request,
        {
          libraryId: entry.libraryId,
          entryId: entry.id,
          rendered: true,
          ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
        },
        signal,
      ),
    [request, entry.libraryId, entry.id, entry.sha256],
  )
  const failureText = useCallback((failure: unknown) => productErrorMessage(failure, t, 'libraryReadFailed'), [t])
  const download = async () => {
    if (writing.current) return
    writing.current = true
    setPending(true)
    try {
      await request('library.files.download', {
        libraryId: entry.libraryId,
        entryId: entry.id,
        ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
      })
      captureFeedback()
      setError(undefined)
    } catch (failure) {
      setError(failure)
    } finally {
      writing.current = false
      setPending(false)
    }
  }
  return (
    <Modal
      open
      title={entry.name}
      closeLabel={t('close')}
      onClose={onClose}
      className={`${css.detailModal} ${css.libraryPreview}`}
      contentClassName={css.detailModalContent as string}
      footer={
        <div className={css.libraryMutationFooter}>
          <div ref={feedback} className={css.feedbackResult}>
            <span aria-hidden="true">{t('libraryDownloadFailed')}</span>
            {error !== undefined && <p role="alert" tabIndex={0} className={css.catalogError}>{productErrorMessage(error, t, 'libraryDownloadFailed')}</p>}
          </div>
          <div className={css.detailActions}>
            <Button
              ref={downloadButton}
              variant="outline"
              aria-disabled={pending}
              aria-busy={pending}
              onClick={() => {
                void download()
              }}
            >
              {t('libraryDownload')}
            </Button>
            <Button variant="primary" onClick={onClose}>
              {t('close')}
            </Button>
          </div>
        </div>
      }
    >
      {renderFactorySlot(
        'document.preview',
        { fileName: entry.name, read, renderOffice, revision: entry.sha256 ?? '', failureText },
        { fallback: <p role="alert">{t('unavailable')}</p> },
      )}
    </Modal>
  )
}
