import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-sdk-client'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { IMAGE_LIMITS } from './image-limits.js'

export async function mcpResultContent(result: CallToolResult, attachments: Pick<AttachmentStore, 'saveImage'>, connectorName: string, signal: AbortSignal): Promise<ContentBlock[]> {
  const images = result.content.flatMap((block) => {
    if (block.type === 'image') return [{ data: block.data, mediaType: block.mimeType }]
    if (block.type === 'resource' && 'blob' in block.resource && block.resource.mimeType?.startsWith('image/')) {
      return [{ data: block.resource.blob, mediaType: block.resource.mimeType }]
    }
    return []
  })
  const texts = result.content.flatMap((block) => block.type === 'text' ? [block.text] : block.type === 'resource_link' ? [`${block.name}: ${block.uri}`] : [])
  const value = result.structuredContent ?? (texts.length === 1 ? texts[0] : texts)
  if (!images.length) return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

  const content: ContentBlock[] = result.structuredContent === undefined ? [] : [{ type: 'text', text: JSON.stringify(result.structuredContent, null, 2) }]
  content.push(...texts.map((text): ContentBlock => ({ type: 'text', text })))
  for (const [index, image] of images.slice(0, IMAGE_LIMITS.maxImagesPerMessage).entries()) {
    signal.throwIfAborted()
    if (image.mediaType !== 'image/png' && image.mediaType !== 'image/jpeg') {
      content.push({ type: 'text', text: `第 ${index + 1} 张图片未预览：连接器图片仅支持 PNG、JPEG。` })
      continue
    }
    try {
      if (image.data.length > 4 * Math.ceil(IMAGE_LIMITS.maxImageBytes / 3)) throw new Error('Image payload too large')
      const data = Buffer.from(image.data, 'base64')
      if (!data.length || data.toString('base64') !== image.data) throw new Error('Invalid image payload')
      const attachment = await attachments.saveImage({
        data, mediaType: image.mediaType,
        name: `${connectorName} 图片 ${index + 1}.${image.mediaType === 'image/png' ? 'png' : 'jpg'}`,
      })
      signal.throwIfAborted()
      content.push({ type: 'image', attachment })
    } catch {
      signal.throwIfAborted()
      content.push({ type: 'text', text: `第 ${index + 1} 张图片未预览：图片无效、超出大小限制或本地保存失败。其他返回结果仍已保留。` })
    }
  }
  if (images.length > IMAGE_LIMITS.maxImagesPerMessage) content.push({ type: 'text', text: `本次返回 ${images.length} 张图片，仅处理前 ${IMAGE_LIMITS.maxImagesPerMessage} 张；其余图片需分批获取。` })
  return content
}
