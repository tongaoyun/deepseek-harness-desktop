import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconSettingsOutlineMedium, IconQuestionOutlineRegular, IconDownloadOutlineRegular,
  IconUserOutlineMedium, Menu, Modal, focusWithoutRing,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DINGTALK_AUTHORIZATION_TIMEOUT_MS } from '@deepseek-harness/product/protocol'
import { NS } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { DesktopFeedback } from './DesktopFeedback.tsx'
import { invokeProduct, productApi, type ProductApi } from './product-api.ts'
import type { EmployeeSignInActions } from './employee-sign-in.ts'

type EmployeeStatus = { readonly phase: 'checking' | 'unavailable' }
  | { readonly phase: 'ready'; readonly session: Awaited<ReturnType<ProductApi['getSession']>> }

/** The persistent sidebar owns employee status, DingTalk authorization, and product settings. */
export function DeepSeekHarnessSettingsMenu({ wide, settingsShortcut, openSettings, openSoftwareUpdate,
  openEmployeeSignIn, subscribeEmployeeSignIn, t }:
PropsRuntime<'settings.launcher'> & PropsLocale<typeof NS> & EmployeeSignInActions & { readonly openSoftwareUpdate?: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const employeeButton = useRef<HTMLButtonElement>(null)
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
  const cancelAuthorization = useCallback(() => {
    authorization.current?.abort()
    authorization.current = undefined
    setAuthPending(false)
    setAuthError(false)
    feedbackAfterSignIn.current = false
  }, [])
  const finishAuthorization = useCallback(() => {
    setLoginVisible(false)
    setAuthError(false)
    if (feedbackAfterSignIn.current) {
      feedbackAfterSignIn.current = false
      setFeedbackOpen(true)
    }
  }, [])
  const signIn = useCallback(async (): Promise<void> => {
    if (authorization.current !== undefined) return
    const api = productApi()
    if (api === undefined) { setAuthError(true); return }
    const controller = new AbortController()
    authorization.current = controller
    setAuthPending(true)
    setAuthError(false)
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
  useEffect(() => subscribeEmployeeSignIn(() => {
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
      if (event.type !== 'session.changed' || typeof value !== 'object' || value === null
        || !('authenticated' in value) || typeof value.authenticated !== 'boolean') return
      sessionRevision.current += 1
      setEmployee({ phase: 'ready', session: { authenticated: value.authenticated,
        ...'employeeId' in value && typeof value.employeeId === 'string' ? { employeeId: value.employeeId } : {},
        ...'displayName' in value && typeof value.displayName === 'string' ? { displayName: value.displayName } : {} } })
      if (value.authenticated) finishAuthorization()
      else setFeedbackOpen(false)
    })
    if (api === undefined) setEmployee({ phase: 'unavailable' })
    else void api.getSession().then((session) => {
      if (live && revision === sessionRevision.current) setEmployee({ phase: 'ready', session })
    }).catch(() => {
      if (live && revision === sessionRevision.current) setEmployee({ phase: 'unavailable' })
    })
    return () => {
      live = false
      unsubscribe?.()
      authorization.current?.abort()
      authorization.current = undefined
    }
  }, [finishAuthorization])
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
      ]}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        if (employeeButton.current) focusWithoutRing(employeeButton.current)
        setOpen(false)
        if (id === 'signin') openEmployeeSignIn()
        if (id === 'settings') openSettings()
        if (id === 'feedback') {
          if (signedIn) setFeedbackOpen(true)
          else { feedbackAfterSignIn.current = true; openEmployeeSignIn() }
        }
        if (id === 'software-update') void update()
      }} />
    <Modal open={loginVisible} title={t(authPending ? 'authWaiting' : 'authTitle')} closeLabel={t('close')}
      description={t(authPending ? 'authBrowserHint' : 'authRequired')}
      onClose={() => { cancelAuthorization(); setLoginVisible(false) }}
      footer={<div className={css.detailActions}>
        <Button variant="outline" size="sm" onClick={() => { cancelAuthorization(); setLoginVisible(false) }}>{t('cancel')}</Button>
        <Button variant="primary" size="sm" disabled={authPending} onClick={() => { void signIn() }}>{t(authPending ? 'signingIn' : 'signIn')}</Button>
      </div>}>
      {authError && <p role="alert" className={css.catalogError}>{t('signInFailed')}</p>}
    </Modal>
    <DesktopFeedback open={feedbackOpen} onClose={() => { setFeedbackOpen(false) }} t={t} />
  </div>
}
