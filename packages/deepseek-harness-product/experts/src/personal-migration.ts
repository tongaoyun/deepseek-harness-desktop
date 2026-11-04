/** One-time conversion from editable Settings bodies into immutable AgentSpec files. */
import { customExpertInputSchema, customExpertSchema, type CustomExpert } from './expert-contract.ts'
import type { ExpertSettingsStore } from './expert-library.ts'
import { ExpertPackageStore } from './expert-packages.ts'

/** Stage all files before a revision-checked Settings commit; stale writes leave no partial references.
 * @param store - Employee-scoped native Settings adapter.
 * @param packages - Immutable personal package storage.
 */
export async function migratePersonalExperts(store: ExpertSettingsStore, packages: ExpertPackageStore): Promise<void> {
  const revision = store.revision(), state = store.read()
  const legacy = (state.customExperts ?? []).some(expert => 'prompt' in expert)
  const oldTeams = (state.customTeams ?? []).some(team => team.members.some(member => !member.expertVersion || !member.expertSha256))
  if (!legacy && !oldTeams) return
  const experts: CustomExpert[] = []
  for (const item of state.customExperts ?? []) {
    if (customExpertSchema.safeParse(item).success) { experts.push(customExpertSchema.parse(item)); continue }
    const value = customExpertInputSchema.parse(item)
    if (!value.slug) throw new Error('个人专家缺少标识，无法转换')
    const { prompt: _prompt, agents: _agents, manifest: _manifest, resources: _resources, ...metadata } = value
    experts.push(customExpertSchema.parse({ ...metadata, ...await packages.save(value.slug, value) }))
  }
  const teams = (state.customTeams ?? []).map(team => ({ ...team, members: team.members.map(member => {
    if (member.expertVersion && member.expertSha256) return member
    const expert = experts.find(expert => expert.slug === member.expertSlug)
    return expert ? { ...member, expertVersion: expert.packageVersion, expertSha256: expert.packageSha256 }
      : { ...member, expertVersion: 'reselect-required', expertSha256: '0'.repeat(64) }
  }) }))
  await store.mutate([{ op: 'set', path: ['customExperts'], value: experts }, { op: 'set', path: ['customTeams'], value: teams }], revision)
}
