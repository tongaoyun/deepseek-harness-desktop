import type { ExpertClientState } from './client-state.ts'
/** Confirmed drafts open only from their original transcript row and never reopen during history replay. */
import React from 'react'
import { z } from 'zod'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallPhaseProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { CreationEditorData } from '../remote-contract.ts'
import { EXPERT_DIVISION_ORDER } from '../names.ts'
import { CustomExpertEditor } from './custom-editor.ts'
import { TeamEditor } from './team-editor.tsx'
import { TeamLocaleContext } from './team-locale.ts'
import { Button } from './plugin-ui.ts'
import { unwrap, type TeamRemote } from './team-ui.tsx'

const readySchema = z.object({ ready: z.literal(true), proposalId: z.uuid() })
/** Session-bound editor operations injected into a transcript action. */
export interface CreationCardInjected {
  cache: ExpertClientState
  remote: TeamRemote
  getActive(): 'zh' | 'en'
  loadCreation: (proposalId: string, signal: AbortSignal) => Promise<CreationEditorData>
}
/** Render one confirmed draft action with the existing conflict-aware personal editor.
 * @param props - Original tool result, localized labels and Session-bound loading callback.
 * @returns Transcript action and, after a click, its editor.
 */
export function CreationCard(props: ToolCallPhaseProps & PropsLocale<'agency'> & CreationCardInjected): React.ReactElement {
  const [editor, setEditor] = React.useState<CreationEditorData | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [claimed, setClaimed] = React.useState(false)
  const pending = React.useRef<AbortController | null>(null)
  const lifetime = React.useRef<AbortController | undefined>(undefined)
  React.useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    setBusy(false)
    return () => {
      controller.abort()
      if (lifetime.current === controller) lifetime.current = undefined
      pending.current?.abort()
      pending.current = null
    }
  }, [props.loadCreation, props.cache])
  const ready = props.phase === 'result' && !props.block.isError ? readySchema.safeParse(props.block.meta) : null
  const load = async (proposalId: string) => {
    if (pending.current || claimed) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError(null)
    try {
      const value = await props.loadCreation(proposalId, controller.signal)
      if (!controller.signal.aborted) {
        props.cache.catalog.accept(value.catalog)
        props.cache.teams.accept(value.teams)
        setEditor(value)
        setClaimed(true)
      }
    } catch (cause: unknown) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (pending.current === controller) pending.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return <div>
    <p>{props.phase === 'result' ? props.block.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : props.t('creation.confirming')}</p>
    {ready?.success && <Button disabled={busy || claimed} onClick={() => { void load(ready.data.proposalId) }}>{props.t(claimed ? 'creation.opened' : 'creation.open')}</Button>}
    {error && <p role="alert" className="aag-error">{error}</p>}
    {editor?.draft.kind === 'expert' && <CustomExpertEditor expert={editor.draft.data} enabled={false} revision={editor.catalog.revision}
      divisions={[...new Set([...EXPERT_DIVISION_ORDER, ...editor.catalog.experts.map(expert => expert.division)])]}
      remote={props.remote} signal={lifetime.current?.signal} t={props.t} locale={props.getActive()} onClose={() => { setEditor(null) }}
      onSaved={(catalog) => { props.cache.catalog.accept(catalog); setEditor(null) }} />}
    {editor?.draft.kind === 'team' && <TeamLocaleContext.Provider value={props.getActive()}><TeamEditor initial={editor.draft.data}
      experts={editor.catalog.experts} enabled={false} enabledExperts={editor.catalog.enabled} close={() => { setEditor(null) }}
      refresh={() => props.cache.teams.refresh()}
      save={async (value, enabled, revision) => {
        const signal = lifetime.current?.signal
        signal?.throwIfAborted()
        const saved = await unwrap(props.remote.saveTeam(value, enabled, revision ?? editor.teams.revision, signal))
        signal?.throwIfAborted()
        props.cache.teams.accept(saved)
        props.cache.catalog.adoptRevision(saved.revision, saved.enabledExperts)
        setEditor(null)
      }} /></TeamLocaleContext.Provider>}
  </div>
}
