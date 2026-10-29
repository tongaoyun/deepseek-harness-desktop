/** Host-only recovery of successful native and PTC connector discoveries from Session events. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { z } from 'zod'

export const DISCOVER_CONNECTOR_TOOLS = 'connector_search_tools'
export const CONNECTOR_SELECTION_META = 'product-connector-tools-v1'
export const connectorPinSchema = z.object({ name: z.string(), connectorId: z.string(), version: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
export type ConnectorPin = z.infer<typeof connectorPinSchema>
const pinsSchema = z.array(connectorPinSchema).max(500)
const metaSchema = z.object({ kind: z.literal(CONNECTOR_SELECTION_META), content: z.string() }).strict()
const stateSchema = z.object({ pins: pinsSchema, calls: z.array(z.object({ id: z.string(), name: z.string() })),
  failure: z.enum(['invalid', 'missing']).nullable() })
type SelectionState = z.infer<typeof stateSchema>
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { productConnectorTools: SelectionState }
}
const isProductTool = (name: string) => /^mcp__[A-Za-z0-9_-]+_[a-f0-9]{8}__/u.test(name)

function fold(state: SelectionState, event: SessionEvent): SelectionState {
  if (event.type === 'tool/call') {
    if (event.data.name !== DISCOVER_CONNECTOR_TOOLS && !isProductTool(event.data.name)) return state
    return { ...state, calls: [...state.calls, { id: event.data.callId, name: event.data.name }] }
  }
  let name: string
  let calls = state.calls
  let result: { isError: boolean; meta?: unknown }
  if (event.type === 'tool/result') {
    const call = calls.find(value => value.id === event.data.message.toolCallId)
    if (!call) return state
    name = call.name
    calls = calls.filter(value => value !== call)
    result = { isError: event.data.message.isError === true, meta: event.data.meta }
  } else if (event.type === 'tool/ptc-dispatch') {
    name = event.data.name
    if (name !== DISCOVER_CONNECTOR_TOOLS && !isProductTool(name)) return state
    result = event.data
  } else return state
  const next = { ...state, calls }
  if (result.isError) return next
  if (name !== DISCOVER_CONNECTOR_TOOLS) {
    return state.pins.some(pin => pin.name === name) ? next : { ...next, failure: 'missing' }
  }
  try {
    const meta = metaSchema.parse(result.meta)
    const selected = pinsSchema.parse(JSON.parse(meta.content))
    const pins = new Map(state.pins.map(pin => [pin.name, pin]))
    for (const pin of selected) {
      const previous = pins.get(pin.name)
      if (previous && JSON.stringify(previous) !== JSON.stringify(pin)) return { ...next, failure: 'invalid' }
      pins.set(pin.name, pin)
    }
    return pins.size > 500 ? { ...next, failure: 'invalid' } : { ...next, pins: [...pins.values()] }
  } catch (_error) {
    // Preserve the malformed source event; only this session becomes non-executable.
    return { ...next, failure: 'invalid' }
  }
}

/** Register the fold before Agents are created or resumed; no client view or extra storage is needed. */
export function registerConnectorSelection(ctx: Context): Promise<ProjectionHandle<SelectionState>> {
  return ctx.sessionProjections.register({ key: 'productConnectorTools', stateVersion: 2, stateSchema,
    init: () => ({ pins: [], calls: [], failure: null }), apply: fold })
}
