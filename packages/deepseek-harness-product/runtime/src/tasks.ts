import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { entryListProblem, type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { ProductContentIdentity, ProductTaskCapabilities, ProductTaskCapabilityRequest, ProductTaskCapabilityResult } from '@deepseek-harness/product/protocol'
import { ProductError, isProductFailure, productFailure, type ProductFailure } from '@deepseek-harness/product/errors'
import { z } from 'zod'
import { hydrateConnectors, parseConnectorSnapshots, snapshotConnector, type DeepSeekHarnessConnector } from './deepseek-harness-connector-contract.ts'

export interface TaskContent {
  readonly dependencyChecks?: ProductTaskCapabilityResult['dependencyChecks']
  readonly requiredTools?: readonly string[]
  readonly identity: ProductContentIdentity
  readonly connectorRefs: readonly string[]
  readonly knowledgeBaseRefs: readonly string[]
  readonly plugins: PresetDefinition['plugins']
}

interface Snapshot {
  readonly version: 2
  readonly presetId: string
  readonly definition: PresetDefinition
  readonly capabilities: ProductTaskCapabilities
  readonly requiredConnectorIds: readonly string[]
  readonly connectors: readonly Omit<DeepSeekHarnessConnector, 'headers' | 'environment'>[]
  readonly skillInvocations: Readonly<Record<string, string>>
  readonly basePluginKeys?: readonly string[]
  readonly requiredTools?: readonly string[]
}

export interface TaskDependencies {
  readonly root: string
  readonly authorizeKit?: (id: string, signal?: AbortSignal) => Promise<void>
  readonly visibleKnowledge?: (signal?: AbortSignal) => Promise<readonly string[]>
  readonly content: (kind: 'kit', id: string, signal?: AbortSignal) => Promise<TaskContent>
  readonly connectors: (signal?: AbortSignal) => Promise<readonly DeepSeekHarnessConnector[]>
  readonly validateKnowledge: (ids: readonly string[], refs: readonly string[], signal?: AbortSignal) => Promise<readonly string[]>
  readonly connectorPlugin: (connector: DeepSeekHarnessConnector) => PresetDefinition['plugins'][number]
  readonly knowledgePlugins: (refs: readonly string[], ids: readonly string[]) => PresetDefinition['plugins']
  readonly register: (
    definition: PresetDefinition, connectors: readonly DeepSeekHarnessConnector[],
  ) => Promise<() => Promise<void>>
  readonly validateTools: (presetId: string, requiredTools: readonly string[]) => Promise<void>
}

const empty: ProductTaskCapabilities = {
  skills: [], connectorIds: [], requiredConnectorIds: [], knowledgeBaseIds: [], requiredKnowledgeBaseIds: [], knowledgeBaseRefs: [],
}
const prefix = 'product-task-'
const CAPABILITY_PROMPT = 'cordis:product-task-capabilities'
const sorted = (values: readonly string[]) => [...new Set(values)].sort()
const rowKey = (row: PresetDefinition['plugins'][number]) => row.id ?? JSON.stringify(row)
const identifier = z.string().min(1).max(256)
const identifiers = z.array(identifier).max(32)
const contentIdentity = z.object({ id: identifier, name: z.string().optional(), version: identifier,
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }).strict()
const capabilitySnapshot = z.object({
  basePresetId: identifier.optional(), expertKit: contentIdentity.optional(), skills: z.array(contentIdentity),
  connectorIds: identifiers, requiredConnectorIds: identifiers, knowledgeBaseIds: identifiers,
  requiredKnowledgeBaseIds: identifiers, knowledgeBaseRefs: identifiers,
}).strict().refine(value => value.requiredKnowledgeBaseIds.every(id => value.knowledgeBaseIds.includes(id))
  && value.requiredConnectorIds.every(id => value.connectorIds.includes(id)))

/** Task configuration uses official selection and never changes a running Agent. */
export async function createTaskCapabilities(ctx: Context, deps: TaskDependencies) {
  await mkdir(deps.root, { recursive: true })
  const snapshots = new Map<string, Snapshot>()
  const registrations = new Map<string, Promise<void>>()
  const disposers = new Map<string, () => Promise<void>>()
  const failures = new Map<string, ProductFailure>()
  const blockedPresets = new Map<string, () => Promise<void>>()
  const registerBlocked = async (id: string) => {
    if (blockedPresets.has(id)) return
    const dispose = await deps.register({ id, plugins: [], selectable: false, defaultable: false }, [])
    blockedPresets.set(id, dispose)
  }
  let committing = Promise.resolve()
  const register = (snapshot: Snapshot, connectors: readonly DeepSeekHarnessConnector[], validate = true) => {
    let pending = registrations.get(snapshot.presetId)
    if (pending === undefined) {
      const plugins = snapshot.definition.plugins.map((row) => {
        const connector = connectors.find(value => row.id === deps.connectorPlugin(value).id)
        return connector === undefined ? row : deps.connectorPlugin(connector)
      })
      pending = (async () => {
        const selectionBase = snapshot.capabilities.basePresetId
        const dispose = await deps.register({ ...snapshot.definition,
          ...selectionBase === undefined ? {} : { selectionBase }, plugins }, connectors)
        disposers.set(snapshot.presetId, dispose)
        try {
          if (validate) await deps.validateTools(snapshot.presetId, snapshot.requiredTools ?? [])
        } catch (error) {
          await dispose()
          disposers.delete(snapshot.presetId)
          throw error
        }
      })()
      registrations.set(snapshot.presetId, pending)
      pending.catch(() => { registrations.delete(snapshot.presetId) })
    } else if (validate) {
      return pending.then(() => deps.validateTools(snapshot.presetId, snapshot.requiredTools ?? []))
    }
    return pending
  }
  for (const filename of await readdir(deps.root)) {
    if (!/^product-task-[a-f0-9]{64}\.json$/.test(filename)) continue
    const path = join(deps.root, filename)
    try {
      if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error('Task snapshot exceeds size limit')
      const raw = await readFile(path, 'utf8')
      const candidate: unknown = JSON.parse(raw)
      if (typeof candidate !== 'object' || candidate === null) throw new Error(`Invalid task snapshot: ${filename}`)
      const value = candidate as Omit<Partial<Snapshot>, 'definition' | 'capabilities' | 'skillInvocations'> & {
        definition?: PresetDefinition | null
        capabilities?: ProductTaskCapabilities | null
        skillInvocations?: unknown
      }
      if (value.version !== 2 || `${value.presetId}.json` !== filename || value.definition == null
      || value.capabilities == null || value.definition.id !== value.presetId
      || entryListProblem(value.definition.plugins) !== undefined
      || !Array.isArray(value.capabilities.skills) || !Array.isArray(value.capabilities.connectorIds)
      || !Array.isArray(value.capabilities.requiredKnowledgeBaseIds)
      || !Array.isArray(value.capabilities.knowledgeBaseIds) || !Array.isArray(value.capabilities.knowledgeBaseRefs)
      || !Array.isArray(value.requiredConnectorIds) || !Array.isArray(value.connectors)
      || (value.basePluginKeys !== undefined && (!Array.isArray(value.basePluginKeys) || value.basePluginKeys.some(key => typeof key !== 'string')))
      || (value.requiredTools !== undefined && (!Array.isArray(value.requiredTools) || value.requiredTools.some(key => typeof key !== 'string')))
      || typeof value.skillInvocations !== 'object' || value.skillInvocations === null
      || Array.isArray(value.skillInvocations)
      || Object.values(value.skillInvocations).some(name => typeof name !== 'string')) throw new Error(`Invalid task snapshot: ${filename}`)
      capabilitySnapshot.parse(value.capabilities)
      if (typeof value.capabilities.basePresetId !== 'string'
        || (value.definition.selectionBase !== undefined && value.definition.selectionBase !== value.capabilities.basePresetId)
        || value.definition.selectable !== false || value.definition.defaultable !== false) {
        throw new Error(`Inconsistent task selection base: ${filename}`)
      }
      identifiers.parse(value.requiredConnectorIds)
      parseConnectorSnapshots(value.connectors)
      if (JSON.stringify(value.requiredConnectorIds) !== JSON.stringify(value.capabilities.requiredConnectorIds)) {
        throw new Error(`Inconsistent required connectors: ${filename}`)
      }
      const snapshot = value as Snapshot
      const expected = identify(snapshot.definition, snapshot.capabilities,
        snapshot.requiredConnectorIds, snapshot.connectors, snapshot.skillInvocations, snapshot.basePluginKeys, snapshot.requiredTools)
      if (expected !== snapshot.presetId) throw new Error(`Task snapshot identity mismatch: ${filename}`)
      snapshots.set(snapshot.presetId, snapshot)
    } catch (error) {
      const id = filename.slice(0, -5)
      const failure = productFailure(new ProductError('TASK_SNAPSHOT_INVALID', `Task snapshot cannot be restored: ${filename}`, false,
        [{ kind: 'task-snapshot', id }], { cause: error }))
      failures.set(id, failure)
      ctx.logger.warn(`${failure.message}: ${String(error)}`)
      await writeFile(`${path}.diagnostic.json`, JSON.stringify(failure), { mode: 0o600 }).catch((problem: unknown) => {
        ctx.logger.warn(`Snapshot diagnostic could not be saved: ${String(problem)}`)
      })
    }
  }
  // Keep all task content until a later explicit retention policy can inspect every reference.
  // Catalog refresh does not delete content pinned by a task.
  const references = await ctx.sessionQuery.listSessions()
  const needed = new Set<string>()
  for (const session of references) {
    if (session.header.agentPreset?.startsWith(prefix)) needed.add(session.header.agentPreset)
    using observation = await ctx.sessionQuery.observeSession(session.header.id)
    const selected = observation.projections?.values.agentPreset
    if (typeof selected === 'string' && selected.startsWith(prefix)) needed.add(selected)
  }
  if (needed.size > 0) {
    for (const id of needed) {
      const snapshot = snapshots.get(id)
      if (snapshot === undefined) {
        failures.set(id, failures.get(id) ?? productFailure(new ProductError(
          'TASK_SNAPSHOT_MISSING', `Task snapshot is unavailable: ${id}`, false, [{ kind: 'task-snapshot', id }],
        )))
        // History can mount an empty composition; validate still rejects every model step.
        await registerBlocked(id)
        continue
      }
      // Restored providers may depend on services supplied by this activating Host plugin.
      try { await register(snapshot, hydrateConnectors(snapshot.connectors, await deps.connectors()), false) }
      catch (error) {
        failures.set(id, productFailure(error))
        ctx.logger.warn(`Task ${id} cannot restore its selected capabilities: ${String(error)}`)
      }
    }
  }

  const inspect = async (sessionId?: string) => {
    if (sessionId === undefined) return { presetId: ctx.agentPresets.defaultId, started: false }
    using observation = await ctx.sessionQuery.observeSession(sessionId as Parameters<typeof ctx.sessionQuery.observeSession>[0])
    const projections = observation.projections?.values
    return {
      presetId: typeof projections?.agentPreset === 'string' ? projections.agentPreset : observation.header.agentPreset ?? ctx.agentPresets.defaultId,
      started: observation.events.some(event => event.type === 'turn/start'),
    }
  }
  return {
    async validate(presetId?: string, signal?: AbortSignal): Promise<void> {
      const failure = presetId === undefined ? undefined : failures.get(presetId)
      if (failure !== undefined) throw new ProductError(failure.code, failure.message, failure.retryable, failure.resources)
      if (presetId?.startsWith(prefix) && !snapshots.has(presetId)) {
        throw new ProductError('TASK_SNAPSHOT_UNAVAILABLE', 'Task capabilities need explicit recovery', false,
          [{ kind: 'task-snapshot', id: presetId }])
      }
      const snapshot = presetId === undefined ? undefined : snapshots.get(presetId)
      if (snapshot !== undefined) {
        if (snapshot.capabilities.expertKit !== undefined) await deps.authorizeKit?.(snapshot.capabilities.expertKit.id, signal)
        await deps.validateKnowledge(snapshot.capabilities.knowledgeBaseIds, [], signal)
        await deps.validateTools(snapshot.presetId, snapshot.requiredTools ?? [])
      }
    },
    async read(request: ProductTaskCapabilityRequest): Promise<ProductTaskCapabilities> {
      const current = await inspect(request.sessionId)
      const snapshot = snapshots.get(current.presetId)
      const unavailable = failures.get(current.presetId) ?? (current.presetId.startsWith(prefix) && snapshot === undefined
        ? productFailure(new ProductError('TASK_SNAPSHOT_MISSING', 'Task capabilities need explicit recovery')) : undefined)
      return structuredClone(snapshot === undefined
        ? { ...empty, basePresetId: current.presetId, ...unavailable === undefined ? {} : { unavailable } }
        : { ...snapshot.capabilities, requiredConnectorIds: snapshot.requiredConnectorIds,
          ...unavailable === undefined ? {} : { unavailable } })
    },
    async resolveSelection(sessionId: string, requested: string): Promise<string> {
      const current = await inspect(sessionId)
      if (requested.startsWith(prefix)) { await this.validate(requested); return requested }
      if (current.presetId.startsWith(prefix) && (!snapshots.has(current.presetId) || failures.has(current.presetId))) {
        await this.validate(current.presetId)
      }
      if (!snapshots.has(current.presetId)) return requested
      return (await this.prepare({ sessionId, basePresetId: requested })).presetId
    },
    async prepare(request: ProductTaskCapabilityRequest, signal?: AbortSignal): Promise<ProductTaskCapabilityResult> {
      const dependencyChecks: ProductTaskCapabilityResult['dependencyChecks'][number][] = []
      try {
        const current = await inspect(request.sessionId)
        signal?.throwIfAborted()
        const previous = request.recoverCapabilities === true ? undefined : snapshots.get(current.presetId)
        if (current.presetId.startsWith(prefix) && !snapshots.has(current.presetId) && request.recoverCapabilities !== true) {
          throw new ProductError('TASK_SNAPSHOT_UNAVAILABLE', 'Recover this task before changing its capabilities')
        }
        const source = snapshots.get(current.presetId)
        if (request.recoverCapabilities === true) {
          if (deps.visibleKnowledge === undefined) {
            throw new ProductError('KNOWLEDGE_RECOVERY_UNAVAILABLE', 'Knowledge recovery is unavailable', true)
          }
          const visible = await deps.visibleKnowledge(signal)
          request = { ...request, expertKitId: null,
            knowledgeBaseIds: (request.knowledgeBaseIds ?? source?.capabilities.knowledgeBaseIds ?? []).filter(id => visible.includes(id)),
            basePresetId: request.basePresetId ?? source?.capabilities.basePresetId ?? ctx.agentPresets.defaultId }
        }
        let capabilities = structuredClone(previous?.capabilities ?? empty)
        const basePresetId = request.basePresetId ?? capabilities.basePresetId
        ?? (previous === undefined && !current.presetId.startsWith(prefix) ? current.presetId : ctx.agentPresets.defaultId)
        if (request.basePresetId !== undefined) {
          const mode = await ctx.agentPresets.resolve(basePresetId)
          if (mode.selectable === false || basePresetId.startsWith(prefix)) throw new Error('Selected Preset is not an execution mode')
        }
        const base = ctx.agentPresets.derive(basePresetId, { id: 'pending-task', plugins: [], selectable: false, defaultable: false })
        let basePluginKeys = previous?.basePluginKeys ?? base.plugins.map(rowKey)
        let definition = previous === undefined
          ? base
          : { ...structuredClone(previous.definition), id: 'pending-task' }
        if (request.basePresetId !== undefined && previous !== undefined) {
          if (previous.basePluginKeys === undefined) throw new Error('This task snapshot has no execution mode metadata; create a new task')
          definition = { ...base, plugins: [...base.plugins, ...definition.plugins.filter(row => !basePluginKeys.includes(rowKey(row)))] }
          basePluginKeys = base.plugins.map(rowKey)
        }
        capabilities = { ...capabilities, basePresetId }
        let requiredConnectorIds = [...previous?.requiredConnectorIds ?? []]
        let skillInvocations = { ...previous?.skillInvocations }
        let requiredTools = [...previous?.requiredTools ?? []]
        const mergeContent = (content: TaskContent) => {
          const keys = new Set(definition.plugins.map(rowKey))
          definition = { ...definition, plugins: [...definition.plugins, ...content.plugins.filter(row => !keys.has(rowKey(row)))] }
          dependencyChecks.push(...content.dependencyChecks ?? [])
          requiredConnectorIds.push(...content.connectorRefs)
          requiredTools.push(...content.requiredTools ?? [])
          capabilities = { ...capabilities, knowledgeBaseRefs: sorted([...capabilities.knowledgeBaseRefs, ...content.knowledgeBaseRefs]) }
        }
        if (request.expertKitId !== undefined) {
          const content = request.expertKitId === null ? undefined : await deps.content('kit', request.expertKitId, signal)
          const retainedKnowledge = capabilities.knowledgeBaseIds
          const retainedConnectors = capabilities.connectorIds.filter(id => !requiredConnectorIds.includes(id))
          definition = base
          basePluginKeys = base.plugins.map(rowKey)
          capabilities = { ...empty, basePresetId, knowledgeBaseIds: retainedKnowledge, connectorIds: retainedConnectors,
            ...content === undefined ? {} : { expertKit: content.identity } }
          requiredConnectorIds = []
          skillInvocations = {}
          requiredTools = []
          if (content !== undefined) mergeContent(content)
        }
        requiredConnectorIds = sorted(requiredConnectorIds)
        const connectorIds = sorted(request.connectorIds ?? capabilities.connectorIds)
        if (request.connectorIds !== undefined && requiredConnectorIds.some(id => !connectorIds.includes(id))) {
          throw new Error('A required connector cannot be disabled')
        }
        capabilities = { ...capabilities,
          connectorIds: sorted([...connectorIds, ...requiredConnectorIds]),
          requiredConnectorIds,
          knowledgeBaseIds: sorted(request.knowledgeBaseIds ?? capabilities.knowledgeBaseIds),
        }
        dependencyChecks.push(
          ...requiredTools.map(reference => ({ kind: 'TOOL' as const, reference, status: 'NOT_CHECKED' as const })),
          ...capabilities.connectorIds.map(reference => ({ kind: 'DATA_CONNECTION' as const, reference, status: 'NOT_CHECKED' as const })),
          ...sorted([...capabilities.knowledgeBaseIds, ...capabilities.knowledgeBaseRefs])
            .map(reference => ({ kind: 'KNOWLEDGE_BASE' as const, reference, status: 'NOT_CHECKED' as const })),
        )
        const requiredKnowledge = request.expertKitId === undefined ? capabilities.requiredKnowledgeBaseIds
          : await deps.validateKnowledge([], capabilities.knowledgeBaseRefs, signal)
        if (request.expertKitId === undefined && request.knowledgeBaseIds !== undefined
        && requiredKnowledge.some(id => !request.knowledgeBaseIds?.includes(id))) {
          throw new ProductError('KNOWLEDGE_REQUIRED', 'A required knowledge base cannot be removed', false,
            requiredKnowledge.map(id => ({ kind: 'knowledge-base', id })))
        }
        const resolvedKnowledge = await deps.validateKnowledge(sorted([...capabilities.knowledgeBaseIds, ...requiredKnowledge]), [], signal)
        for (const reference of sorted([...capabilities.knowledgeBaseRefs, ...resolvedKnowledge])) {
          dependencyChecks.push({ kind: 'KNOWLEDGE_BASE', reference, status: 'READY' })
        }
        capabilities = { ...capabilities, knowledgeBaseIds: sorted(resolvedKnowledge), requiredKnowledgeBaseIds: sorted(requiredKnowledge) }
        if (capabilities.expertKit !== undefined) await deps.authorizeKit?.(capabilities.expertKit.id, signal)
        const live = await deps.connectors(signal)
        dependencyChecks.push(...capabilities.connectorIds.map(reference => ({ kind: 'DATA_CONNECTION' as const, reference,
          status: live.some(row => row.id === reference) ? 'READY' as const : 'UNAUTHORIZED' as const })))
        const connectors = selectedConnectors(capabilities.connectorIds, live).map((connector) => {
          const pinned = request.expertKitId === undefined ? previous?.connectors.find(value => value.id === connector.id) : undefined
          return pinned === undefined ? connector : hydrateConnectors([pinned], live)[0] ?? connector
        })
        definition = { ...definition, selectionBase: basePresetId, name: capabilities.expertKit?.name ?? basePresetId, plugins: [
          ...definition.plugins.filter(row => !row.id?.startsWith('deepseek-harness-mcp-')
          && row.id !== 'product-knowledge' && row.id !== 'product-task-capabilities'),
          { id: 'product-task-capabilities', name: CAPABILITY_PROMPT, config: { capabilities } },
          ...connectors.map(deps.connectorPlugin),
          ...deps.knowledgePlugins([], capabilities.knowledgeBaseIds),
        ] }
        // Connector credentials are hydrated from main at mount time, never stored in snapshots.
        const persisted = { ...definition, plugins: definition.plugins.map((row) => {
          if (!row.id?.startsWith('deepseek-harness-mcp-')) return row
          const config = { ...row.config as Record<string, unknown> }
          delete config.headers
          delete config.env
          const connector = connectors.find(value => row.id === deps.connectorPlugin(value).id)
          if (connector?.transport === 'streamable-http') config.url = `http://product.invalid/${encodeURIComponent(connector.id)}`
          return { ...row, config }
        }) }
        const contracts = connectors.map(snapshotConnector)
        requiredTools = sorted(requiredTools)
        const presetId = identify(persisted, capabilities, requiredConnectorIds, contracts, skillInvocations, basePluginKeys, requiredTools)
        const snapshot: Snapshot = { version: 2, presetId, definition: { ...persisted, id: presetId },
          capabilities, requiredConnectorIds, connectors: contracts, skillInvocations, basePluginKeys, requiredTools }
        const preceding = committing
        let release!: () => void
        committing = new Promise<void>((resolve) => { release = resolve })
        await preceding
        const alreadyRegistered = registrations.has(presetId)
        const blocked = blockedPresets.get(presetId)
        const target = join(deps.root, `${presetId}.json`)
        const temporary = `${target}.${randomUUID()}.tmp`
        let committed = false
        try {
          signal?.throwIfAborted()
          if (blocked !== undefined) { await blocked(); blockedPresets.delete(presetId) }
          await register(snapshot, connectors)
          await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600, signal })
          signal?.throwIfAborted()
          if (failures.get(presetId)?.code === 'TASK_SNAPSHOT_INVALID') {
            await copyFile(target, `${target}.invalid-${randomUUID()}`)
          }
          await rename(temporary, target)
          committed = true
        } finally {
          try {
            await rm(temporary, { force: true })
            if (!committed && !alreadyRegistered) {
              await disposers.get(presetId)?.()
              disposers.delete(presetId)
              registrations.delete(presetId)
            }
            if (!committed && blocked !== undefined) await registerBlocked(presetId)
          } finally { release() }
        }
        snapshots.set(presetId, snapshot)
        failures.delete(presetId)
        const latest = await inspect(request.sessionId)
        return { kind: request.sessionId !== undefined && !latest.started ? 'CURRENT_SESSION' : 'NEW_SESSION', presetId, capabilities,
          dependencyChecks: [...new Map([
            ...dependencyChecks.filter(check => check.status !== 'NOT_CHECKED'),
            ...requiredTools.map(reference => ({ kind: 'TOOL' as const, reference, status: 'READY' as const })),
            ...capabilities.connectorIds.map(reference => ({ kind: 'DATA_CONNECTION' as const, reference, status: 'READY' as const })),
            ...capabilities.knowledgeBaseIds.map(reference => ({ kind: 'KNOWLEDGE_BASE' as const, reference, status: 'READY' as const })),
          ].map(check => [`${check.kind}:${check.reference}`, check])).values()],
        }
      } catch (error) {
        if (!isProductFailure(error)) throw error
        const failure = productFailure(error)
        if (failure.dependencyChecks !== undefined) throw error
        const completed = new Map(dependencyChecks.map(check => [`${check.kind}:${check.reference}`, check]))
        for (const resource of failure.resources) {
          const kind = resource.kind === 'connector' ? 'DATA_CONNECTION' : resource.kind === 'knowledge-base' ? 'KNOWLEDGE_BASE'
            : resource.kind === 'tool' ? 'TOOL' : resource.kind === 'skill' ? 'SKILL' : undefined
          if (kind !== undefined) completed.set(`${kind}:${resource.id}`, { kind, reference: resource.id,
            status: kind === 'TOOL' || kind === 'SKILL' ? 'MISSING' : 'UNAUTHORIZED' })
        }
        throw new ProductError(failure.code, failure.message, failure.retryable, failure.resources,
          { cause: error, dependencyChecks: [...completed.values()] })
      }
    },
  }
}

function identify(definition: PresetDefinition, capabilities: ProductTaskCapabilities,
  requiredConnectorIds: readonly string[], connectors: Snapshot['connectors'], skillInvocations: Snapshot['skillInvocations'], basePluginKeys?: readonly string[], requiredTools?: readonly string[]): string {
  return prefix + createHash('sha256').update(JSON.stringify({ definition: { ...definition, id: '' }, capabilities, requiredConnectorIds, connectors, skillInvocations,
    ...basePluginKeys === undefined ? {} : { basePluginKeys }, ...requiredTools === undefined ? {} : { requiredTools } })).digest('hex')
}

function selectedConnectors(ids: readonly string[], live: readonly DeepSeekHarnessConnector[]) {
  return ids.map((id) => {
    const connector = live.find(value => value.id === id)
    if (connector === undefined) throw new ProductError('CONNECTOR_AUTHORIZATION_REQUIRED', `Connector authorization is required: ${id}`, false, [{ kind: 'connector', id }])
    return connector
  })
}
