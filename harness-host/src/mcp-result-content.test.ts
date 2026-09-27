import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { mcpResultContent } from './mcp-result-content.js'
import { IMAGE_LIMITS } from './image-limits.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const image = { type: 'image' as const, mimeType: 'image/png', data: png }
const signal = () => new AbortController().signal

it('persists MCP images and embedded resources with durable references alongside structured data and captions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-mcp-images-'))
  try {
    const store = new LocalAttachmentStore(new Context(), { dshHome: directory })
    const content = await mcpResultContent({ structuredContent: { completed: true }, content: [
      { type: 'text', text: '生成结果' }, image,
      { type: 'resource', resource: { uri: 'resource://poster', mimeType: 'image/png', blob: png } },
    ] }, store, '设计', signal())
    expect(content.slice(0, 2)).toEqual([{ type: 'text', text: '{\n  "completed": true\n}' }, { type: 'text', text: '生成结果' }])
    const images = content.filter((block) => block.type === 'image')
    expect(images).toHaveLength(2)
    for (const block of images) {
      expect(block.attachment).toMatchObject({ width: 1, height: 1 })
      expect(['image/png', 'image/jpeg', 'image/webp']).toContain(block.attachment.mediaType)
      expect(block.attachment.attachmentId).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(await readFile(store.imageHostPath(block.attachment))).toEqual(Buffer.from((await store.readImage(block.attachment)).data))
    }
    expect(JSON.stringify(content)).not.toContain(png)
    const restored = new LocalAttachmentStore(new Context(), { dshHome: directory })
    expect(Buffer.from((await restored.readImage(images[0].attachment)).data)).toEqual(Buffer.from((await store.readImage(images[0].attachment)).data))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('keeps text results unchanged and does not download resource links', async () => {
  const attachments = { saveImage: vi.fn() }
  for (const [result, expected] of [
    [{ content: [{ type: 'text', text: 'done' }] }, 'done'],
    [{ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, '[\n  "a",\n  "b"\n]'],
    [{ structuredContent: { count: 2 }, content: [{ type: 'text', text: 'summary' }] }, '{\n  "count": 2\n}'],
  ] as Array<[CallToolResult, string]>) {
    expect(await mcpResultContent(result, attachments, '工具', signal())).toEqual([{ type: 'text', text: expected }])
  }
  expect(await mcpResultContent({ content: [{ type: 'resource_link', uri: 'https://example.com/image.png', name: '图片' }] }, attachments, '工具', signal())).toEqual([{ type: 'text', text: '图片: https://example.com/image.png' }])
  expect(attachments.saveImage).not.toHaveBeenCalled()
})

it('isolates invalid images and reports unsupported formats and extra images without exposing base64', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-mcp-invalid-'))
  try {
    const store = new LocalAttachmentStore(new Context(), { dshHome: directory })
    const content = await mcpResultContent({ content: [
      { type: 'text', text: '业务处理完成' }, { ...image, data: 'not-base64' }, { ...image, mimeType: 'image/webp' }, image,
      { ...image, data: Buffer.from('bad PNG').toString('base64') }, image,
    ] }, store, '设计', signal())
    expect(content.filter((block) => block.type === 'image')).toHaveLength(1)
    const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    expect(text).toContain('业务处理完成')
    expect(text).toContain('第 1 张图片未预览')
    expect(text).toContain('第 2 张图片未预览')
    expect(text).toContain('第 4 张图片未预览')
    expect(text).toContain('仅处理前 4 张')
    expect(JSON.stringify(content)).not.toContain('not-base64')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('bounds base64 input and observes cancellation before and after attachment storage', async () => {
  const saveImage = vi.fn()
  const content = await mcpResultContent({ content: [{ ...image, data: 'a'.repeat(4 * Math.ceil(IMAGE_LIMITS.maxImageBytes / 3) + 4) }] }, { saveImage }, '工具', signal())
  expect(saveImage).not.toHaveBeenCalled()
  expect(content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('未预览') })])
  const controller = new AbortController()
  controller.abort()
  await expect(mcpResultContent({ content: [image] }, { saveImage }, '工具', controller.signal)).rejects.toThrow()
  const inFlight = new AbortController()
  saveImage.mockImplementationOnce(() => { inFlight.abort(); throw new Error('aborted') })
  await expect(mcpResultContent({ content: [image] }, { saveImage }, '工具', inFlight.signal)).rejects.toThrow()
})
