import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconSettingsOutlineMedium, IconQuestionOutlineRegular, IconDownloadOutlineRegular,
  IconUserOutlineMedium, Menu, Modal, focusWithoutRing,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useRef, useState } from 'react'
import { EMPLOYEE_AUTH_CLASS_NAME, EMPLOYEE_AUTH_CSS } from '@deepseek-harness/product/auth-screen'
import { DINGTALK_AUTHORIZATION_TIMEOUT_MS } from '@deepseek-harness/product/protocol'
import { NS } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { DesktopFeedback } from './DesktopFeedback.tsx'
import { invokeProduct, productApi, type ProductApi } from './product-api.ts'
import type { EmployeeSignInActions } from './employee-sign-in.ts'
import { ProductActionLabel } from './ProductActionLabel.tsx'
import { useResultFocus } from './useResultFocus.ts'

type EmployeeStatus = { readonly phase: 'checking' | 'unavailable' }
  | { readonly phase: 'ready'; readonly session: Awaited<ReturnType<ProductApi['getSession']>> }

/** The persistent sidebar owns employee status, DingTalk authorization, and product settings.
 * A missing or expired employee session opens one full-window login screen. Cancellation suppresses repeated notices.
 * Authorization retries retain their feedback, focused action and reserved label width.
 * If sign-in removes its directory entry, lost return focus uses the employee button or its page when the sidebar is inert.
 */
export function DeepSeekHarnessSettingsMenu({ wide, settingsShortcut, openSettings, openSoftwareUpdate,
  openEmployeeSignIn, subscribeEmployeeSignIn, t }:
PropsRuntime<'settings.launcher'> & PropsLocale<typeof NS> & EmployeeSignInActions & { readonly openSoftwareUpdate?: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const employeeButton = useRef<HTMLButtonElement>(null)
  const authorizationFocusArea = useRef<HTMLElement | null>(null)
  const authorizationReturn = useRef<() => void>()
  const preserveAuthorizationFocus = useResultFocus(authorizationFocusArea, () => {
    const employee = employeeButton.current
    if (employee?.isConnected && !employee.closest('[hidden], [inert]')) focusWithoutRing(employee, { preventScroll: true })
    else authorizationReturn.current?.()
  })
  const signOutRequest = useRef<AbortController>()
  const [signOutPending, setSignOutPending] = useState(false)
  const [signOutError, setSignOutError] = useState(false)
  useEffect(() => () => { signOutRequest.current?.abort() }, [])
  const signOut = async (): Promise<void> => {
    if (signOutRequest.current) return
    const api = productApi()
    if (!api) { setSignOutError(true); return }
    const controller = new AbortController()
    signOutRequest.current = controller
    setSignOutPending(true)
    try {
      await invokeProduct(api, 'auth.signOut', undefined, controller.signal)
      controller.signal.throwIfAborted()
      setSignOutError(false)
    } catch {
      if (!controller.signal.aborted) setSignOutError(true)
    } finally {
      if (signOutRequest.current === controller) {
        signOutRequest.current = undefined
        if (!controller.signal.aborted) setSignOutPending(false)
      }
    }
  }
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const feedbackAfterSignIn = useRef(false)
  const [updateError, setUpdateError] = useState(false)
  const [updatePending, setUpdatePending] = useState(false)
  const operation = useRef({ live: true, pending: false })
  const [employee, setEmployee] = useState<EmployeeStatus>({ phase: 'checking' })
  const [loginVisible, setLoginVisible] = useState(false)
  const [authPending, setAuthPending] = useState(false)
  const [authError, setAuthError] = useState(false)
  const authorization = useRef<AbortController>()
  const sessionRevision = useRef(0)
  const signInRequested = useRef(false)
  const requireSignIn = useCallback(() => {
    if (signInRequested.current) return
    signInRequested.current = true
    setOpen(false)
    setFeedbackOpen(false)
    setLoginVisible(true)
  }, [])
  const cancelAuthorization = useCallback(() => {
    preserveAuthorizationFocus()
    authorization.current?.abort()
    authorization.current = undefined
    setAuthPending(false)
    setAuthError(false)
    feedbackAfterSignIn.current = false
  }, [preserveAuthorizationFocus])
  const finishAuthorization = useCallback(() => {
    signInRequested.current = false
    preserveAuthorizationFocus()
    setLoginVisible(false)
    setAuthError(false)
    if (feedbackAfterSignIn.current) {
      feedbackAfterSignIn.current = false
      setFeedbackOpen(true)
    }
  }, [preserveAuthorizationFocus])
  const signIn = useCallback(async (): Promise<void> => {
    if (authorization.current !== undefined) return
    const api = productApi()
    if (api === undefined) { setAuthError(true); return }
    const controller = new AbortController()
    authorization.current = controller
    setAuthPending(true)
    try {
      await invokeProduct(api, 'auth.ensureDingTalk', undefined, controller.signal, DINGTALK_AUTHORIZATION_TIMEOUT_MS + 10_000)
      controller.signal.throwIfAborted()
      const revision = sessionRevision.current
      const session = await api.getSession()
      controller.signal.throwIfAborted()
      if (revision !== sessionRevision.current) return
      if (session.authenticated !== true) throw new Error('Employee authorization did not complete')
      setEmployee({ phase: 'ready', session })
      finishAuthorization()
    } catch {
      if (authorization.current === controller && !controller.signal.aborted) setAuthError(true)
    } finally {
      if (authorization.current === controller) {
        authorization.current = undefined
        setAuthPending(false)
      }
    }
  }, [finishAuthorization])
  useEffect(() => subscribeEmployeeSignIn((returnFocus) => {
    signInRequested.current = true
    authorizationReturn.current = returnFocus
    setOpen(false)
    setLoginVisible(true)
    void signIn()
  }), [subscribeEmployeeSignIn, signIn])
  useEffect(() => {
    const api = productApi()
    let live = true
    const revision = sessionRevision.current
    const unsubscribe = api?.subscribe((event) => {
      const value = event.payload
      if (event.type === 'auth.required') {
        sessionRevision.current += 1
        setEmployee({ phase: 'ready', session: { authenticated: false } })
        requireSignIn()
        return
      }
      if (event.type !== 'session.changed' || typeof value !== 'object' || value === null
        || !('authenticated' in value) || typeof value.authenticated !== 'boolean') return
      sessionRevision.current += 1
      setEmployee({ phase: 'ready', session: { authenticated: value.authenticated,
        ...'employeeId' in value && typeof value.employeeId === 'string' ? { employeeId: value.employeeId } : {},
        ...'displayName' in value && typeof value.displayName === 'string' ? { displayName: value.displayName } : {} } })
      if (value.authenticated) finishAuthorization()
      else { setFeedbackOpen(false); requireSignIn() }
    })
    if (api === undefined) setEmployee({ phase: 'unavailable' })
    else void api.getSession().then((session) => {
      if (live && revision === sessionRevision.current) {
        setEmployee({ phase: 'ready', session })
        if (session.authenticated) signInRequested.current = false
        else requireSignIn()
      }
    }).catch(() => {
      if (live && revision === sessionRevision.current) setEmployee({ phase: 'unavailable' })
    })
    return () => {
      live = false
      unsubscribe?.()
      authorization.current?.abort()
      authorization.current = undefined
    }
  }, [finishAuthorization, requireSignIn])
  useEffect(() => {
    operation.current.live = true
    return () => { operation.current.live = false }
  }, [])
  const update = async () => {
    if (openSoftwareUpdate === undefined || operation.current.pending) return
    operation.current.pending = true
    setUpdatePending(true); setUpdateError(false)
    try { await openSoftwareUpdate() }
    catch { if (operation.current.live) setUpdateError(true) }
    finally {
      operation.current.pending = false
      if (operation.current.live) setUpdatePending(false)
    }
  }
  const signedIn = employee.phase === 'ready' && employee.session.authenticated === true
  const employeeLabel = employee.phase === 'ready'
    ? signedIn ? employee.session.displayName?.trim() || t('employeeSignedIn') : t('employeeSignedOut')
    : t(employee.phase === 'checking' ? 'loading' : 'employeeStatusUnavailable')
  return <div className={css.menuRoot}>
    {signOutError && <p role="alert" className={css.catalogError}>{t('signOutFailed')}</p>}
    {updateError && <p role="alert" className={css.catalogError}>{t('softwareUpdateFailed')}</p>}
    <Menu open={open} side="top" portal autoFocus className={css.menuAnchor} listClassName={css.menuList}
      anchor={<button ref={employeeButton} type="button" className={css.menuTrigger} data-collapsed={!wide} title={employeeLabel}
        aria-label={employeeLabel} aria-haspopup="menu" aria-expanded={open}
        disabled={employee.phase === 'checking'} onClick={() => { setOpen(value => !value) }}>
        <IconUserOutlineMedium size={16} />
        {wide && <span className={css.menuLabel}>{employeeLabel}</span>}
      </button>}
      items={[
        ...signedIn ? [] : [{ id: 'signin', label: t('signIn'), icon: <IconUserOutlineMedium size={16} /> }],
        { id: 'settings', label: t('settings'), icon: <IconSettingsOutlineMedium size={16} />,
          ...(settingsShortcut === undefined ? {} : { shortcut: settingsShortcut }) },
        ...openSoftwareUpdate === undefined ? [] : [
          { id: 'software-update', label: t('softwareUpdate'), icon: <IconDownloadOutlineRegular size={16} />, disabled: updatePending },
        ],
        { id: 'feedback', label: t('feedbackTitle'), icon: <IconQuestionOutlineRegular size={16} /> },
        ...signedIn ? [{ id: 'signout', label: t('signOut'), icon: <IconUserOutlineMedium size={16} />, disabled: signOutPending }] : [],
      ]}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        if (employeeButton.current) focusWithoutRing(employeeButton.current)
        setOpen(false)
        if (id === 'signin') openEmployeeSignIn()
        if (id === 'signout') void signOut()
        if (id === 'settings') openSettings()
        if (id === 'feedback') {
          if (signedIn) setFeedbackOpen(true)
          else { feedbackAfterSignIn.current = true; openEmployeeSignIn() }
        }
        if (id === 'software-update') void update()
      }} />
    <Modal open={loginVisible} title={t('authTitle')} headless backdropBlur={false}
      className={EMPLOYEE_AUTH_CLASS_NAME}
      onClose={() => { cancelAuthorization(); setLoginVisible(false) }}>
      <style>{EMPLOYEE_AUTH_CSS}</style>
      <main ref={(node) => { authorizationFocusArea.current = node?.closest<HTMLElement>('[role="dialog"]') ?? null }}>
        <div data-product-auth-mark={authPending ? 'pending' : 'idle'} aria-hidden="true" />
        <h1><ProductActionLabel pending={authPending} label={t('authTitle')} pendingLabel={t('authConnecting')} /></h1>
        <p>{t('authBrowserHint')}</p>
        <div data-product-auth-actions>
          <Button variant="outline" onClick={() => { cancelAuthorization(); setLoginVisible(false) }}>{t('cancel')}</Button>
          <Button variant="primary" aria-disabled={authPending} aria-busy={authPending}
            data-modal-autofocus className={authPending ? 'product-control-pending' : undefined}
            onClick={() => { void signIn() }}>
            <ProductActionLabel pending={authPending} label={t('signIn')} pendingLabel={t('signingIn')} />
          </Button>
        </div>
        <p role={authError ? 'alert' : undefined} aria-hidden={!authError} data-product-auth-error>{t('signInFailed')}</p>
      </main>
    </Modal>
    <DesktopFeedback open={feedbackOpen} onClose={() => { setFeedbackOpen(false) }} t={t} />
  </div>
}
