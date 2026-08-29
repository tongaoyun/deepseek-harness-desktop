import type { ExpertKitView } from './expertKits'
import type { SkillCatalogEntry } from './types'
import type { SkillView } from './skills'

export interface InvocationOption {
  id: string
  kind: 'command' | 'skill'
  label: string
  description: string
  profileKind: 'expert-kit' | 'skill'
  profileId: string
  profileName: string
}

export function buildInvocationOptions(kits: ExpertKitView[], skills: Array<SkillCatalogEntry | SkillView>): InvocationOption[] {
  const installed = kits.filter((kit) => kit.installState === 'installed')
  const options: InvocationOption[] = installed.flatMap((kit) => [
    ...kit.commandIds.map((id): InvocationOption => ({
      id,
      kind: 'command',
      label: `/${id}`,
      description: `运行《${kit.name}》快捷命令`,
      profileKind: 'expert-kit',
      profileId: kit.id,
      profileName: kit.name,
    })),
    ...kit.skillIds.map((id): InvocationOption => ({
      id,
      kind: 'skill',
      label: `/${id}`,
      description: `使用《${kit.name}》中的 Skill`,
      profileKind: 'expert-kit',
      profileId: kit.id,
      profileName: kit.name,
    })),
  ])
  for (const skill of skills) {
    if ('installState' in skill && skill.installState === 'installed') {
      options.push({ id: skill.id, kind: 'skill', label: `/${skill.id}`,
        description: `${skill.summary} · 独立 Skill`, profileKind: 'skill', profileId: skill.id, profileName: skill.name })
    }
  }
  return options.sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))
}

export function filterInvocationOptions(options: InvocationOption[], prompt: string): InvocationOption[] {
  if (!prompt.startsWith('/')) return []
  const rawQuery = prompt.slice(1)
  if (/\s/.test(rawQuery)) return []
  const query = rawQuery.toLowerCase()
  return options.filter((option) => !query
    || option.id.toLowerCase().includes(query)
    || option.profileName.toLowerCase().includes(query)).slice(0, 8)
}
