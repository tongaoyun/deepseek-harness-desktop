import { expect, it } from 'vitest'
import { Document, Packer, Paragraph } from 'docx'
import ExcelJS from 'exceljs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply, parsePdf, renderPptx } from './local-documents-plugin.js'
import { convertOffice, findOfficeEngine, officeEngineCandidates, officeFontConfig, runOffice } from './office-conversion.js'

const engine = await findOfficeEngine()
const signal = () => new AbortController().signal
it('scopes font discovery to an escaped private configuration without changing process settings', () => {
  const previous = process.env.FONTCONFIG_FILE
  const config = officeFontConfig('/Users/Test & Team', '/private/tmp/test<cache>')
  expect(config).toContain('<dir>/Users/Test &amp; Team/Library/Fonts</dir>')
  expect(config).toContain('<cachedir>/private/tmp/test&lt;cache&gt;</cachedir>')
  expect(config).toContain('/System/Library/Fonts')
  expect(process.env.FONTCONFIG_FILE).toBe(previous)
})
it.skipIf(!engine.available || process.platform !== 'darwin')('exports distinct Chinese glyphs and complete text through macOS headless LibreOffice', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('销售汇总')
  sheet.getCell('A1').value = '中文月份 数量 合计 287.5'
  sheet.getColumn(1).width = 45
  const pdf = await convertOffice(Buffer.from(await workbook.xlsx.writeBuffer()), '.xlsx', 'pdf', signal())
  expect(await parsePdf(pdf)).toMatchObject({ text: expect.stringContaining('中文月份 数量 合计 287.5') })
}, 120_000)
it('discovers standard and per-user macOS installations without shell startup files', () => {
  expect(officeEngineCandidates({ HOME: '/Users/test', PATH: '/usr/bin:.:/usr/bin' }, 'darwin')).toEqual([
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/Users/test/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
  ])
})
it('uses Windows paths and checks both standard installation directories', () => {
  expect(officeEngineCandidates({ ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', PATH: 'D:\\Office;.;D:\\Office' }, 'win32')).toEqual([
    'C:\\Program Files\\LibreOffice\\program\\soffice.com', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com', 'D:\\Office\\soffice.com',
  ])
})
it('honors an explicit path exclusively and rejects relative executable paths', () => {
  expect(officeEngineCandidates({ XIAOYIN_SOFFICE_PATH: ' /custom/soffice ', PATH: '/usr/bin' }, 'darwin')).toEqual(['/custom/soffice'])
  expect(officeEngineCandidates({ XIAOYIN_SOFFICE_PATH: './soffice', PATH: '/usr/bin' }, 'darwin')).toEqual([])
})
it.skipIf(!engine.available)('completes native formula creation, reading, recalculation and follow-up modification', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-office-lifecycle-'))
  try {
    const tools = new Map<string, ToolDefinition>()
    await apply({ tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } }, effect() {} } as unknown as Context,
      { roots: [{ id: 'r', name: 'Test', path: directory }] })
    const run = async (name: string, args: object) => {
      const result = await tools.get(name)!.execute({ rootId: 'r', ...args }, { signal: signal() } as never)
      expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result)
      return result
    }
    await run('office_xlsx_create', { path: 'sales.xlsx', sheets: [{ name: 'Sales', rows: [
      ['quantity', 'unitPrice', 'amount'], [3, 12.5, { formula: 'A2*B2' }], [2, 40, { formula: 'A3*B3' }],
      [4, 12.5, { formula: 'A4*B4' }], [{ formula: 'SUM(A2:A4)' }, null, { formula: 'SUM(C2:C4)' }],
    ] }] })
    const initial = await readFile(join(directory, 'sales.xlsx'))
    const read = await run('office_document_read', { path: 'sales.xlsx' })
    expect(JSON.parse(JSON.stringify(read))).toStrictEqual(read)
    await run('office_xlsx_recalculate', { path: 'sales.xlsx', outputPath: 'checked.xlsx' })
    const checked = new ExcelJS.Workbook(); await checked.xlsx.readFile(join(directory, 'checked.xlsx'))
    expect(checked.getWorksheet('Sales')!.getCell('C5').result).toBe(167.5)
    expect(await readFile(join(directory, 'sales.xlsx'))).toEqual(initial)
    await run('office_xlsx_update_cells', { path: 'sales.xlsx', updates: [{ sheet: 'Sales', cell: 'A3', value: 5 }] })
    await run('office_xlsx_recalculate', { path: 'sales.xlsx', outputPath: 'revised.xlsx' })
    const revised = new ExcelJS.Workbook(); await revised.xlsx.readFile(join(directory, 'revised.xlsx'))
    expect(revised.getWorksheet('Sales')!.getCell('A5').result).toBe(12)
    expect(revised.getWorksheet('Sales')!.getCell('C5').result).toBe(287.5)
    expect(revised.getWorksheet('Sales')!.getCell('C3').formula).toBe('A3*B3')
    await run('office_document_export_pdf', { path: 'revised.xlsx', outputPath: 'revised.pdf' })
    expect(await parsePdf(await readFile(join(directory, 'revised.pdf')))).toMatchObject({ text: expect.stringContaining('287.5') })
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 120_000)

it('reports unavailable explicit engines without falling back to another installation', async () => {
  expect(await findOfficeEngine({ XIAOYIN_SOFFICE_PATH: '/missing/xiaoyin-test/soffice' })).toMatchObject({ available: false })
})
it('rejects macros and external workbooks before conversion', async () => {
  for (const path of ['xl/vbaProject.bin', 'xl/externalLinks/externalLink1.xml']) {
    const bytes = Buffer.from(zipSync({ [path]: strToU8('test') }))
    await expect(convertOffice(bytes, '.xlsx', 'recalculate', signal())).rejects.toThrow('人工处理')
  }
})
it('does not treat a zero exit code without output as successful conversion', async () => {
  const bytes = Buffer.from(zipSync({ 'word/document.xml': strToU8('test') }))
  await expect(convertOffice(bytes, '.docx', 'pdf', signal(), { executable: '/fake', runner: async () => {} })).rejects.toThrow('没有生成结果')
})
it('cancels and times out a process without waiting for completion', async () => {
  const abort = new AbortController()
  const pending = runOffice(process.execPath, ['-e', 'setInterval(()=>{},1000)'], abort.signal)
  abort.abort()
  await expect(pending).rejects.toThrow('停止')
  await expect(runOffice(process.execPath, ['-e', 'setInterval(()=>{},1000)'], signal(), 50)).rejects.toThrow('超时')
})
it.skipIf(!engine.available)('recalculates stale and missing cached formula results through real LibreOffice', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Summary')
  sheet.getCell('A1').value = 7; sheet.getCell('A2').value = 5
  sheet.getCell('B1').value = { formula: 'SUM(A1:A2)', result: 999 }
  sheet.getCell('B2').value = { formula: 'A1-A1' }
  sheet.getCell('B3').value = { formula: 'A1<A2' }
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
  const result = await convertOffice(bytes, '.xlsx', 'recalculate', signal())
  const recalculated = new ExcelJS.Workbook(); await recalculated.xlsx.load(result as never)
  expect(recalculated.worksheets[0]!.getCell('B1').result).toBe(12)
  expect(recalculated.worksheets[0]!.getCell('B2').result).toBe(0)
  expect(recalculated.worksheets[0]!.getCell('B3').result).toBe(false)
  const original = new ExcelJS.Workbook(); await original.xlsx.load(bytes as never)
  expect(original.worksheets[0]!.getCell('B1').result).toBe(999)
}, 120_000)
it.skipIf(!engine.available)('exports real DOCX and PPTX files into readable PDFs', async () => {
  const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('OFFICE_EXPORT_OK')] }] }))
  const pptx = await renderPptx([{ title: 'PRESENTATION_EXPORT_OK', bullets: ['Revenue: 12'] }], 'Report')
  for (const [bytes, extension, text] of [[docx, '.docx', 'OFFICE_EXPORT_OK'], [pptx, '.pptx', 'PRESENTATION_EXPORT_OK']] as const) {
    const output = await convertOffice(bytes, extension, 'pdf', signal())
    expect(await parsePdf(output)).toMatchObject({ pageCount: 1, text: expect.stringContaining(text) })
  }
}, 120_000)
it.skipIf(!engine.available)('registers the converted copy with an actual hash while preserving source and existing outputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-office-receipt-'))
  try {
    const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('DELIVERY_OK')] }] }))
    await writeFile(join(directory, 'original.docx'), bytes)
    const tools = new Map<string, ToolDefinition>()
    const ctx = { tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } }, effect() {} } as unknown as Context
    await apply(ctx, { roots: [{ id: 'work', name: 'Test', path: directory }] })
    const tool = tools.get('office_document_export_pdf')!
    const args = { rootId: 'work', path: 'original.docx', outputPath: 'copy.pdf' }
    const result = await tool.execute(args, { signal: signal() } as never)
    expect(result).toMatchObject({ path: 'copy.pdf', originalUnchanged: true, afterHash: expect.stringMatching(/^[a-f0-9]{64}$/), verification: { status: 'structure_checked' } })
    expect(await readFile(join(directory, 'original.docx'))).toEqual(bytes)
    await expect(tool.execute(args, { signal: signal() } as never)).rejects.toThrow('目标文件已存在')
    const readOnly = new Map<string, ToolDefinition>()
    await apply({ tools: { register(tool: ToolDefinition) { readOnly.set(tool.name, tool); return () => {} } }, effect() {} } as unknown as Context, { roots: [{ id: 'work', name: 'Test', path: directory }], readOnly: true })
    expect(readOnly.has('office_document_export_pdf')).toBe(false)
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 120_000)
