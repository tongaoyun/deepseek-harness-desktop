import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { publishedTeamDocument } from '@deepseek-harness/product/company-team'
import type { ExpertTeam } from './team-contract.ts'
import type { ExpertSummary } from './expert-contract.ts'
import { ZH_DIVISION } from './names.ts'

/** Team documents and members are read from the same immutable, main-verified release. */
export async function readCompanyTeams(expertsRoot: string): Promise<{
  teams: ExpertTeam[]; experts: Map<string, ExpertSummary & { prompt: string }>
}> {
  const root = join(expertsRoot, '..', 'teams')
  let names: string[]
  try { names = await readdir(root) }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { teams: [], experts: new Map() }; throw error }
  const teams: ExpertTeam[] = [], experts = new Map<string, ExpertSummary & { prompt: string }>()
  for (const name of names.sort()) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/u.test(name)) throw new Error('专家团文件名无效')
    const key = name.slice(0, -5), value = publishedTeamDocument(await readFile(join(root, name), 'utf8'))
    const slug = (member: string) => `team-${key}-${member}`
    teams.push({ ...value.team, id: `team-shared-${key}`, company: true,
      members: value.team.members.map(member => ({ ...member, expertSlug: slug(member.expertSlug) })) })
    for (const expert of value.experts) experts.set(slug(expert.key), { slug: slug(expert.key),
      name: expert.name, nameEn: expert.name, description: expert.description, descriptionEn: '',
      emoji: expert.emoji, division: expert.division, divisionZh: ZH_DIVISION[expert.division] ?? expert.division,
      company: true, teamMember: true, custom: false, prompt: expert.prompt })
  }
  return { teams, experts }
}
