import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, it, onTestFinished } from 'vitest'
import { readCompanyTeams } from './company-teams.ts'
import { createTeamLibrary } from './team-library.ts'
import { createExpertLibrary, type AgencySettings } from './expert-library.ts'
import { resolveEnabledTeam } from './team-contract.ts'
import { executeTeam } from './team-runtime.ts'
import { publishedTeamDocument } from '@deepseek-harness/product/company-team'

let document: string
beforeAll(async () => { document = await readFile(new URL('../tests/fixtures/team.json', import.meta.url), 'utf8') })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'company-teams-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}
it('installs, restores and executes published teams with pinned personas after a release update', async () => {
  const root = await fixture(), signal = new AbortController().signal
  const old = { expertsRoot: join(root, 'first', 'experts') }
  await mkdir(join(root, 'first', 'teams'), { recursive: true })
  await writeFile(join(root, 'first', 'teams', 'orders.json'), document)
  const updated = document.replaceAll('固定成员说明', '新版成员说明')
  const latest = { expertsRoot: join(root, 'next', 'experts') }
  await mkdir(join(root, 'next', 'teams'), { recursive: true })
  await writeFile(join(root, 'next', 'teams', 'orders.json'), updated)
  const first = await readCompanyTeams(old.expertsRoot), next = await readCompanyTeams(latest.expertsRoot)
  expect(first.teams[0].id).toBe(next.teams[0].id)
  expect(first.experts.values().next().value?.prompt).toContain('固定成员说明')
  expect(next.experts.values().next().value?.prompt).toContain('新版成员说明')
  const experts = [...first.experts.values()]
  const result = await executeTeam({ team: first.teams[0], experts, enabled: experts.map(expert => expert.slug),
    task: '分析订单', revision: 0, signal, readPersona: async expert => first.experts.get(expert.slug)!.prompt,
    run: async (member) => { expect(member.persona).toContain('固定成员说明'); return '基于证据的结论' } })
  expect(JSON.stringify(result)).toContain('基于证据的结论')
})
it('exposes shared teams as read-only and enables all bundled members atomically', async () => {
  const root = await fixture(); await mkdir(join(root, 'teams'))
  await writeFile(join(root, 'teams/orders.json'), document)
  const shared = await readCompanyTeams(join(root, 'experts'))
  let state: AgencySettings = { enabled: [], customTeams: [] }, revision = 0
  const store = { read: () => state, revision: () => revision,
    mutate: async (ops: { path: readonly string[]; value?: unknown }[], expected: number) => {
      expect(expected).toBe(revision)
      state = { ...state, ...Object.fromEntries(ops.map(op => [op.path[0], op.value])) }; revision++
    } }
  const library = createTeamLibrary(async () => ({ experts: [...shared.experts.values()], enabled: state.enabled, revision }), store,
    () => 'zh', async (sessionId) => { expect(sessionId === undefined || sessionId === 'old-session').toBe(true); return shared.teams })
  expect((await library.snapshot('old-session')).teams[0].company).toBe(true)
  const enabled = await library.setEnabled(shared.teams[0].id, true, 0)
  expect(enabled.enabledExperts).toHaveLength(2)
  expect(state.customTeams).toEqual([])
  await expect(library.remove(shared.teams[0].id, 1)).rejects.toThrow('只能删除')
  await expect(library.save(shared.teams[0], true, 1)).rejects.toThrow()
  const duplicateNames = [...shared.experts.values(), { ...[...shared.experts.values()][0], slug: 'standalone', teamMember: false }]
  const experts = createExpertLibrary(async () => duplicateNames, store, ['operations'], () => 'zh')
  expect((await experts.catalog()).experts.some(expert => expert.conflict)).toBe(false)
})
it('rejects missing, duplicate or private-only member references before installing a team', async () => {
  const value = publishedTeamDocument(document)
  for (const corrupt of [ { ...value, experts: value.experts.slice(0, 1) },
    { ...value, experts: [value.experts[0], value.experts[0]] },
    { ...value, team: { ...value.team, members: [{ ...value.team.members[0], expertSlug: 'custom-private' }, value.team.members[1]] } },
    { ...value, ownerEmployeeId: 'spoofed' } ]) expect(() => publishedTeamDocument(JSON.stringify(corrupt))).toThrow()
})

it('rejects ambiguous names while an exact team ID remains selectable', async () => {
  const root = await fixture(); await mkdir(join(root, 'teams')); await writeFile(join(root, 'teams/orders.json'), document)
  const { teams } = await readCompanyTeams(join(root, 'experts'))
  const other = { ...teams[0], id: 'team-shared-second' }
  const snapshot = { teams: [...teams, other], enabledTeams: [teams[0].id, other.id], enabledExperts: [], revision: 0 }
  expect(() => resolveEnabledTeam(snapshot, teams[0].name, 'zh')).toThrow('同名')
  expect(resolveEnabledTeam(snapshot, other.id, 'zh')).toBe(other)
})
