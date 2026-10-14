/** Employee-scoped installations exposed through the official per-agent Skill Provider. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { SkillDefinition, SkillProviderControl, SkillRegistry } from '@deepseek-ai/dsh-skill'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { publicToolName } from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { ProductContentIdentity, ProductInstalledSkills, ProductTaskCapabilities } from '@deepseek-harness/product/protocol'
import { isProductFailure, ProductError } from '@deepseek-harness/product/errors'
import type { SkillContent } from './content.ts'
import type { DeepSeekHarnessProductIpc } from './deepseek-harness-product-ipc.ts'
import { connectorServerName, hydrateConnectors, parseConnectorSnapshots, snapshotConnector, type ConnectorSnapshot, type DeepSeekHarnessConnector } from './deepseek-harness-connector-contract.ts'

interface Dependencies {
  readonly root: string
  readonly product: Pick<DeepSeekHarnessProductIpc, 'invoke'>
  readonly parse: (value: unknown) => SkillContent[]
  readonly load: (skill: SkillContent) => Promise<SkillDefinition>
  readonly install: (skill: SkillContent, signal?: AbortSignal) => Promise<void>
  readonly capabilities: (sessionId: string) => Promise<ProductTaskCapabilities>
  readonly connectors: (signal?: AbortSignal) => Promise<readonly DeepSeekHarnessConnector[]>
  readonly mountConnectors: (
    agent: Agent, connectors: readonly DeepSeekHarnessConnector[], signal?: AbortSignal,
  ) => Promise<() => Promise<void>>
}
interface CatalogSnapshot {
  readonly employee: string
  readonly skills: readonly SkillContent[]
  readonly connectors: readonly ConnectorSnapshot[]
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Installed content identities remain in the message text; readers preserve it without this producer.
     * @persistenceAttribution
     */
    'product-installed-skills': {
      readonly kind: 'product-installed-skills'
    }
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { productInstalledSkillsPublished: boolean }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const identity = (skill: SkillContent): ProductContentIdentity => ({
  id: skill.id, name: skill.name, version: skill.version, sha256: skill.sha256,
})
const MAX_CATALOG_BYTES = 8 * 1024 * 1024

/** Mount installed skills without selecting or deriving a Preset.
 * @param ctx Product runtime owner; unloading removes every borrowed registration.
 * @param deps Content installation, credential-free data, and task-scope checks.
 * @returns Installation, removal, and inspection operations with durable per-session catalogs.
 */
export function createInstalledSkills(ctx: Context, deps: Dependencies) {
  ctx.sessionProjections.register({
    key: 'productInstalledSkillsPublished', stateSchema: z.boolean(), stateVersion: 1, init: () => false,
    apply: (state, event) => state || (event.type === 'user/message' && event.data.source.kind === 'product-installed-skills'),
  })
  const catalogs = new Map<string, CatalogSnapshot>()
  const controls = new Map<Agent, SkillProviderControl>()
  const providers = new Map<Agent, () => void>()
  const mounts = new Map<Agent, { stamp: string; ready: Promise<() => Promise<void>> }>()
  const preparations = new Map<Agent, Promise<void>>()
  let installation: Promise<unknown> = Promise.resolve()
  let closed = false
  const assertOpen = () => { if (closed) throw new Error('Skill installer has been disposed') }
  ctx.effect(() => async () => { closed = true; await installation }, 'product-installed-skills.installations')
  const unmount = async (agent: Agent) => {
    const mounted = mounts.get(agent)
    mounts.delete(agent)
    if (mounted !== undefined) await (await mounted.ready)()
  }
  ctx.effect(() => async () => {
    closed = true
    for (const dispose of providers.values()) dispose()
    await Promise.allSettled(preparations.values())
    await Promise.all([...mounts.keys()].map(unmount))
    providers.clear()
    controls.clear()
    catalogs.clear()
  }, 'product-installed-skills.providers')
  // oxlint-disable-next-line typescript/no-misused-promises -- Notifications contain rejections; Agent scope owns teardown.
  ctx.on('agent/disposed', async ({ agent }) => {
    providers.get(agent)?.()
    providers.delete(agent)
    controls.delete(agent)
    catalogs.delete(agent.session.id)
    await preparations.get(agent)?.catch(() => undefined)
    await unmount(agent)
  })
  const account = async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const session = await deps.product.invoke('auth.getSession', undefined, signal)
    if (typeof session !== 'object' || session === null || !('authenticated' in session) || session.authenticated !== true
      || !('employeeId' in session) || typeof session.employeeId !== 'string' || session.employeeId === '') {
      throw new Error('Installed skills require an authenticated employee')
    }
    return hash(session.employeeId)
  }
  const read = async (path: string): Promise<unknown> => {
    try {
      if ((await stat(path)).size > MAX_CATALOG_BYTES) throw new Error('Installed skill catalog is too large')
      return JSON.parse(await readFile(path, 'utf8'))
    }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
  }
  const save = async (path: string, value: unknown, signal?: AbortSignal) => {
    const encoded = JSON.stringify(value)
    if (Buffer.byteLength(encoded) > MAX_CATALOG_BYTES) throw new Error('Installed skill catalog is too large')
    await mkdir(deps.root, { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, encoded, { mode: 0o600, signal })
      signal?.throwIfAborted()
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  }
  const installed = async (employee: string) => {
    const value = await read(join(deps.root, `installed-${employee}.json`))
    return value === undefined ? [] : parseCatalog(value)
  }
  const parseCatalog = (value: unknown) => {
    const skills = deps.parse(value)
    if (!Array.isArray(value) || skills.length !== value.length || new Set(skills.map(skill => skill.id)).size !== skills.length
      || skills.some(skill => !/^[a-z][a-z0-9-]{2,63}$/.test(skill.id) || !/^[a-fA-F0-9]{64}$/.test(skill.sha256))) {
      throw new Error('Invalid installed skill catalog')
    }
    return skills
  }
  const eligible = async (
    agent: Agent, entries: readonly SkillContent[], signal?: AbortSignal,
    pinned?: readonly ConnectorSnapshot[], requireMountedTools = false,
  ) => {
    const capabilities = await deps.capabilities(agent.session.id)
    const tools = new Set(ctx.tools.schemas(agent).map(tool => tool.name))
    const visible = async () => {
      const value = await deps.product.invoke('knowledge.bases.list', undefined, signal)
      if (!Array.isArray(value)) throw new Error('Invalid skill dependency catalog')
      return value.map((entry: unknown) => {
        if (typeof entry !== 'object' || entry === null) throw new Error('Invalid skill dependency')
        return entry as Record<string, unknown>
      })
    }
    const live = entries.some(skill => skill.connectorRefs.length > 0) ? await deps.connectors(signal) : []
    const connectors = pinned === undefined ? live : hydrateConnectors(pinned.filter(contract =>
      live.some(connector => connector.id === contract.id && connector.transport === contract.transport)), live)
    const knowledge = new Map<string, Set<string>>()
    for (const [reference, id] of (entries.some(skill => skill.knowledgeBaseRefs.length > 0) ? await visible() : [])
      .flatMap(record => typeof record.id !== 'string' ? [] : [record.id, record.referenceKey, record.reference]
        .filter((id): id is string => typeof id === 'string').map(reference => [reference, record.id as string] as const))) {
      if (!capabilities.knowledgeBaseIds.includes(id)) continue
      const candidates = knowledge.get(reference) ?? new Set<string>()
      candidates.add(id)
      knowledge.set(reference, candidates)
    }
    const candidates = entries.filter(skill => skill.connectorRefs.every(id => connectors.some(connector => connector.id === id))
      && skill.knowledgeBaseRefs.every((id) => {
        return knowledge.get(id)?.size === 1
      })
      && skill.requiredTools.every(name => tools.has(name) || connectors.some(connector =>
        skill.connectorRefs.includes(connector.id) && connector.toolNames.some((tool) => {
          const publicName = publicToolName(connectorServerName(connector.id), tool)
          return (tool === name || publicName === name) && (!requireMountedTools || tools.has(publicName))
        }))))
    const permissions = await Promise.allSettled(candidates.map(async (skill) => { await permitted(skill, signal); return skill }))
    signal?.throwIfAborted()
    for (const result of permissions) {
      if (result.status === 'rejected' && !(isProductFailure(result.reason)
        && result.reason.code === 'EXPERT_KIT_NOT_FOUND' && !result.reason.retryable)) throw result.reason
    }
    const skills = permissions.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    const ids = new Set(skills.flatMap(skill => skill.connectorRefs))
    return { skills, connectors: connectors.filter(connector => ids.has(connector.id)).sort((a, b) => a.id.localeCompare(b.id)) }
  }
  const catalog = async (agent: Agent, freeze = false, signal?: AbortSignal): Promise<CatalogSnapshot> => {
    const employee = await account(signal)
    const sessionId = agent.session.id
    const path = join(deps.root, `session-${hash(sessionId)}.json`)
    let snapshot = catalogs.get(sessionId)
    if (snapshot === undefined) {
      const stored = await read(path)
      if (stored === undefined && ctx.sessionProjections.stateOf(agent.session, 'productInstalledSkillsPublished')) {
        throw new ProductError('SKILL_SNAPSHOT_MISSING', 'The task skill snapshot is missing; create a replacement task', false,
          [{ kind: 'session', id: sessionId }])
      }
      if (stored !== undefined) {
        if (typeof stored !== 'object' || stored === null || !('employee' in stored) || !('skills' in stored)
          || !('connectors' in stored) || !Array.isArray(stored.connectors)
          || !('digest' in stored) || stored.digest !== hash(JSON.stringify({ employee: stored.employee, skills: stored.skills, connectors: stored.connectors }))) {
          throw new Error('Invalid installed skill session snapshot')
        }
        snapshot = { employee: String(stored.employee), skills: parseCatalog(stored.skills),
          connectors: parseConnectorSnapshots(stored.connectors) }
        catalogs.set(sessionId, snapshot)
      }
    }
    if (snapshot !== undefined) {
      if (snapshot.employee !== employee) throw new Error('Task skill catalog belongs to another employee')
      return snapshot
    }
    const available = await eligible(agent, await installed(employee), signal)
    snapshot = { employee, skills: available.skills, connectors: available.connectors.map(snapshotConnector) }
    if (freeze) {
      const loaded = await Promise.allSettled(snapshot.skills.map(skill => deps.load(skill)))
      signal?.throwIfAborted()
      for (const result of loaded) if (result.status === 'rejected') throw result.reason
      await save(path, { ...snapshot, digest: hash(JSON.stringify(snapshot)) }, signal)
      catalogs.set(sessionId, snapshot)
    }
    return snapshot
  }
  const permitted = async (skill: SkillContent, signal?: AbortSignal) => {
    // A local snapshot pins content, but grants no continuing server authorization.
    const current = deps.parse([await deps.product.invoke('skills.get', { id: skill.id }, signal)])[0]
    if (current === undefined || current.id !== skill.id) throw new Error(`Skill permission is unavailable: ${skill.id}`)
  }
  const attach = (agent: Agent) => {
    if (controls.has(agent)) return
    const dispose = (agent.ctx.get('skills') as SkillRegistry).registerProvider((control) => {
      controls.set(agent, control)
      return {
        name: 'product-installed-skills',
        async list(options) {
          const snapshot = await catalog(agent, false, options.signal)
          const available = await eligible(agent, snapshot.skills, options.signal, snapshot.connectors, mounts.has(agent))
          const results = await Promise.allSettled(available.skills.map(async (skill) => {
            const definition = await deps.load(skill)
            return { ...definition, provider: 'product-installed-skills', source: 'user' as const, rank: 350,
              locator: skill.id, metadata: { ...definition.metadata, productContent: identity(skill) } }
          }))
          options.signal?.throwIfAborted()
          return results.map((result) => {
            if (result.status === 'rejected') throw result.reason
            return result.value
          })
        },
        async get(candidate, options) {
          const snapshot = await catalog(agent, false, options.signal)
          const skill = snapshot.skills.find(value => value.id === candidate.locator)
          if (skill === undefined) return undefined
          await permitted(skill, options.signal)
          const available = await eligible(agent, [skill], options.signal, snapshot.connectors, mounts.has(agent))
          if (available.skills.length === 0) throw new Error(`Skill dependencies are unavailable: ${skill.id}`)
          const definition = await deps.load(skill)
          return { ...definition, provider: 'product-installed-skills', source: 'user' as const,
            metadata: { ...definition.metadata, productContent: identity(skill) } }
        },
      }
    })
    providers.set(agent, dispose)
  }
  ctx.on('agent/created', ({ agent }) => { attach(agent) })
  ctx.on('agent-preset/selected', (sessionId) => {
    const agent = ctx.agents.get(sessionId)
    if (agent !== undefined) controls.get(agent)?.invalidate()
  })
  for (const agent of ctx.agents.list()) attach(agent)
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent
    if (agent === undefined) return next()
    const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
    if (boundary === undefined) throw new Error('Installed skills require the official turn boundary projection')
    if (boundary.lastTurn === 0) return next()
    const signal = context.signal
    signal?.throwIfAborted()
    const previous = mounts.get(agent)
    const operation = (preparations.get(agent)?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
      assertOpen()
      signal?.throwIfAborted()
      const snapshot = await catalog(agent, true, signal)
      const available = await eligible(agent, snapshot.skills, signal, snapshot.connectors)
      const stamp = JSON.stringify(available.connectors)
      if (mounts.get(agent)?.stamp !== stamp) {
        await unmount(agent)
        assertOpen()
        const ready = deps.mountConnectors(agent, available.connectors, signal).then(async (dispose) => {
          if (closed) { await dispose(); throw new Error('Skill installer has been disposed') }
          return dispose
        })
        mounts.set(agent, { stamp, ready })
        try { await ready } catch (error) { mounts.delete(agent); throw error }
      } else await mounts.get(agent)?.ready
    })
    preparations.set(agent, operation)
    try { await operation }
    finally { if (preparations.get(agent) === operation) preparations.delete(agent) }
    signal?.throwIfAborted()
    const assembly = await next()
    // Tool providers run before this waterfall. Reassemble once after a mount changes,
    // so native schemas and the official PTC SDK both include the same scoped tools.
    return previous === mounts.get(agent) ? assembly : ctx.systemPrompt.assemble(context)
  }, { prepend: true })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    signal.throwIfAborted()
    const snapshot = await catalog(agent, true, signal)
    controls.get(agent)?.invalidate()
    const decision = await next()
    if (decision.kind === 'reject' || ctx.sessionProjections.stateOf(agent.session, 'productInstalledSkillsPublished')) return decision
    signal.throwIfAborted()
    const entries = snapshot.skills.map(identity)
    return { ...decision, messages: [...decision.messages, createUserMessage({
      content: [{ type: 'text', text: `Installed skill content snapshot:\n${JSON.stringify({ entries, connectors: snapshot.connectors })}` }],
      source: { kind: 'product-installed-skills' },
    })] }
  })
  return {
    async install(id: string, signal?: AbortSignal): Promise<ProductContentIdentity> {
      const pending = installation.then(async () => {
        assertOpen()
        const employee = await account(signal)
        const skill = deps.parse([await deps.product.invoke('skills.get', { id }, signal)])[0]
        if (skill === undefined || skill.id !== id) throw new Error(`Skill is unavailable: ${id}`)
        await deps.install(skill, signal)
        signal?.throwIfAborted()
        await deps.load(skill)
        const previous = await installed(employee)
        if (await account(signal) !== employee) throw new Error('Employee changed during skill installation')
        assertOpen()
        signal?.throwIfAborted()
        const skills = [...previous.filter(value => value.id !== id), skill].sort((a, b) => a.id.localeCompare(b.id))
        await save(join(deps.root, `installed-${employee}.json`), skills, signal)
        for (const control of controls.values()) control.invalidate()
        return identity(skill)
      })
      installation = pending.catch(() => undefined)
      return pending
    },
    uninstall(id: string, signal?: AbortSignal): Promise<{ id: string }> {
      const pending = installation.then(async () => {
        assertOpen()
        if (!/^[a-z][a-z0-9-]{2,63}$/.test(id)) throw new Error('Invalid Skill identity')
        const employee = await account(signal)
        const previous = await installed(employee)
        if (await account(signal) !== employee) throw new Error('Employee changed during skill removal')
        assertOpen()
        signal?.throwIfAborted()
        await save(join(deps.root, `installed-${employee}.json`), previous.filter(skill => skill.id !== id), signal)
        for (const control of controls.values()) control.invalidate()
        return { id }
      })
      installation = pending.catch(() => undefined)
      return pending
    },
    async read(sessionId?: string, signal?: AbortSignal): Promise<ProductInstalledSkills> {
      const employee = await account(signal)
      const all = await installed(employee)
      const agent = sessionId === undefined ? undefined : ctx.agents.get(sessionId as Agent['session']['id'])
      const snapshot = agent === undefined ? undefined : await catalog(agent, false, signal)
      const available = agent === undefined || snapshot === undefined ? []
        : (await eligible(agent, snapshot.skills, signal, snapshot.connectors, mounts.has(agent))).skills
      return { installed: all.map(identity), available: available.map(identity),
        frozen: sessionId !== undefined && catalogs.has(sessionId) }
    },
  }
}
