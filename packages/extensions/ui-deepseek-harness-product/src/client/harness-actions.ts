/** The only product client adapter to Harness Sessions, Presets, Workspaces, and drafts. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { DraftInput, DraftSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { parseTaskCapabilities, parseTaskCapabilityResult, type ProductTaskCapabilityRequest, type ProductTaskCapabilities } from '@deepseek-harness/product/protocol'
import type { DeepSeekHarnessCatalogActions } from './DeepSeekHarnessCatalogSection.tsx'
import type { AgentPresetRow } from '@deepseek-ai/dsh-agent-preset-registry/types'
import { invokeProduct, productApi, type ProductApi } from './product-api.ts'
import { items, type Catalog, type ProductItem } from './catalog-shared.tsx'
import { CAPABILITY_PANELS } from './DeepSeekHarnessCapabilitiesNavigation.tsx'

/** Adapt product selection to official task services.
 * @param ctx Client plugin context.
 * @returns Serialized actions with cancellable Session acquisition, native failure details, and unchanged drafts on failure.
 */
export function createHarnessActions(ctx: Context): DeepSeekHarnessCatalogActions & TaskModeActions {
  let pending: Promise<unknown> = Promise.resolve()
  const lifecycle = new AbortController()
  let identityLifecycle = new AbortController()
  ctx.effect(() => {
    const api = productApi()
    let live = true
    let identity: string | undefined
    const key = (session: Awaited<ReturnType<ProductApi['getSession']>>) =>
      JSON.stringify([session.authenticated, session.employeeId])
    const unsubscribe = api?.subscribe((event) => {
      if (event.type !== 'session.changed') return
      const session = event.payload
      if (typeof session !== 'object' || session === null || !('authenticated' in session)
        || typeof session.authenticated !== 'boolean') return
      const next = key({ authenticated: session.authenticated,
        ...'employeeId' in session && typeof session.employeeId === 'string' ? { employeeId: session.employeeId } : {} })
      if (next === identity) return
      identity = next
      identityLifecycle.abort(new Error('Product employee identity changed'))
      identityLifecycle = new AbortController()
    })
    void api?.getSession().then((session) => { if (live && identity === undefined) identity = key(session) }).catch(() => {
      // Main still authenticates each request; identity events cancel work queued before a change.
    })
    return () => { live = false; unsubscribe?.() }
  }, 'product-task.identity')
  ctx.effect(() => async () => {
    lifecycle.abort(new Error('Product task actions were released'))
    await pending
  }, 'product-task.actions')
  const operationSignal = () => AbortSignal.any([lifecycle.signal, identityLifecycle.signal])
  const serialize = (signal: AbortSignal, operation: (signal: AbortSignal) => Promise<void>) => {
    const result = pending.then(() => operation(signal))
    pending = result.catch((error: unknown) => { console.warn('Product task preparation failed', error) })
    return result
  }
  const currentSession = () => Object.values(ctx.sessions.list.getSnapshot().byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
  const invoke = (method: string, payload?: unknown, signal?: AbortSignal) => {
    const api = productApi()
    if (api === undefined) throw new Error('Product bridge is unavailable')
    const combined = AbortSignal.any([lifecycle.signal, ...signal === undefined ? [] : [signal]])
    return invokeProduct(api, method, payload, combined)
  }
  const workspace = async (signal: AbortSignal, sessionId?: SessionId) => {
    signal.throwIfAborted()
    const items = ctx.workspaces.list.getSnapshot().items
    const selected = sessionId === undefined ? undefined : items.find(item => item.sessionIds.includes(sessionId))
    const result = selected ?? items[0] ?? await ctx.workspaces.initializeDefault(signal)
    signal.throwIfAborted()
    if (result !== undefined) return result
    const choice = await ctx.remote.directoryPicker.pick(signal)
    signal.throwIfAborted()
    if (!choice.ok) throw choice.error
    const path = choice.value
    if (path === null) throw new Error('Workspace selection was canceled')
    return ctx.workspaces.create({ path })
  }
  const draft = (sessionId?: SessionId): DraftSnapshot => {
    const binding = sessionId === undefined ? undefined : ctx.sessions.binding(sessionId)
    if (binding === undefined) return { text: '', references: [] }
    return ctx.conversation.input.for(binding.ctx).draftSnapshot
  }
  const initializeDraft = (binding: Parameters<typeof ctx.conversation.input.requestDraftInitialization>[0], prompt: DraftInput) => {
    const result = ctx.conversation.input.requestDraftInitialization(binding, { prompt, clearPreviousDraft: true })
    if (result === 'blocked') throw new Error('Task draft initialization is blocked by a pending submission')
  }
  const readCapabilities = async (sessionId = currentSession()): Promise<ProductTaskCapabilities> => {
    const value = await invoke('tasks.capabilities.read', sessionId === undefined ? {} : { sessionId })
    return parseTaskCapabilities(value)
  }
  const prepare = async (request: ProductTaskCapabilityRequest, signal: AbortSignal, options: { navigation?: AbortSignal } = {}) => {
    const current = request.sessionId as SessionId | undefined
    const value = await invoke('tasks.capabilities.prepare', {
      ...request, ...current === undefined ? {} : { sessionId: current },
    }, signal)
    const result = parseTaskCapabilityResult(value, request)
    const newSession = async () => {
      const item = await workspace(signal, current)
      signal.throwIfAborted()
      return ctx.sessions.create({ workspaceId: item.workspaceId })
    }
    let sessionId = result.kind === 'CURRENT_SESSION' && current !== undefined
      ? current : await newSession()
    signal.throwIfAborted()
    let selected = await ctx.remote.agentPresets.select(sessionId, result.presetId)
    signal.throwIfAborted()
    if (!selected.ok && selected.error.code === 'agent-preset/locked') {
      sessionId = await newSession()
      selected = await ctx.remote.agentPresets.select(sessionId, result.presetId)
      signal.throwIfAborted()
    }
    if (!selected.ok) throw selected.error
    await ctx.sessions.using(sessionId, { source: 'gateway', signal }, (reference) => {
      signal.throwIfAborted()
      const input = ctx.conversation.input.for(reference.binding.ctx)
      if (sessionId !== current) {
        initializeDraft(reference.binding, draft(current))
      }
      if (currentSession() === current && options.navigation?.aborted !== true) {
        ctx.uiWorkspace.openSession(sessionId)
        input.focus()
      }
      return Promise.resolve()
    })
  }
  const enqueue = (request: ProductTaskCapabilityRequest, sessionId = currentSession()) => {
    const signal = operationSignal()
    const source = sessionId === undefined ? undefined : ctx.sessions.retain(sessionId, { source: 'gateway', signal })
    let navigation: AbortSignal
    try { navigation = ctx.layout.beginNavigation() }
    catch (error) { source?.release(); throw error }
    const captured = structuredClone({ ...request, ...sessionId === undefined ? {} : { sessionId } })
    return serialize(signal, async (signal) => {
      try { await source?.ready; await prepare(captured, signal, { navigation }) }
      finally { source?.release() }
    })
  }
  return {
    readKnowledgeCatalog: signal => invoke('knowledge.bases.list', undefined, signal).then(items),
    openCatalog: (catalog) => {
      const panel = CAPABILITY_PANELS.find(value => value.labelKey === catalog)
      if (panel === undefined) throw new Error('Task capability panel is unavailable')
      ctx.layout.selectPanel(panel.id)
    },
    readMode: async (sessionId) => {
      const id = sessionId ?? currentSession()
      const [roster, capabilities] = await Promise.all([
        ctx.remote.agentPresets.list(),
        readCapabilities(id),
      ])
      if (!roster.ok) throw roster.error
      const current = id === undefined ? undefined : ctx.sessions.list.getSnapshot().byId[id]?.projectionValues?.agentPreset
      const modeId = (capabilities.unavailable === undefined ? capabilities.basePresetId : roster.value.presets.find(row => row.isDefault)?.id) ?? (typeof current === 'string' && !current.startsWith('product-task-')
        ? current : roster.value.presets.find(row => row.isDefault)?.id)
      const mode = roster.value.presets.find(row => row.id === modeId)
      if (mode === undefined) throw new Error('Task execution mode is unavailable')
      return { mode, capabilities,
        options: roster.value.presets.filter(row => row.selectable && row.defaultable && row.broken === undefined) }
    },
    setKnowledgeSelection: (ids, sessionId) => enqueue({ knowledgeBaseIds: ids }, sessionId),
    recoverCapabilities: sessionId => enqueue({ recoverCapabilities: true }, sessionId),
    retryCapabilities: (sessionId = currentSession()) => {
      if (sessionId === undefined) return Promise.reject(new Error('Task retry requires a Session'))
      const signal = operationSignal()
      const source = ctx.sessions.retain(sessionId, { source: 'gateway', signal })
      return serialize(signal, async (signal) => {
        try {
          await source.ready
          const presetId = ctx.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset
          if (typeof presetId !== 'string' || !presetId.startsWith('product-task-')) throw new Error('Task retry requires a pinned capability snapshot')
          const value = parseTaskCapabilityResult(await invoke('tasks.capabilities.prepare', { sessionId }, signal))
          if (value.presetId !== presetId
            || ctx.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset !== presetId) {
            throw new Error('Task composition changed during retry; refresh the task')
          }
        } finally { source.release() }
      })
    },
    readCapabilities,
    subscribeTaskSelection: (listener) => {
      const selection = () => {
        const id = currentSession()
        return JSON.stringify([id, id === undefined ? undefined : ctx.sessions.list.getSnapshot().byId[id]?.projectionValues?.agentPreset])
      }
      let previous = selection()
      return ctx.sessions.list.subscribe(() => {
        const current = selection()
        if (current === previous) return
        previous = current
        listener()
      })
    },
  }
}

/** Task selectors use product catalogs and the official Session selection guard. */
export interface TaskModeActions {
  /** Read knowledge identities and references available to the employee. */
  readonly readKnowledgeCatalog: (signal?: AbortSignal) => Promise<readonly ProductItem[]>
  /** Open a capability directory without changing the current Session or draft. */
  readonly openCatalog: (catalog: Catalog) => void
  /** Read one Session's mode and capability summary, or the current task when omitted. */
  readonly readMode: (sessionId?: SessionId) => Promise<{
    mode: AgentPresetRow
    options: readonly AgentPresetRow[]
    capabilities: ProductTaskCapabilities
  }>
  /** Apply a complete knowledge selection once, retaining other task configuration. */
  readonly setKnowledgeSelection: (ids: readonly string[], sessionId?: SessionId) => Promise<void>
  readonly recoverCapabilities: (sessionId?: SessionId) => Promise<void>
  /** Restore the pinned snapshot registration without selecting a Preset, navigating, or changing drafts. */
  readonly retryCapabilities: (sessionId?: SessionId) => Promise<void>
}
