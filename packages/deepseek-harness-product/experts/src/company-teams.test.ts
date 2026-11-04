import { teamFixture, contentIndex, encoded, expertFiles, versionRef } from '../../product/tests/content-fixtures.ts'
import { installCompanyIndex } from '../../desktop/src/company-content.ts'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, beforeAll } from 'vitest'
import { readCompanyTeams } from './company-teams.ts'
import { createTeamLibrary } from './team-library.ts'
import { createExpertLibrary, type AgencySettings } from './expert-library.ts'
import { resolveEnabledTeam, teamSnapshotSchema } from './team-contract.ts'
import { executeTeam } from './team-runtime.ts'
import { publishedTeamDocument } from '@deepseek-harness/product/company-team'

let document: string
beforeAll(async () => {
  document = await readFile(new URL('../tests/fixtures/team.json', import.meta.url), 'utf8')
})
async function fixture(instructions = '固定成员说明') {
  const root = await mkdtemp(join(tmpdir(), 'company-teams-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const value = await teamFixture('1.0.0', instructions)
  return await installCompanyIndex(root, 'employee', value.index, async ref => ({ ...ref, files: value.payloads.get(ref.sha256) }), new AbortController().signal)
}
it('installs, restores and executes published teams with pinned personas after a release update', async () => {
  const old = await fixture(), latest = await fixture('新版成员说明'), signal = new AbortController().signal
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
it.each([
  { name: 'hyphenated identifiers', pairs: [['a-b', 'c'], ['a', 'b-c']] },
  { name: 'maximum-length identifiers', pairs: [['a'.repeat(80), 'b'.repeat(80)], ['c'.repeat(80), 'd'.repeat(80)]] },
])('keeps team member identities distinct and executable for $name', async ({ pairs }) => {
  const root = await mkdtemp(join(tmpdir(), 'company-team-identities-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const payloads = new Map<string, Record<string, string>>()
  const memberIds = [...pairs.map(([, member]) => member!), 'reviewer']
  const experts = memberIds.map(id => {
    const files = expertFiles(id, `Instructions for ${id}`), ref = versionRef(`experts/${id}`, files)
    payloads.set(ref.sha256, files)
    return ref
  })
  const teams = pairs.map(([id, member], index) => {
    const team = publishedTeamDocument(document)
    team.id = id!
    const members = [experts[index]!, experts[2]!]
    team.team.members = team.team.members.map((value, i) => ({ ...value,
      expertSlug: i === 0 ? member! : 'reviewer', expertVersion: members[i]!.version, expertSha256: members[i]!.sha256 }))
    const files = { [`teams/${id}.json`]: encoded(JSON.stringify(team)) }
    const ref = versionRef(`teams/${id}`, files, Object.fromEntries(members.map(ref => [ref.resourceKey, ref.sha256])))
    payloads.set(ref.sha256, files)
    return ref
  })
  const signal = new AbortController().signal
  const installed = await installCompanyIndex(root, 'employee', contentIndex('1.0.0', [...experts, ...teams], experts),
    async ref => ({ ...ref, files: payloads.get(ref.sha256) }), signal)
  const result = await readCompanyTeams(installed.expertsRoot)
  expect(result.experts.size).toBe(4)
  expect(teamSnapshotSchema.safeParse({ teams: result.teams, enabledTeams: [], enabledExperts: [], revision: 0 }).success).toBe(true)
  for (const [index, [id, member]] of pairs.entries()) {
    const team = result.teams.find(value => value.id === `team-shared-${id}`)!
    const expert = result.experts.get(team.members[0]!.expertSlug)!
    expect(expert.packageSha256).toBe(experts[index]!.sha256)
    expect(expert.prompt).toContain(`Instructions for ${member}`)
    const execution = await executeTeam({ team, experts: [...result.experts.values()], enabled: team.members.map(value => value.expertSlug),
      task: 'Review orders', revision: 0, signal, readPersona: async expert => result.experts.get(expert.slug)!.prompt,
      run: async value => {
        expect(value.persona).toContain(value.slug === expert.slug ? `Instructions for ${member}` : 'Instructions for reviewer')
        return 'Reviewed'
      } })
    expect(execution.coverage.status).toBe('complete')
  }
})
it('exposes shared teams as read-only and enables all bundled members atomically', async () => {
  const root = await fixture()
  const shared = await readCompanyTeams(root.expertsRoot)
  let state: AgencySettings = { enabled: [], customTeams: [] }, revision = 0
  const store = { read: () => state, revision: () => revision,
    mutate: async (ops: { path: readonly string[]; value?: unknown }[], expected: number) => {
      expect(expected).toBe(revision)
      state = { ...state, ...Object.fromEntries(ops.map(op => [op.path[0], op.value])) }; revision++
    } }
  const library = createTeamLibrary(async (sessionId) => {
    expect(sessionId === undefined || sessionId === 'old-session').toBe(true)
    return { all: { experts: [...shared.experts.values()], enabled: state.enabled, revision }, shared: shared.teams }
  }, store)
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
it('rejects embedded personas, duplicate members and unknown document fields', () => {
  const value = publishedTeamDocument(document)
  for (const corrupt of [{ ...value, experts: [] },
    { ...value, team: { ...value.team, members: [value.team.members[0], value.team.members[0]] } },
    { ...value, ownerEmployeeId: 'spoofed' }]) expect(() => publishedTeamDocument(JSON.stringify(corrupt))).toThrow()
})

it('rejects ambiguous names while an exact team ID remains selectable', async () => {
  const root = await fixture()
  const { teams } = await readCompanyTeams(root.expertsRoot)
  const other = { ...teams[0], id: 'team-shared-second' }
  const snapshot = { teams: [...teams, other], enabledTeams: [teams[0].id, other.id], enabledExperts: [], revision: 0 }
  expect(() => resolveEnabledTeam(snapshot, teams[0].name, 'zh')).toThrow('同名')
  expect(resolveEnabledTeam(snapshot, other.id, 'zh')).toBe(other)
})
