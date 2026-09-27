import { createSkillDownload } from './api'
import { installExtension } from './expertKits'
import { inspectGithubSkills, installGithubSkill } from './githubSkills'
import type { SkillView } from './skills'

export interface SkillCommandContext {
  skills: SkillView[]
  employeeId: string
  endpoint: string
  sessionToken: string
  assertActive: () => void
  refresh: () => Promise<void>
}

export async function localSkillCommand(context: SkillCommandContext, action: string, input: unknown): Promise<unknown> {
  context.assertActive()
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('技能参数必须是对象')
  const args = input as Record<string, unknown>
  if (action === 'search') {
    if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200)) throw new Error('搜索词不能超过 200 字')
    const query = String(args.query ?? '').trim().toLocaleLowerCase()
    const matches = context.skills.filter((skill) => [skill.id, skill.name, skill.summary, ...(skill.triggers ?? [])].join(' ').toLocaleLowerCase().includes(query))
    return { total: matches.length, skills: matches.slice(0, 50).map((skill) => ({
      id: skill.id, name: skill.name, summary: skill.summary, version: skill.version,
      installState: skill.installState, enabled: Boolean(skill.installed && skill.installed.enabled !== false),
      issues: [...skill.connectorIssues, ...skill.knowledgeIssues],
    })) }
  }
  if (action === 'inspect_github') {
    if (typeof args.sourceUrl !== 'string' || args.sourceUrl.length > 2000) throw new Error('GitHub 地址无效')
    const result = await inspectGithubSkills(args.sourceUrl)
    context.assertActive()
    return result
  }
  if (action !== 'install') throw new Error('不支持的技能操作')
  const catalog = typeof args.id === 'string' && args.id.length > 0
  const github = typeof args.archiveId === 'string' && typeof args.path === 'string'
  if (catalog === github || (catalog && ('archiveId' in args || 'path' in args)) || (github && 'id' in args)) throw new Error('请选择一种安装来源：企业技能 ID，或 GitHub 下载摘要和目录')
  let installed
  if (github) {
    installed = await installGithubSkill(args.archiveId as string, args.path as string)
  } else {
    const skill = context.skills.find((item) => item.id === args.id)
    if (!skill || skill.installState === 'retired' || skill.installState === 'incompatible') throw new Error('技能不在当前桌面版本可用目录中，请升级后重试')
    if (skill.installState === 'installed') return { id: skill.id, installed: true, enabled: skill.installed?.enabled !== false, changed: false }
    const download = await createSkillDownload(context.endpoint, skill.id, context.employeeId, context.sessionToken)
    context.assertActive()
    if (download.version !== skill.version || download.sha256 !== skill.sha256) throw new Error('技能目录已变化，请刷新后重试')
    installed = await installExtension(download, 'skill')
  }
  context.assertActive()
  await context.refresh()
  return { id: installed.manifest.id, name: installed.manifest.name, version: installed.manifest.version,
    installed: true, enabled: installed.enabled !== false, availableFrom: 'next-turn' }
}
