/** Expert semantic contracts exercised through the real Loader, Gateway and owner Peer. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Access from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import Remote from '../src/remote.ts'
import { AGENCY_PERSONA_SERVICE, type AgencyPersonaSource } from '../src/index.ts'
import { AGENCY_LIBRARY_SERVICE, agencySettingsSchema, createExpertLibrary, type AgencySettings } from '../src/expert-library.ts'
import { AGENCY_TEAM_SERVICE, createTeamLibrary } from '../src/team-library.ts'
import type { CompanyContentSource } from '@deepseek-harness/product/protocol'
import { teamSnapshotSchema, type TeamSnapshot } from '../src/team-contract.ts'
import { nativeTeamMemberName } from '../src/team-engine.ts'
import { CREATION_SERVICE, createDrafts } from '../src/creation.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TEST_TEAMS } from '../src/fixtures/teams.ts'
import { MemorySettings } from '../src/settings-memory.ts'
import { expertSettingsNamespace } from '../src/settings.ts'
import { catalogSnapshotSchema } from '../src/expert-contract.ts'
import { AGENCY_AGENTS_DESCRIPTORS, TYPERT_REMOTE } from '../src/remote-contract.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { 'experts-test-guest': { kind: 'experts-test-guest' } }
}
const draft = { name: ' Reviewer ', description: ' Review code ', division: 'engineering', prompt: ' Check changes. ' }

async function boot(base?: Parameters<typeof createExpertLibrary>[0]) {
  const root = await mkdtemp(join(tmpdir(), 'experts-native-remote-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const settings = new MemorySettings()
  const ns = expertSettingsNamespace('agency-agents')
  settings.register(ns, agencySettingsSchema)
  const store = {
    read: () => settings.get(ns) as AgencySettings,
    revision: () => settings.describe().find(item => item.ns === ns)!.revision,
    mutate: (ops, revision) => settings.mutate(ns, ops, revision),
  } satisfies Parameters<typeof createExpertLibrary>[1]
  const library = createExpertLibrary(base ?? (() => Promise.resolve([])), store, ['engineering'], () => 'en')
  const teams = createTeamLibrary((_sessionId, signal) => library.catalog(signal), store, () => 'en')
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, typert: Typert, access: Access, gateway: Gateway, remote: Remote,
    settings: { name: 'expert-test-settings', apply(scope: Context) { scope.reflect.provide('settings', settings) } },
    library: { name: 'expert-test-library', apply(scope: Context) { scope.reflect.provide(AGENCY_LIBRARY_SERVICE, library); scope.reflect.provide(AGENCY_TEAM_SERVICE, teams) } },
  })
  const config = join(root, 'cordis.yml')
  await writeFile(config, ['settings', 'library', 'typert', 'access', 'gateway', 'remote'].map(name => `- name: 'cordis:${name}'`).join('\n'))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const invoke = (method: string, args: Record<string, unknown>, signal?: AbortSignal) => ctx.typertGateway.invoke({ namespace: 'agencyAgents', method, args, peer, signal })
  return { ctx, settings, ns, invoke, library, teams }
}

async function savedTeam(base?: Parameters<typeof createExpertLibrary>[0]) {
  const host = await boot(base)
  const first = catalogSnapshotSchema.parse(await host.invoke('saveCustomExpert', { expert: draft, enabled: true, expectedRevision: 0 }))
  const second = catalogSnapshotSchema.parse(await host.invoke('saveCustomExpert', { expert: { ...draft, name: 'Security' }, enabled: true, expectedRevision: first.revision }))
  const { id: _id, ...template } = TEST_TEAMS[0]
  const snapshot = teamSnapshotSchema.parse(await host.invoke('saveTeam', { team: { ...template,
    members: second.experts.map(expert => ({ expertSlug: expert.slug, duty: 'Review', instructions: 'Report findings' })),
  }, enabled: false, expectedRevision: second.revision }))
  return { ...host, snapshot, team: snapshot.teams[0] }
}

it('keeps native member labels and current execution metadata complete after team mutations', async () => {
  const { ctx, invoke, snapshot, team } = await savedTeam()
  const members = Object.fromEntries(team.members.map(member => [nativeTeamMemberName(team.id, member.expertSlug), member.expertSlug]))
  expect(snapshot.nativeMembers).toEqual(members)
  const engine: NonNullable<TeamSnapshot['engine']> = { state: 'enabled', mode: 'native', reason: 'Available', recommendation: '' }
  ctx.provide('agencyAgentsTeamEngine', () => engine)
  const enabled = teamSnapshotSchema.parse(await invoke('setTeamEnabled', { id: team.id, enabled: true, expectedRevision: snapshot.revision }))
  expect(enabled).toMatchObject({ nativeMembers: members, engine })
  const removed = teamSnapshotSchema.parse(await invoke('deleteTeam', { id: team.id, expectedRevision: enabled.revision }))
  expect(removed).toMatchObject({ teams: [], nativeMembers: {}, engine })
})

it('passes native team export cancellation to persona reads and rejects late content', async () => {
  const { ctx, invoke, snapshot, team } = await savedTeam()
  const reading = Promise.withResolvers<{ prompt: string }>()
  const getPrompt = vi.fn<AgencyPersonaSource['getPrompt']>(() => reading.promise)
  ctx.provide(AGENCY_PERSONA_SERVICE, { getPrompt } satisfies AgencyPersonaSource)
  const controller = new AbortController()
  const pending = invoke('exportTeam', { id: team.id, expectedRevision: snapshot.revision }, controller.signal)
  const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => { expect(getPrompt).toHaveBeenCalledTimes(team.members.length) })
  controller.abort()
  const signals = getPrompt.mock.calls.map(call => call[4])
  reading.resolve({ prompt: 'Late persona' })
  await rejected
  expect(signals.every(signal => signal?.aborted)).toBe(true)
})

it('cancelling editor preparation leaves the confirmed creation draft available', async () => {
  const { ctx, invoke, library } = await boot()
  const drafts = createDrafts()
  ctx.provide(CREATION_SERVICE, drafts)
  const session = SessionId('creation-request')
  const proposal = drafts.save(session, { kind: 'expert', data: draft })
  drafts.confirm(session, proposal.id)
  const catalog = await library.catalog()
  const reading = Promise.withResolvers<typeof catalog>()
  const source = vi.spyOn(library, 'catalog').mockReturnValueOnce(reading.promise)
  const controller = new AbortController()
  const pending = invoke('claimCreation', { sessionId: session, proposalId: proposal.id }, controller.signal)
  const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => { expect(source).toHaveBeenCalledOnce() })
  controller.abort()
  reading.resolve(catalog)
  await rejected
  expect(drafts.get(session, proposal.id)).toEqual(proposal.draft)
  expect(drafts.claim(session, proposal.id)).toEqual(proposal.draft)
})

it('preserves strict parsing, defaults, saved revisions and authorization through native dispatch', async () => {
  const { ctx, settings, ns, invoke } = await boot()
  const saved = catalogSnapshotSchema.parse(await invoke('saveCustomExpert', { expert: draft, enabled: true, expectedRevision: 0 }))
  expect(saved.revision).toBe(1)
  expect(saved.experts[0]).toMatchObject({ name: 'Reviewer', description: 'Review code', emoji: '🧩', avatar: 0 })
  const slug = saved.experts[0].slug
  expect(await invoke('getCustomExpert', { slug })).toMatchObject({ prompt: 'Check changes.' })
  await expect(invoke('deleteCustomExpert', { slug, expectedRevision: 0 })).rejects.toMatchObject({ code: 'experts/conflict' })
  await expect(invoke('saveTeam', { team: TEST_TEAMS[0], enabled: false, expectedRevision: 0 })).rejects.toMatchObject({ code: 'experts/conflict' })
  const invalid = [
    { expert: { ...draft, unexpected: true }, enabled: true, expectedRevision: 1 },
    { expert: { ...draft, name: 'x'.repeat(41) }, enabled: true, expectedRevision: 1 },
    { expert: { ...draft, prompt: 'x'.repeat(20_001) }, enabled: true, expectedRevision: 1 },
    { expert: draft, enabled: true, expectedRevision: -1 },
    { expert: draft, enabled: true, expectedRevision: 1.5 },
  ]
  for (const args of invalid) await expect(invoke('saveCustomExpert', args)).rejects.toMatchObject({ code: 'gateway/input-invalid' })
  await expect(invoke('claimCreation', { sessionId: 's', proposalId: 'bad-id' })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
  expect(settings.describe().find(item => item.ns === ns)?.revision).toBe(1)
  const guest = new Peer(ctx, { principal: { kind: 'experts-test-guest' } })
  await expect(ctx.typertGateway.invoke({ namespace: 'agencyAgents', method: 'getCatalog', args: { refreshCompany: false }, peer: guest })).rejects.toMatchObject({ code: 'remote-access/denied' })
  expect(catalogSnapshotSchema.parse(await invoke('getCatalog', { refreshCompany: false })).experts).toHaveLength(1)
  const removed = catalogSnapshotSchema.parse(await invoke('deleteCustomExpert', { slug, expectedRevision: 1 }))
  expect(removed.experts).toHaveLength(0)
  const remote = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:remote')
  expect(remote?.fiber).toBeDefined()
  await remote!.fiber!.dispose()
  expect(ctx.get('agencyAgents')).toBeUndefined()
  expect(ctx.typert.local.get('agencyAgents/getCatalog')).toBeUndefined()
  await expect(invoke('getCatalog', { refreshCompany: false })).rejects.toThrow()
}, 30000)

it('shares native method descriptors and keeps semantic codecs in ordinary and strict named inputs', () => {
  for (const [endpoint, method] of Object.entries(TYPERT_REMOTE.methods)) {
    expect(AGENCY_AGENTS_DESCRIPTORS.find(item => `${item.namespace}/${item.method}` === endpoint)).toBe(method)
    if (method.parameters.length > 0) expect(method.input().jsonSchema).toBeUndefined()
  }
  const save = TYPERT_REMOTE.methods['agencyAgents/saveCustomExpert']
  for (const input of [save.input(), save.input({ strict: true })]) {
    const parsed = input.create().parse({ expert: draft, enabled: false, expectedRevision: 0 })
    const value = z.object({ expert: z.object({ name: z.string(), emoji: z.string(), avatar: z.number() }) }).parse(parsed)
    expect(value.expert).toEqual({ name: 'Reviewer', emoji: '🧩', avatar: 0 })
    expect(() => input.create().parse({ expert: { ...draft, extra: true }, enabled: false, expectedRevision: 0 })).toThrow()
    expect(() => input.create().parse({ expert: draft, enabled: false, expectedRevision: 0, extra: true })).toThrow()
    expect(input.jsonSchema).toBeUndefined()
    expect(input.jsonSchemaError).toContain('semantic')
  }
  const claim = TYPERT_REMOTE.methods['agencyAgents/claimCreation'].input().create()
  expect(() => claim.parse({ sessionId: '', proposalId: '00000000-0000-4000-8000-000000000000' })).toThrow()
  expect(() => claim.parse({ sessionId: 's'.repeat(129), proposalId: '00000000-0000-4000-8000-000000000000' })).toThrow()
  expect(() => TYPERT_REMOTE.methods['agencyAgents/getPrompt'].input().create().parse({ slug: 's', division: 'x'.repeat(65) })).toThrow()
  expect(() => TYPERT_REMOTE.methods['agencyAgents/getCustomExpert'].input().create().parse({ slug: '../outside' })).toThrow()
  expect(() => TYPERT_REMOTE.methods['agencyAgents/getCatalog'].result.create().parse({ experts: [], enabled: [], revision: -1 })).toThrow()
})

it('cancelling a company refresh prevents a subsequent catalog read without aborting shared refresh', async () => {
  const { ctx, invoke, library } = await boot()
  const refreshing = Promise.withResolvers<undefined>()
  const refresh = vi.fn((_signal?: AbortSignal) => refreshing.promise)
  const unused = () => Promise.reject(new Error('Unexpected company read'))
  ctx.provide('companyContent', { refresh, read: unused, forSession: unused } satisfies CompanyContentSource)
  const catalog = vi.spyOn(library, 'catalog')
  const controller = new AbortController()
  const pending = invoke('getCatalog', { refreshCompany: true }, controller.signal)
  const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => { expect(refresh).toHaveBeenCalledOnce() })
  controller.abort()
  expect(refresh.mock.calls[0][0]?.aborted).toBe(true)
  refreshing.resolve(undefined)
  await rejected
  expect(catalog).not.toHaveBeenCalled()
})

it('passes native catalog cancellation to its source and rejects a late catalog', async () => {
  const reading = Promise.withResolvers<[]>()
  const source = vi.fn((_signal?: AbortSignal) => reading.promise)
  const { invoke } = await boot(source)
  const controller = new AbortController()
  const pending = invoke('getCatalog', { refreshCompany: false }, controller.signal)
  const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => { expect(source).toHaveBeenCalledOnce() })
  controller.abort()
  expect(source.mock.calls[0][0]?.aborted).toBe(true)
  reading.resolve([])
  await rejected
})

it('passes native prompt cancellation to its source and rejects a late prompt', async () => {
  const { ctx, invoke } = await boot()
  const reading = Promise.withResolvers<{ prompt: string }>()
  const getPrompt = vi.fn<AgencyPersonaSource['getPrompt']>(() => reading.promise)
  ctx.provide(AGENCY_PERSONA_SERVICE, { getPrompt } satisfies AgencyPersonaSource)
  const controller = new AbortController()
  const pending = invoke('getPrompt', { slug: 'reviewer', division: 'engineering' }, controller.signal)
  const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => { expect(getPrompt).toHaveBeenCalledOnce() })
  controller.abort()
  expect(getPrompt.mock.calls[0][4]?.aborted).toBe(true)
  reading.resolve({ prompt: 'Late prompt' })
  await rejected
})

it('cancelling a team snapshot prevents reading native engine metadata', async () => {
  const { ctx, invoke, teams } = await boot()
  const reading = Promise.withResolvers<TeamSnapshot>()
  const snapshot = vi.spyOn(teams, 'snapshot').mockReturnValueOnce(reading.promise)
  const engine = vi.fn(() => ({ state: 'disabled', mode: 'native', reason: '', recommendation: '' }))
  ctx.provide('agencyAgentsTeamEngine', engine)
  const controller = new AbortController()
  const pending = invoke('getTeams', {}, controller.signal)
  const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => { expect(snapshot).toHaveBeenCalledOnce() })
  controller.abort()
  reading.resolve({ teams: [], enabledTeams: [], enabledExperts: [], revision: 0 })
  await rejected
  expect(engine).not.toHaveBeenCalled()
})

it('keeps a concurrent Settings transaction conflict typed across native dispatch and leaves committed data intact', async () => {
  const { invoke, settings, ns } = await boot()
  const first = await invoke('saveCustomExpert', { expert: draft, enabled: true, expectedRevision: 0 })
  const catalog = catalogSnapshotSchema.parse(first)
  const slug = catalog.experts[0].slug
  const before = settings.get(ns) as AgencySettings
  const writes = await Promise.allSettled([
    invoke('setEnabled', { enabled: [slug], expectedRevision: catalog.revision }),
    invoke('setEnabled', { enabled: [], expectedRevision: catalog.revision }),
  ])
  const failed = writes.find(result => result.status === 'rejected')
  expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(failed).toMatchObject({ status: 'rejected', reason: { code: 'experts/conflict', cause: { code: 'SETTINGS_CONFLICT' } } })
  expect(settings.describe().find(item => item.ns === ns)?.revision).toBe(2)
  expect(settings.get(ns)).toMatchObject({ customExperts: before.customExperts })
})

it.each(['saveCustomExpert', 'setEnabled', 'saveTeam', 'setTeamEnabled'])(
  'cancels %s during catalog preparation without committing personal settings', async (method) => {
    const reading = Promise.withResolvers<[]>()
    const entered = Promise.withResolvers<AbortSignal | undefined>()
    let hold = false
    const { invoke, settings, ns, snapshot, team } = await savedTeam((signal) => {
      if (!hold) return Promise.resolve([])
      entered.resolve(signal)
      return reading.promise
    })
    hold = true
    const before = structuredClone(settings.get(ns))
    const args = method === 'saveCustomExpert' ? { expert: { ...draft, name: 'Cancelled new expert' }, enabled: true }
      : method === 'setEnabled' ? { enabled: [] }
        : method === 'saveTeam' ? { team: { ...team, name: 'Cancelled team edit' }, enabled: true }
          : { id: team.id, enabled: true }
    const controller = new AbortController()
    const pending = invoke(method, { ...args, expectedRevision: snapshot.revision }, controller.signal)
      .then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      const signal = await entered.promise
      controller.abort(new Error('Editor closed before commit'))
      expect(signal?.aborted).toBe(true)
      reading.resolve([])
      expect(await pending).toHaveProperty('error')
      expect(settings.get(ns)).toEqual(before)
      expect(settings.describe().find(item => item.ns === ns)?.revision).toBe(snapshot.revision)
    } finally {
      controller.abort()
      reading.resolve([])
      await pending
    }
  },
)

it('allows a dispatched Settings transaction to finish after its editor closes', async () => {
  const { invoke, settings, ns, snapshot } = await savedTeam()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const mutate = settings.mutate.bind(settings)
  const transaction = vi.spyOn(settings, 'mutate').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    await mutate(...args)
  })
  const controller = new AbortController()
  const pending = invoke('setEnabled', { enabled: [], expectedRevision: snapshot.revision }, controller.signal)
    .then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    await entered.promise
    controller.abort()
    release.resolve(undefined)
    expect(await pending).toHaveProperty('error')
    expect(settings.get(ns)).toMatchObject({ enabled: [] })
    expect(settings.describe().find(item => item.ns === ns)?.revision).toBe(snapshot.revision + 1)
  } finally {
    release.resolve(undefined)
    await pending
    transaction.mockRestore()
  }
})

it.each(['create-expert', 'edit-expert', 'delete-expert', 'save-team', 'enable-team', 'delete-team'] as const)(
  'returns the committed %s receipt when the company source becomes unavailable after persistence', async (operation) => {
    let unavailable = false
    const { invoke, settings, ns, snapshot, team } = await savedTeam(async () => {
      if (unavailable) throw new Error('Company catalog unavailable after commit')
      return []
    })
    const expert = (settings.get(ns) as AgencySettings).customExperts![0]
    const mutate = settings.mutate.bind(settings)
    const transaction = vi.spyOn(settings, 'mutate').mockImplementationOnce(async (...args) => {
      await mutate(...args)
      unavailable = true
    })
    onTestFinished(() => { transaction.mockRestore() })
    const method = operation === 'delete-expert' ? 'deleteCustomExpert'
      : operation === 'save-team' ? 'saveTeam' : operation === 'enable-team' ? 'setTeamEnabled'
        : operation === 'delete-team' ? 'deleteTeam' : 'saveCustomExpert'
    const args = operation === 'create-expert' ? { expert: { ...draft, name: 'New committed reviewer' }, enabled: true }
      : operation === 'edit-expert' ? { expert: { ...expert, name: 'Updated committed reviewer' }, enabled: true }
        : operation === 'delete-expert' ? { slug: expert.slug }
          : operation === 'save-team' ? { team: { ...team, name: 'Updated committed team' }, enabled: true }
            : operation === 'enable-team' ? { id: team.id, enabled: true } : { id: team.id }
    const result = await invoke(method, { ...args, expectedRevision: snapshot.revision })
    if (operation.endsWith('expert')) {
      const catalog = catalogSnapshotSchema.parse(result)
      expect(catalog.revision).toBe(snapshot.revision + 1)
      expect(catalog.experts.filter(item => item.custom)).toHaveLength(operation === 'create-expert' ? 3 : operation === 'delete-expert' ? 1 : 2)
      if (operation !== 'delete-expert') expect(catalog.experts.some(item => item.name === (operation === 'create-expert'
        ? 'New committed reviewer' : 'Updated committed reviewer') && catalog.enabled.includes(item.slug))).toBe(true)
      else expect(catalog.experts.some(item => item.slug === expert.slug)).toBe(false)
    } else {
      const teams = teamSnapshotSchema.parse(result)
      expect(teams.revision).toBe(snapshot.revision + 1)
      expect(teams.teams).toHaveLength(operation === 'delete-team' ? 0 : 1)
      expect(Object.keys(teams.nativeMembers ?? {})).toHaveLength(operation === 'delete-team' ? 0 : team.members.length)
      if (operation !== 'delete-team') {
        expect(teams.enabledTeams).toContain(team.id)
        expect(teams.enabledExperts).toEqual(expect.arrayContaining(team.members.map(member => member.expertSlug)))
      }
    }
    expect(settings.describe().find(item => item.ns === ns)?.revision).toBe(snapshot.revision + 1)
    await expect(invoke('getCatalog', { refreshCompany: false })).rejects.toThrow('Company catalog unavailable after commit')
  },
)

it.each(['deleteCustomExpert', 'deleteTeam'] as const)('rejects %s before committing if source preparation fails', async (method) => {
  let unavailable = false
  const { invoke, settings, ns, snapshot, team } = await savedTeam(async () => {
    if (unavailable) throw new Error('Company catalog unavailable before commit')
    return []
  })
  const before = structuredClone(settings.get(ns))
  const expert = (settings.get(ns) as AgencySettings).customExperts![0]
  unavailable = true
  await expect(invoke(method, { ...(method === 'deleteCustomExpert' ? { slug: expert.slug } : { id: team.id }),
    expectedRevision: snapshot.revision })).rejects.toThrow('Company catalog unavailable before commit')
  expect(settings.get(ns)).toEqual(before)
  expect(settings.describe().find(item => item.ns === ns)?.revision).toBe(snapshot.revision)
})

it.each(['saveCustomExpert', 'saveTeam', 'setEnabled'] as const)(
  'includes a neighboring committed transaction in the %s receipt', async (method) => {
    const { invoke, settings, ns, snapshot, team } = await savedTeam()
    const mutate = settings.mutate.bind(settings)
    const transaction = vi.spyOn(settings, 'mutate').mockImplementationOnce(async (...args) => {
      await mutate(...args)
      await invoke('saveCustomExpert', { expert: { ...draft, name: 'Neighboring reviewer' }, enabled: true,
        expectedRevision: snapshot.revision + 1 })
    })
    onTestFinished(() => { transaction.mockRestore() })
    const args = method === 'saveCustomExpert' ? { expert: { ...draft, name: 'First committed reviewer' }, enabled: true }
      : method === 'saveTeam' ? { team: { ...team, name: 'First committed team' }, enabled: true } : { enabled: [] }
    const result = await invoke(method, { ...args, expectedRevision: snapshot.revision })
    const state = settings.get(ns) as AgencySettings
    const neighbor = state.customExperts!.find(expert => expert.name === 'Neighboring reviewer')!
    expect(neighbor).toBeDefined()
    expect(settings.describe().find(item => item.ns === ns)?.revision).toBe(snapshot.revision + 2)
    if (method === 'saveCustomExpert') {
      const current = catalogSnapshotSchema.parse(result)
      expect(current.revision).toBe(snapshot.revision + 2)
      expect(current.experts.map(expert => expert.name)).toEqual(expect.arrayContaining(['First committed reviewer', neighbor.name]))
      expect(current.enabled).toEqual(state.enabled)
    } else if (method === 'saveTeam') {
      const current = teamSnapshotSchema.parse(result)
      expect(current.revision).toBe(snapshot.revision + 2)
      expect(current.teams[0].name).toBe('First committed team')
      expect(current.enabledExperts).toEqual(state.enabled)
      expect(current.enabledExperts).toContain(neighbor.slug)
    } else {
      expect(result).toEqual({ enabled: state.enabled, revision: snapshot.revision + 2 })
      expect(state.enabled).toContain(neighbor.slug)
    }
  },
)

it.each(['saveCustomExpert', 'saveTeam'] as const)('preserves the real Settings failure from %s without a success receipt', async (method) => {
  const { invoke, settings, ns, snapshot, team } = await savedTeam()
  const before = structuredClone(settings.get(ns))
  settings.fail = true
  await expect(invoke(method, { ...(method === 'saveCustomExpert' ? { expert: { ...draft, name: 'Uncommitted reviewer' }, enabled: true }
    : { team: { ...team, name: 'Uncommitted team' }, enabled: true }), expectedRevision: snapshot.revision })).rejects.toThrow('disk full')
  expect(settings.get(ns)).toEqual(before)
  expect(settings.describe().find(item => item.ns === ns)?.revision).toBe(snapshot.revision)
})
