/** Required discovery prevents an incomplete policy source from exposing fallback skills. */
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SkillRegistry, { type SkillCandidate, type SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { expect, it, onTestFinished, vi } from 'vitest'

function candidate(provider: string, enabled: boolean): SkillCandidate {
  return { name: 'audit-orders', description: 'Audit orders', provider, source: provider,
    rank: enabled ? 400 : 399, invocation: { modelInvocable: enabled, userInvocable: enabled }, locator: null }
}

async function boot() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SkillRegistry)
  const fallbackLoad = vi.fn(async () => ({ ...candidate('filesystem', true), content: 'Native fallback body.' }))
  ctx.skills.registerProvider(() => ({ name: 'filesystem', list: async () => [candidate('filesystem', true)], get: fallbackLoad }))
  return { ctx, fallbackLoad }
}

it.each(['throw', 'incomplete'] as const)('rejects required %s discovery before loading fallback and retries after recovery', async (mode) => {
  const { ctx, fallbackLoad } = await boot()
  const failure = new Error('Policy source unavailable')
  let failing = true
  const list = vi.fn(async () => {
    if (failing && mode === 'throw') throw failure
    return { candidates: [candidate('policy', false)], complete: !failing }
  })
  ctx.skills.registerProvider(() => ({ name: 'policy', required: true, list,
    get: async value => ({ ...value, content: 'Disabled instructions.' }) }))
  await expect(ctx.skills.snapshot()).rejects.toMatchObject({ name: 'SkillProviderUnavailableError', provider: 'policy',
    ...mode === 'throw' ? { cause: failure } : {} })
  await expect(ctx.skills.get('audit-orders')).rejects.toMatchObject({ name: 'SkillProviderUnavailableError', provider: 'policy' })
  expect(fallbackLoad).not.toHaveBeenCalled()
  expect(list).toHaveBeenCalledTimes(2)
  failing = false
  expect(await ctx.skills.snapshot()).toMatchObject({ complete: true, skills: [{ provider: 'policy', invocation: { modelInvocable: false } }] })
  expect(await ctx.skills.get('audit-orders')).toMatchObject({ provider: 'policy', invocation: { modelInvocable: false } })
  expect(list).toHaveBeenCalledTimes(3)
  expect(fallbackLoad).not.toHaveBeenCalled()
})

it('preserves cancellation while waiting for a required provider', async () => {
  const { ctx, fallbackLoad } = await boot()
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<SkillCandidate[]>()
  ctx.skills.registerProvider(() => ({ name: 'policy', required: true,
    list: () => { entered.resolve(undefined); return released.promise }, get: async () => undefined }))
  const controller = new AbortController()
  const pending = ctx.skills.get('audit-orders', { signal: controller.signal })
  await entered.promise
  const reason = new Error('Caller cancelled required discovery')
  controller.abort(reason)
  try { await expect(pending).rejects.toBe(reason) }
  finally { released.resolve([]) }
  expect(fallbackLoad).not.toHaveBeenCalled()
})

it('limits required failures to their scope and keeps replacement registrations authoritative', async () => {
  const { ctx, fallbackLoad } = await boot()
  const preset = createScope(ctx, { preset: 'required-policy' })
  onTestFinished(() => preset.dispose())
  const skills = preset.ctx.get('skills')
  if (!skills) throw new Error('Scoped skill registry unavailable')
  let oldControl: SkillProviderControl | undefined
  const dispose = skills.registerProvider((control) => {
    oldControl = control
    return { name: 'policy', required: true, list: async () => ({ candidates: [], complete: false }), get: async () => undefined }
  })
  expect(await ctx.skills.get('audit-orders')).toMatchObject({ provider: 'filesystem' })
  await expect(ctx.skills.get('audit-orders', { scope: scopeOf(preset.ctx) })).rejects.toMatchObject({ provider: 'policy' })
  dispose()
  const list = vi.fn(async () => [candidate('policy', false)])
  skills.registerProvider(() => ({ name: 'policy', required: true, list,
    get: async value => ({ ...value, content: 'Disabled replacement.' }) }))
  expect(await ctx.skills.get('audit-orders', { scope: scopeOf(preset.ctx) })).toMatchObject({ provider: 'policy', invocation: { userInvocable: false } })
  oldControl?.invalidate()
  expect(await ctx.skills.get('audit-orders', { scope: scopeOf(preset.ctx) })).toMatchObject({ provider: 'policy' })
  expect(list).toHaveBeenCalledTimes(1)
  expect(fallbackLoad).toHaveBeenCalledTimes(1)
})

it('rejects a required observation that becomes incomplete during an invalidated collection', async () => {
  const { ctx, fallbackLoad } = await boot()
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  let failing = false
  let calls = 0
  let invalidate = () => {}
  ctx.skills.registerProvider((control) => {
    invalidate = control.invalidate
    return { name: 'policy', required: true, async list() {
      calls++
      if (calls === 1) { entered.resolve(undefined); await released.promise }
      return { candidates: [candidate('policy', false)], complete: !failing }
    }, get: async value => ({ ...value, content: 'Disabled instructions.' }) }
  })
  const pending = ctx.skills.get('audit-orders')
  await entered.promise
  failing = true
  invalidate()
  released.resolve(undefined)
  await expect(pending).rejects.toMatchObject({ provider: 'policy' })
  expect(fallbackLoad).not.toHaveBeenCalled()
  failing = false
  expect(await ctx.skills.get('audit-orders')).toMatchObject({ provider: 'policy', invocation: { modelInvocable: false } })
})

it('does not fall back when a cached required candidate fails to load', async () => {
  const { ctx, fallbackLoad } = await boot()
  let failing = false
  const failure = new Error('Required body read failed')
  ctx.skills.registerProvider(() => ({ name: 'policy', required: true,
    list: async () => [candidate('policy', false)], async get(value) {
      if (failing) throw failure
      return { ...value, content: 'Disabled instructions.' }
    } }))
  await ctx.skills.snapshot()
  failing = true
  await expect(ctx.skills.get('audit-orders')).rejects.toBe(failure)
  expect(fallbackLoad).not.toHaveBeenCalled()
  failing = false
  expect(await ctx.skills.get('audit-orders')).toMatchObject({ provider: 'policy' })
})

it('rejects repeated catalog invalidation while a required provider participates', async () => {
  const { ctx, fallbackLoad } = await boot()
  let changing = true
  ctx.skills.registerProvider(control => ({ name: 'policy', required: true,
    list: async () => {
      if (changing) control.invalidate()
      return [candidate('policy', false)]
    }, get: async value => ({ ...value, content: 'Disabled instructions.' }) }))
  await expect(ctx.skills.get('audit-orders')).rejects.toMatchObject({ provider: 'policy', reason: 'unstable' })
  expect(fallbackLoad).not.toHaveBeenCalled()
  changing = false
  expect(await ctx.skills.get('audit-orders')).toMatchObject({ provider: 'policy', invocation: { modelInvocable: false } })
})
