/** Team activation rejects incomplete fixed versions; editing can repair them without losing the team. */
import { expect, it, vi } from 'vitest'
import { agencySettingsSchema, validateAgencySettings, type AgencySettings } from '../src/expert-library.ts'
import { MemorySettings } from '../src/settings-memory.ts'
import { createTeamLibrary } from '../src/team-library.ts'
import { executeTeam } from '../src/team-runtime.ts'
import { TEST_TEAMS } from '../src/fixtures/teams.ts'
import type { ExpertTeam } from '../src/team-contract.ts'
import type { ExpertSummary } from '../src/expert-contract.ts'

const experts: ExpertSummary[] = TEST_TEAMS[0].members.map(member => ({
  slug: member.expertSlug, name: member.expertSlug, nameEn: member.expertSlug,
  description: '评审', descriptionEn: '', division: 'engineering', divisionZh: '研发', emoji: '🧩',
  custom: false, packageVersion: member.expertVersion, packageSha256: member.expertSha256,
}))

function fixture(team: ExpertTeam, currentExperts = experts) {
  const settings = new MemorySettings()
  settings.restore({ personal: { enabled: experts.map(expert => expert.slug), customTeams: [team], enabledTeams: [team.id] } })
  settings.register('personal', agencySettingsSchema, { validate: validateAgencySettings })
  const store = {
    read: () => settings.get('personal') as AgencySettings,
    revision: () => settings.describe()[0].revision,
    mutate: (ops, revision) => settings.mutate('personal', ops, revision),
  } satisfies Parameters<typeof createTeamLibrary>[1]
  const library = createTeamLibrary(async () => ({
    all: { experts: currentExperts, enabled: store.read().enabled, revision: store.revision() }, shared: [],
  }), store)
  return { library, store }
}

it.each(['missing-version', 'missing-digest', 'reselect-required'] as const)(
  'rejects activation of a %s team before changing settings or reading instructions, and permits repair', async (kind) => {
    const team = structuredClone(TEST_TEAMS[0])
    if (kind === 'missing-version') delete team.members[0].expertVersion
    else if (kind === 'missing-digest') delete team.members[0].expertSha256
    else team.members[0].expertVersion = 'reselect-required'
    const { library, store } = fixture(team)
    const before = store.read()
    await expect(library.setEnabled(team.id, true, 0)).rejects.toThrow('团队成员需要重新选择并保存。')
    expect(store.read()).toEqual(before)
    expect(store.revision()).toBe(0)
    const readPersona = vi.fn(async () => '说明'), run = vi.fn(async () => '结果')
    await expect(executeTeam({ team, experts, enabled: before.enabled, task: '只读评审', revision: 0, readPersona, run }))
      .rejects.toThrow('团队成员需要重新选择并保存。')
    expect(readPersona).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    const disabled = await library.setEnabled(team.id, false, 0)
    expect(disabled.enabledTeams).not.toContain(team.id)
    const repaired = await library.save(team, true, disabled.revision)
    expect(repaired.enabledTeams).toContain(team.id)
    expect(repaired.teams[0].members).toEqual(TEST_TEAMS[0].members)
  },
)

it('enables a complete pinned team without upgrading its members to the current catalog versions', async () => {
  const team = structuredClone(TEST_TEAMS[0])
  const { library } = fixture(team, experts.map(expert => ({ ...expert,
    packageVersion: '0.0.0-' + 'b'.repeat(56), packageSha256: 'b'.repeat(64),
  })))
  const enabled = await library.setEnabled(team.id, true, 0)
  expect(enabled.teams[0].members).toEqual(team.members)
})
