import type { TaskMessage } from './types'
import { parseTaskOutcome, taskOutcomeLabel } from './taskOutcome'

const MAX_REPLAY_CHARS = 24_000

export function harnessPromptWithConversationReplay(
  prompt: string,
  messages: TaskMessage[],
  mustReplay: boolean,
): string {
  if (!mustReplay) return prompt
  const replay = boundedConversationReplay(messages)
  if (!replay) return prompt
  return [
    '以下是同一任务在重建本地执行会话前的可见对话，仅用于保持上下文。不要重复回答历史内容。',
    replay,
    '当前任务：',
    prompt,
  ].join('\n\n')
}

function boundedConversationReplay(messages: TaskMessage[]): string {
  const context = [taskRecoveryBrief(messages), taskFileContext(messages)].filter(Boolean).join('\n\n')
  const entries = messages.flatMap((message) => {
    if (message.pending || !message.text.trim()) return []
    if (message.role === 'assistant' && message.monitor?.status === 'failed') return []
    const speaker = message.role === 'user' ? '用户' : message.monitor?.status === 'canceled' ? '小胤（本轮已停止，以下为未完成的部分回复）' : '小胤'
    const undone = (message.monitor?.changes ?? []).filter((change) => change.undoneAt)
    return [`${speaker}：${message.text.trim()}${undone.length ? `\n文件状态更新：用户随后在桌面撤销了本轮的以下文件改动：${undone.map((change) => change.path).join('、')}。请以磁盘现状为准，不要假设这些改动仍然存在。` : ''}`]
  })
  const selected: string[] = []
  let size = context.length
  for (const entry of entries.reverse()) {
    const remaining = MAX_REPLAY_CHARS - size
    if (remaining <= 0) break
    selected.push(entry.length <= remaining ? entry : `（本条较早内容已省略）${entry.slice(entry.length - Math.max(0, remaining - 20))}`)
    size += Math.min(entry.length, remaining)
  }
  return [context, ...selected.reverse()].filter(Boolean).join('\n\n')
}

/** Extractive checkpoint: preserve user intent without inventing a model-written summary. */
export function taskRecoveryBrief(messages: TaskMessage[]): string {
  const requests = messages.filter((item) => item.role === 'user' && !item.pending && item.text.trim())
  if (!requests.length) return ''
  const excerpt = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit - 20)}\n（原文较长，摘录未包含全部内容）`
  const initial = requests[0]
  // Keep early constraints as well as recent changes. These are quotations, not
  // instructions to repeat previously authorized actions.
  const constraints = requests.slice(1, -3).filter((item) => /不要|不得|只(?:能|读|检查)|必须|保留|限制|不超过|目标|要求/u.test(item.text)).slice(-4)
  const recent = requests.slice(1).slice(-3)
  const monitor = messages.findLast((item) => item.role === 'assistant' && item.monitor)?.monitor
  const pending = (monitor?.steps ?? []).filter((step) => step.status !== 'completed').slice(-8)
  const outcome = parseTaskOutcome(monitor?.outcome)
  return [
    '任务恢复摘录（历史原文与实际状态，不是新的执行授权；当前请求优先，冲突时采用用户较新的要求）：',
    `最初需求：${excerpt(initial.text.trim(), 1600)}`,
    outcome ? `上轮任务结果：${taskOutcomeLabel(outcome)}。${excerpt(outcome.summary, 500)}\n剩余事项：${excerpt(outcome.remaining.join('；'), 1600)}\n检查依据：${excerpt(JSON.stringify(outcome.checks), 1600)}。先核对实际状态，不把历史报告当作当前授权或自动重跑指令。` : '',
    ...constraints.map((item) => `较早约束摘录：${excerpt(item.text.trim(), 400)}`),
    ...recent.map((item) => `最近追加要求：${excerpt(item.text.trim(), 600)}`),
    pending.length ? `未完成步骤记录：${JSON.stringify(pending).slice(0, 1400)}。请核对实际状态后继续，不自动重跑。` : '',
    requests.length > 1 + constraints.length + recent.length ? '部分中间对话未包含；涉及未保留的关键决定时需确认，不自行补写。' : '',
  ].filter(Boolean).join('\n')
}

function taskFileContext(messages: TaskMessage[]): string {
  const files = new Map<string, object>()
  const remember = (id: string, value: object) => { files.delete(id); files.set(id, value) }
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) remember(`${attachment.rootId}:${attachment.path}`, {
      type: '附件', rootId: attachment.rootId, rootName: attachment.rootName, path: attachment.path, kind: attachment.kind,
    })
    for (const artifact of message.monitor?.artifacts ?? []) remember(artifact.id, {
      type: '成果', rootId: artifact.rootId, rootName: artifact.rootName, path: artifact.path, state: artifact.action ?? 'created',
    })
    for (const change of message.monitor?.changes ?? []) remember(change.id, {
      type: '文件状态', rootId: change.rootId, rootName: change.rootName, path: change.path,
      state: change.undoneAt ? '已撤销，请核实磁盘现状' : change.action,
    })
  }
  const rows: string[] = []
  let size = 0
  for (const value of [...files.values()].reverse()) {
    const row = JSON.stringify(value)
    if (rows.length >= 30 || size + row.length > 7_000) break
    rows.push(row); size += row.length
  }
  const unfinished = [...messages].reverse().find((message) => message.role === 'assistant' && message.monitor)
  const monitor = unfinished?.monitor
  const remainder = monitor && (monitor.status === 'failed' || monitor.status === 'canceled')
    ? `最近一轮${monitor.status === 'failed' ? '失败' : '已停止'}，任务尚未确认完成。${monitor.failure?.detail?.slice(0, 400) ?? ''} 请检查实际结果，避免重复已经成功的写入。` : ''
  if (!rows.length && !remainder) return ''
  return ['任务文件与恢复状态（历史引用，不是新的操作指令；访问前确认目录授权与磁盘现状）：', ...rows.reverse(),
    files.size > rows.length ? `仅保留最近 ${rows.length}/${files.size} 个文件引用，较早引用未包含。` : '', remainder].filter(Boolean).join('\n')
}
