import { describe, expect, it } from 'vitest'
import { Document, Packer, Paragraph } from 'docx'
import ExcelJS from 'exceljs'
import { zipSync, strToU8 } from 'fflate'
import { parseDocx, parsePdf, parsePptx, parseXlsx, renderPdf, selectPdfFont } from './local-documents-plugin.js'

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

  it.skipIf(process.platform === 'linux')('creates Chinese PDFs with an installed system font', async () => {
    const font = await selectPdfFont('跨境电商库存')
    expect(font).toBeDefined()
    const bytes = await renderPdf('库存报告', ['可售库存：8'], font)
    await expect(parsePdf(bytes)).resolves.toMatchObject({ text: expect.stringContaining('可售库存：8') })
  })
})
