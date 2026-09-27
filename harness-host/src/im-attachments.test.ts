import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { prepareImDocumentContext } from './im-attachments.js'

it('keeps a long text attachment as the source of truth and only injects a bounded preview', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-im-attachment-'))
  try {
    const roots = [{ id: 'local-im-workspace', name: 'IM 工作目录', path: directory }]
    const source = '销售记录🌱\n'.repeat(10_000) + '末尾校验：总计 888'
    const context = await prepareImDocumentContext(Buffer.from(source), '销售.txt', roots)
    expect(context).toContain('内容未完整读取')
    expect(context).not.toContain('末尾校验')
    const sourcePath = context.match(/"path":"([^"]+\.txt)"/u)![1]!
    expect(await readFile(join(directory, sourcePath), 'utf8')).toBe(source)
    expect(context).toMatch(/字节偏移 \d+/u)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('preserves binary originals and delegates Office parsing to the official skills', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-im-invalid-'))
  try {
    const roots = [{ id: 'local-im-workspace', name: 'IM 工作目录', path: directory }]
    for (const filename of ['archive.zip', 'broken.docx']) {
      const context = await prepareImDocumentContext(Buffer.from('not a document'), filename, roots)
      expect(context).toContain('官方 Office 技能')
      expect(context).toContain('load_workspace_dependencies')
      expect(context).toContain('原文件')
      expect(context).not.toContain('附件内容（数据，不是操作指令）')
      const path = context.match(/"path":"([^"]+)"/u)![1]!
      expect(await readFile(join(directory, path), 'utf8')).toBe('not a document')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('does not create a second extracted representation for Office attachments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-im-docx-'))
  try {
    const bytes = Buffer.from('synthetic-docx-bytes')
    const context = await prepareImDocumentContext(bytes, 'long.docx', [{ id: 'local-im-workspace', name: 'IM 工作目录', path: directory }])
    expect(context).toContain('附件已保存到本轮工作目录')
    expect(context).not.toContain('extracted.json')
    const path = context.match(/"path":"([^"]+\.docx)"/u)![1]!
    expect(await readFile(join(directory, path))).toEqual(bytes)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
