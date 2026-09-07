import type { MemoryEntry, MemoryProfile } from './memory'

export function normalizeMemory(text: string): string {
  return text.toLowerCase().replace(/^(请|帮我)?(记住|以后请|今后请|默认请|以后都|我偏好|我的偏好是)/, '').replace(/[\s，。；：、,.!！?？:;]+/g, '')
}

const families = [
  [['美元', '美金', 'usd'], ['人民币', 'cny', 'rmb'], ['欧元', 'eur']],
  [['中文', '汉语'], ['英文', '英语', 'english'], ['日语', '日文']],
]
export function relatedMemories(entries: MemoryEntry[], text: string, excludeId?: string): MemoryEntry[] {
  const normalized = normalizeMemory(text)
  if (!normalized) return []
  return entries.filter((entry) => {
    if (entry.id === excludeId) return false
    const other = normalizeMemory(entry.text)
    if (normalized === other) return true
    if (Math.min(normalized.length, other.length) >= 4 && (normalized.includes(other) || other.includes(normalized))) return true
    return families.some((family) => {
      const matches = (value: string) => family.filter((terms) => terms.some((term) => value.includes(term)))
      return matches(normalized).length === 1 && matches(other).length === 1
        && /默认|以后|今后|偏好|习惯|统一/.test(text + entry.text)
    })
  })
}

export function findMemoryCandidates(profile: MemoryProfile, query: string, taskId: string): MemoryEntry[] {
  const entries = profile.entries ?? []
  if (/^(刚才那条|刚才的记忆|刚才说的|这个|这条|这条记忆|它)$/.test(query)) return entries.filter((entry) => entry.taskId === taskId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5)
  const normalized = normalizeMemory(query)
  if (normalized.length < 2) return []
  const exact = entries.filter((entry) => normalizeMemory(entry.text) === normalized)
  if (exact.length) return exact
  const terms = new Set(Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2)))
  return entries.map((entry) => {
    const text = normalizeMemory(entry.text)
    return { entry, score: text.includes(normalized) ? 10 : [...terms].filter((term) => text.includes(term)).length / terms.size }
  }).filter(({ score }) => score >= .5).sort((a, b) => b.score - a.score).slice(0, 5).map(({ entry }) => entry)
}
