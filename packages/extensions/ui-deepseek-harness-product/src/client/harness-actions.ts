/** The only product client adapter to Harness Sessions, Presets, Workspaces, and drafts. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { ExtensionAuthoringSnapshotSchema } from '@deepseek-harness/product/extension-draft'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { DraftInput, DraftSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-skill/client'
import type { ProductTaskCapabilityRequest, ProductTaskCapabilityResult, ProductTaskCapabilities, ProductInstalledExpertKits, ProductInstalledSkills } from '@deepseek-harness/product/protocol'
import type { DeepSeekHarnessCatalogActions } from './DeepSeekHarnessCatalogSection.tsx'
import type { AgentPresetRow } from '@deepseek-ai/dsh-agent-preset-registry/types'
import { productApi, type ProductApi } from './product-api.ts'
import { isInstalled, items, nextProductRequestId, type Catalog, type ProductItem } from './catalog-shared.tsx'
import { CAPABILITY_PANELS } from './DeepSeekHarnessCapabilitiesNavigation.tsx'

/** Adapt product selection to official task services.
 * @param ctx Client plugin context.
 * @returns Serialized capability actions that preserve the current draft on failure.
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
  const serialize = (operation: (signal: AbortSignal) => Promise<void>) => {
    const signal = AbortSignal.any([lifecycle.signal, identityLifecycle.signal])
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
    combined.throwIfAborted()
    const requestId = nextProductRequestId()
    const abort = () =>{  api.cancel(requestId) }
    combined.addEventListener('abort', abort, { once: true })
    return api.invoke(method, payload, requestId).then((value) => {
      combined.throwIfAborted()
      return value
    }).finally(() =>{  combined.removeEventListener('abort', abort) })
  }
  const workspace = async (sessionId?: SessionId) => {
    const items = ctx.workspaces.list.getSnapshot().items
    const selected = sessionId === undefined ? undefined : items.find(item => item.sessionIds.includes(sessionId))
    const result = selected ?? items[0] ?? await ctx.workspaces.initializeDefault()
    if (result !== undefined) return result
    const path = await ctx.uiWorkspace.pickDirectory()
    if (path === null) throw new Error('Workspace selection was canceled')
    return ctx.workspaces.create({ path })
  }
  const draft = (sessionId?: SessionId): DraftSnapshot => {
    const binding = sessionId === undefined ? undefined : ctx.sessions.binding(sessionId)
    if (binding === undefined) return { text: '', references: [] }
    const snapshot = ctx.conversation.input.for(binding.ctx).state.getSnapshot()
    return { text: snapshot.draft, references: snapshot.occurrences }
  }
  const initializeDraft = (binding: Parameters<typeof ctx.conversation.input.requestDraftInitialization>[0], prompt: DraftInput) => {
    const result = ctx.conversation.input.requestDraftInitialization(binding, { prompt, clearPreviousDraft: true })
    if (result === 'blocked') throw new Error('Task draft initialization is blocked by a pending submission')
  }
  const readCapabilities = async (sessionId = currentSession()): Promise<ProductTaskCapabilities> => {
    const value = await invoke('tasks.capabilities.read', sessionId === undefined ? {} : { sessionId })
    if (typeof value !== 'object' || value === null || !('connectorIds' in value) || !Array.isArray(value.connectorIds)
      || !('requiredConnectorIds' in value) || !Array.isArray(value.requiredConnectorIds)
      || !('requiredKnowledgeBaseIds' in value) || !Array.isArray(value.requiredKnowledgeBaseIds)
      || !('knowledgeBaseIds' in value) || !Array.isArray(value.knowledgeBaseIds)) throw new Error('Invalid task capabilities')
    return value as ProductTaskCapabilities
  }
  const readInstalledSkills = async (sessionId = currentSession()): Promise<ProductInstalledSkills> => {
    const value = await invoke('skills.installed.read', sessionId === undefined ? {} : { sessionId })
    if (typeof value !== 'object' || value === null || !('installed' in value) || !Array.isArray(value.installed)
      || !('available' in value) || !Array.isArray(value.available) || !('frozen' in value) || typeof value.frozen !== 'boolean') {
      throw new Error('Invalid installed skill response')
    }
    return value as ProductInstalledSkills
  }
  const readInstalledExpertKits = async (signal?: AbortSignal): Promise<ProductInstalledExpertKits> => {
    const value = await invoke('expertKits.installed.read', undefined, signal)
    if (typeof value !== 'object' || value === null || !('installed' in value) || !Array.isArray(value.installed)
      || value.installed.some((kit: unknown) => typeof kit !== 'object' || kit === null
        || !('id' in kit) || typeof kit.id !== 'string' || !('version' in kit) || typeof kit.version !== 'string'
        || !('sha256' in kit) || typeof kit.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(kit.sha256))) {
      throw new Error('Invalid installed Expert Kit response')
    }
    return value as ProductInstalledExpertKits
  }
  const prepare = async (request: ProductTaskCapabilityRequest, signal: AbortSignal, options: { navigation?: AbortSignal } = {}) => {
    const current = request.sessionId as SessionId | undefined
    const value = await invoke('tasks.capabilities.prepare', {
      ...request, ...current === undefined ? {} : { sessionId: current },
    }, signal)
    if (typeof value !== 'object' || value === null || !('presetId' in value) || typeof value.presetId !== 'string'
      || !('kind' in value) || !['CURRENT_SESSION', 'NEW_SESSION'].includes(String(value.kind))) throw new Error('Invalid task preparation response')
    const result = value as ProductTaskCapabilityResult
    const newSession = async () => {
      const item = await workspace(current)
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
    if (!selected.ok) throw new Error(selected.error.message)
    await ctx.sessions.using(sessionId, { source: 'gateway' }, (reference) => {
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
    const source = sessionId === undefined ? undefined : ctx.sessions.retain(sessionId, { source: 'gateway' })
    let navigation: AbortSignal
    try { navigation = ctx.layout.beginNavigation() }
    catch (error) { source?.release(); throw error }
    const captured = structuredClone({ ...request, ...sessionId === undefined ? {} : { sessionId } })
    return serialize(async (signal) => {
      try { await source?.ready; await prepare(captured, signal, { navigation }) }
      finally { source?.release() }
    })
  }
  return {
    startExtensionAuthoring: (kind, options) => {
      const current = currentSession()
      const source = current === undefined ? undefined : ctx.sessions.retain(current, { source: 'gateway' })
      let navigation: AbortSignal
      try { navigation = ctx.layout.beginNavigation() }
      catch (error) { source?.release(); throw error }
      const captured = structuredClone(options)
      return serialize(async (signal) => {
        try {
          await source?.ready
          signal.throwIfAborted()
          const location = await workspace(current)
          const sessionId = SessionId(`session-${randomUUID()}`)
          const state = ExtensionAuthoringSnapshotSchema.parse(await invoke('extensions.authoring.begin',
            { kind, sessionId, ...captured }, signal))
          try { await ctx.sessions.create({ workspaceId: location.workspaceId, sessionId }) }
          catch (error) {
            await invoke('extensions.authoring.discard', { sessionId, authoringId: state.authoringId, revision: state.revision }).catch(() => undefined)
            throw error
          }
          await ctx.sessions.using(sessionId, { source: 'gateway' }, (reference) => {
            signal.throwIfAborted()
            const input = ctx.conversation.input.for(reference.binding.ctx)
            initializeDraft(reference.binding, captured.prompt)
            if (currentSession() === current && !navigation.aborted) { ctx.uiWorkspace.openSession(sessionId); input.focus() }
            return Promise.resolve()
          })
        } finally { source?.release() }
      })
    },
    readExpertKits: async (signal) => {
      const [catalog, installations] = await Promise.all([
        invoke('expertKits.list', undefined, signal), readInstalledExpertKits(signal),
      ])
      const installed = new Map(installations.installed.map(kit => [kit.id, kit]))
      return items(catalog).filter(kit => isInstalled(installed, kit))
    },
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
      if (!roster.ok) throw new Error(roster.error.message)
      const current = id === undefined ? undefined : ctx.sessions.list.getSnapshot().byId[id]?.projectionValues?.agentPreset
      const modeId = (capabilities.unavailable === undefined ? capabilities.basePresetId : roster.value.presets.find(row => row.isDefault)?.id) ?? (typeof current === 'string' && !current.startsWith('product-task-')
        ? current : roster.value.presets.find(row => row.isDefault)?.id)
      const mode = roster.value.presets.find(row => row.id === modeId)
      if (mode === undefined) throw new Error('Task execution mode is unavailable')
      return { mode, capabilities,
        options: roster.value.presets.filter(row => row.selectable && row.defaultable && row.broken === undefined) }
    },
    setExpertKit: (id, sessionId) => enqueue({ expertKitId: id }, sessionId),
    setKnowledgeSelection: (ids, sessionId) => enqueue({ knowledgeBaseIds: ids }, sessionId),
    recoverCapabilities: sessionId => enqueue({ recoverCapabilities: true }, sessionId),
    retryCapabilities: (sessionId = currentSession()) => {
      if (sessionId === undefined) return Promise.reject(new Error('Task retry requires a Session'))
      const source = ctx.sessions.retain(sessionId, { source: 'gateway' })
      return serialize(async (signal) => {
        try {
          await source.ready
          const presetId = ctx.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset
          if (typeof presetId !== 'string' || !presetId.startsWith('product-task-')) throw new Error('Task retry requires a pinned capability snapshot')
          const value = await invoke('tasks.capabilities.prepare', { sessionId }, signal)
          if (typeof value !== 'object' || value === null || !('presetId' in value) || value.presetId !== presetId
            || ctx.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset !== presetId) {
            throw new Error('Task composition changed during retry; refresh the task')
          }
        } finally { source.release() }
      })
    },
    startExpertKit: id => enqueue({ expertKitId: id }),
    installSkill: id => serialize(async (signal) => {
      await invoke('skills.install', { id }, signal)
      ctx.uiSkills.refresh()
    }),
    readInstalledSkills,
    installExpertKit: id => serialize(async (signal) => { await invoke('expertKits.install', { id }, signal) }),
    readInstalledExpertKits,
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
  /** Read installed Expert Kits whose identities still match the accessible catalog. */
  readonly readExpertKits: (signal?: AbortSignal) => Promise<readonly ProductItem[]>
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
  /** Replace or clear the Expert Kit while preserving selected knowledge and drafts. */
  readonly setExpertKit: (id: string | null, sessionId?: SessionId) => Promise<void>
  /** Apply a complete knowledge selection once, retaining other task configuration. */
  readonly setKnowledgeSelection: (ids: readonly string[], sessionId?: SessionId) => Promise<void>
  readonly recoverCapabilities: (sessionId?: SessionId) => Promise<void>
  /** Restore the pinned snapshot registration without selecting a Preset, navigating, or changing drafts. */
  readonly retryCapabilities: (sessionId?: SessionId) => Promise<void>
}
