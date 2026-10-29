import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { entryListProblem, type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { ProductTaskCapabilitiesSchema, type ProductTaskCapabilities, type ProductTaskCapabilityRequest, type ProductTaskCapabilityResult } from '@deepseek-harness/product/protocol'
import { ProductError, isProductFailure, productFailure, type ProductFailure } from '@deepseek-harness/product/errors'

interface Snapshot {
  readonly version: 4
  readonly presetId: string
  readonly definition: PresetDefinition
  readonly capabilities: ProductTaskCapabilities
}

export interface TaskDependencies {
  readonly root: string
  readonly visibleKnowledge: (signal?: AbortSignal) => Promise<readonly string[]>
  readonly validateKnowledge: (ids: readonly string[], signal?: AbortSignal) => Promise<readonly string[]>
  readonly knowledgePlugins: (ids: readonly string[]) => PresetDefinition['plugins']
  readonly register: (definition: PresetDefinition) => Promise<() => Promise<void>>
}
const empty: ProductTaskCapabilities = { knowledgeBaseIds: [] }
const prefix = 'product-task-'
const CAPABILITY_PROMPT = 'cordis:product-task-capabilities'
const sorted = (values: readonly string[]) => [...new Set(values)].sort()
const capabilitySnapshot = ProductTaskCapabilitiesSchema.omit({ unavailable: true }).required({ basePresetId: true })

/** Validate a durable task generation before restoring or collecting its content.
 * @param raw Stored JSON, already checked against the snapshot byte limit.
 * @param filename Expected immutable generation filename.
 * @returns The validated snapshot, including its pinned content identities.
 */
export function parseTaskSnapshot(raw: string, filename: string): Snapshot {
  const candidate: unknown = JSON.parse(raw)
  if (typeof candidate !== 'object' || candidate === null) throw new Error(`Invalid task snapshot: ${filename}`)
  const value = candidate as Omit<Partial<Snapshot>, 'definition' | 'capabilities'> & {
    definition?: PresetDefinition | null
    capabilities?: ProductTaskCapabilities | null
  }
  if (value.version !== 4 || `${value.presetId}.json` !== filename || value.definition == null
    || value.capabilities == null || value.definition.id !== value.presetId
    || entryListProblem(value.definition.plugins) !== undefined
    || Object.keys(candidate).some(key => !['version', 'presetId', 'definition', 'capabilities'].includes(key))) throw new Error(`Invalid task snapshot: ${filename}`)
  capabilitySnapshot.parse(value.capabilities)
  if (value.definition.selectionBase !== value.capabilities.basePresetId
    || value.definition.selectable !== false || value.definition.defaultable !== false) throw new Error(`Inconsistent task selection base: ${filename}`)
  const snapshot = value as Snapshot
  const expected = identify(snapshot.definition, snapshot.capabilities)
  if (expected !== snapshot.presetId) throw new Error(`Task snapshot identity mismatch: ${filename}`)
  return snapshot
}

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
    const failure = failures.get(id)
    if (failure === undefined) throw new Error(`Blocked task requires a restoration diagnostic: ${id}`)
    const dispose = await deps.register({ id, plugins: [{ id: 'product-blocked-task', name: CAPABILITY_PROMPT, config: { failure } }],
      selectable: false, defaultable: false })
    blockedPresets.set(id, dispose)
  }
  let committing = Promise.resolve()
  const register = (snapshot: Snapshot) => {
    let pending = registrations.get(snapshot.presetId)
    if (pending === undefined) {
      pending = deps.register(snapshot.definition).then((dispose) => { disposers.set(snapshot.presetId, dispose) })
      registrations.set(snapshot.presetId, pending)
      pending.catch(() => { registrations.delete(snapshot.presetId) })
    }
    return pending
  }
  for (const filename of await readdir(deps.root)) {
    if (!/^product-task-[a-f0-9]{64}\.json$/.test(filename)) continue
    const path = join(deps.root, filename)
    try {
      if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error('Task snapshot exceeds size limit')
      const raw = await readFile(path, 'utf8')
      const snapshot = parseTaskSnapshot(raw, filename)
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
  const references = await ctx.sessionQuery.listSessions()
  const needed = new Set<string>()
  for (const session of references) {
    if (session.header.agentPreset?.startsWith(prefix)) needed.add(session.header.agentPreset)
    try {
      using observation = await ctx.sessionQuery.observeSession(session.header.id)
      const selected = observation.projections?.values.agentPreset
      if (typeof selected === 'string' && selected.startsWith(prefix)) needed.add(selected)
    } catch (error) {
      ctx.logger.warn(`Task history ${session.header.id} cannot be inspected during restoration: ${String(error)}`)
    }
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
      try { await register(snapshot) }
      catch (error) {
        failures.set(id, productFailure(error))
        await registerBlocked(id)
        ctx.logger.warn(`Task ${id} cannot restore its selected capabilities: ${String(error)}`)
      }
    }
  }

  const inspect = async (sessionId?: string, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    if (sessionId === undefined) return { presetId: ctx.agentPresets.defaultId, started: false }
    try {
      using observation = await ctx.sessionQuery.observeSession(sessionId as Parameters<typeof ctx.sessionQuery.observeSession>[0],
        signal === undefined ? {} : { signal })
      signal?.throwIfAborted()
      const projections = observation.projections?.values
      return {
        presetId: typeof projections?.agentPreset === 'string' ? projections.agentPreset : observation.header.agentPreset ?? ctx.agentPresets.defaultId,
        started: observation.events.some(event => event.type === 'turn/start'),
      }
    } catch (error) {
      signal?.throwIfAborted()
      throw error
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
        await deps.validateKnowledge(snapshot.capabilities.knowledgeBaseIds, signal)
      }
    },
    async read(request: ProductTaskCapabilityRequest, signal?: AbortSignal): Promise<ProductTaskCapabilities> {
      const current = await inspect(request.sessionId, signal)
      signal?.throwIfAborted()
      const snapshot = snapshots.get(current.presetId)
      const unavailable = failures.get(current.presetId) ?? (current.presetId.startsWith(prefix) && snapshot === undefined
        ? productFailure(new ProductError('TASK_SNAPSHOT_MISSING', 'Task capabilities need explicit recovery')) : undefined)
      return structuredClone(snapshot === undefined
        ? { ...empty, basePresetId: current.presetId, ...unavailable === undefined ? {} : { unavailable } }
        : { ...snapshot.capabilities,
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
        const current = await inspect(request.sessionId, signal)
        signal?.throwIfAborted()
        const previous = request.recoverCapabilities === true ? undefined : snapshots.get(current.presetId)
        if (current.presetId.startsWith(prefix) && !snapshots.has(current.presetId) && request.recoverCapabilities !== true) {
          throw new ProductError('TASK_SNAPSHOT_UNAVAILABLE', 'Recover this task before changing its capabilities')
        }
        const source = snapshots.get(current.presetId)
        if (request.recoverCapabilities === true) {
          const visible = await deps.visibleKnowledge(signal)
          request = { ...request,
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
        const ids = sorted(request.knowledgeBaseIds ?? capabilities.knowledgeBaseIds)
        const resolved = await deps.validateKnowledge(ids, signal)
        capabilities = { basePresetId, knowledgeBaseIds: sorted(resolved) }
        const definition = ctx.agentPresets.derive(basePresetId, {
          id: 'pending-task', selectable: false, defaultable: false,
          plugins: [
            { id: 'product-task-capabilities', name: CAPABILITY_PROMPT, config: { capabilities } },
            ...deps.knowledgePlugins(capabilities.knowledgeBaseIds),
          ],
        })
        const presetId = identify(definition, capabilities)
        const snapshot: Snapshot = { version: 4, presetId, definition: { ...definition, id: presetId }, capabilities }
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
          await register(snapshot)
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
        const latest = await inspect(request.sessionId, signal)
        signal?.throwIfAborted()
        return { kind: request.sessionId !== undefined && !latest.started ? 'CURRENT_SESSION' : 'NEW_SESSION', presetId, capabilities,
          dependencyChecks: capabilities.knowledgeBaseIds.map(reference => ({ kind: 'KNOWLEDGE_BASE', reference, status: 'READY' })),
        }
      } catch (error) {
        if (!isProductFailure(error)) throw error
        const failure = productFailure(error)
        if (failure.dependencyChecks !== undefined) throw error
        const completed = new Map(dependencyChecks.map(check => [`${check.kind}:${check.reference}`, check]))
        for (const resource of failure.resources) {
          if (resource.kind === 'knowledge-base') completed.set(`KNOWLEDGE_BASE:${resource.id}`, {
            kind: 'KNOWLEDGE_BASE', reference: resource.id, status: 'UNAUTHORIZED',
          })
        }
        throw new ProductError(failure.code, failure.message, failure.retryable, failure.resources,
          { cause: error, dependencyChecks: [...completed.values()] })
      }
    },
  }
}

function identify(definition: PresetDefinition, capabilities: ProductTaskCapabilities): string {
  return prefix + createHash('sha256').update(JSON.stringify({ definition: { ...definition, id: '' }, capabilities })).digest('hex')
}
