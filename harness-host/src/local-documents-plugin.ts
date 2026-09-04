import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from 'docx'
import ExcelJS from 'exceljs'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import PDFDocument from 'pdfkit'
import { createRequire } from 'node:module'
import { unzipSync } from 'fflate'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { LocalFileBridge, discoverAuthorizedRoots, type LocalFileRootInput } from './local-files-plugin.js'

const { Workbook } = ExcelJS
const require = createRequire(import.meta.url)
interface PptxSlide {
  background: { color: string }
  addShape(shape: unknown, options: Record<string, unknown>): void
  addText(text: string | Array<{ text: string; options: Record<string, unknown> }>, options: Record<string, unknown>): void
  addNotes(notes: string): void
}
interface PptxPresentation {
  layout: string
  author: string
  subject: string
  theme: { headFontFace: string; bodyFontFace: string; lang: string }
  ShapeType: { rect: unknown }
  addSlide(): PptxSlide
  write(options: { outputType: 'nodebuffer' }): Promise<Buffer | ArrayBuffer>
}
const PptxGenJS = require('pptxgenjs') as { new(): PptxPresentation }

export const name = 'xiaoyin-local-documents'
export const inject = ['tools']

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
const MAX_TEXT_CHARS = 400_000
const MAX_SHEETS = 20
const MAX_ROWS = 2_000
const MAX_COLUMNS = 100
const CREATE_TOOLS = new Set([
  'office_docx_create', 'office_xlsx_create', 'office_xlsx_update_cells', 'office_xlsx_append_rows',
  'office_xlsx_add_sheet', 'office_pptx_create', 'office_pdf_create',
])

export interface Config { roots?: LocalFileRootInput[]; enabled?: boolean }
export const Config = z.object({
  roots: z.array(z.any()).default([]), enabled: z.boolean().default(true),
})

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (config.enabled === false) return
  const roots = await discoverAuthorizedRoots(config.roots ?? [])
  if (roots.length === 0) return
  const bridge = new LocalFileBridge(roots)
  const unregister = [
    ctx.tools.register(readDocumentTool(bridge)),
    ctx.tools.register(createDocxTool(bridge)),
    ctx.tools.register(createXlsxTool(bridge)),
    ctx.tools.register(updateXlsxCellsTool(bridge)),
    ctx.tools.register(appendXlsxRowsTool(bridge)),
    ctx.tools.register(addXlsxSheetTool(bridge)),
    ctx.tools.register(createPptxTool(bridge)),
    ctx.tools.register(createPdfTool(bridge)),
  ]
  ctx.effect(() => () => {
    for (const dispose of unregister.reverse()) dispose()
  }, 'xiaoyin local document bridge')
}

function readDocumentTool(bridge: LocalFileBridge): ToolDefinition {
  return tool('office_document_read', 'Extract text and tables from a DOCX, XLSX, PPTX or PDF in an authorized directory.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative DOCX, XLSX, PPTX or PDF path.'),
  }, ['rootId', 'path'], async (input) => {
    const rootId = requiredString(input.rootId, 'rootId')
    const requestedPath = requiredString(input.path, 'path')
    const { root, target } = await bridge.resolveExisting(rootId, requestedPath)
    const metadata = await stat(target)
    if (!metadata.isFile()) throw new Error('Requested document path is not a file')
    if (metadata.size > MAX_DOCUMENT_BYTES) throw new Error(`Document exceeds the ${MAX_DOCUMENT_BYTES} byte limit`)
    const extension = extname(target).toLowerCase()
    const bytes = await readFile(target)
    const base = { rootId: root.id, rootName: root.name, path: bridge.visiblePath(root, target), size: metadata.size }
    if (extension === '.docx') return { ...base, type: 'docx', ...(await parseDocx(bytes)) }
    if (extension === '.xlsx') return { ...base, type: 'xlsx', ...(await parseXlsx(bytes)) }
    if (extension === '.pdf') return { ...base, type: 'pdf', ...(await parsePdf(bytes)) }
    if (extension === '.pptx') return { ...base, type: 'pptx', ...(await parsePptx(bytes)) }
    throw new Error('Only DOCX, XLSX, PPTX and PDF documents are supported')
  })
}

function createDocxTool(bridge: LocalFileBridge): ToolDefinition {
  return tool('office_docx_create', 'Create a DOCX document from a title, paragraphs and simple tables.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative .docx destination.'),
    title: { type: 'string', maxLength: 500 }, paragraphs: { type: 'array', items: { type: 'string', maxLength: 20_000 }, maxItems: 2_000 },
    tables: tableArraySchema(), overwrite: { type: 'boolean', default: false },
  }, ['rootId', 'path'], async (input) => {
    const target = await documentTarget(bridge, input, '.docx')
    const title = optionalString(input.title, 'title', 500)
    const paragraphs = stringArray(input.paragraphs, 'paragraphs', 2_000, 20_000)
    const tables = tablesInput(input.tables)
    const children = [
      ...(title ? [new Paragraph({ text: title, heading: HeadingLevel.TITLE })] : []),
      ...paragraphs.map((text) => new Paragraph({ text })),
      ...tables.map((rows) => new Table({ rows: rows.map((cells) => new TableRow({ children: cells.map((text) => new TableCell({ children: [new Paragraph({ text })] })) })) })),
    ]
    const bytes = await Packer.toBuffer(new Document({ sections: [{ children }] }))
    const backupPath = await safeDocumentWrite(bridge, target, bytes, optionalBoolean(input.overwrite, false, 'overwrite'))
    return outputTarget(target, bytes.length, backupPath)
  })
}

function createXlsxTool(bridge: LocalFileBridge): ToolDefinition {
  return tool('office_xlsx_create', 'Create an XLSX workbook from structured sheets and rows.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative .xlsx destination.'),
    sheets: { type: 'array', minItems: 1, maxItems: MAX_SHEETS, items: { type: 'object', properties: {
      name: { type: 'string', minLength: 1, maxLength: 31 }, rows: { type: 'array', maxItems: MAX_ROWS, items: { type: 'array', maxItems: MAX_COLUMNS, items: { type: ['string', 'number', 'boolean', 'null'] } } },
    }, required: ['name', 'rows'], additionalProperties: false } }, overwrite: { type: 'boolean', default: false },
  }, ['rootId', 'path', 'sheets'], async (input) => {
    const target = await documentTarget(bridge, input, '.xlsx')
    const sheets = sheetsInput(input.sheets)
    const workbook = new Workbook()
    for (const sheet of sheets) {
      const worksheet = workbook.addWorksheet(sheet.name)
      worksheet.addRows(sheet.rows)
      if (sheet.rows.length > 0) worksheet.getRow(1).font = { bold: true }
      worksheet.columns.forEach((column) => { column.width = Math.min(60, Math.max(10, measuredWidth(column.values ?? []))) })
    }
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
    const backupPath = await safeDocumentWrite(bridge, target, bytes, optionalBoolean(input.overwrite, false, 'overwrite'))
    return outputTarget(target, bytes.length, backupPath)
  })
}

function updateXlsxCellsTool(bridge: LocalFileBridge): ToolDefinition {
  return tool('office_xlsx_update_cells', 'Update specific cells in an existing XLSX workbook while preserving the rest of the workbook.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative .xlsx file path.'),
    updates: { type: 'array', minItems: 1, maxItems: 2_000, items: { type: 'object', properties: {
      sheet: { type: 'string', minLength: 1, maxLength: 31 }, cell: { type: 'string', pattern: '^[A-Za-z]{1,3}[1-9][0-9]{0,6}$' },
      value: { type: ['string', 'number', 'boolean', 'null'] },
    }, required: ['sheet', 'cell', 'value'], additionalProperties: false } },
  }, ['rootId', 'path', 'updates'], async (input) => {
    const rootId = requiredString(input.rootId, 'rootId')
    const requestedPath = requiredString(input.path, 'path')
    const { root, target } = await bridge.resolveExisting(rootId, requestedPath)
    if (extname(target).toLowerCase() !== '.xlsx') throw new Error('Workbook path must end with .xlsx')
    const metadata = await stat(target)
    if (!metadata.isFile() || metadata.size > MAX_DOCUMENT_BYTES) throw new Error('Workbook is unavailable or exceeds the size limit')
    const updates = cellUpdatesInput(input.updates)
    const workbook = new Workbook()
    await workbook.xlsx.readFile(target)
    for (const update of updates) {
      const worksheet = workbook.getWorksheet(update.sheet)
      if (!worksheet) throw new Error(`Worksheet does not exist: ${update.sheet}`)
      worksheet.getCell(update.cell).value = update.value
    }
    const backupPath = await bridge.backupExisting(rootId, requestedPath)
    await workbook.xlsx.writeFile(target)
    return { rootId: root.id, rootName: root.name, path: bridge.visiblePath(root, target), size: (await stat(target)).size, updatedCells: updates.length, ...(backupPath ? { backupPath } : {}) }
  })
}

function appendXlsxRowsTool(bridge: LocalFileBridge): ToolDefinition {
  return tool('office_xlsx_append_rows', 'Append rows to an existing XLSX worksheet while preserving workbook formatting, formulas and other sheets.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative .xlsx file path.'),
    sheet: { type: 'string', minLength: 1, maxLength: 31 },
    rows: { type: 'array', minItems: 1, maxItems: MAX_ROWS, items: { type: 'array', maxItems: MAX_COLUMNS, items: { type: ['string', 'number', 'boolean', 'null'] } } },
  }, ['rootId', 'path', 'sheet', 'rows'], async (input) => {
    const { rootId, requestedPath, root, target, workbook } = await existingWorkbook(bridge, input)
    const sheetName = requiredString(input.sheet, 'sheet')
    const worksheet = workbook.getWorksheet(sheetName)
    if (!worksheet) throw new Error(`Worksheet does not exist: ${sheetName}`)
    const rows = worksheetRowsInput(input.rows)
    const firstRow = worksheet.rowCount + 1
    worksheet.addRows(rows)
    const backupPath = await bridge.backupExisting(rootId, requestedPath)
    await workbook.xlsx.writeFile(target)
    return { rootId: root.id, rootName: root.name, path: bridge.visiblePath(root, target), size: (await stat(target)).size,
      sheet: sheetName, firstRow, appendedRows: rows.length, ...(backupPath ? { backupPath } : {}) }
  })
}

function addXlsxSheetTool(bridge: LocalFileBridge): ToolDefinition {
  return tool('office_xlsx_add_sheet', 'Add a worksheet to an existing XLSX workbook without rebuilding the file.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative .xlsx file path.'),
    sheet: { type: 'string', minLength: 1, maxLength: 31 },
    rows: { type: 'array', maxItems: MAX_ROWS, items: { type: 'array', maxItems: MAX_COLUMNS, items: { type: ['string', 'number', 'boolean', 'null'] } } },
  }, ['rootId', 'path', 'sheet'], async (input) => {
    const { rootId, requestedPath, root, target, workbook } = await existingWorkbook(bridge, input)
    const sheetName = requiredString(input.sheet, 'sheet')
    if (sheetName.length > 31 || workbook.getWorksheet(sheetName)) throw new Error(`Worksheet already exists or has an invalid name: ${sheetName}`)
    const rows = input.rows === undefined ? [] : worksheetRowsInput(input.rows)
    const worksheet = workbook.addWorksheet(sheetName)
    worksheet.addRows(rows)
    if (rows.length > 0) worksheet.getRow(1).font = { bold: true }
    worksheet.columns.forEach((column) => { column.width = Math.min(60, Math.max(10, measuredWidth(column.values ?? []))) })
    const backupPath = await bridge.backupExisting(rootId, requestedPath)
    await workbook.xlsx.writeFile(target)
    return { rootId: root.id, rootName: root.name, path: bridge.visiblePath(root, target), size: (await stat(target)).size,
      sheet: sheetName, rowCount: rows.length, ...(backupPath ? { backupPath } : {}) }
  })
}

function createPptxTool(bridge: LocalFileBridge): ToolDefinition {
  return tool('office_pptx_create', 'Create an editable PPTX presentation from structured slides.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative .pptx destination.'),
    title: { type: 'string', maxLength: 500 },
    slides: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: {
      title: { type: 'string', maxLength: 500 },
      bullets: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 2_000 } },
      speakerNotes: { type: 'string', maxLength: 10_000 },
    }, required: ['title'], additionalProperties: false } },
    overwrite: { type: 'boolean', default: false },
  }, ['rootId', 'path', 'slides'], async (input) => {
    const target = await documentTarget(bridge, input, '.pptx')
    const bytes = await renderPptx(
      presentationSlidesInput(input.slides),
      optionalString(input.title, 'title', 500),
    )
    const backupPath = await safeDocumentWrite(bridge, target, bytes, optionalBoolean(input.overwrite, false, 'overwrite'))
    return outputTarget(target, bytes.length, backupPath)
  })
}

export async function renderPptx(
  slides: Array<{ title: string; bullets: string[]; speakerNotes?: string }>,
  title = '',
): Promise<Buffer> {
  const presentation = new PptxGenJS()
  presentation.layout = 'LAYOUT_WIDE'
  presentation.author = '小胤'
  presentation.subject = title || '小胤生成演示文稿'
  presentation.theme = { headFontFace: 'Microsoft YaHei', bodyFontFace: 'Microsoft YaHei', lang: 'zh-CN' }
  for (const item of slides) {
    const slide = presentation.addSlide()
    slide.background = { color: 'F7FAF8' }
    slide.addShape(presentation.ShapeType.rect, { x: 0, y: 0, w: 0.16, h: 7.5, fill: { color: '4F9366' }, line: { color: '4F9366' } })
    slide.addText(item.title, { x: 0.65, y: 0.55, w: 11.7, h: 0.7, fontFace: 'Microsoft YaHei', fontSize: 27, bold: true, color: '202522', margin: 0 })
    if (item.bullets.length > 0) {
      slide.addText(item.bullets.map((text) => ({ text, options: { bullet: { indent: 18 }, breakLine: true } })), {
        x: 0.75, y: 1.65, w: 11.6, h: 4.9, fontFace: 'Microsoft YaHei', fontSize: 18, color: '3F4741', breakLine: false,
        margin: 0.08, paraSpaceAfterPt: 14, valign: 'top',
      })
    }
    if (item.speakerNotes) slide.addNotes(item.speakerNotes)
  }
  const raw = await presentation.write({ outputType: 'nodebuffer' })
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
}

function createPdfTool(bridge: LocalFileBridge): ToolDefinition {
  return tool('office_pdf_create', 'Create a PDF document from a title and paragraphs.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative .pdf destination.'),
    title: { type: 'string', maxLength: 500 }, paragraphs: { type: 'array', items: { type: 'string', maxLength: 20_000 }, maxItems: 2_000 },
    overwrite: { type: 'boolean', default: false },
  }, ['rootId', 'path'], async (input) => {
    const target = await documentTarget(bridge, input, '.pdf')
    const title = optionalString(input.title, 'title', 500)
    const paragraphs = stringArray(input.paragraphs, 'paragraphs', 2_000, 20_000)
    const content = [title, ...paragraphs].join('\n')
    const font = await selectPdfFont(content)
    const bytes = await renderPdf(title, paragraphs, font)
    const backupPath = await safeDocumentWrite(bridge, target, bytes, optionalBoolean(input.overwrite, false, 'overwrite'))
    return outputTarget(target, bytes.length, backupPath)
  })
}

export async function parseDocx(bytes: Buffer): Promise<object> {
  const result = await mammoth.extractRawText({ buffer: bytes })
  return { text: truncateText(result.value), warnings: result.messages.map((message) => message.message).slice(0, 20) }
}

export async function parseXlsx(bytes: Buffer): Promise<object> {
  const workbook = new Workbook()
  // ExcelJS 4 declares its own legacy Buffer shape; the runtime accepts Node buffers.
  await workbook.xlsx.load(bytes as never)
  const sheets = workbook.worksheets.slice(0, MAX_SHEETS).map((worksheet) => {
    const rows: string[][] = []
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values = Array.isArray(row.values) ? row.values : Object.values(row.values)
      if (rowNumber <= MAX_ROWS) rows.push(values.slice(1, MAX_COLUMNS + 1).map((value: unknown) => cellText(value)))
    })
    return { name: worksheet.name, rowCount: worksheet.rowCount, columnCount: worksheet.columnCount, rows }
  })
  return { sheets, truncated: workbook.worksheets.length > MAX_SHEETS || workbook.worksheets.some((sheet) => sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLUMNS) }
}

export async function parsePdf(bytes: Buffer): Promise<object> {
  const parser = new PDFParse({ data: bytes })
  try {
    const result = await parser.getText()
    return { pageCount: result.total, text: truncateText(result.text), pages: result.pages.slice(0, 200).map((page) => ({ page: page.num, text: truncateText(page.text, 20_000) })) }
  } finally {
    await parser.destroy()
  }
}

export async function parsePptx(bytes: Buffer): Promise<object> {
  let archive: Record<string, Uint8Array>
  let extractedBytes = 0
  let slideCount = 0
  try {
    archive = unzipSync(bytes, { filter(file) {
      if (!/^ppt\/slides\/slide\d+\.xml$/u.test(file.name)) return false
      slideCount += 1
      extractedBytes += file.originalSize
      if (slideCount > 300 || extractedBytes > MAX_TEXT_CHARS * 4) throw new Error('PPTX slide content exceeds limits')
      return true
    } })
  } catch (error) {
    if (error instanceof Error && error.message.includes('exceeds limits')) throw error
    throw new Error('PPTX archive is invalid')
  }
  const slideNames = Object.keys(archive).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right)).slice(0, 300)
  if (slideNames.length === 0) throw new Error('PPTX contains no slides')
  const decoder = new TextDecoder()
  const slides = slideNames.map((name, index) => {
    const xml = decoder.decode(archive[name])
    const text = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)]
      .map((match) => decodeXmlText(match[1] ?? '')).filter(Boolean).join('\n')
    return { slide: index + 1, text: truncateText(text, 20_000) }
  })
  return { slideCount: slideNames.length, text: truncateText(slides.map((slide) => slide.text).join('\n\n')), slides }
}

function slideNumber(name: string): number { return Number(name.match(/slide(\d+)\.xml$/u)?.[1] ?? 0) }
function decodeXmlText(value: string): string {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&').trim()
}

type Target = Awaited<ReturnType<LocalFileBridge['resolveTarget']>>

async function existingWorkbook(bridge: LocalFileBridge, input: Record<string, unknown>) {
  const rootId = requiredString(input.rootId, 'rootId')
  const requestedPath = requiredString(input.path, 'path')
  const { root, target } = await bridge.resolveExisting(rootId, requestedPath)
  if (extname(target).toLowerCase() !== '.xlsx') throw new Error('Workbook path must end with .xlsx')
  const metadata = await stat(target)
  if (!metadata.isFile() || metadata.size > MAX_DOCUMENT_BYTES) throw new Error('Workbook is unavailable or exceeds the size limit')
  const workbook = new Workbook()
  await workbook.xlsx.readFile(target)
  return { rootId, requestedPath, root, target, workbook }
}

async function documentTarget(bridge: LocalFileBridge, input: Record<string, unknown>, extension: string): Promise<Target> {
  const target = await bridge.resolveTarget(requiredString(input.rootId, 'rootId'), requiredString(input.path, 'path'))
  if (extname(target.target).toLowerCase() !== extension) throw new Error(`Destination path must end with ${extension}`)
  return target
}

async function safeDocumentWrite(bridge: LocalFileBridge, target: Target, bytes: Buffer, overwrite: boolean): Promise<string | undefined> {
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error(`Generated document exceeds the ${MAX_DOCUMENT_BYTES} byte limit`)
  const requestedPath = target.target.slice(target.root.path.length + 1)
  const backupPath = overwrite ? await bridge.backupExisting(target.root.id, requestedPath) : undefined
  await writeFile(target.target, bytes, { flag: overwrite ? 'w' : 'wx' })
  return backupPath
}

function outputTarget(target: Target, size: number, backupPath?: string): object {
  return { rootId: target.root.id, rootName: target.root.name, path: target.target.slice(target.root.path.length + 1).replaceAll('\\', '/'), size, ...(backupPath ? { backupPath } : {}) }
}

interface PdfFont { path: string; family?: string }

export async function renderPdf(title: string, paragraphs: string[], font: PdfFont | string | undefined): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', margin: 54, info: { Title: title || '小胤生成文档' } })
    const chunks: Buffer[] = []
    document.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    document.on('end', () => resolve(Buffer.concat(chunks)))
    document.on('error', reject)
    if (typeof font === 'string') document.font(font)
    else if (font) {
      if (font.family) document.font(font.path, font.family)
      else document.font(font.path)
    }
    if (title) document.fontSize(20).text(title).moveDown()
    document.fontSize(11)
    for (const paragraph of paragraphs) document.text(paragraph, { lineGap: 4 }).moveDown(0.6)
    document.end()
  })
}

export async function selectPdfFont(content: string): Promise<PdfFont | undefined> {
  if (!/[^\x00-\x7F]/u.test(content)) return undefined
  const candidates: PdfFont[] = process.platform === 'win32'
    ? [
        { path: 'C:\\Windows\\Fonts\\simhei.ttf' },
        { path: 'C:\\Windows\\Fonts\\msyh.ttc', family: 'MicrosoftYaHei' },
        { path: 'C:\\Windows\\Fonts\\simsun.ttc', family: 'SimSun' },
      ]
    : process.platform === 'darwin'
      ? [
          { path: '/System/Library/Fonts/Supplemental/Arial Unicode.ttf' },
          { path: '/System/Library/Fonts/STHeiti Medium.ttc', family: 'STHeitiSC-Medium' },
        ]
      : [
          { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'NotoSansCJK-Regular' },
          { path: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', family: 'WenQuanYiZenHei' },
        ]
  for (const candidate of candidates) {
    try { await access(candidate.path); return candidate } catch { /* try the next system font */ }
  }
  throw new Error('No CJK font is installed; PDF generation with Chinese text is unavailable')
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], execute: (input: Record<string, unknown>) => Promise<unknown>): ToolDefinition {
  return { name, description, parameters: { type: 'object', properties, required, additionalProperties: false }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, async execute(args) { return execute(record(args)) }, isConcurrencySafe: () => !CREATE_TOOLS.has(name) }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Document tool arguments must be an object')
  return value as Record<string, unknown>
}
function stringProperty(description: string): object { return { type: 'string', minLength: 1, maxLength: 4096, description } }
function requiredString(value: unknown, name: string): string { if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new Error(`${name} must be a non-empty string`); return value }
function optionalString(value: unknown, name: string, max: number): string { if (value === undefined) return ''; if (typeof value !== 'string' || value.length > max) throw new Error(`${name} must be a string of at most ${max} characters`); return value }
function optionalBoolean(value: unknown, fallback: boolean, name: string): boolean { if (value === undefined) return fallback; if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`); return value }
function stringArray(value: unknown, name: string, maxItems: number, maxLength: number): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string' || item.length > maxLength)) throw new Error(`${name} is invalid`); return value as string[] }
function truncateText(value: string, max = MAX_TEXT_CHARS): string { return value.length <= max ? value : `${value.slice(0, max)}\n…内容已截断` }
function cellText(value: unknown): string { if (value === null || value === undefined) return ''; if (value instanceof Date) return value.toISOString(); if (typeof value === 'object' && 'result' in value) return String((value as { result?: unknown }).result ?? ''); if (typeof value === 'object' && 'text' in value) return String((value as { text?: unknown }).text ?? ''); return String(value) }
function measuredWidth(values: readonly unknown[]): number { return Math.max(0, ...values.map((value) => cellText(value).length + 2)) }
function tableArraySchema(): object { return { type: 'array', maxItems: 100, items: { type: 'array', maxItems: MAX_ROWS, items: { type: 'array', maxItems: MAX_COLUMNS, items: { type: 'string', maxLength: 20_000 } } } } }
function tablesInput(value: unknown): string[][][] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 100) throw new Error('tables is invalid'); return value.map((table) => { if (!Array.isArray(table) || table.length > MAX_ROWS) throw new Error('table rows are invalid'); return table.map((row) => { if (!Array.isArray(row) || row.length > MAX_COLUMNS || row.some((cell) => typeof cell !== 'string' || cell.length > 20_000)) throw new Error('table cells are invalid'); return row as string[] }) }) }
function sheetsInput(value: unknown): Array<{ name: string; rows: Array<Array<string | number | boolean | null>> }> { if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SHEETS) throw new Error('sheets is invalid'); const names = new Set<string>(); return value.map((item) => { const sheet = record(item); const name = requiredString(sheet.name, 'sheet.name'); if (name.length > 31 || names.has(name)) throw new Error('Sheet names must be unique and at most 31 characters'); names.add(name); if (!Array.isArray(sheet.rows) || sheet.rows.length > MAX_ROWS) throw new Error('sheet.rows is invalid'); const rows = sheet.rows.map((row) => { if (!Array.isArray(row) || row.length > MAX_COLUMNS || row.some((cell) => cell !== null && !['string', 'number', 'boolean'].includes(typeof cell))) throw new Error('sheet row is invalid'); return row as Array<string | number | boolean | null> }); return { name, rows } }) }
function worksheetRowsInput(value: unknown): Array<Array<string | number | boolean | null>> { if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROWS) throw new Error('rows is invalid'); return value.map((row) => { if (!Array.isArray(row) || row.length > MAX_COLUMNS || row.some((cell) => cell !== null && !['string', 'number', 'boolean'].includes(typeof cell))) throw new Error('row is invalid'); return row as Array<string | number | boolean | null> }) }
function cellUpdatesInput(value: unknown): Array<{ sheet: string; cell: string; value: string | number | boolean | null }> { if (!Array.isArray(value) || value.length === 0 || value.length > 2_000) throw new Error('updates is invalid'); return value.map((item) => { const update = record(item); const sheet = requiredString(update.sheet, 'update.sheet'); const cell = requiredString(update.cell, 'update.cell').toUpperCase(); if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/u.test(cell)) throw new Error(`Invalid cell reference: ${cell}`); if (update.value !== null && !['string', 'number', 'boolean'].includes(typeof update.value)) throw new Error('update.value is invalid'); return { sheet, cell, value: update.value as string | number | boolean | null } }) }
function presentationSlidesInput(value: unknown): Array<{ title: string; bullets: string[]; speakerNotes: string }> { if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error('slides is invalid'); return value.map((item) => { const slide = record(item); return { title: requiredString(slide.title, 'slide.title'), bullets: stringArray(slide.bullets, 'slide.bullets', 30, 2_000), speakerNotes: optionalString(slide.speakerNotes, 'slide.speakerNotes', 10_000) } }) }
