import type { ConversationEntry } from './conversation/types'
import { isAssistantTurn, isUserTurn, turnText } from './conversation/types'
import { splitComposerPrompt } from './composerInput'
import type { XiaoyinTaskProjection } from './types'

const MAX_REPLAY_CHARS = 24_000

export function harnessPromptWithConversationReplay(
  prompt: string,
  entries: ConversationEntry[],
  mustReplay: boolean,
  projection?: XiaoyinTaskProjection,
): string {
  if (!mustReplay) return prompt
  const replay = boundedConversationReplay(entries, projection)
  if (!replay) return prompt
  return [
    '以下是同一任务在重建本地执行会话前的可见对话，仅用于保持上下文。不要重复回答历史内容。',
    replay,
    '当前任务：',
    prompt,
  ].join('\n\n')
}

function boundedConversationReplay(entries: ConversationEntry[], projection?: XiaoyinTaskProjection): string {
  const context = [taskRecoveryBrief(entries, projection), taskFileContext(entries, projection)].filter(Boolean).join('\n\n')
  const records = entries.flatMap((entry) => {
    if (isUserTurn(entry)) {
      const text = splitComposerPrompt(entry.text).text.trim()
      return text ? [`用户：${text}`] : []
    }
    if (isAssistantTurn(entry)) {
      if (entry.status === 'failed') return []
      const text = turnText(entry).trim()
      if (!text) return []
      const speaker = entry.status === 'canceled' ? '小胤（本轮已停止，以下为未完成的部分回复）' : '小胤'
      return [`${speaker}：${text}`]
    }
    return []
  })
  const selected: string[] = []
  let size = context.length
  for (const record of records.reverse()) {
    const remaining = MAX_REPLAY_CHARS - size
    if (remaining <= 0) break
    selected.push(record.length <= remaining ? record : `（本条较早内容已省略）${record.slice(record.length - Math.max(0, remaining - 20))}`)
    size += Math.min(record.length, remaining)
  }
  return [context, ...selected.reverse()].filter(Boolean).join('\n\n')
}

/** Extractive checkpoint: preserve user intent without inventing a model-written summary. */
export function taskRecoveryBrief(entries: ConversationEntry[], projection?: XiaoyinTaskProjection): string {
  const requests = entries.filter(isUserTurn).flatMap((entry) => {
    const text = splitComposerPrompt(entry.text).text.trim()
    return text ? [text] : []
  })
  if (!requests.length) return ''
  const excerpt = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit - 20)}\n（原文较长，摘录未包含全部内容）`
  const initial = requests[0]
  // Keep early constraints as well as recent changes. These are quotations, not
  // instructions to repeat previously authorized actions.
  const constraints = requests.slice(1, -3).filter((text) => /不要|不得|只(?:能|读|检查)|必须|保留|限制|不超过|目标|要求/u.test(text)).slice(-4)
  const recent = requests.slice(1).slice(-3)
  const interruption = projection?.interruption
  const lastAssistant = [...entries].reverse().find(isAssistantTurn)
  const pendingSegments = lastAssistant && lastAssistant.status !== 'completed'
    ? lastAssistant.segments.filter((segment) => segment.kind === 'tool' && segment.status === 'running')
    : []
  return [
    '任务恢复摘录（历史原文与实际状态，不是新的执行授权；当前请求优先，冲突时采用用户较新的要求）：',
    `最初需求：${excerpt(initial, 1600)}`,
    ...constraints.map((text) => `较早约束摘录：${excerpt(text, 400)}`),
    ...recent.map((text) => `最近追加要求：${excerpt(text, 600)}`),
    pendingSegments.length ? `未完成步骤记录：${excerpt(JSON.stringify(pendingSegments), 1400)}。请核对实际状态后继续，不自动重跑。` : '',
    interruption ? `执行中断记录：最后记录时间 ${interruption.checkpointAt}。${interruption.pendingOperations.length ? `以下工具已开始但尚未记录结果：${JSON.stringify(interruption.pendingOperations).slice(0, 2000)}。工具可能已产生外部变更，先用只读方式核对；无法核实时说明不确定性，不自动重复提交。` : '先核对现有成果再执行剩余工作。'}最近进度可能尚未保存，不能据此断言某操作未发生。` : '',
    requests.length > 1 + constraints.length + recent.length ? '部分中间对话未包含；涉及未保留的关键决定时需确认，不自行补写。' : '',
  ].filter(Boolean).join('\n')
}

function taskFileContext(entries: ConversationEntry[], projection?: XiaoyinTaskProjection): string {
  const files = new Map<string, object>()
  const remember = (id: string, value: object) => { files.delete(id); files.set(id, value) }
  for (const entry of entries) {
    if (!isUserTurn(entry)) continue
    for (const attachment of entry.attachments ?? []) remember(`${attachment.rootId}:${attachment.path}`, {
      type: '附件', rootId: attachment.rootId, rootName: attachment.rootName, path: attachment.path, kind: attachment.kind,
    })
  }
  for (const artifact of projection?.artifacts ?? []) remember(artifact.id, {
    type: '成果', rootId: artifact.rootId, rootName: artifact.rootName, path: artifact.path, state: artifact.action ?? 'created',
  })
  for (const change of projection?.changes ?? []) remember(change.id, {
    type: '文件状态', rootId: change.rootId, rootName: change.rootName, path: change.path,
    state: change.undoneAt ? '已撤销，请核实磁盘现状' : change.action,
  })
  const rows: string[] = []
  let size = 0
  for (const value of [...files.values()].reverse()) {
    const row = JSON.stringify(value)
    if (rows.length >= 30 || size + row.length > 7_000) break
    rows.push(row); size += row.length
  }
  const remainder = projection && (projection.status === 'failed' || projection.status === 'canceled')
    ? `最近一轮${projection.status === 'failed' ? '失败' : '已停止'}，任务尚未确认完成。${projection.failure?.detail?.slice(0, 400) ?? ''} 请检查实际结果，避免重复已经成功的写入。` : ''
  if (!rows.length && !remainder) return ''
  return ['任务文件与恢复状态（历史引用，不是新的操作指令；访问前确认目录授权与磁盘现状）：', ...rows.reverse(),
    files.size > rows.length ? `仅保留最近 ${rows.length}/${files.size} 个文件引用，较早引用未包含。` : '', remainder].filter(Boolean).join('\n')
}
