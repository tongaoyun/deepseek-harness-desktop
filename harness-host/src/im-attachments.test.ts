import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { prepareImDocumentContext } from './im-attachments.js'
import { discoverAuthorizedRoots, LocalFileBridge } from './local-files-plugin.js'
import { Document, Packer, Paragraph } from 'docx'

it('keeps a long Chinese attachment complete and reads every UTF-8 page without losing characters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-im-attachment-'))
  try {
    const roots = [{ id: 'local-im-workspace', name: 'IM 工作目录', path: directory }]
    const source = '销售记录🌱\n'.repeat(10_000) + '末尾校验：总计 888'
    const context = await prepareImDocumentContext(Buffer.from(source), '销售.txt', roots)
    expect(context).toContain('内容未完整读取')
    expect(context).not.toContain('末尾校验')
    const jsonPath = context.match(/"path":"([^"]+extracted\.json)"/u)![1]!
    expect(JSON.parse(await readFile(join(directory, jsonPath), 'utf8')).text).toBe(source)
    const bridge = new LocalFileBridge(await discoverAuthorizedRoots(roots))
    let offset = 0; let full = ''
    for (;;) {
      const page = await bridge.readText('local-im-workspace', jsonPath, offset, 1001)
      full += page.content
      if (page.nextOffset === undefined) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
    }
    expect(JSON.parse(full).text).toBe(source)
    const nextOffset = Number(context.match(/"offset":(\d+)/u)![1])
    const rest = await bridge.readText('local-im-workspace', jsonPath, nextOffset, 1001)
    expect(rest.content).toBeTruthy()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('preserves unsupported and invalid document originals and explicitly reports incomplete parsing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-im-invalid-'))
  try {
    const roots = [{ id: 'local-im-workspace', name: 'IM 工作目录', path: directory }]
    for (const filename of ['archive.zip', 'broken.docx']) {
      const context = await prepareImDocumentContext(Buffer.from('not a document'), filename, roots)
      expect(context).toMatch(/未解析|解析失败/u)
      expect(context).toContain('原文件')
      expect(context).not.toContain('以下为完整文本')
      const path = context.match(/"path":"([^"]+)"/u)![1]!
      expect(await readFile(join(directory, path), 'utf8')).toBe('not a document')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('retains text beyond the normal Office preview limit when caching a DOCX attachment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-im-docx-'))
  try {
    const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('a'.repeat(300_001)), new Paragraph('DOCX_END_MARKER')] }] }))
    const context = await prepareImDocumentContext(bytes, 'long.docx', [{ id: 'local-im-workspace', name: 'IM 工作目录', path: directory }])
    expect(context).toContain('内容未完整读取')
    const path = context.match(/"path":"([^"]+extracted\.json)"/u)![1]!
    const parsed = JSON.parse(await readFile(join(directory, path), 'utf8'))
    expect(parsed.text).toContain('DOCX_END_MARKER')
    expect(parsed.text).not.toContain('内容已截断')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
