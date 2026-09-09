import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const require = createRequire(new URL('../harness-host/package.json', import.meta.url))
const ExcelJS = require('exceljs')
const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell } = require('docx')
const PptxGenJS = require('pptxgenjs')
const directory = resolve(process.argv[2] ?? fileURLToPath(new URL('../src-tauri/tests/preview-fixtures', import.meta.url)))
await mkdir(directory, { recursive: true })

const workbook = new ExcelJS.Workbook()
const revenue = workbook.addWorksheet('销售明细')
revenue.addRow(['商品', '数量', '单价', '金额'])
revenue.addRow(['标准款', 3, 25, { formula: 'B2*C2', result: 75 }])
revenue.getCell('D4').value = { formula: 'SUM(D2:D3)' }
revenue.getCell('B6').value = new Date('2026-09-08T00:00:00Z')
revenue.getCell('B6').numFmt = 'yyyy-mm-dd'
const detail = workbook.addWorksheet('客户备注')
detail.getCell('C3').value = '空白行列应保留'
detail.getCell('E3').value = '多行\n备注'
for (let index = 4; index <= 110; index++) detail.getCell(`C${index}`).value = `客户 ${index}`
await workbook.xlsx.writeFile(join(directory, 'workbook.xlsx'))

const document = new Document({ sections: [{ children: [
  new Paragraph({ text: '季度经营简报', heading: HeadingLevel.HEADING_1 }),
  new Paragraph('收入增长 18%，重点客户复购稳定。'),
  new Paragraph({ text: '行动安排', heading: HeadingLevel.HEADING_2 }),
  new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('负责人')] }), new TableCell({ children: [new Paragraph('事项')] })] }),
    new TableRow({ children: [new TableCell({ children: [new Paragraph('产品组')] }), new TableCell({ children: [new Paragraph('完成需求评审')] })] })] }),
] }] })
await writeFile(join(directory, 'brief.docx'), await Packer.toBuffer(document))
const presentation = new PptxGenJS()
for (const title of ['业务目标', '执行安排', '交付检查']) {
  const slide = presentation.addSlide()
  slide.addText(title, { x: 0.5, y: 0.5, w: 8, h: 1, fontSize: 28 })
  slide.addText('负责人、时间与验收依据', { x: 0.5, y: 2, w: 8, h: 1, fontSize: 18 })
}
await presentation.writeFile({ fileName: join(directory, 'plan.pptx') })
await writeFile(join(directory, 'quoted.csv'), '\uFEFF名称,备注,金额\r\n"项目,一","第一行\n第二行",12.5\r\n项目二,,0\r\n')
await writeFile(join(directory, 'readme.md'), '# 交付说明\n\n本轮完成了 **表格、文档和演示稿**。\n\n| 文件 | 用途 |\n| --- | --- |\n| workbook.xlsx | 销售核对 |\n| brief.docx | 经营简报 |\n\n- [x] 检查内容\n- [ ] 重算缺少结果的公式\n\n```js\nconst total = 3 * 25\n```\n')
console.log(`Preview fixtures: ${directory}`)
