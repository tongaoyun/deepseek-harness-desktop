// @vitest-environment jsdom
/** Company-team copies save through native Remote with public expert identities. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Access from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import { installCompanyIndex } from '../../../desktop/src/company-content.ts'
import { contentIndex, encoded, expertFiles, versionRef } from '../../../product/tests/content-fixtures.ts'
import { publishedTeamDocument } from '@deepseek-harness/product/company-team'
import { readCompanyTeams } from '../../src/company-teams.ts'
import { readPackageCatalog } from '../../src/package-catalog.ts'
import { AGENCY_LIBRARY_SERVICE, agencySettingsSchema, createExpertLibrary, type AgencySettings } from '../../src/expert-library.ts'
import { AGENCY_TEAM_SERVICE, createTeamLibrary } from '../../src/team-library.ts'
import { catalogSnapshotSchema } from '../../src/expert-contract.ts'
import { teamSnapshotSchema } from '../../src/team-contract.ts'
import { MemorySettings } from '../../src/settings-memory.ts'
import Remote from '../../src/remote.ts'
import { createExpertClientState } from '../../src/client/client-state.ts'
import { TeamsPanel, type TeamRemote } from '../../src/client/team-ui.tsx'

afterEach(cleanup)

it.each(['unchanged', 'updated', 'conflicted'] as const)('handles a company-team copy when the member catalog is %s', async (catalogState) => {
  const root = await mkdtemp(join(tmpdir(), 'company-team-copy-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const document = publishedTeamDocument(await readFile(join(process.cwd(), 'packages/deepseek-harness-product/experts/tests/fixtures/team.json'), 'utf8'))
  const payloads = new Map<string, Record<string, string>>()
  const experts = document.team.members.map((member) => {
    const files = expertFiles(member.expertSlug), ref = versionRef('experts/' + member.expertSlug, files)
    payloads.set(ref.sha256, files)
    member.expertVersion = ref.version
    member.expertSha256 = ref.sha256
    return ref
  })
  const teamFiles = { 'teams/orders.json': encoded(JSON.stringify(document)) }
  const team = versionRef('teams/orders', teamFiles, Object.fromEntries(experts.map(ref => [ref.resourceKey, ref.sha256])))
  payloads.set(team.sha256, teamFiles)
  const content = { document, payloads, index: contentIndex('1.0.0', [...experts, team], experts) }
  const files = expertFiles('member-1', 'Updated member instructions')
  const next = versionRef('experts/member-1', files)
  content.payloads.set(next.sha256, files)
  const index = catalogState === 'updated' ? contentIndex('2.0.0', content.index.resources.map(ref => ref.resourceKey === next.resourceKey ? next : ref), content.index.dependencies) : content.index
  const signal = new AbortController().signal
  const installed = await installCompanyIndex(join(root, 'cache'), 'employee', index,
    async ref => ({ ...ref, files: content.payloads.get(ref.sha256) }), signal)
  const shared = await readCompanyTeams(installed.expertsRoot)
  const standalone = [...(await readPackageCatalog(installed.expertsRoot)).values()].map(expert => ({ ...expert, company: true }))
  const source = shared.teams[0]
  const before = structuredClone(source)
  const settings = new MemorySettings()
  settings.register('agency-agents', agencySettingsSchema)
  const store = {
    read: () => settings.get('agency-agents') as AgencySettings,
    revision: () => settings.describe().find(value => value.ns === 'agency-agents')!.revision,
    mutate: (ops, revision) => settings.mutate('agency-agents', ops, revision),
  } satisfies Parameters<typeof createExpertLibrary>[1]
  const available = catalogState === 'conflicted' ? standalone.map(expert => ({ ...expert, name: standalone[0].name, nameEn: standalone[0].nameEn })) : standalone
  const library = createExpertLibrary(async () => [...available, ...shared.experts.values()], store, ['specialized'], () => 'zh')
  const teams = createTeamLibrary(async (_session, active) => ({ all: await library.catalog(active), shared: shared.teams }), store)
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, typert: Typert, gateway: Gateway, access: Access, remote: Remote,
    library: { apply(scope: Context) {
      scope.reflect.provide('settings', settings)
      scope.reflect.provide(AGENCY_LIBRARY_SERVICE, library)
      scope.reflect.provide(AGENCY_TEAM_SERVICE, teams)
    } } })
  const config = join(root, 'cordis.yml')
  await writeFile(config, ['library', 'typert', 'access', 'gateway', 'remote'].map(name => `- name: 'cordis:${name}'`).join('\n') + '\n')
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const invoke = (method: string, args: Record<string, unknown>, active?: AbortSignal) =>
    ctx.typertGateway.invoke({ namespace: 'agencyAgents', method, args, peer, signal: active })
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected Remote operation'))
  const remote: TeamRemote = {
    getCatalog: async (refreshCompany, active) => ({ ok: true, value: catalogSnapshotSchema.parse(await invoke('getCatalog', { refreshCompany }, active)) }),
    getTeams: async active => ({ ok: true, value: teamSnapshotSchema.parse(await invoke('getTeams', {}, active)) }),
    saveTeam: async (team, enabled, expectedRevision, active) => ({ ok: true,
      value: teamSnapshotSchema.parse(await invoke('saveTeam', { team, enabled, expectedRevision }, active)) }),
    importExpert: unused, exportExpert: unused, getCustomExpert: unused, saveCustomExpert: unused, deleteCustomExpert: unused,
    exportTeam: unused, deleteTeam: unused, setTeamEnabled: unused,
  }
  const cache = createExpertClientState(remote)
  onTestFinished(() => { cache.catalog.dispose(); cache.teams.dispose() })
  await act(async () => { render(<TeamsPanel cache={cache} remote={remote} source="company" />) })
  fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '复制并自定义' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
  if (catalogState === 'conflicted') {
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect((await teams.snapshot()).teams).toEqual([source])
    expect(settings.disk).toEqual({})
    expect(source).toEqual(before)
    expect(screen.getByRole('alert').textContent).toMatchInlineSnapshot('"团队成员已删除或名称冲突，请替换后重试。"')
    return
  }
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  const saved = (await teams.snapshot()).teams.find(team => !team.company)
  expect(saved?.members).toEqual(content.document.team.members.map((member) => {
    const expert = standalone.find(expert => expert.slug === member.expertSlug)!
    return { ...member, expertVersion: expert.packageVersion, expertSha256: expert.packageSha256 }
  }))
  expect(source).toEqual(before)
  expect({ name: saved?.name, members: saved?.members.map(member => member.expertSlug),
    originalMembersUnchanged: JSON.stringify(source.members) === JSON.stringify(before.members),
    updatedVersionSelected: saved?.members[0]?.expertSha256 === next.sha256,
    notice: screen.getByRole('status').textContent }).toMatchSnapshot()
})
