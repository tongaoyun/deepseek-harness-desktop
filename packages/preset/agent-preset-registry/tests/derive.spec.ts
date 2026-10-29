import { expect, it, onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { harness, declare, contribution, agentOn } from './harness.ts'
import Preset from '@deepseek-ai/dsh-agent-preset'

it('derives detached rows and retains the declaring Loader base URL', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())
  await declare(ctx, contribution('standard'))
  const derived = ctx.agentPresets.derive('standard', { id: 'derived', plugins: [], selectable: false })
  expect(derived.resolutionBase).toBe(ctx.baseUrl)
  expect(derived.selectionBase).toBe('standard')
  const row = derived.plugins[0]!
  row.config = { tool: 'changed' }
  expect(ctx.agentPresets.derive('standard', { id: 'second', plugins: [] }).plugins[0]?.config).toEqual({ tool: 'standard' })
  const foreign = ctx.extend({ baseUrl: 'file:///unrelated/profile/' })
  const dispose = await foreign.agentPresets.register(derived)
  onTestFinished(dispose)
  await using scope = await ctx.agentPresets.acquireScope('derived')
  expect(ctx.tools.schemas(scope.key).map(tool => tool.name)).toEqual(['changed'])
  expect(ctx.tools.schemas()).toEqual([])
  expect(() => ctx.agentPresets.derive('missing', { id: 'bad', plugins: [] })).toThrow('Unknown agent preset')
})

it('flattens hidden derivations to their selectable origin while executing and logging the full composition', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())
  await declare(ctx, contribution('standard'))
  await declare(ctx, contribution('minimal'))
  const first = ctx.agentPresets.derive('minimal', { id: 'snapshot-one', selectable: false, defaultable: false, plugins: [] })
  await declare(ctx, first)
  const second = ctx.agentPresets.derive(first.id, { id: 'snapshot-two', selectable: false, defaultable: false, plugins: [] })
  expect(second.selectionBase).toBe('minimal')
  await declare(ctx, second)
  expect((await ctx.agentPresets.remoteExportList()).presets.find(row => row.id === second.id)).toMatchObject({
    selectionBase: 'minimal', selectable: false, defaultable: false,
  })
  expect(await ctx.agentPresets.resolve(second.id)).toMatchObject({ selectionBase: 'minimal', selectable: false })
  const agent = await agentOn(ctx, 'derived-mode')
  ctx.on('agent-preset/resolve-selection', async (_agent, _requested, next) => { await next(); return second.id })
  expect(await ctx.agentPresets.select(agent, 'minimal')).toBe(second.id)
  expect(ctx.agentPresets.presetForSession(agent.session)).toBe(second.id)
  expect(ctx.tools.schemas(agent).map(row => row.name)).toEqual(['minimal'])
  expect(() => ctx.agentPresets.derive('minimal', {
    id: 'misnamed', selectable: false, selectionBase: 'standard', plugins: [],
  })).toThrow('selectable origin')
})

it('rejects malformed selectable origins before registration', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())
  await declare(ctx, contribution('standard'))
  await declare(ctx, { id: 'hidden', selectable: false, plugins: [] })
  for (const selectionBase of ['', ' ', 'invalid']) {
    await expect(ctx.agentPresets.register({ id: 'invalid', selectable: false, selectionBase, plugins: [] }))
      .rejects.toThrow('nonempty, distinct selection base')
  }
  await expect(ctx.agentPresets.register({ id: 'invalid', selectionBase: 'standard', plugins: [] }))
    .rejects.toThrow('hidden composition')
  expect((await ctx.agentPresets.list()).map(row => row.id).sort()).toEqual(['hidden', 'standard'])
})

it('diagnoses missing and hidden bases without changing the current composition or Session events', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())
  await declare(ctx, contribution('standard'))
  await declare(ctx, { id: 'hidden', selectable: false, plugins: [] })
  await declare(ctx, { id: 'associated', selectable: false, selectionBase: 'standard', plugins: [] })
  const agent = await agentOn(ctx, 'invalid-origin')
  const selected: string[] = []
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'agent-preset/selected') selected.push(event.data.agentPreset)
  })
  for (const selectionBase of ['missing', 'hidden', 'associated']) {
    const id = `snapshot-${selectionBase}`
    await declare(ctx, { id, selectable: false, selectionBase, plugins: [] })
    const reason = selectionBase === 'missing' ? 'is not registered' : 'must be selectable'
    expect((await ctx.agentPresets.resolve(id)).broken).toContain(reason)
    expect((await ctx.agentPresets.list()).find(row => row.id === id)?.broken).toContain(reason)
    await expect(ctx.agentPresets.acquireScope(id)).rejects.toThrow(reason)
    const scope = createScope(ctx, {})
    await expect(ctx.agentPresets.mount(scope.ctx, id)).rejects.toThrow(reason)
    await scope.dispose()
    await expect(ctx.agentPresets.select(agent, id)).rejects.toThrow(reason)
  }
  expect(ctx.agentPresets.composedPreset(agent.ctx)).toBe('standard')
  expect(ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(['standard'])
  expect(selected).toEqual([])
})

it('waits for a concurrently declared base after registering a real Loader hidden declaration', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.loader.builtins.preset = Preset
  let release!: () => void
  const paused = new Promise<void>((resolve) => { release = resolve })
  onTestFinished(release)
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  ctx.loader.builtins.slowPreset = {
    inject: ['agentPresets'],
    async* apply(host: Context) {
      entered()
      await paused
      yield await host.agentPresets.register(contribution('standard'))
    },
  }
  const update = ctx.loader.root.update([
    { id: 'snapshot-declaration', name: 'cordis:preset', config: {
      ...contribution('snapshot'), selectable: false, defaultable: false, selectionBase: 'standard',
    } },
    { id: 'base-declaration', name: 'cordis:slowPreset' },
  ])
  await started
  const declaration = ctx.loader.resolve('snapshot-declaration')
  await declaration._initTask
  await declaration.fiber!.await()
  const settle = ctx.loader.await.bind(ctx.loader)
  let audited!: () => void
  const awaitingBase = new Promise<void>((resolve) => { audited = resolve })
  ctx.loader.await = () => { audited(); return settle() }
  let completed = false
  const acquiring = ctx.agentPresets.acquireScope('snapshot').then((lease) => { completed = true; return lease })
  await awaitingBase
  expect(completed).toBe(false)
  release()
  await update
  await using lease = await acquiring
  expect(await ctx.agentPresets.resolve('snapshot')).toEqual({
    id: 'snapshot', selectable: false, defaultable: false, selectionBase: 'standard',
  })
  expect(ctx.tools.schemas(lease.key).map(tool => tool.name)).toEqual(['snapshot'])
  await ctx.loader.root.update([])
  await settle()
  expect(await ctx.agentPresets.list()).toEqual([])
  expect(ctx.tools.schemas(lease.key).map(tool => tool.name)).toEqual(['snapshot'])
})

it('re-audits unloaded and replaced bases while retaining a live composition revision', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())
  const base = await declare(ctx, contribution('standard'))
  await declare(ctx, { ...contribution('snapshot'), selectable: false, selectionBase: 'standard' })
  const agent = await agentOn(ctx, 'retained-snapshot', 'snapshot')
  await base.dispose()
  expect((await ctx.agentPresets.resolve('snapshot')).broken).toContain('is not registered')
  await expect(ctx.agentPresets.acquireScope('snapshot')).rejects.toThrow('is not registered')
  expect(ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(['snapshot'])
  const hidden = await declare(ctx, { ...contribution('standard'), selectable: false })
  expect((await ctx.agentPresets.resolve('snapshot')).broken).toContain('must be selectable')
  await hidden.dispose()
  await declare(ctx, contribution('standard'))
  expect((await ctx.agentPresets.resolve('snapshot')).broken).toBeUndefined()
  await using lease = await ctx.agentPresets.acquireScope('snapshot')
  expect(ctx.tools.schemas(lease.key).map(tool => tool.name)).toEqual(['snapshot'])
})

it('retains visibility and selectable-origin metadata through the real Loader declaration schema', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.loader.builtins.preset = Preset
  const base = { id: 'base-declaration', name: 'cordis:preset', config: { id: 'standard', plugins: [] } }
  await ctx.loader.root.update([base])
  await ctx.loader.await()
  await ctx.loader.root.update([base, {
    id: 'snapshot-declaration', name: 'cordis:preset', config: {
      id: 'snapshot', selectable: false, defaultable: false, selectionBase: 'standard', plugins: [],
    },
  }])
  await ctx.loader.await()
  expect((await ctx.agentPresets.remoteExportList()).presets.find(row => row.id === 'snapshot')).toMatchObject({
    selectionBase: 'standard', selectable: false, defaultable: false,
  })
  await ctx.loader.root.update([])
  await ctx.loader.await()
  expect(await ctx.agentPresets.list()).toEqual([])
})
