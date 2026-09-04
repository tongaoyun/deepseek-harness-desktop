import type { TaskMessage } from './types'

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
  const entries = messages.flatMap((message) => {
    if (message.pending || !message.text.trim()) return []
    if (message.role === 'assistant' && ['failed', 'canceled'].includes(message.monitor?.status ?? '')) return []
    return [`${message.role === 'user' ? '用户' : '小胤'}：${message.text.trim()}`]
  })
  const selected: string[] = []
  let size = 0
  for (const entry of entries.reverse()) {
    const remaining = MAX_REPLAY_CHARS - size
    if (remaining <= 0) break
    selected.push(entry.length <= remaining ? entry : entry.slice(entry.length - remaining))
    size += Math.min(entry.length, remaining)
  }
  return selected.reverse().join('\n\n')
}
