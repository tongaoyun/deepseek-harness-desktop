import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Document, Packer, Paragraph } from 'docx'
import ExcelJS from 'exceljs'
import { zipSync, strToU8 } from 'fflate'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyDocuments, parseDocx, parsePdf, parsePptx, parseXlsx, renderPdf, renderPptx, selectPdfFont } from './local-documents-plugin.js'

const { Workbook } = ExcelJS

describe('local document formats', () => {
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
