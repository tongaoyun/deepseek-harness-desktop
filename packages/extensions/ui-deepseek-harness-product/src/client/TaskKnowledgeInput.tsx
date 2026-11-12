/** Knowledge references in the resident composer, addressed by the Add menu's Session. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { productFailure, type ProductFailure } from '@deepseek-harness/product/errors'
import type { NS } from '../locales.ts'
import type { TaskModeActions } from './harness-actions.ts'
import { TaskKnowledgeSelector } from './TaskKnowledgeSelector.tsx'
import { productApi, type ProductApi } from './product-api.ts'
import { productErrorMessage } from './product-errors.ts'
import { useResultFocus } from './useResultFocus.ts'
import css from '../DeepSeekHarnessProduct.module.css'

interface KnowledgeInjected extends Pick<TaskModeActions,
  'readCapabilities' | 'readKnowledgeCatalog' | 'setKnowledgeSelection' | 'recoverCapabilities' | 'retryCapabilities' | 'openCatalog'> {
  subscribeOpen: (listener: () => void) => () => void
  openEmployeeSignIn: () => void
  focusInput: () => void
}

/** Render task knowledge inside the input without adding an execution-mode control.
 * Removed capability retries return their owned focus through the native input action; focus elsewhere remains unchanged.
 * @param props Session capability readers, guarded selection actions, and the Add-menu opening callback.
 * @returns Knowledge tags, their selection dialog, and capability-load diagnostics.
 */
export function TaskKnowledgeInput({
  sessionId, useSessions, readCapabilities, readKnowledgeCatalog, setKnowledgeSelection,
  recoverCapabilities, retryCapabilities, openCatalog, openEmployeeSignIn, focusInput, subscribeOpen, t,
}: PropsRuntime<'conversation.input.references'> & PropsLocale<typeof NS> & InjectFace<KnowledgeInjected>) {
  const presetId = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset)
  const [state, setState] = useState<Awaited<ReturnType<TaskModeActions['readCapabilities']>>>()
  const [failure, setFailure] = useState<ProductFailure>()
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const [identityRevision, setIdentityRevision] = useState(0)
  const [signedOut, setSignedOut] = useState(false)
  const notice = useRef<HTMLDivElement>(null)
  const preserveReadFocus = useResultFocus(notice, focusInput)
  useEffect(() => {
    const api = productApi()
    let live = true
    let identity: string | undefined
    const updateIdentity = (session: Awaited<ReturnType<ProductApi['getSession']>>, changed = false) => {
      setSignedOut(session.authenticated === false)
      const next = JSON.stringify([session.authenticated, session.employeeId])
      if (identity === undefined ? changed : next !== identity) {
        setState(undefined)
        setFailure(undefined)
        setIdentityRevision(value => value + 1)
      }
      identity = next
    }
    const unsubscribe = api?.subscribe((event) => {
      const value = event.payload
      if (event.type === 'session.changed' && typeof value === 'object' && value !== null
        && 'authenticated' in value && typeof value.authenticated === 'boolean') {
        updateIdentity({ authenticated: value.authenticated,
          ...'employeeId' in value && typeof value.employeeId === 'string' ? { employeeId: value.employeeId } : {} }, true)
      }
      if (event.type === 'catalog.changed' || event.type === 'session.changed') setRevision(value => value + 1)
    })
    void api?.getSession().then((session) => { if (live && identity === undefined) updateIdentity(session) }).catch(() => {
      // Session events remain authoritative when the initial identity read fails.
    })
    return () => { live = false; unsubscribe?.() }
  }, [])
  useEffect(() => { setState(undefined); setFailure(undefined) }, [sessionId, presetId])
  useEffect(() => {
    let active = true
    if (signedOut) {
      setState(undefined)
      setFailure(undefined)
      setLoading(false)
      return
    }
    setLoading(true)
    void readCapabilities(sessionId).then((value) => { if (active) { preserveReadFocus(); setState(value); setFailure(undefined) } })
      .catch((error: unknown) => { if (active) {
        preserveReadFocus()
        const failure = productFailure(error)
        if (failure.code === 'EMPLOYEE_UNAUTHORIZED') setState(undefined)
        setFailure(failure)
      } }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [sessionId, presetId, revision, identityRevision, signedOut, readCapabilities, preserveReadFocus])
  const signInRequired = signedOut || failure?.code === 'EMPLOYEE_UNAUTHORIZED'
  const subscribeKnowledgeOpen = useCallback((listener: () => void) => subscribeOpen(() => {
    if (signInRequired) openEmployeeSignIn()
    else listener()
  }), [subscribeOpen, signInRequired, openEmployeeSignIn])
  return <>
    <TaskKnowledgeSelector key={identityRevision} sessionId={sessionId} capabilities={state}
      refreshRevision={revision} readKnowledgeCatalog={readKnowledgeCatalog}
      setKnowledgeSelection={setKnowledgeSelection} recoverCapabilities={recoverCapabilities}
      retryCapabilities={retryCapabilities} openCatalog={openCatalog}
      subscribeOpen={subscribeKnowledgeOpen} onApplied={() => { setRevision(value => value + 1) }} t={t} />
    {!signInRequired && failure && <div ref={notice} role="alert" className={css.taskKnowledgeNotice} data-tone="error">
      <span className={css.taskKnowledgeNoticeCopy}>
        <IconWarningOutlineRegular size={14} aria-hidden="true" />
        <span>{failure.code === 'PRODUCT_HOST_IDENTITY_CHANGED' ? t('employeeHostRestartRequired')
          : productErrorMessage(failure, t, 'taskReadFailed')}</span>
      </span>
      {failure.code !== 'PRODUCT_HOST_IDENTITY_CHANGED'
          && <Button variant="ghost" size="sm" aria-disabled={loading} aria-busy={loading} className={loading ? 'product-control-pending' : undefined}
            onClick={() => {
              if (loading) return
              setLoading(true); setRevision(value => value === revision ? revision + 1 : value)
            }}>{t('retry')}</Button>}
    </div>}
  </>
}
