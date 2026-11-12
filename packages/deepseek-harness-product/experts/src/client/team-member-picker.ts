import { resolveContentCategory } from '@deepseek-harness/product/content-categories'

export type TeamMemberPickerStatus = '' | 'enabled' | 'disabled'

/** 个人组团只选独立专家；停用专家在「全部」和「已停用」里仍可加入。 */
export function filterTeamMemberCandidates<T extends {
  slug: string
  name: string
  nameEn: string
  description: string
  custom: boolean
  division: string
  conflict?: boolean
  teamMember?: boolean
}>(
  experts: readonly T[],
  options: {
    source: 'all' | 'company' | 'custom'
    division: string
    status: TeamMemberPickerStatus
    enabled: readonly string[]
    taken: readonly { expertSlug: string }[]
    replacing: number
    query: string
  },
): T[] {
  const enabled = new Set(options.enabled)
  const needle = options.query.trim().toLowerCase()
  return experts.filter((expert) => {
    if (expert.conflict || expert.teamMember) return false
    if (options.taken.some((member, index) => member.expertSlug === expert.slug && index !== options.replacing)) return false
    if (options.source !== 'all' && expert.custom !== (options.source === 'custom')) return false
    if (options.division !== '' && resolveContentCategory(expert.division).id !== resolveContentCategory(options.division).id) return false
    if (options.status === 'enabled' && !enabled.has(expert.slug)) return false
    if (options.status === 'disabled' && enabled.has(expert.slug)) return false
    if (needle !== '' && !`${expert.name} ${expert.nameEn} ${expert.description}`.toLowerCase().includes(needle)) return false
    return true
  })
}
