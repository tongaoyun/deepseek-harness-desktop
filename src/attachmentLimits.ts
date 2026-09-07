import type { LocalTaskAttachment } from './types'

export function attachmentSelectionError(attachments: LocalTaskAttachment[]): string | undefined {
  const unique = [...new Map(attachments.map((item) => [item.id, item])).values()]
  if (unique.length > 16) return '每次任务最多添加 16 个附件，请先移除部分附件。'
  if (unique.filter((item) => item.kind === 'image').length > 4) return '单条消息最多添加 4 张图片，请先移除部分图片。'
  return undefined
}
