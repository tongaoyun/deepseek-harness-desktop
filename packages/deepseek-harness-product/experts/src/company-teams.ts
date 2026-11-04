import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { publishedTeamDocument } from '@deepseek-harness/product/company-team'
import type { ExpertTeam } from './team-contract.ts'
import type { ExpertSummary } from './expert-contract.ts'
import { readPackageCatalog, readPackagePrompt } from './package-catalog.ts'

/** Team documents and members are read from the same immutable, main-verified release. */
export async function readCompanyTeams(expertsRoot: string): Promise<{
  teams: ExpertTeam[]; experts: Map<string, ExpertSummary & { prompt: string }>
}> {
  const root = join(expertsRoot, '..', 'teams')
  let names: string[]
  try { names = await readdir(root) }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { teams: [], experts: new Map() }; throw error }
  const teams: ExpertTeam[] = [], experts = new Map<string, ExpertSummary & { prompt: string }>()
  const catalog = await readPackageCatalog(expertsRoot)
  for (const name of names.sort()) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/u.test(name)) throw new Error('专家团文件名无效')
    const key = name.slice(0, -5), value = publishedTeamDocument(await readFile(join(root, name), 'utf8'))
    const slug = (member: string) => `team-member-${createHash('sha256').update(JSON.stringify([key, member])).digest('hex')}`
    teams.push({ ...value.team, id: `team-shared-${key}`, company: true,
      members: value.team.members.map(member => ({ ...member, expertSlug: slug(member.expertSlug) })) })
    for (const member of value.team.members) {
      const packageRoot = join(expertsRoot, '..', 'expert-versions', member.expertSlug, member.expertSha256)
      const expert = catalog.get(member.expertSlug)
      if (!expert) throw new Error('专家团成员需要重新选择')
      experts.set(slug(member.expertSlug), { ...expert, slug: slug(member.expertSlug), company: true, teamMember: true,
        packageVersion: member.expertVersion, packageSha256: member.expertSha256, ...(await readPackagePrompt(packageRoot)) })
    }
  }
  return { teams, experts }
}
