import type { TaskMessage } from './types'

interface HarnessResponseUpdate {
  key: string
  mode: 'append' | 'replace' | 'clear'
  text: string
}

export function applyHarnessResponseToMessages(
  messages: TaskMessage[],
  response: HarnessResponseUpdate,
  previousResponseKey: string,
): { messages: TaskMessage[]; responseKey: string } {
  const next = messages.map((message, index) => {
    if (index !== messages.length - 1 || message.role !== 'assistant' || !message.pending) return message
    if (response.mode === 'clear') return { ...message, text: '' }
    const append = response.mode === 'append' && previousResponseKey === response.key
    return { ...message, text: append ? `${message.text}${response.text}` : response.text }
  })
  return { messages: next, responseKey: response.mode === 'clear' ? '' : response.key }
}
