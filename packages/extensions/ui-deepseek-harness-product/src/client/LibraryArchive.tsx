/** Explicitly archive one native deliverable; ordinary model outputs remain in their Session. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { z } from 'zod'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-deliverables/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { LibrarySelectionSchema, type LibrarySelection } from '@deepseek-harness/product/library'
import { NS, type DeepSeekHarnessProductKey } from '../locales.ts'
import { LibraryBrowser, type LibraryLocation } from './LibraryBrowser.tsx'
import { productApi } from './product-api.ts'
import { useLibraryRequests } from './library-data.ts'
import { productErrorMessage, type ProductFailureReport } from './product-errors.ts'
import { useResultFocus } from './useResultFocus.ts'
import css from '../DeepSeekHarnessProduct.module.css'
/** The original deliverables card supplies authenticated Session event coordinates.
 * @param props Original action owner and native modal/preview factories.
 * @returns A save action with a destination picker; writes only after explicit confirmation.
 */
export function LibraryArchive({
  actionUrl,
  available,
  pending: nativePending,
  t,
  renderFactorySlot,
}: Pick<PropsRuntime<'deliverables.file.actions'>, 'actionUrl' | 'available' | 'pending'> &
  PropsLocale<typeof NS> & PropsRenderFactories): ReactNode {
  const request = useLibraryRequests()
  const [open, setOpen] = useState(false)
  const [selection, setSelection] = useState<LibrarySelection>()
  const [location, setLocation] = useState<LibraryLocation>()
  const [progress, setProgress] = useState<'prepare' | 'save'>()
  const pending = progress !== undefined
  const [error, setError] = useState<DeepSeekHarnessProductKey | ProductFailureReport>()
  const operation = useRef<AbortController>()
  const writing = useRef(false)
  const owned = useRef<string>()
  const key = useRef(randomUUID())
  const destination = useRef<string>()
  const retry = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const capture = useResultFocus(retry, cancel)
  const feedback = useRef<HTMLDivElement>(null)
  const captureFeedback = useResultFocus(feedback, cancel)
  const reset = useCallback((release: boolean) => {
    operation.current?.abort()
    operation.current = undefined
    writing.current = false
    if (release && owned.current)
      void request('library.files.upload.discard', { selectionId: owned.current }).catch((failure: unknown) => {
        console.warn('Library archive cleanup failed', failure)
      })
    owned.current = undefined
    setProgress(undefined)
    setOpen(false)
    setSelection(undefined)
    setLocation(undefined)
    setError(undefined)
    destination.current = undefined
    key.current = randomUUID()
  }, [request])
  const close = () => {
    if (!writing.current) reset(true)
  }
  useEffect(() => {
    const api = productApi()
    let live = true
    let identity: string | undefined
    const updateIdentity = (session: Awaited<ReturnType<NonNullable<typeof api>['getSession']>>, changed = false) => {
      const next = JSON.stringify([session.authenticated, session.employeeId])
      // The main process revokes selections when the employee changes.
      if (identity === undefined ? changed : next !== identity) reset(false)
      identity = next
    }
    const dispose = api?.subscribe((event) => {
      const value = event.payload
      if (event.type !== 'session.changed' || typeof value !== 'object' || value === null ||
        !('authenticated' in value) || typeof value.authenticated !== 'boolean') return
      updateIdentity({ authenticated: value.authenticated,
        ...('employeeId' in value && typeof value.employeeId === 'string' ? { employeeId: value.employeeId } : {}),
      }, true)
    })
    void api?.getSession().then((session) => {
      if (live && identity === undefined) updateIdentity(session)
    }).catch(() => {
      if (live && identity === undefined) reset(true)
    })
    return () => {
      live = false
      dispose?.()
    }
  }, [reset])
  useEffect(
    () => () => {
      operation.current?.abort()
      if (owned.current)
        void request('library.files.upload.discard', { selectionId: owned.current }).catch((failure: unknown) => {
          console.warn('Library archive cleanup failed', failure)
        })
    },
    [request],
  )
  const prepare = async () => {
    if (operation.current || !available || nativePending) return
    const controller = new AbortController()
    operation.current = controller
    setProgress('prepare')
    setOpen(true)
    try {
      const query = new URL(actionUrl, document.baseURI).searchParams
      const [file] = z.tuple([LibrarySelectionSchema.refine(value => value.kind === 'FILE')]).parse(
        await request(
          'library.files.archive.select',
          {
            sessionId: query.get('sessionId'),
            seq: Number(query.get('seq')),
            index: Number(query.get('index')),
          },
          controller.signal,
        ),
      )
      controller.signal.throwIfAborted()
      owned.current = file.selectionId
      capture()
      captureFeedback()
      setSelection(file)
      setError(undefined)
    } catch (failure) {
      if (!controller.signal.aborted) setError({ failure, fallback: 'saveFailed' })
    } finally {
      if (operation.current === controller) {
        operation.current = undefined
        if (!controller.signal.aborted) setProgress(undefined)
      }
    }
  }
  const save = async () => {
    if (operation.current || !selection || !location?.library.canManage) return
    const fingerprint = JSON.stringify([location.library.id, location.parentId])
    if (destination.current && destination.current !== fingerprint) {
      setError('libraryRetryDestination')
      return
    }
    destination.current = fingerprint
    const controller = new AbortController()
    operation.current = controller
    writing.current = true
    setProgress('save')
    try {
      await request(
        'library.files.upload',
        {
          selectionId: selection.selectionId,
          libraryId: location.library.id,
          parentId: location.parentId,
          key: key.current,
        },
        controller.signal,
      )
      controller.signal.throwIfAborted()
      void request('library.files.upload.discard', { selectionId: selection.selectionId }).catch((failure: unknown) => {
        console.warn('Library archive cleanup failed', failure)
      })
      owned.current = undefined
      operation.current = undefined
      writing.current = false
      setProgress(undefined)
      close()
    } catch (failure) {
      if (!controller.signal.aborted) setError({ failure, fallback: 'saveFailed' })
    } finally {
      if (operation.current === controller) {
        operation.current = undefined
        writing.current = false
        if (!controller.signal.aborted) setProgress(undefined)
      }
    }
  }
  const onLocation = useCallback((value: LibraryLocation | undefined) => {
    setLocation(value)
  }, [])
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-disabled={!available || nativePending || pending}
        onClick={() => {
          void prepare()
        }}
      >
        {t('libraryArchive')}
      </Button>
      {open && (
        <Modal
          open
          title={t('libraryArchive')}
          closeLabel={t('close')}
          onClose={close}
          className={`${css.detailModal} ${css.libraryModal} ${css.libraryPicker}`}
          contentClassName={css.detailModalContent as string}
          footer={
            <div className={css.libraryMutationFooter}>
              <div ref={feedback} className={css.feedbackResult}>
                <span aria-hidden="true">{t('saveFailed')}</span>
                {error !== undefined && <p role="alert" tabIndex={0} className={css.catalogError}>{typeof error === 'string' ? t(error)
                  : productErrorMessage(error.failure, t, error.fallback)}</p>}
              </div>
              <div className={css.detailActions}>
                <Button ref={cancel} variant="outline" aria-disabled={pending && selection !== undefined} onClick={close}>
                  {t('cancel')}
                </Button>
                <Button
                  variant="primary"
                  aria-disabled={pending || !selection || !location?.library.canManage}
                  aria-busy={progress === 'save'}
                  onClick={() => {
                    void save()
                  }}
                >
                  {t('saveResource')}
                </Button>
              </div>
            </div>
          }
        >
          {selection && <p className={css.resourceConfirmation}>{selection.name}</p>}
          {selection && (
            <LibraryBrowser t={t} foldersOnly navigationLocked={pending} renderFactorySlot={renderFactorySlot} onLocation={onLocation} />
          )}
          {!selection && (
            <div aria-busy={progress === 'prepare'}>
              <Button
                ref={retry}
                className={css.libraryPrepareRetry}
                variant="outline"
                aria-hidden={error === undefined}
                disabled={error === undefined}
                aria-disabled={pending || error === undefined}
                aria-busy={progress === 'prepare'}
                onClick={() => {
                  void prepare()
                }}
              >
                {t('retry')}
              </Button>
            </div>
          )}
        </Modal>
      )}
    </>
  )
}
