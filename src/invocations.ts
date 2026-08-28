import type { ExpertKitView } from './expertKits'
import type { SkillCatalogEntry } from './types'

export interface InvocationOption {
  id: string
  kind: 'command' | 'skill'
  label: string
  description: string
  expertKitId: string
  expertKitName: string
}

export function buildInvocationOptions(kits: ExpertKitView[], skills: SkillCatalogEntry[]): InvocationOption[] {
  const installed = kits.filter((kit) => kit.installState === 'installed')
  const options: InvocationOption[] = installed.flatMap((kit) => kit.commandIds.map((id): InvocationOption => ({
    id,
    kind: 'command' as const,
    label: `/${id}`,
    description: `运行《${kit.name}》快捷命令`,
    expertKitId: kit.id,
    expertKitName: kit.name,
  })))
  for (const skill of skills) {
    const kit = installed.find((item) => item.id === skill.sourceKitId
      || item.skillIds.includes(skill.id))
    if (!kit) continue
    options.push({
      id: skill.id,
      kind: 'skill',
      label: `/${skill.id}`,
      description: `${skill.summary} · Skill`,
      expertKitId: kit.id,
      expertKitName: kit.name,
    })
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
    || option.expertKitName.toLowerCase().includes(query)).slice(0, 8)
}
