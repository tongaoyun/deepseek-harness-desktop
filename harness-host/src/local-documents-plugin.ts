import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from 'docx'
import ExcelJS from 'exceljs'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import PDFDocument from 'pdfkit'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { LocalFileBridge, discoverAuthorizedRoots } from './local-files-plugin.js'

const { Workbook } = ExcelJS

export const name = 'xiaoyin-local-documents'
export const inject = ['tools']

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
const MAX_TEXT_CHARS = 400_000
const MAX_SHEETS = 20
const MAX_ROWS = 2_000
const MAX_COLUMNS = 100
const CREATE_TOOLS = new Set([
  'local_documents_create_docx', 'local_documents_create_xlsx', 'local_documents_create_pdf',
])

export interface Config { roots?: string[]; enabled?: boolean }
export const Config = z.object({ roots: z.array(z.string()).default([]), enabled: z.boolean().default(true) })

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (config.enabled === false) return
  const roots = await discoverAuthorizedRoots(config.roots ?? [])
  if (roots.length === 0) return
  const bridge = new LocalFileBridge(roots)
  const unregister = [
    ctx.tools.register(readDocumentTool(bridge)),
    ctx.tools.register(createDocxTool(bridge)),
    ctx.tools.register(createXlsxTool(bridge)),
    ctx.tools.register(createPdfTool(bridge)),
  ]
  const stopApprovalPolicy = ctx.on('tools/pre-execute', (exec, next) => {
    if (!CREATE_TOOLS.has(exec.name)) return next()
    const input = record(exec.arguments)
    const path = typeof input.path === 'string' ? input.path : '未指定路径'
    return Promise.resolve({ kind: 'ask' as const, reason: `生成并写入本地文档\npath: ${path}\n工具：${exec.name}` })
  })
  ctx.effect(() => () => {
    stopApprovalPolicy()
    for (const dispose of unregister.reverse()) dispose()
  }, 'xiaoyin local document bridge')
}

function readDocumentTool(bridge: LocalFileBridge): ToolDefinition {
  return tool('local_documents_read', 'Extract text and tables from a DOCX, XLSX or PDF in an authorized directory.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative DOCX, XLSX or PDF path.'),
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
    throw new Error('Only DOCX, XLSX and PDF documents are supported')
  })
}

function createDocxTool(bridge: LocalFileBridge): ToolDefinition {
  return tool('local_documents_create_docx', 'Create a DOCX document from a title, paragraphs and simple tables.', {
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
    await safeDocumentWrite(target.target, bytes, optionalBoolean(input.overwrite, false, 'overwrite'))
    return outputTarget(target, bytes.length)
  })
}

function createXlsxTool(bridge: LocalFileBridge): ToolDefinition {
  return tool('local_documents_create_xlsx', 'Create an XLSX workbook from structured sheets and rows.', {
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
    await safeDocumentWrite(target.target, bytes, optionalBoolean(input.overwrite, false, 'overwrite'))
    return outputTarget(target, bytes.length)
  })
}

function createPdfTool(bridge: LocalFileBridge): ToolDefinition {
  return tool('local_documents_create_pdf', 'Create a PDF document from a title and paragraphs.', {
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
    await safeDocumentWrite(target.target, bytes, optionalBoolean(input.overwrite, false, 'overwrite'))
    return outputTarget(target, bytes.length)
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

type Target = Awaited<ReturnType<LocalFileBridge['resolveTarget']>>

async function documentTarget(bridge: LocalFileBridge, input: Record<string, unknown>, extension: string): Promise<Target> {
  const target = await bridge.resolveTarget(requiredString(input.rootId, 'rootId'), requiredString(input.path, 'path'))
  if (extname(target.target).toLowerCase() !== extension) throw new Error(`Destination path must end with ${extension}`)
  return target
}

async function safeDocumentWrite(path: string, bytes: Buffer, overwrite: boolean): Promise<void> {
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error(`Generated document exceeds the ${MAX_DOCUMENT_BYTES} byte limit`)
  await writeFile(path, bytes, { flag: overwrite ? 'w' : 'wx' })
}

function outputTarget(target: Target, size: number): object {
  return { rootId: target.root.id, rootName: target.root.name, path: target.target.slice(target.root.path.length + 1).replaceAll('\\', '/'), size }
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
