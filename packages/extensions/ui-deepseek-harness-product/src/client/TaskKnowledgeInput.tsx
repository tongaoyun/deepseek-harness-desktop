/** Knowledge references in the resident composer, addressed by the Add menu's Session. */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from '../locales.ts'
import type { TaskModeActions } from './harness-actions.ts'
import { TaskKnowledgeSelector } from './TaskKnowledgeSelector.tsx'
import { productApi } from './product-api.ts'
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
  const [pending, setPending] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => productApi()?.subscribe((event) => {
    if (event.type === 'catalog.changed' || event.type === 'session.changed') setRevision(value => value + 1)
  }), [])
  useEffect(() => {
    setState(undefined)
    setPending(false)
  }, [sessionId, presetId])
  useEffect(() => {
    let active = true
    setFailure('')
    void readMode(sessionId).then((value) => { if (active) setState(value) })
      .catch((error: unknown) => { if (active) setFailure(productErrorMessage(error, t, 'taskSelectionFailed')) })
    return () => { active = false }
  }, [sessionId, presetId, revision, readMode, t])
  return <>
    <TaskKnowledgeSelector sessionId={sessionId} capabilities={state?.capabilities} readKnowledgeCatalog={readKnowledgeCatalog}
      setKnowledgeSelection={setKnowledgeSelection} recoverCapabilities={recoverCapabilities}
      retryCapabilities={retryCapabilities} openCatalog={openCatalog}
      subscribeOpen={subscribeOpen} onApplied={() => { setRevision(value => value + 1) }} onPendingChange={setPending}
      disabled={pending} t={t} />
    {failure && <span role="alert" className={css.catalogError}>{failure}</span>}
  </>
}
