// Synthetic indexing fixtures, never business documents. Prints a manifest path for
// xiaoyin-server/scripts/verify-knowledge-runtime.mjs (XIAOYIN_KNOWLEDGE_FIXTURES).
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../harness-host/package.json', import.meta.url))
const { Document, Packer, Paragraph } = require('docx')
const ExcelJS = require('exceljs')
const folder = await mkdtemp(join(tmpdir(), 'xiaoyin-knowledge-acceptance-'))
const fixtures = []
const policy = '差旅报销规定：合成验收员工每天住宿上限为 800 元，必须保留发票。'
const docxPath = join(folder, '差旅规定.docx')
await writeFile(docxPath, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('知识库合成验收'), new Paragraph(policy)] }] })))
fixtures.push({ path: docxPath, filename: '差旅规定.docx', query: '差旅报销规定', locator: '正文', expected: '800' })
const workbook = new ExcelJS.Workbook()
const sheet = workbook.addWorksheet('销售汇总')
sheet.getCell('A1').value = '合成验收销售额'
sheet.getCell('C1').value = '数量'
sheet.getCell('D1').value = '销售额'
sheet.getCell('A2').value = '样例商品'
sheet.getCell('C2').value = 5
sheet.getCell('D2').value = { formula: 'C2*40' }
const xlsxPath = join(folder, '销售汇总.xlsx')
await workbook.xlsx.writeFile(xlsxPath)
fixtures.push({ path: xlsxPath, filename: '销售汇总.xlsx', query: '合成验收销售额', locator: '工作表', expected: 'D2=200' })
// Optional PDF from the existing synthetic file-delivery acceptance suite.
if (process.env.XIAOYIN_ACCEPTANCE_PDF) fixtures.push({ path: process.env.XIAOYIN_ACCEPTANCE_PDF, filename: '销售复核.pdf', query: '销售', locator: '页', expected: '287.5' })
const manifest = join(folder, 'manifest.json')
await writeFile(manifest, JSON.stringify(fixtures, null, 2))
console.log(manifest)
