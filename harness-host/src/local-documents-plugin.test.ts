import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Document, Packer, Paragraph } from 'docx'
import ExcelJS from 'exceljs'
import { zipSync, strToU8 } from 'fflate'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyDocuments, checkDocument, parseDocx, parsePdf, parsePptx, parseXlsx, renderPdf, renderPptx, selectPdfFont } from './local-documents-plugin.js'

const { Workbook } = ExcelJS

describe('local document formats', () => {
  it('formats a worksheet without changing formulas, preserves an undo backup and rejects invalid layout before writing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-sheet-layout-'))
    try {
      const tools = new Map<string, ToolDefinition>()
      await applyDocuments({ tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } }, effect() {} } as unknown as Context,
        { roots: [{ id: 'r', name: 'Test', path: directory }] })
      const exec = { signal: new AbortController().signal } as never
      const target = { rootId: 'r', path: 'layout.xlsx' }
      await tools.get('office_xlsx_create')!.execute({ ...target, sheets: [{ name: 'Summary', rows: [['中文说明', 'Amount'], ['长说明'.repeat(25), { formula: '1+2' }]] }] }, exec)
      const original = await readFile(join(directory, 'layout.xlsx'))
      const initial = new Workbook(); await initial.xlsx.load(original as never)
      expect(initial.worksheets[0].getColumn(1).width).toBe(60)
      const result = await tools.get('office_xlsx_format_sheet')!.execute({ ...target, sheet: 'Summary', columnWidths: [48, 20] }, exec) as { backupPath: string }
      expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result)
      expect(await readFile(join(directory, result.backupPath))).toEqual(original)
      const formatted = await readFile(join(directory, 'layout.xlsx'))
      const workbook = new Workbook(); await workbook.xlsx.load(formatted as never)
      const sheet = workbook.getWorksheet('Summary')!
      expect(sheet.getCell('B2').formula).toBe('1+2')
      expect(sheet.getCell('A2').alignment.wrapText).toBe(true)
      expect(sheet.getRow(2).height).toBeGreaterThan(30)
      expect(sheet.pageSetup).toMatchObject({ paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printArea: 'A1:B2' })
      await expect(tools.get('office_xlsx_format_sheet')!.execute({ ...target, sheet: 'Summary', columnWidths: [1] }, exec)).rejects.toThrow('columnWidths')
      expect(await readFile(join(directory, 'layout.xlsx'))).toEqual(formatted)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('returns lossless JSON for DOCX, PPTX and PDF verification instead of undefined format-specific fields', async () => {
    const files = [
      ['.docx', await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Report')] }] }))],
      ['.pptx', await renderPptx([{ title: 'Report', bullets: ['Revenue'] }], 'Report')],
      ['.pdf', await renderPdf('Report', ['Revenue'], undefined)],
    ] as const
    for (const [extension, bytes] of files) {
      const result = await checkDocument(bytes, extension)
      expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result)
      expect(result.status).toBe('structure_checked')
    }
  })

  it('extracts all rich-text runs and error values after an Office round trip', async () => {
    const workbook = new Workbook(), sheet = workbook.addWorksheet('Review')
    sheet.getCell('A1').value = { richText: [{ font: { bold: true }, text: '复核' }, { text: '：数量 12，金额 287.5' }] }
    sheet.getCell('B1').value = { error: '#REF!' }
    const result = await parseXlsx(Buffer.from(await workbook.xlsx.writeBuffer()))
    expect(result).toMatchObject({ sheets: [{ rows: [['复核：数量 12，金额 287.5', '#REF!']] }] })
    expect(JSON.stringify(result)).not.toContain('[object Object]')
  })

  it('materializes leading and interior blank cells into lossless JSON, including formula zero and false', async () => {
    const workbook = new Workbook(), sheet = workbook.addWorksheet('Sparse')
    sheet.getCell('B1').value = 'value'
    sheet.getCell('D1').value = { formula: '1-1', result: 0 }
    sheet.getCell('F1').value = { formula: '1>2', result: false }
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
    for (const complete of [false, true]) {
      const result = await parseXlsx(bytes, complete)
      expect(result).toMatchObject({ sheets: [{ rows: [['', 'value', '', '0', '', 'false']] }] })
      expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result)
    }
  })

  it('creates and edits real formula cells while keeping equals-prefixed text literal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-formulas-'))
    try {
      const tools = new Map<string, ToolDefinition>()
      await applyDocuments({ tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } }, effect() {} } as unknown as Context,
        { roots: [{ id: 'r', name: 'Test', path: directory }] })
      const exec = { signal: new AbortController().signal } as never
      const target = { rootId: 'r', path: 'formulas.xlsx' }
      await tools.get('office_xlsx_create')!.execute({ ...target, sheets: [{ name: 'Sales', rows: [[3, 12.5, { formula: '=A1*B1' }, '=literal']] }] }, exec)
      await tools.get('office_xlsx_append_rows')!.execute({ ...target, sheet: 'Sales', rows: [[2, 40, { formula: 'A2*B2' }]] }, exec)
      await tools.get('office_xlsx_add_sheet')!.execute({ ...target, sheet: 'Summary', rows: [[{ formula: 'SUM(Sales!C1:C2)' }]] }, exec)
      await tools.get('office_xlsx_update_cells')!.execute({ ...target, updates: [{ sheet: 'Sales', cell: 'C1', value: { formula: 'A1*B1+0' } }] }, exec)
      const bytes = await readFile(join(directory, 'formulas.xlsx'))
      const workbook = new Workbook(); await workbook.xlsx.load(bytes as never)
      const sales = workbook.getWorksheet('Sales')!
      expect(sales.getCell('C1').formula).toBe('A1*B1+0')
      expect(sales.getCell('C2').formula).toBe('A2*B2')
      expect(sales.getCell('C1').result).toBeUndefined()
      expect(sales.getCell('D1').value).toBe('=literal')
      expect(workbook.getWorksheet('Summary')!.getCell('A1').formula).toBe('SUM(Sales!C1:C2)')
      expect(await checkDocument(bytes, '.xlsx')).toMatchObject({ formulaCount: 3, issueCount: 3, status: 'needs_review' })
      for (const value of [{ formula: '=' }, { formula: '1+1', result: 999 }, { bogus: true }]) {
        await expect(tools.get('office_xlsx_update_cells')!.execute({ ...target, updates: [{ sheet: 'Sales', cell: 'C1', value }] }, exec)).rejects.toThrow('Cell must')
      }
      expect(await readFile(join(directory, 'formulas.xlsx'))).toEqual(bytes)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('reports missing formula results and cell errors without claiming recalculation', async () => {
    const workbook = new Workbook()
    const sheet = workbook.addWorksheet('汇总')
    sheet.getCell('A1').value = { formula: '1+1' }
    sheet.getCell('A2').value = { error: '#REF!' }
    sheet.getCell('A3').value = { formula: '1-1', result: 0 }
    const result = await checkDocument(Buffer.from(await workbook.xlsx.writeBuffer()), '.xlsx')
    expect(result).toMatchObject({ status: 'needs_review', issueCount: 2, formulaCount: 2 })
    expect(JSON.stringify(result)).toContain('未重新计算公式')
    expect(JSON.stringify(result)).toContain('A1')
    expect(JSON.stringify(result)).not.toContain('"cell":"A3"')
  })

  it('renders an actual PDF page through the registered visual tool', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-pdf-check-'))
    try {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(directory, 'report.pdf'), await renderPdf('Report', ['Checked page'], undefined))
      const tools = new Map<string, ToolDefinition>()
      let imageBytes = Buffer.alloc(0)
      const ctx = { tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => undefined } }, effect() {},
        attachments: { async saveImage(input: { data: Buffer }) { imageBytes = input.data; return { attachmentId: 'test-image' } } } } as unknown as Context
      await applyDocuments(ctx, { roots: [{ id: 'r', name: 'Test', path: directory }] })
      const value = await tools.get('office_pdf_page')!.execute({ rootId: 'r', path: 'report.pdf', page: 1 }, { signal: new AbortController().signal } as never)
      expect(value).toMatchObject({ page: 1, total: 1 })
      expect(imageBytes.subarray(1, 4).toString()).toBe('PNG')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('extracts text from DOCX', async () => {
    const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('inventory report')] }] }))
    await expect(parseDocx(bytes)).resolves.toMatchObject({ text: expect.stringContaining('inventory report') })
  })

  it('extracts bounded worksheet rows from XLSX', async () => {
    const workbook = new Workbook()
    workbook.addWorksheet('Orders').addRows([['sku', 'qty'], ['A-1', 8]])
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
    await expect(parseXlsx(bytes)).resolves.toMatchObject({
      sheets: [{ name: 'Orders', rows: [['sku', 'qty'], ['A-1', '8']] }],
    })
  })

  it('adds sheets and appends rows without rebuilding the workbook', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-office-'))
    try {
      const workbook = new Workbook()
      workbook.addWorksheet('Orders').addRows([['sku', 'qty'], ['A-1', 8]])
      await workbook.xlsx.writeFile(join(directory, 'report.xlsx'))
      const tools = new Map<string, ToolDefinition>()
      const context = {
        tools: { register(definition: ToolDefinition) { tools.set(definition.name, definition); return () => undefined } },
        effect() { return () => undefined },
      } as unknown as Context
      await applyDocuments(context, { roots: [{ id: 'reports', name: '报表', path: directory }] })
      const execution = { signal: new AbortController().signal } as never
      await tools.get('office_xlsx_append_rows')!.execute({ rootId: 'reports', path: 'report.xlsx', sheet: 'Orders', rows: [['B-2', 5]] }, execution)
      await tools.get('office_xlsx_add_sheet')!.execute({ rootId: 'reports', path: 'report.xlsx', sheet: 'Summary', rows: [['total'], [13]] }, execution)
      const parsed = await parseXlsx(await readFile(join(directory, 'report.xlsx')))
      expect(parsed).toMatchObject({ sheets: [
        { name: 'Orders', rows: [['sku', 'qty'], ['A-1', '8'], ['B-2', '5']] },
        { name: 'Summary', rows: [['total'], ['13']] },
      ] })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('creates a PDF that can be parsed again', async () => {
    const bytes = await renderPdf('Report', ['Total sales: 8'], undefined)
    await expect(parsePdf(bytes)).resolves.toMatchObject({
      pageCount: 1,
      text: expect.stringContaining('Total sales: 8'),
    })
  })

  it('extracts ordered slide text from PPTX', async () => {
    const bytes = Buffer.from(zipSync({
      'ppt/slides/slide2.xml': strToU8('<p:sld><a:t>Second &amp; final</a:t></p:sld>'),
      'ppt/slides/slide1.xml': strToU8('<p:sld><a:t>First slide</a:t></p:sld>'),
    }))
    await expect(parsePptx(bytes)).resolves.toMatchObject({
      slideCount: 2,
      slides: [{ slide: 1, text: 'First slide' }, { slide: 2, text: 'Second & final' }],
    })
  })

  it('creates an editable PPTX that can be parsed again', async () => {
    const bytes = await renderPptx([{ title: '库存周报', bullets: ['SKU-A 偏低', '建议补货'] }], '运营汇报')
    await expect(parsePptx(bytes)).resolves.toMatchObject({
      slideCount: 1,
      text: expect.stringContaining('库存周报'),
    })
  })

  it.skipIf(process.platform === 'linux')('creates Chinese PDFs with an installed system font', async () => {
    const font = await selectPdfFont('跨境电商库存')
    expect(font).toBeDefined()
    const bytes = await renderPdf('库存报告', ['可售库存：8'], font)
    await expect(parsePdf(bytes)).resolves.toMatchObject({ text: expect.stringContaining('可售库存：8') })
  })
})
