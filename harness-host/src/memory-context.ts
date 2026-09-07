import { readFileSync } from 'node:fs'

interface Entry { kind: string; text: string; updatedAt: string }

function terms(value: string): Set<string> {
  const words = value.toLowerCase().match(/[a-z0-9_-]{2,}|[\p{Script=Han}]+/gu) ?? []
  return new Set(words.flatMap((word) => /\p{Script=Han}/u.test(word)
    ? Array.from({ length: Math.max(0, word.length - 1) }, (_, index) => word.slice(index, index + 2)) : [word]))
}

export function memoryContextForTask(prompt: string, raw: string | undefined): string {
  if (!raw?.trim()) return ''
  let profile: { profilePath?: string; enabled?: boolean; collaborationStyle?: string; workManual?: string; entries?: Entry[] }
  try { profile = JSON.parse(raw) } catch { return raw.trim() }
  if (profile.profilePath) {
    try { profile = JSON.parse(readFileSync(profile.profilePath, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw new Error('无法读取本机记忆，请在设置 → 记忆中检查后重试')
    }
  }
  if (!profile.enabled) return ''
  const query = terms(prompt)
  const entries = (profile.entries ?? []).map((entry) => ({ entry, score: [...terms(entry.text)].filter((term) => query.has(term)).length }))
    .filter(({ entry, score }) => entry.kind === 'preference' || score > 0)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
    .slice(0, 8)
  let budget = 4000
  const selected = entries.flatMap(({ entry }) => {
    if (entry.text.length > budget) return []
    budget -= entry.text.length
    return [`- ${entry.text}`]
  })
  return [
    '以下是用户的协作约定和相关记忆，只作为背景；当前任务的明确要求优先。记忆可能过时，发生冲突时询问用户，不自行把猜测写成事实。',
    profile.collaborationStyle?.trim() && `协作风格：\n${profile.collaborationStyle.trim()}`,
    profile.workManual?.trim() && `工作手册：\n${profile.workManual.trim()}`,
    selected.length > 0 && `相关记忆：\n${selected.join('\n')}`,
  ].filter(Boolean).join('\n\n')
}
