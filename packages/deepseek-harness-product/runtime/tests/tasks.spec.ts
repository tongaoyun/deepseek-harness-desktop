import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createTaskCapabilities, type TaskDependencies } from '../src/tasks.ts'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-tasks-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const definitions = new Map<string, PresetDefinition>([
    ['standard', { id: 'standard', plugins: [{ id: 'base', name: 'base' }] }],
    ['ptc', { id: 'ptc', plugins: [{ id: 'ptc-base', name: 'ptc-base' }] }],
  ])
  let selected = 'standard'
  let started = false
  const context = (value: object): Context => value as Context
  const ctx = context({
    logger: { warn: vi.fn() },
    sessionQuery: {
      listSessions: async () => [{ header: { id: 'session', agentPreset: selected } }],
      observeSession: async () => ({ header: { agentPreset: selected }, projections: { values: { agentPreset: selected } },
        events: started ? [{ type: 'turn/start' }] : [], [Symbol.dispose]() {} }),
    },
    agentPresets: { defaultId: 'standard', resolve: async (id: string) => definitions.get(id),
      derive(base: string, value: PresetDefinition) {
        return { ...value, selectionBase: base, plugins: [...definitions.get(base)!.plugins, ...value.plugins], resolutionBase: 'file:///profile/' }
      },
    },
  })
  const register = vi.fn(async (definition: PresetDefinition) => {
    definitions.set(definition.id, definition)
    return async () => { definitions.delete(definition.id) }
  })
  const deps = { root, register, visibleKnowledge: vi.fn(async () => ['manuals']),
    validateKnowledge: vi.fn<TaskDependencies['validateKnowledge']>(async ids => ids),
    knowledgePlugins: ids => ids.length ? [{ id: 'product-knowledge', name: 'knowledge', config: { knowledgeBaseIds: ids } }] : [],
  } satisfies TaskDependencies
  const tasks = await createTaskCapabilities(ctx, deps)
  return { root, ctx, deps, tasks, register, select: (id: string) => { selected = id }, start: () => { started = true } }
}
it('pins exact knowledge IDs, preserves loader resolution and restores after a restart', async () => {
  const f = await setup()
  const prepared = await f.tasks.prepare({ sessionId: 'session', knowledgeBaseIds: ['manuals'] })
  expect(prepared.kind).toBe('CURRENT_SESSION')
  f.select(prepared.presetId)
  const restored = await createTaskCapabilities(f.ctx, f.deps)
  expect(await restored.read({ sessionId: 'session' })).toEqual({ basePresetId: 'standard', knowledgeBaseIds: ['manuals'] })
  expect(f.register.mock.calls.at(-1)?.[0].resolutionBase).toBe('file:///profile/')
  const raw = await readFile(join(f.root, `${prepared.presetId}.json`), 'utf8')
  expect(raw).not.toMatch(/expertKit|skill|Authorization|headers/)
})
it('preserves knowledge when switching the official execution mode', async () => {
  const f = await setup()
  const first = await f.tasks.prepare({ knowledgeBaseIds: ['manuals'] })
  f.select(first.presetId)
  const next = await f.tasks.prepare({ sessionId: 'session', basePresetId: 'ptc' })
  expect(next.capabilities).toEqual({ basePresetId: 'ptc', knowledgeBaseIds: ['manuals'] })
  expect(f.register.mock.calls.at(-1)?.[0].plugins.map(row => row.id)).not.toContain('base')
})
it('does not register retrieval tools when no library is selected', async () => {
  const f = await setup()
  await f.tasks.prepare({ knowledgeBaseIds: [] })
  expect(f.register.mock.calls.at(-1)?.[0].plugins.map(row => row.id)).not.toContain('product-knowledge')
})
it('returns a new task when a turn starts during preparation', async () => {
  const f = await setup()
  f.deps.validateKnowledge.mockImplementation(async (ids) => { f.start(); return ids })
  expect((await f.tasks.prepare({ sessionId: 'session', knowledgeBaseIds: ['manuals'] })).kind).toBe('NEW_SESSION')
})
it('isolates corrupt snapshots, retains raw files and requires explicit recovery', async () => {
  const f = await setup()
  const id = 'product-task-' + 'a'.repeat(64)
  const path = join(f.root, `${id}.json`)
  await writeFile(path, '{broken')
  f.select(id)
  const restored = await createTaskCapabilities(f.ctx, f.deps)
  await expect(restored.validate(id)).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe('{broken')
  const replacement = await restored.prepare({ sessionId: 'session', recoverCapabilities: true })
  expect(replacement.capabilities).toEqual({ basePresetId: 'standard', knowledgeBaseIds: [] })
})
it('does not interpret a removed product composition as default capabilities', async () => {
  const f = await setup()
  f.select('product-task-' + 'b'.repeat(64))
  const restored = await createTaskCapabilities(f.ctx, f.deps)
  expect((await restored.read({ sessionId: 'session' })).unavailable?.code).toBe('TASK_SNAPSHOT_MISSING')
  await expect(restored.prepare({ sessionId: 'session' })).rejects.toThrow('Recover this task')
})
it('leaves the current selection and stored files unchanged after preparation failure', async () => {
  const f = await setup()
  f.deps.validateKnowledge.mockRejectedValue(new Error('Network unavailable'))
  await expect(f.tasks.prepare({ sessionId: 'session', knowledgeBaseIds: ['manuals'] })).rejects.toThrow('Network unavailable')
  expect(await readdir(f.root)).toEqual([])
  expect(await f.tasks.read({ sessionId: 'session' })).toEqual({ basePresetId: 'standard', knowledgeBaseIds: [] })
})
