/** 专家团选择复用原生引用和带修订号的正文插入，保留已有内容。 */
import type { ReferenceInsert, TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { teamText, type TeamLocale } from '../team-i18n.ts'
import type { ExpertTeam } from '../team-contract.ts'
import { confirmTeamAction } from './team-confirmation.tsx'
import { expertDetectText, insertExpertReference, type ReferenceInsertionTarget } from './index.ts'

/** 专家团在原生输入引用中的来源标识。 */
export const TEAM_REFERENCE_SOURCE = 'agency-agents:teams'

/**
 * 创建专家团的原生输入引用。
 * @param team - 要选择的专家团。
 * @param locale - 引用展示语言。
 * @returns 带团队标识与剪贴板文本的引用。
 */
export const teamReference = (team: ExpertTeam, locale: TeamLocale = 'zh'): ReferenceInsert => ({
  source: TEAM_REFERENCE_SOURCE,
  ref: team.id,
  label: team.name,
  clipboardText: teamText(locale, '@专家团：{0}\u00A0', [team.name]),
  appearance: 'session',
})

/**
 * 保留正文和附件，确认后替换唯一的团队引用，并在返回前追加已确认的示例。
 * @param target - 当前聊天的原生输入目标。
 * @param team - 要选择的专家团。
 * @param example - 用户选择的任务示例；已有正文时追加需要确认。
 * @param triggerSpan - 要替换的 @ 触发区间及草稿修订号。
 * @param locale - 确认与错误提示语言。
 * @param confirm - 异步确认；挂载方负责取消和核对当前输入目标。
 * @returns 是否已插入团队引用；示例失败时保留引用并通过目标报告错误。
 */
export async function insertTeamReference(
  target: ReferenceInsertionTarget | undefined,
  team: ExpertTeam,
  example?: string,
  triggerSpan?: TokenSpan,
  locale: TeamLocale = 'zh',
  confirm = confirmTeamAction,
): Promise<boolean> {
  const tx = (key: string, values?: readonly unknown[]) => teamText(locale, key, values)
  if (!target) return false
  const state = target.state.getSnapshot()
  const existing = (state.occurrences ?? []).filter(o => o.source === TEAM_REFERENCE_SOURCE)
  let span = triggerSpan
  if (existing.length) {
    if (triggerSpan) {
      target.notify?.('error', tx('草稿已有专家团，请先移除原团队再通过 @ 选择。'))
      return false
    }
    if (!await confirm(tx('草稿已有专家团，是否替换为当前团队？正文和附件将保留。'), locale)) return false
    const old = existing[0]
    const reduction = (state.occurrences ?? [])
      .filter(o => o.offset < old.offset)
      .reduce((n, o) => n + (o.length ?? 1) - 1, 0)
    span = {
      start: old.offset - reduction,
      end: old.offset - reduction + 1,
      draftRev: state.draftRev,
    }
  }
  const detect = expertDetectText(state)
  // 触发词会被标签替换，不属于用户任务正文。
  const body = (triggerSpan
    ? detect.slice(0, triggerSpan.start) + detect.slice(triggerSpan.end)
    : detect)
    .replace(/\uFFFC/gu, '')
    .trim()
  const append = example !== undefined && body !== ''
    && await confirm(tx('草稿已有正文，是否保留正文并追加所选示例？取消则仅选择团队。'), locale)
  // 确认窗口打开期间可能收到新的草稿，不能使用旧坐标覆盖用户输入。
  if (target.state.getSnapshot().draftRev !== state.draftRev) {
    target.notify?.('error', tx('草稿已变化，请重新选择专家团。'))
    return false
  }
  const selected = insertExpertReference(target, teamReference(team, locale),
    body === '' ? (example ?? team.examples[0]) : undefined, span, tx('专家团已选择，但示例填入失败，请补充任务。'))
  if (selected && append) {
    try {
      const current = target.state.getSnapshot()
      if (current.draftRev !== state.draftRev + 1) {
        target.notify?.('error', tx('示例追加失败，草稿已保留。'))
        return selected
      }
      const text = expertDetectText(current)
      if (!target.insertText?.(`\n\n${example}`, {
        start: text.length,
        end: text.length,
        draftRev: current.draftRev,
      })) target.notify?.('error', tx('示例追加失败，草稿已保留。'))
    } catch {
      target.notify?.('error', tx('示例追加失败，草稿已保留。'))
    }
  }
  return selected
}
