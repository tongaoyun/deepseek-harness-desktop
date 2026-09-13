import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from 'docx'
import ExcelJS from 'exceljs'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import PDFDocument from 'pdfkit'
import { spawn } from 'node:child_process'
import { unzipSync } from 'fflate'
import { access, link, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LocalFileBridge, discoverAuthorizedRoots, fileChangeReceipt, type LocalFileRootInput } from './local-files-plugin.js'
import { convertOffice, findOfficeEngine } from './office-conversion.js'

const { Workbook } = ExcelJS

export const name = 'xiaoyin-local-documents'
export const inject = ['tools', 'attachments']

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
const MAX_TEXT_CHARS = 400_000
const MAX_SHEETS = 20
const MAX_ROWS = 2_000
const MAX_COLUMNS = 100
const MAX_PPTX_RENDER_BYTES = 25 * 1024 * 1024
const PPTX_RENDER_TIMEOUT_MS = 30_000
const CREATE_TOOLS = new Set([
  'office_docx_create', 'office_xlsx_create', 'office_xlsx_update_cells', 'office_xlsx_append_rows',
  'office_xlsx_add_sheet', 'office_xlsx_format_sheet', 'office_pptx_create', 'office_pdf_create',
  'office_document_export_pdf', 'office_xlsx_recalculate',
])

export interface Config { roots?: LocalFileRootInput[]; enabled?: boolean; readOnly?: boolean }
export const Config = z.object({
  roots: z.array(z.any()).default([]), enabled: z.boolean().default(true), readOnly: z.boolean().default(false),
})

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (config.enabled === false) return
  const roots = await discoverAuthorizedRoots(config.roots ?? [])
  if (roots.length === 0) return
  const bridge = new LocalFileBridge(roots)
  const unregister = [
    ctx.tools.register(readDocumentTool(bridge)),
    ctx.tools.register(checkDocumentTool(bridge)),
    ctx.tools.register(pdfPageTool(bridge, ctx)),
    ctx.tools.register(tool('office_engine_status', 'Check whether local LibreOffice is available for Office PDF export and spreadsheet recalculation. Does not install software.', {}, [], async () => {
      const engine = await findOfficeEngine()
      return { available: engine.available, engine: 'LibreOffice', ...(engine.reason ? { reason: engine.reason, installUrl: 'https://www.libreoffice.org/download/' } : {}) }
    })),
    ...(config.readOnly ? [] : [
      ctx.tools.register(createDocxTool(bridge)),
      ctx.tools.register(createXlsxTool(bridge)),
      ctx.tools.register(updateXlsxCellsTool(bridge)),
      ctx.tools.register(appendXlsxRowsTool(bridge)),
      ctx.tools.register(addXlsxSheetTool(bridge)),
      ctx.tools.register(formatXlsxSheetTool(bridge)),
      ctx.tools.register(createPptxTool(bridge)),
      ctx.tools.register(createPdfTool(bridge)),
      ctx.tools.register(convertDocumentTool(bridge, 'pdf')),
      ctx.tools.register(convertDocumentTool(bridge, 'recalculate')),
    ]),
  ]
  ctx.effect(() => () => {
    for (const dispose of unregister.reverse()) dispose()
  }, 'xiaoyin local document bridge')
}

function convertDocumentTool(bridge: LocalFileBridge, mode: 'pdf' | 'recalculate'): ToolDefinition {
  const name = mode === 'pdf' ? 'office_document_export_pdf' : 'office_xlsx_recalculate'
  const definition = tool(name, mode === 'pdf'
    ? 'Export DOCX/XLSX/PPTX to a NEW PDF using local LibreOffice for visual verification. Original is unchanged. Use office_pdf_page to inspect the generated pages.'
    : 'Recalculate XLSX formulas with local LibreOffice and save a NEW XLSX copy. Original is unchanged. Report formula errors and compatibility limitations; do not claim business correctness.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Existing source file path.'),
    outputPath: stringProperty(mode === 'pdf' ? 'New .pdf path in the same authorized root. Existing files are never overwritten.' : 'New .xlsx path in the same authorized root. Existing files are never overwritten.'),
  }, ['rootId', 'path', 'outputPath'], async () => ({}))
  definition.execute = async (args, exec) => {
    exec.signal.throwIfAborted()
    const input = record(args)
    const outputPath = requiredString(input.outputPath, 'outputPath')
    const target = await documentTarget(bridge, { ...input, path: outputPath }, mode === 'pdf' ? '.pdf' : '.xlsx')
    try { await stat(target.target); throw new Error('目标文件已存在，请选择新路径；不会覆盖原件或已有成果') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const { bytes, extension } = await documentBytes(bridge, input)
    const result = await convertOffice(bytes, extension, mode, exec.signal)
    const checked = await checkDocument(result, mode === 'pdf' ? '.pdf' : '.xlsx')
    const verification = mode === 'pdf' ? checked : { ...checked, limitations: checked.limitations.filter((item) => item !== '未重新计算公式；缓存结果可能过期').concat('LibreOffice 已请求强制重算；不保证所有 Excel 专有函数与外部数据兼容') }
    exec.signal.throwIfAborted()
    // Publish a fully written copy atomically, without replacing another file
    // that may have appeared while LibreOffice was running.
    const temporaryOutput = join(dirname(target.target), `.xiaoyin-conversion-${randomUUID()}.tmp`)
    try {
      await writeFile(temporaryOutput, result, { flag: 'wx' })
      exec.signal.throwIfAborted()
      await link(temporaryOutput, target.target)
    } finally { await rm(temporaryOutput, { force: true }) }
    return { ...await outputTarget(target, result.length), engine: 'LibreOffice', originalUnchanged: true,
      verification, note: mode === 'pdf' ? '已导出 PDF；需用 office_pdf_page 检查页面，尚未确认版面正确' : '已由 LibreOffice 加载并重算副本；复杂 Excel 功能可能存在兼容差异，需核对业务数据与公式错误' }
  }
  return definition
}

async function documentBytes(bridge: LocalFileBridge, input: Record<string, unknown>) {
  const { target } = await bridge.resolveExisting(requiredString(input.rootId, 'rootId'), requiredString(input.path, 'path'))
  const metadata = await stat(target)
  if (!metadata.isFile() || metadata.size > MAX_DOCUMENT_BYTES) throw new Error('Document must be a file no larger than 25 MiB')
  return { bytes: await readFile(target), extension: extname(target).toLowerCase() }
}

function checkDocumentTool(bridge: LocalFileBridge): ToolDefinition {
  return tool('office_document_check', 'Read-only structural check of an Office/PDF deliverable. Reports empty content, spreadsheet error cells and missing cached formula results. Does not recalculate formulas or certify business correctness or layout.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative document path.'),
  }, ['rootId', 'path'], async (input) => {
    const { bytes, extension } = await documentBytes(bridge, input)
    return checkDocument(bytes, extension)
  })
}

export async function checkDocument(bytes: Buffer, extension: string) {
  if (extension === '.xlsx') {
    const workbook = new Workbook()
    await workbook.xlsx.load(bytes as never)
    const issues: Array<{ sheet: string; cell?: string; issue: string }> = []
    let issueCount = 0
    let formulaCount = 0
    let checkedCells = 0
    let truncated = false
    const issue = (sheet: string, cell: string | undefined, detail: string) => {
      issueCount++
      if (issues.length < 100) issues.push({ sheet, ...(cell ? { cell } : {}), issue: detail })
    }
    for (const sheet of workbook.worksheets) {
      if (sheet.actualRowCount === 0) issue(sheet.name, undefined, '工作表没有数据')
      sheet.eachRow((row) => row.eachCell((cell) => {
        if (checkedCells >= 100_000) { truncated = true; return }
        checkedCells++
        const value = cell.value
        if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
          formulaCount++
          const result = cell.result // ExcelJS cell.value omits falsy cached results (0/false).
          if (result === undefined || result === null) issue(sheet.name, cell.address, '公式缺少缓存计算结果，需用电子表格应用重算')
          else if (typeof result === 'object' && 'error' in result) issue(sheet.name, cell.address, `公式结果错误：${result.error}`)
        } else if (value && typeof value === 'object' && 'error' in value) issue(sheet.name, cell.address, `单元格错误：${value.error}`)
      }))
    }
    return { format: 'xlsx', checkedCells, formulaCount, issueCount, issues, truncated,
      sheets: workbook.worksheets.map((sheet) => ({ name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount })),
      status: issueCount || truncated || !workbook.worksheets.length ? 'needs_review' : 'structure_checked',
      limitations: ['未重新计算公式；缓存结果可能过期', '未核对业务数据、版面或图表正确性', ...(truncated ? ['仅检查前 100000 个非空单元格'] : [])] }
  }
  const parsed = extension === '.pdf' ? await parsePdf(bytes) : extension === '.docx' ? await parseDocx(bytes) : extension === '.pptx' ? await parsePptx(bytes) : undefined
  if (!parsed) throw new Error('Only DOCX, XLSX, PPTX and PDF documents are supported')
  const value = parsed as { text?: string; pageCount?: number; slideCount?: number }
  const hasText = Boolean(value.text?.trim())
  return { format: extension.slice(1), status: hasText ? 'structure_checked' : 'needs_review',
    textCharacters: value.text?.length ?? 0,
    ...(value.pageCount !== undefined ? { pageCount: value.pageCount } : {}),
    ...(value.slideCount !== undefined ? { slideCount: value.slideCount } : {}),
    issues: hasText ? [] : ['未提取到正文；可能是扫描件、图片内容或空文件，需查看页面图像'],
    limitations: ['仅检查文档可解析及正文存在，不等于内容或版面验收通过'] }
}

function pdfPageTool(bridge: LocalFileBridge, ctx: Context): ToolDefinition {
  return {
    name: 'office_pdf_page', description: 'Render one PDF page as an image for visual reading of scanned documents and layout checks. Requires an image-capable model. Never claims OCR or document verification from rendering alone.',
    parameters: { type: 'object', properties: { rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative PDF path.'), page: { type: 'integer', minimum: 1 } }, required: ['rootId', 'path', 'page'], additionalProperties: false },
    output: { schema: {}, render: (_args, value) => {
      const result = value as unknown as { image: import('@deepseek-ai/dsh-attachment').ImageAttachmentRef; page: number; total: number }
      return [{ type: 'text', text: JSON.stringify({ page: result.page, total: result.total, note: '仅渲染此页，需观察内容后判断；其余页面未检查' }) }, { type: 'image', attachment: result.image }]
    } },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const input = record(args)
      const page = input.page
      if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1) throw new Error('page must be a positive integer')
      const { bytes, extension } = await documentBytes(bridge, input)
      if (extension !== '.pdf') throw new Error('Only PDF page rendering is supported; export Office documents to PDF with an available application first')
      const parser = new PDFParse({ data: bytes })
      try {
        const result = await parser.getScreenshot({ partial: [page], desiredWidth: 1400, imageDataUrl: false, imageBuffer: true })
        exec.signal.throwIfAborted()
        const rendered = result.pages[0]
        if (!rendered) throw new Error('Requested PDF page does not exist')
        const image = await ctx.attachments.saveImage({ data: Buffer.from(rendered.data), mediaType: 'image/png', name: `PDF 第 ${page} 页.png` })
        return { page, total: result.total, image }
      } finally { await parser.destroy() }
    }, isConcurrencySafe: () => false,
  }
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
  return tool('office_xlsx_create', 'Create an XLSX workbook from structured sheets and rows. Use {formula:"C2*D2"} for formulas, not an equals-prefixed string. Formula results require recalculation.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative .xlsx destination.'),
    sheets: { type: 'array', minItems: 1, maxItems: MAX_SHEETS, items: { type: 'object', properties: {
      name: { type: 'string', minLength: 1, maxLength: 31 }, rows: { type: 'array', maxItems: MAX_ROWS, items: { type: 'array', maxItems: MAX_COLUMNS, items: worksheetCellSchema() } },
    }, required: ['name', 'rows'], additionalProperties: false } }, overwrite: { type: 'boolean', default: false },
  }, ['rootId', 'path', 'sheets'], async (input) => {
    const target = await documentTarget(bridge, input, '.xlsx')
    const sheets = sheetsInput(input.sheets)
    const workbook = new Workbook()
    workbook.calcProperties.fullCalcOnLoad = true
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
      value: worksheetCellSchema(),
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
    workbook.calcProperties.fullCalcOnLoad = true
    for (const update of updates) {
      const worksheet = workbook.getWorksheet(update.sheet)
      if (!worksheet) throw new Error(`Worksheet does not exist: ${update.sheet}`)
      worksheet.getCell(update.cell).value = update.value
    }
    const backupPath = await bridge.backupExisting(rootId, requestedPath)
    await workbook.xlsx.writeFile(target)
    return { rootId: root.id, rootName: root.name, path: bridge.visiblePath(root, target), size: (await stat(target)).size, updatedCells: updates.length, ...await fileChangeReceipt(root.path, target, backupPath), ...(backupPath ? { backupPath } : {}) }
  })
}

function appendXlsxRowsTool(bridge: LocalFileBridge): ToolDefinition {
  return tool('office_xlsx_append_rows', 'Append rows to an existing XLSX worksheet while preserving workbook formatting, formulas and other sheets.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative .xlsx file path.'),
    sheet: { type: 'string', minLength: 1, maxLength: 31 },
    rows: { type: 'array', minItems: 1, maxItems: MAX_ROWS, items: { type: 'array', maxItems: MAX_COLUMNS, items: worksheetCellSchema() } },
  }, ['rootId', 'path', 'sheet', 'rows'], async (input) => {
    const { rootId, requestedPath, root, target, workbook } = await existingWorkbook(bridge, input)
    workbook.calcProperties.fullCalcOnLoad = true
    const sheetName = requiredString(input.sheet, 'sheet')
    const worksheet = workbook.getWorksheet(sheetName)
    if (!worksheet) throw new Error(`Worksheet does not exist: ${sheetName}`)
    const rows = worksheetRowsInput(input.rows)
    const firstRow = worksheet.rowCount + 1
    worksheet.addRows(rows)
    const backupPath = await bridge.backupExisting(rootId, requestedPath)
    await workbook.xlsx.writeFile(target)
    return { rootId: root.id, rootName: root.name, path: bridge.visiblePath(root, target), size: (await stat(target)).size,
      sheet: sheetName, firstRow, appendedRows: rows.length, ...await fileChangeReceipt(root.path, target, backupPath), ...(backupPath ? { backupPath } : {}) }
  })
}

function addXlsxSheetTool(bridge: LocalFileBridge): ToolDefinition {
  return tool('office_xlsx_add_sheet', 'Add a worksheet to an existing XLSX workbook without rebuilding the file.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative .xlsx file path.'),
    sheet: { type: 'string', minLength: 1, maxLength: 31 },
    rows: { type: 'array', maxItems: MAX_ROWS, items: { type: 'array', maxItems: MAX_COLUMNS, items: worksheetCellSchema() } },
  }, ['rootId', 'path', 'sheet'], async (input) => {
    const { rootId, requestedPath, root, target, workbook } = await existingWorkbook(bridge, input)
    const sheetName = requiredString(input.sheet, 'sheet')
    if (sheetName.length > 31 || workbook.getWorksheet(sheetName)) throw new Error(`Worksheet already exists or has an invalid name: ${sheetName}`)
    workbook.calcProperties.fullCalcOnLoad = true
    const rows = input.rows === undefined ? [] : worksheetRowsInput(input.rows)
    const worksheet = workbook.addWorksheet(sheetName)
    worksheet.addRows(rows)
    if (rows.length > 0) worksheet.getRow(1).font = { bold: true }
    worksheet.columns.forEach((column) => { column.width = Math.min(60, Math.max(10, measuredWidth(column.values ?? []))) })
    const backupPath = await bridge.backupExisting(rootId, requestedPath)
    await workbook.xlsx.writeFile(target)
    return { rootId: root.id, rootName: root.name, path: bridge.visiblePath(root, target), size: (await stat(target)).size,
      sheet: sheetName, rowCount: rows.length, ...await fileChangeReceipt(root.path, target, backupPath), ...(backupPath ? { backupPath } : {}) }
  })
}

function formatXlsxSheetTool(bridge: LocalFileBridge): ToolDefinition {
  return tool('office_xlsx_format_sheet', 'Format an existing worksheet for readable PDF export: explicit column widths, wrapped text, estimated row heights and A4 print area fitted to one page wide (multiple pages tall allowed). Preserves cell values/formulas and saves an undo backup. Inspect the exported pages; height estimates are not a visual guarantee.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Existing .xlsx path.'), sheet: stringProperty('Worksheet name.'),
    columnWidths: { type: 'array', minItems: 1, maxItems: MAX_COLUMNS, items: { type: 'number', minimum: 8, maximum: 80 }, description: 'Widths in Excel character units for columns A onward; omit to keep current widths.' },
    orientation: { type: 'string', enum: ['portrait', 'landscape'], default: 'landscape' },
  }, ['rootId', 'path', 'sheet'], async (input) => {
    const { root, target, workbook } = await existingWorkbook(bridge, input)
    const sheet = workbook.getWorksheet(requiredString(input.sheet, 'sheet'))
    if (!sheet) throw new Error('Worksheet does not exist')
    if (!sheet.rowCount || sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLUMNS) throw new Error('排版仅支持非空且不超过 2000 行、100 列的工作表')
    const orientation = input.orientation ?? 'landscape'
    if (orientation !== 'portrait' && orientation !== 'landscape') throw new Error('orientation is invalid')
    if (input.columnWidths !== undefined) {
      if (!Array.isArray(input.columnWidths) || !input.columnWidths.length || input.columnWidths.length > sheet.columnCount
        || input.columnWidths.some((width) => typeof width !== 'number' || !Number.isFinite(width) || width < 8 || width > 80)) throw new Error('columnWidths must match existing columns and contain values from 8 to 80')
      input.columnWidths.forEach((width: number, index: number) => { sheet.getColumn(index + 1).width = width })
    }
    sheet.eachRow((row) => {
      let height = 18
      row.eachCell((cell) => {
        if (cell.isMerged) throw new Error('含合并单元格的工作表请在办公应用中调整版面')
        cell.alignment = { ...cell.alignment, wrapText: true, vertical: 'top', shrinkToFit: false }
        const width = Math.max(6, (sheet.getColumn(cell.col).width || 10) - 2)
        const lines = cellText(cell.value).split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(textWidth(line) / width)), 0)
        height = Math.max(height, lines * Math.max(15, (cell.font?.size || 11) * 1.5) + 4)
      })
      if (height > 409) throw new Error('单元格内容过长，请将长说明拆分成多行后再排版')
      row.height = height
    })
    sheet.pageSetup = { ...sheet.pageSetup, paperSize: 9, orientation, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      printArea: `A1:${sheet.getColumn(sheet.columnCount).letter}${sheet.rowCount}` }
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
    const backupPath = await safeDocumentWrite(bridge, { root, target }, bytes, true)
    return { ...await outputTarget({ root, target }, bytes.length, backupPath), sheet: sheet.name,
      note: '已设置换行、估算行高和单页宽打印范围；需检查导出页面，尚未确认版面正确' }
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
  return runPptxRenderer(fileURLToPath(new URL('./pptx-render-worker.mjs', import.meta.url)), { slides, title })
}

export function runPptxRenderer(
  workerPath: string,
  payload: { slides: Array<{ title: string; bullets: string[]; speakerNotes?: string }>; title: string },
  timeoutMs = PPTX_RENDER_TIMEOUT_MS,
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    let outputBytes = 0
    let errorBytes = 0
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) rejectPromise(error)
      else resolvePromise(Buffer.concat(output))
    }
    const stop = (error: Error) => {
      child.kill('SIGKILL')
      finish(error)
    }
    const timer = setTimeout(() => stop(new Error('PPTX 生成超时，未写入文件')), timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_PPTX_RENDER_BYTES) stop(new Error('PPTX 生成结果超过 25 MiB 限制'))
      else output.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (errorBytes >= 64 * 1024) return
      errorBytes += chunk.length
      errors.push(chunk.subarray(0, Math.max(0, 64 * 1024 - errorBytes + chunk.length)))
    })
    child.once('error', () => finish(new Error('无法启动隔离的 PPTX 生成进程')))
    child.once('close', (code) => {
      if (settled) return
      if (code === 0 && outputBytes > 0) finish()
      else {
        const detail = Buffer.concat(errors).toString('utf8').trim()
        finish(new Error(detail ? `PPTX 生成失败：${detail}` : 'PPTX 生成失败'))
      }
    })
    child.stdin.on('error', () => { /* A failed worker is reported through close/error. */ })
    child.stdin.end(JSON.stringify(payload))
  })
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

export async function parseDocx(bytes: Buffer, complete = false): Promise<object> {
  const result = await mammoth.extractRawText({ buffer: bytes })
  return { text: complete ? result.value : truncateText(result.value), warnings: result.messages.map((message) => message.message).slice(0, 20) }
}

export async function parseXlsx(bytes: Buffer, complete = false): Promise<object> {
  const workbook = new Workbook()
  // ExcelJS 4 declares its own legacy Buffer shape; the runtime accepts Node buffers.
  await workbook.xlsx.load(bytes as never)
  const sheets = workbook.worksheets.slice(0, complete ? undefined : MAX_SHEETS).map((worksheet) => {
    const rows: string[][] = []
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      // ExcelJS values are sparse: map() keeps holes, which the tool runtime
      // rejects as non-lossless JSON. Materialize blank cells explicitly.
      if (complete || rowNumber <= MAX_ROWS) rows.push(Array.from({ length: complete ? row.cellCount : Math.min(row.cellCount, MAX_COLUMNS) }, (_, index) => {
        const cell = row.getCell(index + 1)
        return cell.formula ? cell.result === undefined ? `[公式：${cell.formula}；缺少计算结果]` : cellText(cell.result) : cellText(cell.value)
      }))
    })
    return { name: worksheet.name, rowCount: worksheet.rowCount, columnCount: worksheet.columnCount, rows }
  })
  return { sheets, truncated: !complete && (workbook.worksheets.length > MAX_SHEETS || workbook.worksheets.some((sheet) => sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLUMNS)) }
}

export async function parsePdf(bytes: Buffer, complete = false): Promise<object> {
  const parser = new PDFParse({ data: bytes })
  try {
    const result = await parser.getText({ pageJoiner: '' })
    return { pageCount: result.total, text: complete ? result.text : truncateText(result.text), pages: result.pages.slice(0, complete ? undefined : 200).map((page) => ({ page: page.num, text: complete ? page.text : truncateText(page.text, 20_000) })) }
  } finally {
    await parser.destroy()
  }
}

export async function parsePptx(bytes: Buffer, complete = false): Promise<object> {
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
    return { slide: index + 1, text: complete ? text : truncateText(text, 20_000) }
  })
  const text = slides.map((slide) => slide.text).join('\n\n')
  return { slideCount: slideNames.length, text: complete ? text : truncateText(text), slides }
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

async function outputTarget(target: Target, size: number, backupPath?: string): Promise<object> {
  return { rootId: target.root.id, rootName: target.root.name, path: target.target.slice(target.root.path.length + 1).replaceAll('\\', '/'), size, ...await fileChangeReceipt(target.root.path, target.target, backupPath), ...(backupPath ? { backupPath } : {}) }
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
function truncateText(value: string, max = MAX_TEXT_CHARS): string {
  if (value.length <= max) return value
  // Use Harness' UTF-8-safe retainer so a multibyte character is never split at the cap.
  const maxBytes = Buffer.byteLength(value.slice(0, max))
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  retainer.push(value)
  const retained = retainer.finish()
  return `${retained.text}\n…内容已截断${retained.truncated ? `（省略 ${Buffer.byteLength(value) - Buffer.byteLength(retained.text)} 字节）` : ''}`
}
function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map((run: unknown) => cellText(run)).join('')
    if ('result' in value) return cellText(value.result)
    if ('text' in value) return String(value.text ?? '')
    if ('error' in value) return String(value.error)
  }
  return String(value)
}
function textWidth(value: string): number { return [...value].reduce((total, character) => total + (character.codePointAt(0)! > 255 ? 2 : 1), 0) }
function measuredWidth(values: readonly unknown[]): number { return Math.max(0, ...Array.from(values, (value) => textWidth(cellText(value)) + 2)) }
function tableArraySchema(): object { return { type: 'array', maxItems: 100, items: { type: 'array', maxItems: MAX_ROWS, items: { type: 'array', maxItems: MAX_COLUMNS, items: { type: 'string', maxLength: 20_000 } } } } }
function tablesInput(value: unknown): string[][][] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 100) throw new Error('tables is invalid'); return value.map((table) => { if (!Array.isArray(table) || table.length > MAX_ROWS) throw new Error('table rows are invalid'); return table.map((row) => { if (!Array.isArray(row) || row.length > MAX_COLUMNS || row.some((cell) => typeof cell !== 'string' || cell.length > 20_000)) throw new Error('table cells are invalid'); return row as string[] }) }) }
type WorksheetCell = string | number | boolean | null | { formula: string }
function worksheetCellSchema(): object {
  return { description: 'Literal value or explicit {formula:"SUM(A1:A3)"}. Strings stay text, including strings starting with =. Formulas have no cached result until recalculated.', anyOf: [
    { type: ['string', 'number', 'boolean', 'null'] },
    { type: 'object', properties: { formula: { type: 'string', minLength: 1, maxLength: 8192 } }, required: ['formula'], additionalProperties: false },
  ] }
}
function worksheetCellInput(value: unknown): WorksheetCell {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const input = value as Record<string, unknown>
    if (Object.keys(input).length === 1 && typeof input.formula === 'string') {
      const formula = input.formula.trim().replace(/^=/u, '').trim()
      if (formula.length > 0 && formula.length <= 8192) return { formula }
    }
  }
  throw new Error('Cell must be a literal value or {formula:"C2*D2"}; cached results are not accepted')
}
function worksheetRowsInput(value: unknown): WorksheetCell[][] {
  if (!Array.isArray(value) || value.length > MAX_ROWS) throw new Error('rows is invalid')
  return value.map((row) => {
    if (!Array.isArray(row) || row.length > MAX_COLUMNS) throw new Error('row is invalid')
    return row.map(worksheetCellInput)
  })
}
function sheetsInput(value: unknown): Array<{ name: string; rows: WorksheetCell[][] }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SHEETS) throw new Error('sheets is invalid')
  const names = new Set<string>()
  return value.map((item) => {
    const sheet = record(item), name = requiredString(sheet.name, 'sheet.name')
    if (name.length > 31 || names.has(name)) throw new Error('Sheet names must be unique and at most 31 characters')
    names.add(name)
    return { name, rows: worksheetRowsInput(sheet.rows) }
  })
}
function cellUpdatesInput(value: unknown): Array<{ sheet: string; cell: string; value: WorksheetCell }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_000) throw new Error('updates is invalid')
  return value.map((item) => {
    const update = record(item), sheet = requiredString(update.sheet, 'update.sheet'), cell = requiredString(update.cell, 'update.cell').toUpperCase()
    if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/u.test(cell)) throw new Error(`Invalid cell reference: ${cell}`)
    return { sheet, cell, value: worksheetCellInput(update.value) }
  })
}
function presentationSlidesInput(value: unknown): Array<{ title: string; bullets: string[]; speakerNotes: string }> { if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error('slides is invalid'); return value.map((item) => { const slide = record(item); return { title: requiredString(slide.title, 'slide.title'), bullets: stringArray(slide.bullets, 'slide.bullets', 30, 2_000), speakerNotes: optionalString(slide.speakerNotes, 'slide.speakerNotes', 10_000) } }) }
