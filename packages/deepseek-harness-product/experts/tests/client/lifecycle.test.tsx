// @vitest-environment jsdom
/** The mounted expert plugin owns and resets the same data used by its UI contributions. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Experts from '../../src/client/index.ts'
import type { ExpertClientState } from '../../src/client/client-state.ts'
import type { AgencyCatalogRemote, AgencyTeamsRemote } from '../../src/client/remote.ts'

it('clears disconnected Host data, accepts its new revision and disposes the previous mount', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sessions', {} as never)
  ctx.provide('conversation', {} as never)
  ctx.provide('layout', {} as never)
  ctx.provide('inputTriggers', { registerSource: () => () => {} } as never)
  const unmount = vi.fn(async () => {})
  ctx.provide('remote', { $mount: async () => unmount } as never)
  const getCatalog = vi.fn<AgencyCatalogRemote['getCatalog']>().mockResolvedValue({ ok: true, value: { experts: [], enabled: ['old'], revision: 8 } })
  const getTeams = vi.fn<AgencyTeamsRemote['getTeams']>().mockResolvedValue({ ok: true, value: { teams: [], enabledTeams: ['old'], enabledExperts: ['old'], revision: 8 } })
  ctx.provide('remote.agencyAgents', { getCatalog, getTeams } as never)
  slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' },
    'conversation.input.left': { kind: 'list', scope: 'session' },
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
  } }, (props: PropsRenderSlots<'main' | 'conversation.input.left' | 'tool.call.toolview'>) => { void props.renderSlot; return null })
  const owner = ctx.plugin(Experts)
  await owner.await()
  const cache = slots.entries('tool.call.toolview')[0]?.inject?.().cache as ExpertClientState | undefined
  if (!cache) throw new Error('Expert transcript contribution missing')
  await vi.waitFor(() => { expect(cache.catalog.getSnapshot().revision).toBe(8); expect(cache.teams.getSnapshot()?.revision).toBe(8) })
  const disconnectedCatalog = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['getCatalog']>>>()
  const disconnectedTeams = Promise.withResolvers<Awaited<ReturnType<AgencyTeamsRemote['getTeams']>>>()
  getCatalog.mockReturnValueOnce(disconnectedCatalog.promise)
  getTeams.mockReturnValueOnce(disconnectedTeams.promise)
  ctx.emit('connection/reset')
  expect(cache.catalog.getSnapshot().revision).toBe(-1)
  expect(cache.teams.getSnapshot()).toBeNull()
  disconnectedCatalog.resolve({ ok: true, value: { experts: [], enabled: [], revision: 0 } })
  disconnectedTeams.resolve({ ok: true, value: { teams: [], enabledTeams: [], enabledExperts: [], revision: 0 } })
  await vi.waitFor(() => { expect(cache.catalog.getSnapshot().revision).toBe(0); expect(cache.teams.getSnapshot()?.revision).toBe(0) })
  expect(getCatalog).toHaveBeenCalledTimes(2)
  expect(getTeams).toHaveBeenCalledTimes(2)
  await owner.dispose()
  expect(cache.catalog.getSnapshot().revision).toBe(-1)
  expect(cache.teams.getSnapshot()).toBeNull()
  expect(() => cache.catalog.refresh()).toThrow()
  expect(unmount).toHaveBeenCalledTimes(1)
  const nextOwner = ctx.plugin(Experts)
  await nextOwner.await()
  const next = slots.entries('tool.call.toolview')[0]?.inject?.().cache
  expect(next).not.toBe(cache)
  await nextOwner.dispose()
  expect(unmount).toHaveBeenCalledTimes(2)
})
