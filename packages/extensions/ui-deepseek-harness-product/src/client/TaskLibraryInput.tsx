/** The Add menu opens a directory picker; selected files use the original attachment rail. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { LIBRARY_ATTACHMENT_LIMITS, type LibraryEntry } from '@deepseek-harness/product/library'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { productApi } from './product-api.ts'
import { NS, type DeepSeekHarnessProductKey } from '../locales.ts'
import { LibraryBrowser } from './LibraryBrowser.tsx'
import { productErrorMessage, type ProductFailureReport } from './product-errors.ts'
import type { EmployeeSignInActions } from './employee-sign-in.ts'
import { ProductLoading } from './ProductLoading.tsx'
import { useResultFocus } from './useResultFocus.ts'
import css from '../DeepSeekHarnessProduct.module.css'
/** Releasing the picker cancels pending file admission and uses no separate task scope.
 * @param props Current native Session, directory opener and original composer admission.
 * @returns A native modal while requested from the Add menu.
 */
export function TaskLibraryInput({
  sessionId,
  t,
  renderFactorySlot,
  subscribeOpen,
  attachLibraryFiles,
  openEmployeeSignIn,
  focusInput,
}: Pick<PropsRuntime<'conversation.input.references'>, 'sessionId'> &
  PropsLocale<typeof NS> &
  PropsRenderFactories & Pick<EmployeeSignInActions, 'openEmployeeSignIn'> & {
    readonly focusInput: () => void
    readonly subscribeOpen: (open: () => void) => () => void
    readonly attachLibraryFiles: (
      sessionId: SessionId,
      entries: readonly LibraryEntry[],
      signal: AbortSignal,
    ) => Promise<void>
  }): ReactNode {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<ReadonlyMap<string, LibraryEntry>>(new Map())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<DeepSeekHarnessProductKey | ProductFailureReport>()
  const operation = useRef<AbortController>()
  const pickerRequested = useRef(false)
  const requestSignIn = useRef(() => {})
  requestSignIn.current = () => { openEmployeeSignIn(focusInput) }
  const [authenticated, setAuthenticated] = useState<boolean>()
  const [verifying, setVerifying] = useState(true)
  const [verificationError, setVerificationError] = useState<unknown>()
  const [revision, setRevision] = useState(0)
  const retry = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const capture = useResultFocus(retry, cancel)
  const close = useCallback(() => {
    pickerRequested.current = false
    operation.current?.abort()
    operation.current = undefined
    setPending(false)
    setOpen(false)
    setSelected(new Map())
    setError(undefined)
  }, [])
  useEffect(() => subscribeOpen(() => {
    if (authenticated === false) openEmployeeSignIn(focusInput)
    else { pickerRequested.current = true; setOpen(true) }
  }), [subscribeOpen, authenticated, openEmployeeSignIn, focusInput])
  useEffect(() => {
    close()
    setAuthenticated(undefined)
    setVerificationError(undefined)
  }, [sessionId, close])
  useEffect(() => {
    const api = productApi()
    let live = true
    setVerifying(true)
    let identity: string | undefined
    const updateIdentity = (session: Awaited<ReturnType<NonNullable<typeof api>['getSession']>>, changed = false) => {
      const next = JSON.stringify([session.authenticated, session.employeeId])
      const requested = pickerRequested.current
      if (identity === undefined ? changed : next !== identity) close()
      identity = next
      capture()
      const authorized = session.authenticated === true && !!session.employeeId
      if (!authorized) {
        close()
        if (requested) requestSignIn.current()
      }
      setAuthenticated(authorized)
      setVerificationError(undefined)
      setVerifying(false)
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
    }).catch((failure: unknown) => {
      if (live && identity === undefined) {
        setAuthenticated(undefined)
        setVerificationError(failure)
        setVerifying(false)
      }
    })
    if (api === undefined) {
      setVerificationError(new Error('Product transport unavailable'))
      setVerifying(false)
    }
    return () => {
      live = false
      dispose?.()
      operation.current?.abort()
      operation.current = undefined
    }
  }, [sessionId, revision, close, capture])
  const attach = async () => {
    if (authenticated !== true || operation.current || selected.size === 0) return
    const controller = new AbortController()
    operation.current = controller
    setPending(true)
    try {
      await attachLibraryFiles(sessionId, [...selected.values()], controller.signal)
      if (!controller.signal.aborted) {
        setOpen(false)
        setSelected(new Map())
        setError(undefined)
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError({ failure, fallback: 'libraryAttachFailed' })
    } finally {
      if (operation.current === controller) {
        operation.current = undefined
        if (!controller.signal.aborted) setPending(false)
      }
    }
  }
  if (!open) return null
  return (
    <Modal
      open
      title={t('libraryChooseFiles')}
      closeLabel={t('close')}
      onClose={close}
      className={`${css.detailModal} ${css.libraryPicker}`}
      contentClassName={css.detailModalContent as string}
      footer={
        <div className={`${css.libraryMutationFooter} ${css.libraryAttachmentFooter}`}>
          <div className={css.feedbackResult}>
            <span aria-hidden="true">{t('libraryAttachFailed')}</span>
            {error !== undefined && <p role="alert" tabIndex={0} className={css.catalogError}>{typeof error === 'string' ? t(error)
              : productErrorMessage(error.failure, t, error.fallback)}</p>}
          </div>
          <div className={css.detailActions}>
            <Button ref={cancel} variant="outline" onClick={close}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              aria-disabled={authenticated !== true || pending || selected.size === 0}
              aria-busy={pending}
              onClick={() => {
                void attach()
              }}
            >
              {t('libraryAttach').replace('{count}', String(selected.size))}
            </Button>
          </div>
        </div>
      }
    >
      {authenticated === undefined && verificationError === undefined && <ProductLoading label={t('loading')} />}
      {authenticated === undefined && verificationError !== undefined && (
        <div role="alert">
          <p>{productErrorMessage(verificationError, t, 'loadFailed')}</p>
          <Button ref={retry} variant="outline" aria-disabled={verifying} aria-busy={verifying}
            onClick={() => { if (!verifying) setRevision(value => value + 1) }}>
            {t('retry')}
          </Button>
        </div>
      )}
      {authenticated === true && <LibraryBrowser
        t={t}
        selected={selected}
        renderFactorySlot={renderFactorySlot}
        onSelect={(entry) => {
          if (operation.current) return
          const next = new Map(selected)
          if (!next.delete(entry.id)) {
            if (next.size >= LIBRARY_ATTACHMENT_LIMITS.files) {
              setError('librarySelectionCountLimit')
              return
            }
            if ([...next.values(), entry].reduce((bytes, item) => bytes + item.sizeBytes, 0) > LIBRARY_ATTACHMENT_LIMITS.bytes) {
              setError('librarySelectionSizeLimit')
              return
            }
            next.set(entry.id, entry)
          }
          setSelected(next)
          setError(undefined)
        }}
      />}
    </Modal>
  )
}
