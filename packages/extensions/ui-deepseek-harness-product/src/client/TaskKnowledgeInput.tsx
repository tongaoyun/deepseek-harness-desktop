/** Knowledge references in the resident composer, addressed by the Add menu's Session. */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from '../locales.ts'
import type { TaskModeActions } from './harness-actions.ts'
import { TaskKnowledgeSelector } from './TaskKnowledgeSelector.tsx'
import { productApi, type ProductApi } from './product-api.ts'
import { productErrorMessage } from './product-errors.ts'
import css from '../DeepSeekHarnessProduct.module.css'

interface KnowledgeInjected extends Pick<TaskModeActions,
  'readMode' | 'readKnowledgeCatalog' | 'setKnowledgeSelection' | 'recoverCapabilities' | 'retryCapabilities' | 'openCatalog'> {
  subscribeOpen: (listener: () => void) => () => void
}

/** Render task knowledge inside the input without adding an execution-mode control.
 * @param props Session capability readers, guarded selection actions, and the Add-menu opening callback.
 * @returns Knowledge tags, their selection dialog, and capability-load diagnostics.
 */
export function TaskKnowledgeInput({
  sessionId, useSessions, readMode, readKnowledgeCatalog, setKnowledgeSelection,
  recoverCapabilities, retryCapabilities, openCatalog, subscribeOpen, t,
}: PropsRuntime<'conversation.input.left'> & PropsLocale<typeof NS> & InjectFace<KnowledgeInjected>) {
  const presetId = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset)
  const [state, setState] = useState<Awaited<ReturnType<TaskModeActions['readMode']>>>()
  const [failure, setFailure] = useState('')
  const [revision, setRevision] = useState(0)
  const [identityRevision, setIdentityRevision] = useState(0)
  useEffect(() => {
    const api = productApi()
    let live = true
    let identity: string | undefined
    const updateIdentity = (session: Awaited<ReturnType<ProductApi['getSession']>>, changed = false) => {
      const next = JSON.stringify([session.authenticated, session.employeeId])
      if (identity === undefined ? changed : next !== identity) {
        setState(undefined)
        setFailure('')
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
  useEffect(() => { setState(undefined) }, [sessionId, presetId])
  useEffect(() => {
    let active = true
    setFailure('')
    void readMode(sessionId).then((value) => { if (active) setState(value) })
      .catch((error: unknown) => { if (active) setFailure(productErrorMessage(error, t, 'taskSelectionFailed')) })
    return () => { active = false }
  }, [sessionId, presetId, revision, identityRevision, readMode, t])
  return <>
    <TaskKnowledgeSelector key={identityRevision} sessionId={sessionId} capabilities={state?.capabilities}
      refreshRevision={revision} readKnowledgeCatalog={readKnowledgeCatalog}
      setKnowledgeSelection={setKnowledgeSelection} recoverCapabilities={recoverCapabilities}
      retryCapabilities={retryCapabilities} openCatalog={openCatalog}
      subscribeOpen={subscribeOpen} onApplied={() => { setRevision(value => value + 1) }} t={t} />
    {failure && <span role="alert" className={css.catalogError}>{failure}</span>}
  </>
}
