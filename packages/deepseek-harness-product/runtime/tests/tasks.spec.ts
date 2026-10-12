import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { afterEach, expect, it, vi } from 'vitest'
import { createTaskCapabilities, type TaskDependencies } from '../src/tasks.ts'

const roots: string[] = []
const asContext = (value: object) => value as Context
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'product-task-test-'))
  roots.push(root)
  const definitions = new Map<string, PresetDefinition>([
    ['standard', { id: 'standard', plugins: [{ id: 'base', name: 'base' }] }],
    ['ptc', { id: 'ptc', plugins: [{ id: 'ptc-base', name: 'ptc-base' }] }],
  ])
  let selected = 'standard'
  let started = false
  const observeSession = vi.fn(async () => ({ header: { agentPreset: 'standard' },
    projections: { values: { agentPreset: selected } }, events: started ? [{ type: 'turn/start' }] : [], [Symbol.dispose]() {} }))
  const ctx = asContext({
    logger: { warn: vi.fn() },
    sessionQuery: { listSessions: async () => [{ header: { id: 'session', agentPreset: selected } }], observeSession },
    agentPresets: { defaultId: 'standard', resolve: async (id: string) => definitions.get(id), derive(base: string, definition: PresetDefinition) {
      return { ...definition, plugins: [...definitions.get(base)!.plugins, ...definition.plugins], resolutionBase: 'file:///profile/' }
    } },
  })
  const connector = { id: 'erp', name: 'ERP', status: 'ready' as const, authMode: 'employee-bearer' as const,
    timeoutSeconds: 120,
    transport: 'streamable-http' as const, url: 'https://example.test/mcp', arguments: [], toolNames: ['read'], readOnlyTools: ['read'],
    headers: { Authorization: 'Bearer private' }, environment: {} }
  const register = vi.fn(async (definition: PresetDefinition) => {
    definitions.set(definition.id, definition)
    return async () => { definitions.delete(definition.id) }
  })
  const deps = {
    root, register, validateTools: vi.fn(async () => {}),
    authorizeKit: vi.fn(async (_id: string) => {}),
    visibleKnowledge: vi.fn(async () => ['manuals']),
    connectors: vi.fn(async () => [connector]),
    content: vi.fn<TaskDependencies['content']>(async (kind, id) => ({
      identity: { id, name: `Name of ${id}`, version: '1', sha256: 'a'.repeat(64) },
      connectorRefs: kind === 'kit' ? ['erp'] : [], knowledgeBaseRefs: kind === 'kit' ? ['company:orders'] : [],
      plugins: [{ id, name: kind }],
    })),
    connectorPlugin: value => ({ id: `deepseek-harness-mcp-${value.id}`, name: 'mcp', config: { headers: value.headers } }),
    knowledgePlugins: (refs, ids) => refs.length + ids.length === 0 ? [] : [{ id: 'product-knowledge', name: 'knowledge', config: { refs, ids } }],
    validateKnowledge: vi.fn<TaskDependencies['validateKnowledge']>(async (ids, refs) => [...new Set([...ids, ...refs.map(() => 'orders-kb')])]),
  } satisfies TaskDependencies
  const tasks = await createTaskCapabilities(ctx, deps)
  return { tasks, deps, ctx, root, register, connector, definitions,
    select: (id: string) => { selected = id }, start: () => { started = true }, observeSession }
}

it('enables an independent connector and retains it when adding knowledge', async () => {
  const fixture = await setup()
  const first = await fixture.tasks.prepare({ sessionId: 'session', connectorIds: ['erp'] })
  expect(first.kind).toBe('CURRENT_SESSION')
  expect(first.capabilities.connectorIds).toEqual(['erp'])
  expect(first.capabilities.requiredConnectorIds).toEqual([])
  expect(fixture.register.mock.calls[0]?.[0].plugins.some(row => row.id === 'product-knowledge')).toBe(false)
  fixture.select(first.presetId)
  const next = await fixture.tasks.prepare({ sessionId: 'session', knowledgeBaseIds: ['manuals'] })
  expect(next.capabilities).toMatchObject({ connectorIds: ['erp'], knowledgeBaseIds: ['manuals'], skills: [] })
  expect(fixture.register.mock.calls.at(-1)?.[0].plugins.filter(row => row.id === 'base')).toHaveLength(1)
  const files = (await readdir(fixture.root)).filter(name => name.endsWith('.json'))
  const persisted = await Promise.all(files.map(name => readFile(join(fixture.root, name), 'utf8')))
  expect(persisted.join('')).not.toContain('Bearer private')
})

it('pins shortcut skills, retains them through mode changes and clears them with the kit', async () => {
  const f = await setup()
  f.deps.content.mockResolvedValueOnce({ identity: { id: 'orders', name: 'Orders', version: '1', sha256: 'a'.repeat(64) },
    connectorRefs: [], knowledgeBaseRefs: [], plugins: [{ id: 'orders', name: 'kit', config: { initialSkillIds: ['order-review'] } }],
    shortcut: { id: 'review-orders', name: 'Review orders', skillIds: ['order-review'], prompt: 'Review these orders.' } })
  const first = await f.tasks.prepare({ sessionId: 'session', expertKitId: 'orders', expertKitTaskId: 'review-orders' })
  expect(f.deps.content).toHaveBeenCalledWith('kit', 'orders', undefined, 'review-orders')
  expect(first.prompt).toBe('Review these orders.')
  f.select(first.presetId)
  const mode = await f.tasks.prepare({ sessionId: 'session', basePresetId: 'ptc' })
  expect(mode.capabilities.expertKitTask).toEqual(first.capabilities.expertKitTask)
  expect(f.definitions.get(mode.presetId)?.plugins).toContainEqual(expect.objectContaining({ config: { initialSkillIds: ['order-review'] } }))
  f.select(mode.presetId)
  const restored = await createTaskCapabilities(f.ctx, f.deps)
  expect((await restored.read({ sessionId: 'session' })).expertKitTask).toEqual(first.capabilities.expertKitTask)
  const cleared = await restored.prepare({ sessionId: 'session', expertKitId: null })
  expect(cleared.capabilities.expertKitTask).toBeUndefined()
})

it('rejects unmapped shortcuts without persisting or registering a task', async () => {
  const f = await setup()
  await expect(f.tasks.prepare({ expertKitTaskId: 'review-orders' })).rejects.toMatchObject({ code: 'KIT_TASK_INVALID' })
  await expect(f.tasks.prepare({ expertKitId: 'orders', expertKitTaskId: 'review-orders' })).rejects.toMatchObject({ code: 'KIT_TASK_INVALID' })
  expect(f.register).not.toHaveBeenCalled()
  expect(await readdir(f.root)).toEqual([])
})

it('switches execution modes without re-fetching pinned kit and skill content, and restores that mode', async () => {
  const f = await setup()
  const kit = await f.tasks.prepare({ expertKitId: 'order-expert', knowledgeBaseIds: ['manuals'] })
  f.select(kit.presetId)
  f.deps.content.mockRejectedValue(new Error('catalog changed'))
  const switched = await f.tasks.prepare({ sessionId: 'session', basePresetId: 'ptc' })
  expect(switched.capabilities).toEqual({ ...kit.capabilities, basePresetId: 'ptc' })
  const definition = f.register.mock.calls.at(-1)?.[0]
  expect(definition?.selectionBase).toBe('ptc')
  expect(definition?.plugins.map(row => row.id)).toEqual(expect.arrayContaining(['ptc-base', 'order-expert', 'product-knowledge']))
  expect(definition?.plugins.map(row => row.id)).not.toContain('base')
  expect(f.deps.content).toHaveBeenCalledTimes(1)
  f.select(switched.presetId)
  const restored = await createTaskCapabilities(f.ctx, f.deps)
  expect(await restored.read({ sessionId: 'session' })).toEqual(switched.capabilities)
  expect(f.register.mock.calls.at(-1)?.[0].selectionBase).toBe('ptc')
  const back = await restored.resolveSelection('session', 'standard')
  f.select(back)
  expect(await restored.read({ sessionId: 'session' })).toEqual(kit.capabilities)
  expect(f.register.mock.calls.at(-1)?.[0].plugins.map(row => row.id)).not.toContain('ptc-base')
  expect(f.register.mock.calls.at(-1)?.[0].selectionBase).toBe('standard')
})

it('keeps the current capability snapshot when switching mode fails', async () => {
  const f = await setup()
  const prepared = await f.tasks.prepare({ connectorIds: ['erp'] })
  f.select(prepared.presetId)
  f.register.mockRejectedValueOnce(new Error('required tool unavailable'))
  await expect(f.tasks.resolveSelection('session', 'ptc')).rejects.toThrow('required tool unavailable')
  expect(await f.tasks.read({ sessionId: 'session' })).toEqual(prepared.capabilities)
})

it('explicitly selects a selectable nondefault mode through prepare and the native selection resolver', async () => {
  const f = await setup()
  f.definitions.set('explicit-only', { id: 'explicit-only', selectable: true, defaultable: false,
    plugins: [{ id: 'explicit-base', name: 'explicit-base' }] })
  const prepared = await f.tasks.prepare({ expertKitId: 'order-expert', knowledgeBaseIds: ['manuals'] })
  f.select(prepared.presetId)
  const switched = await f.tasks.prepare({ sessionId: 'session', basePresetId: 'explicit-only' })
  expect(switched.capabilities).toEqual({ ...prepared.capabilities, basePresetId: 'explicit-only' })
  expect(f.register.mock.calls.at(-1)?.[0].selectionBase).toBe('explicit-only')
  f.select(switched.presetId)
  const standard = await f.tasks.resolveSelection('session', 'standard')
  f.select(standard)
  const resolved = await f.tasks.resolveSelection('session', 'explicit-only')
  f.select(resolved)
  expect(await f.tasks.read({ sessionId: 'session' })).toEqual(switched.capabilities)
  expect(f.ctx.agentPresets.defaultId).toBe('standard')
})

it.each(['hidden-mode', 'product-task-forged-mode'])('rejects %s as an explicit execution mode', async (id) => {
  const f = await setup()
  f.definitions.set(id, { id, selectable: id !== 'hidden-mode', defaultable: false, plugins: [] })
  const prepared = await f.tasks.prepare({ knowledgeBaseIds: ['manuals'] })
  f.select(prepared.presetId)
  const calls = f.register.mock.calls.length
  await expect(f.tasks.prepare({ sessionId: 'session', basePresetId: id })).rejects.toThrow('not an execution mode')
  expect(f.register).toHaveBeenCalledTimes(calls)
  expect(await f.tasks.read({ sessionId: 'session' })).toEqual(prepared.capabilities)
})

it('projects native mode display from a fixed snapshot base without rewriting existing content or identity', async () => {
  const f = await setup()
  const prepared = await f.tasks.prepare({ basePresetId: 'ptc', expertKitId: 'order-expert', knowledgeBaseIds: ['manuals'] })
  const snapshot = JSON.parse(await readFile(join(f.root, `${prepared.presetId}.json`), 'utf8')) as
    Record<string, unknown> & { presetId: string; definition: PresetDefinition }
  const definition = { ...snapshot.definition }
  delete definition.selectionBase
  const hashed: Record<string, unknown> = { ...snapshot, definition: { ...definition, id: '' } }
  delete hashed.version
  delete hashed.presetId
  const existingId = 'product-task-' + createHash('sha256').update(JSON.stringify(hashed)).digest('hex')
  const stored = JSON.stringify({ ...snapshot, presetId: existingId, definition: { ...definition, id: existingId } })
  await writeFile(join(f.root, `${existingId}.json`), stored)
  f.select(existingId)
  const restored = await createTaskCapabilities(f.ctx, f.deps)
  await expect(restored.validate(existingId)).resolves.toBeUndefined()
  expect(await restored.read({ sessionId: 'session' })).toEqual(prepared.capabilities)
  expect(f.register.mock.calls.at(-1)?.[0]).toMatchObject({ id: existingId, selectionBase: 'ptc' })
  expect(await readFile(join(f.root, `${existingId}.json`), 'utf8')).toBe(stored)
})

it.each(['missing', 'conflicting'])('blocks a task with %s base metadata while retaining raw content', async (kind) => {
  const f = await setup()
  const prepared = await f.tasks.prepare({ knowledgeBaseIds: ['manuals'] })
  const path = join(f.root, `${prepared.presetId}.json`)
  const snapshot = JSON.parse(await readFile(path, 'utf8')) as {
    capabilities: { basePresetId?: string }
    definition: PresetDefinition
  }
  if (kind === 'missing') delete snapshot.capabilities.basePresetId
  else snapshot.definition = { ...snapshot.definition, selectionBase: 'ptc' }
  const stored = JSON.stringify(snapshot)
  await writeFile(path, stored)
  f.select(prepared.presetId)
  const restored = await createTaskCapabilities(f.ctx, f.deps)
  expect((await restored.read({ sessionId: 'session' })).unavailable?.code).toBe('TASK_SNAPSHOT_INVALID')
  await expect(restored.validate(prepared.presetId)).rejects.toThrow('cannot be restored')
  expect(await readFile(path, 'utf8')).toBe(stored)
})

it('registers restored composition before checking its tools and rejects unavailable dependencies at use', async () => {
  const f = await setup()
  const first = await f.tasks.prepare({ connectorIds: ['erp'] })
  f.select(first.presetId)
  f.deps.validateTools.mockClear()
  f.deps.validateTools.mockRejectedValue(new Error('restored tool unavailable'))
  const restored = await createTaskCapabilities(f.ctx, f.deps)
  expect(f.deps.validateTools).not.toHaveBeenCalled()
  await expect(restored.validate(first.presetId)).rejects.toThrow('restored tool unavailable')
  await expect(restored.prepare({ sessionId: 'session', connectorIds: ['erp'] })).rejects.toThrow('restored tool unavailable')
  expect(await restored.read({ sessionId: 'session' })).toEqual(first.capabilities)
})

it('retains a nonstandard mode when adding a kit and skills', async () => {
  const f = await setup()
  f.select('ptc')
  const prepared = await f.tasks.prepare({ sessionId: 'session', expertKitId: 'order-expert' })
  expect(prepared.capabilities.basePresetId).toBe('ptc')
  expect(f.register.mock.calls.at(-1)?.[0].plugins.map(row => row.id)).not.toContain('base')
})

it('keeps required kit dependencies and rejects attempts to disable them', async () => {
  const fixture = await setup()
  const kit = await fixture.tasks.prepare({ expertKitId: 'order-expert' })
  expect(kit.capabilities.requiredConnectorIds).toEqual(['erp'])
  fixture.select(kit.presetId)
  await expect(fixture.tasks.prepare({ sessionId: 'session', connectorIds: [] })).rejects.toThrow('required connector')
  await expect(fixture.tasks.prepare({ sessionId: 'session', knowledgeBaseIds: [] })).rejects.toThrow('required knowledge base')
  expect(await fixture.tasks.read({ sessionId: 'session' })).toEqual(kit.capabilities)
  const restored = await createTaskCapabilities(fixture.ctx, fixture.deps)
  expect((await restored.read({ sessionId: 'session' })).requiredConnectorIds).toEqual(['erp'])
})

it('retains selected knowledge when changing kits and clearing their composition', async () => {
  const f = await setup()
  const initial = await f.tasks.prepare({ knowledgeBaseIds: ['manuals'] })
  f.select(initial.presetId)
  const kit = await f.tasks.prepare({ sessionId: 'session', expertKitId: 'order-expert' })
  expect(kit.capabilities.knowledgeBaseIds).toEqual(['manuals', 'orders-kb'])
  f.select(kit.presetId)
  const replacement = await f.tasks.prepare({ sessionId: 'session', expertKitId: 'second-expert' })
  expect(replacement.capabilities.knowledgeBaseIds).toEqual(['manuals', 'orders-kb'])
  expect(f.register.mock.calls.at(-1)?.[0].plugins.map(row => row.id)).not.toContain('order-expert')
  f.select(replacement.presetId)
  const cleared = await f.tasks.prepare({ sessionId: 'session', expertKitId: null })
  expect(cleared.capabilities.expertKit).toBeUndefined()
  expect(cleared.capabilities.knowledgeBaseIds).toEqual(['manuals', 'orders-kb'])
  expect(cleared.capabilities.connectorIds).toEqual([])
  expect(cleared.capabilities.knowledgeBaseRefs).toEqual([])
  expect(f.register.mock.calls.at(-1)?.[0].plugins.map(row => row.id)).not.toContain('second-expert')
  f.select(cleared.presetId)
  const removed = await f.tasks.prepare({ sessionId: 'session', knowledgeBaseIds: [] })
  expect(removed.capabilities.knowledgeBaseIds).toEqual([])
  f.select(removed.presetId)
  const restored = await createTaskCapabilities(f.ctx, f.deps)
  expect(await restored.read({ sessionId: 'session' })).toEqual(removed.capabilities)
})

it.each([false, true])('removes an independent connector after authorization loss, started=%s', async (started) => {
  const fixture = await setup()
  const first = await fixture.tasks.prepare({ sessionId: 'session', connectorIds: ['erp'] })
  fixture.select(first.presetId)
  if (started) fixture.start()
  fixture.deps.connectors.mockResolvedValue([])
  const result = await fixture.tasks.prepare({ sessionId: 'session', connectorIds: [] })
  expect(result.kind).toBe(started ? 'NEW_SESSION' : 'CURRENT_SESSION')
  expect(result.capabilities.connectorIds).toEqual([])
  expect(fixture.register.mock.calls.at(-1)?.[0].plugins.some(row => row.id?.startsWith('deepseek-harness-mcp-'))).toBe(false)
  expect((await fixture.tasks.read({ sessionId: 'session' })).connectorIds).toEqual(['erp'])
})

it('reports a new task when a turn starts while preparation is in flight', async () => {
  const fixture = await setup()
  fixture.deps.validateKnowledge = vi.fn<TaskDependencies['validateKnowledge']>(async (ids) => { fixture.start(); return ids })
  const result = await fixture.tasks.prepare({ sessionId: 'session', knowledgeBaseIds: ['manuals'] })
  expect(result.kind).toBe('NEW_SESSION')
  expect(await fixture.tasks.read({ sessionId: 'session' })).toMatchObject({ connectorIds: [], knowledgeBaseIds: [] })
})

it('restores immutable composition with current credentials after catalog changes', async () => {
  const fixture = await setup()
  const prepared = await fixture.tasks.prepare({ sessionId: 'session', connectorIds: ['erp'] })
  fixture.select(prepared.presetId)
  fixture.deps.connectors = vi.fn(async () => [{ ...fixture.connector, toolNames: ['new-tool'], headers: { Authorization: 'Bearer refreshed' } }])
  fixture.register.mockClear()
  const restored = await createTaskCapabilities(fixture.ctx, fixture.deps)
  expect(await restored.read({ sessionId: 'session' })).toEqual(prepared.capabilities)
  const mounted = fixture.register.mock.calls[0]
  expect(mounted?.[0].plugins.find(row => row.name === 'mcp')?.config).toEqual({ headers: { Authorization: 'Bearer refreshed' } })
  const saved = JSON.parse(await readFile(join(fixture.root, `${prepared.presetId}.json`), 'utf8')) as { connectors: { toolNames: string[] }[] }
  expect(saved.connectors[0]?.toolNames).toEqual(['read'])
})

it('leaves the selected task unchanged after authorization or registration failure', async () => {
  const fixture = await setup()
  fixture.deps.connectors = vi.fn(async () => [])
  await expect(fixture.tasks.prepare({ sessionId: 'session', connectorIds: ['erp'] })).rejects.toThrow('authorization')
  expect(await fixture.tasks.read({ sessionId: 'session' })).toMatchObject({ connectorIds: [] })
  fixture.register.mockRejectedValueOnce(new Error('mount failed'))
  await expect(fixture.tasks.prepare({ sessionId: 'session', knowledgeBaseIds: ['manuals'] })).rejects.toThrow('mount failed')
  expect((await readdir(fixture.root)).filter(name => name.endsWith('.json'))).toEqual([])
})
it('isolates corrupt and missing snapshots, preserves raw bytes, and requires explicit recovery', async () => {
  const f = await setup()
  const healthy = await f.tasks.prepare({ knowledgeBaseIds: ['manuals'] })
  const broken = 'product-task-' + 'f'.repeat(64)
  await writeFile(join(f.root, `${broken}.json`), '{broken')
  f.select(healthy.presetId)
  const restored = await createTaskCapabilities(f.ctx, f.deps)
  await expect(restored.validate(healthy.presetId)).resolves.toBeUndefined()
  expect(await readFile(join(f.root, `${broken}.json`), 'utf8')).toBe('{broken')
  expect(await readdir(f.root)).toContain(`${broken}.json.diagnostic.json`)
  f.select(broken)
  expect((await restored.read({ sessionId: 'session' })).unavailable?.code).toBe('TASK_SNAPSHOT_INVALID')
  await expect(restored.prepare({ sessionId: 'session' })).rejects.toThrow('Recover')
  await expect(restored.validate(broken)).rejects.toThrow('cannot be restored')
  await expect(restored.resolveSelection('session', 'ptc')).rejects.toThrow('cannot be restored')
  expect((await restored.read({ sessionId: 'session' })).basePresetId).toBe(broken)
  const missing = 'product-task-' + 'e'.repeat(64)
  f.select(missing)
  expect((await restored.read({ sessionId: 'session' })).unavailable?.code).toBe('TASK_SNAPSHOT_MISSING')
  await expect(restored.resolveSelection('session', 'ptc')).rejects.toThrow('explicit recovery')
  expect((await restored.read({ sessionId: 'session' })).basePresetId).toBe(missing)
  const recovery = await restored.prepare({ sessionId: 'session', recoverCapabilities: true })
  expect(recovery.capabilities.expertKit).toBeUndefined()
  expect(recovery.capabilities.basePresetId).toBe('standard')
  expect(await restored.resolveSelection('session', recovery.presetId)).toBe(recovery.presetId)
})

it('pins required knowledge IDs and old kit content while checking current resource permission', async () => {
  const f = await setup()
  const kit = await f.tasks.prepare({ expertKitId: 'order-expert' })
  f.select(kit.presetId)
  expect(kit.capabilities.requiredKnowledgeBaseIds).toEqual(['orders-kb'])
  f.deps.content.mockRejectedValue(new Error('new version must not replace pinned content'))
  const changed = await f.tasks.prepare({ sessionId: 'session', knowledgeBaseIds: ['orders-kb', 'manuals'] })
  expect(changed.capabilities.expertKit).toEqual(kit.capabilities.expertKit)
  expect(changed.capabilities.requiredKnowledgeBaseIds).toEqual(['orders-kb'])
  expect(f.deps.validateKnowledge).toHaveBeenLastCalledWith(['manuals', 'orders-kb'], [], undefined)
  f.deps.authorizeKit.mockRejectedValue(new Error('resource revoked'))
  await expect(f.tasks.validate(kit.presetId)).rejects.toThrow('resource revoked')
})

it('quarantines an invalid nested snapshot and preserves it when explicit recovery replaces the same identity', async () => {
  const f = await setup()
  const prepared = await f.tasks.prepare({ knowledgeBaseIds: ['manuals'] })
  const path = join(f.root, `${prepared.presetId}.json`)
  const saved = JSON.parse(await readFile(path, 'utf8')) as { capabilities: { requiredKnowledgeBaseIds: string[] } }
  saved.capabilities.requiredKnowledgeBaseIds = ['not-selected']
  const corrupted = JSON.stringify(saved)
  await writeFile(path, corrupted)
  f.select(prepared.presetId)
  const restored = await createTaskCapabilities(f.ctx, f.deps)
  expect((await restored.read({ sessionId: 'session' })).unavailable?.code).toBe('TASK_SNAPSHOT_INVALID')
  await expect(restored.validate(prepared.presetId)).rejects.toThrow('cannot be restored')
  expect(f.register).toHaveBeenLastCalledWith({ id: prepared.presetId, plugins: [], selectable: false, defaultable: false }, [])
  const repaired = await restored.prepare({ sessionId: 'session', recoverCapabilities: true, knowledgeBaseIds: ['manuals'] })
  const preserved = (await readdir(f.root)).find(name => name.startsWith(`${prepared.presetId}.json.invalid-`))
  expect(preserved).toBeDefined()
  expect(await readFile(join(f.root, preserved!), 'utf8')).toBe(corrupted)
  expect(repaired.presetId).toBe(prepared.presetId)
  expect(f.register.mock.calls.at(-1)?.[0].plugins.length).toBeGreaterThan(0)
  await expect(restored.validate(repaired.presetId)).resolves.toBeUndefined()
})

it('clears a restored diagnostic after successfully preparing the same snapshot', async () => {
  const f = await setup()
  const prepared = await f.tasks.prepare({ knowledgeBaseIds: ['manuals'] })
  f.select(prepared.presetId)
  f.register.mockRejectedValueOnce(new Error('restore registration failed'))
  const restored = await createTaskCapabilities(f.ctx, f.deps)
  expect((await restored.read({ sessionId: 'session' })).unavailable).toBeDefined()
  const repaired = await restored.prepare({ sessionId: 'session', knowledgeBaseIds: ['manuals'] })
  expect(repaired.presetId).toBe(prepared.presetId)
  await expect(restored.validate(repaired.presetId)).resolves.toBeUndefined()
  expect((await restored.read({ sessionId: 'session' })).unavailable).toBeUndefined()
})

it('restores the blocked composition when recovering the same identity fails registration', async () => {
  const f = await setup()
  const prepared = await f.tasks.prepare({ knowledgeBaseIds: ['manuals'] })
  const path = join(f.root, `${prepared.presetId}.json`)
  await writeFile(path, '{broken snapshot')
  f.select(prepared.presetId)
  const restored = await createTaskCapabilities(f.ctx, f.deps)
  f.deps.validateTools.mockRejectedValueOnce(new Error('composition validation failed'))
  await expect(restored.prepare({ sessionId: 'session', recoverCapabilities: true, knowledgeBaseIds: ['manuals'] }))
    .rejects.toThrow('composition validation failed')
  expect(f.register).toHaveBeenLastCalledWith({ id: prepared.presetId, plugins: [], selectable: false, defaultable: false }, [])
  expect(await readFile(path, 'utf8')).toBe('{broken snapshot')
  await expect(restored.validate(prepared.presetId)).rejects.toThrow('cannot be restored')
  await restored.prepare({ sessionId: 'session', recoverCapabilities: true, knowledgeBaseIds: ['manuals'] })
  await expect(restored.validate(prepared.presetId)).resolves.toBeUndefined()
})

it('recovers invalid knowledge in one submission and retains selection when the directory is unavailable', async () => {
  const f = await setup()
  const kit = await f.tasks.prepare({ expertKitId: 'order-expert', knowledgeBaseIds: ['manuals', 'removed'] })
  f.select(kit.presetId)
  f.deps.visibleKnowledge.mockRejectedValueOnce(new Error('directory unavailable'))
  await expect(f.tasks.prepare({ sessionId: 'session', recoverCapabilities: true })).rejects.toThrow('directory unavailable')
  expect(await f.tasks.read({ sessionId: 'session' })).toEqual(kit.capabilities)
  f.start()
  const recovered = await f.tasks.prepare({ sessionId: 'session', recoverCapabilities: true })
  expect(recovered.kind).toBe('NEW_SESSION')
  expect(recovered.capabilities).toMatchObject({ knowledgeBaseIds: ['manuals'], requiredKnowledgeBaseIds: [], connectorIds: [] })
  expect(recovered.capabilities.expertKit).toBeUndefined()
  expect(await f.tasks.read({ sessionId: 'session' })).toEqual(kit.capabilities)
})

it('rolls registration back when snapshot persistence fails, allowing a concurrent retry to own its registration', async () => {
  const f = await setup()
  const controller = new AbortController()
  f.register.mockImplementationOnce(async (_definition) => {
    controller.abort(new Error('cancel before persistence'))
    return async () => { f.register.mockClear() }
  })
  const first = f.tasks.prepare({ knowledgeBaseIds: ['manuals'] }, controller.signal)
  const second = f.tasks.prepare({ knowledgeBaseIds: ['manuals'] })
  await expect(first).rejects.toThrow()
  const result = await second
  await expect(f.tasks.validate(result.presetId)).resolves.toBeUndefined()
  expect((await readdir(f.root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  expect(await readFile(join(f.root, `${result.presetId}.json`), 'utf8')).toContain('manuals')
})
