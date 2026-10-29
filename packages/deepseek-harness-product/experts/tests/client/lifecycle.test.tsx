// @vitest-environment jsdom
/** The mounted expert plugin owns and resets the same data used by its UI contributions. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { InputTriggerService, type InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Experts from '../../src/client/index.ts'
import type { ExpertClientState } from '../../src/client/client-state.ts'
import type { AgencyCatalogRemote, AgencyTeamsRemote } from '../../src/client/remote.ts'
import { TEST_TEAMS } from '../../src/fixtures/teams.ts'

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sessions', { scope: () => undefined } as never)
  ctx.provide('conversation', {} as never)
  ctx.provide('layout', {} as never)
  await ctx.plugin(InputTriggerService).await()
  const sources = new Map<string, InputTriggerSource>()
  const register = ctx.inputTriggers.registerSource.bind(ctx.inputTriggers)
  vi.spyOn(ctx.inputTriggers, 'registerSource').mockImplementation((source) => {
    const dispose = register(source)
    sources.set(source.name, source)
    return () => { dispose(); if (sources.get(source.name) === source) sources.delete(source.name) }
  })
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
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, 'experts-client': Experts })
  const root = await mkdtemp(join(tmpdir(), 'experts-client-'))
  // The loader watches this file and can close one tick after the owner is
  // disposed. Retry cleanup so a late watcher write cannot make the test
  // itself fail with ENOTEMPTY.
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }))
  const path = join(root, 'cordis.yml')
  await writeFile(path, "- name: 'cordis:experts-client'\n")
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const owner = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:experts-client')?.fiber
  if (!owner) throw new Error('Expert client was not loaded')
  await owner.await()
  const cache = slots.entries('tool.call.toolview')[0]?.inject?.().cache as ExpertClientState | undefined
  if (!cache) throw new Error('Expert transcript contribution missing')
  await vi.waitFor(() => { expect(cache.catalog.getSnapshot().revision).toBe(8); expect(cache.teams.getSnapshot()?.revision).toBe(8) })
  return { ctx, owner, cache, getCatalog, getTeams, unmount, slots, sources }
}

it('clears disconnected Host data, accepts its new revision and disposes the previous mount', async () => {
  const { ctx, owner, cache, getCatalog, getTeams, unmount, slots } = await fixture()
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

const session = { sessionId: SessionId('expert-input') }
const request = { query: '', position: 'inline', drilled: false, signal: new AbortController().signal } as const
const compliance = { slug: 'compliance-review', name: '合规审查', nameEn: 'Compliance review', description: '合规检查',
  descriptionEn: 'Review compliance', emoji: '🔎', division: 'company-compliance', divisionZh: '公司合规', custom: false, company: true }

it('registers newly loaded company categories and removes them when their catalog is replaced', async () => {
  const { ctx, cache, getCatalog, sources, owner } = await fixture()
  getCatalog.mockResolvedValue({ ok: true, value: { experts: [compliance], enabled: [compliance.slug], revision: 9 } })
  await cache.catalog.refresh(true)
  const source = sources.get(Experts.inputTriggerSourceId(compliance.division))
  expect(source, 'company category registered after catalog load').toBeDefined()
  if (!source) throw new Error('Company category is missing')
  const candidates = await source.candidates(session, request)
  expect({ candidates: candidates.map(item => item.name), lexicon: source.lexicon?.(session) }).toMatchInlineSnapshot(`
    {
      "candidates": [
        "Compliance review",
      ],
      "lexicon": [
        "Compliance review",
      ],
    }
  `)
  ctx.locale.setLocale('zh')
  expect(sources.get(source.name)?.lexicon?.(session)).toEqual(['合规审查'])
  getCatalog.mockResolvedValue({ ok: true, value: { experts: [], enabled: [], revision: 10 } })
  await cache.catalog.refresh(true)
  expect(sources.has(source.name)).toBe(false)
  await owner.dispose()
  expect(sources.size).toBe(0)
})

it('uses committed catalog notifications for the expert lexicon and releases its subscribers', async () => {
  const { cache, getCatalog, sources, owner } = await fixture()
  getCatalog.mockResolvedValue({ ok: true, value: { experts: [{ ...compliance, division: 'engineering' }], enabled: [compliance.slug], revision: 9 } })
  await cache.catalog.refresh()
  const source = sources.get(Experts.inputTriggerSourceId('engineering'))
  if (!source) throw new Error('Engineering source is missing')
  const changed = vi.fn()
  const stop = source.subscribeLexicon?.(session, changed)
  expect(source.lexicon?.(session)).toContain('Compliance review')
  cache.catalog.acceptEnabled({ enabled: [], revision: 10 })
  expect(changed).toHaveBeenCalledOnce()
  expect(source.lexicon?.(session)).toEqual([])
  stop?.()
  cache.catalog.acceptEnabled({ enabled: [compliance.slug], revision: 11 })
  expect(changed).toHaveBeenCalledOnce()
  source.subscribeLexicon?.(session, changed)
  await owner.dispose()
  expect(changed).toHaveBeenCalledOnce()
})

it.each(['disabled', 'removed'] as const)('refuses an old team candidate after the confirmed team snapshot marks it %s', async (state) => {
  const { cache, getTeams, sources } = await fixture()
  const team = TEST_TEAMS[0]
  if (!team) throw new Error('Team fixture is missing')
  const value = { teams: [team], enabledTeams: [team.id], enabledExperts: [], revision: 9 }
  getTeams.mockResolvedValue({ ok: true, value })
  await cache.teams.refresh()
  const source = sources.get('agency-agents:teams')
  if (!source) throw new Error('Team source is missing')
  const [candidate] = await source.candidates(session, request)
  if (!candidate) throw new Error('Team candidate is missing')
  const renamed = { ...team, name: '更新后的专家团' }
  cache.teams.accept({ ...value, teams: [renamed], revision: 10 })
  expect(source.codec?.clipboardText(team.id)).toContain(renamed.name)
  cache.teams.accept({ ...value, teams: state === 'removed' ? [] : value.teams, enabledTeams: [], revision: 11 })
  expect(source.onPick({ candidate, session, position: 'inline', via: 'menu', action: 'pick',
    span: { start: 0, end: 1, draftRev: 0 } })).toBeUndefined()
})
