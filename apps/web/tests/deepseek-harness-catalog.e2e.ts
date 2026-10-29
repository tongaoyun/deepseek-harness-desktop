/** Product overlay mounted through the real Harness Loader, with only the external product bridge replaced. */
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron, chromium, type ElectronApplication, type Locator, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, REPO_ROOT } from './support.ts'
import { prepareDevelopmentProject } from '../../desktop/scripts/development-project.ts'
import { developmentRuntimeDirectory, resolveDesktopBuildTarget } from '../../desktop/scripts/desktop-build-paths.mjs'
import { createPluginProfile } from '../../desktop/src/project-manager.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../../desktop/src/host-protocol.ts'
import { parseDesktopRelease } from '../../desktop/src/release.ts'
import type { ProductTaskCapabilities } from '@deepseek-harness/product/protocol'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { pdfFixture } from '../../../packages/client/ui-sidebar-documentpreview/tests/pdf-fixture.ts'
import { realOfficeBytes } from './office-fixture.ts'
import { closeElectronAcceptance } from '../../product-desktop/scripts/close-electron.mjs'
import { dialogWithButton, prepareNativeProductUpdate, type NativeProductUpdateQualification } from '../../product-desktop/tests/native-product-update.mjs'

const packageDir = join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product')
const expectedDir = fileURLToPath(new URL('./expected/deepseek-harness-catalog', import.meta.url))
const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-catalog')

async function openTaskKnowledge(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^(Add files or run commands|添加文件或调用指令)$/, exact: true }).click()
  await page.getByRole('option', { name: /^(Reference knowledge bases|引用知识库)/ }).click()
  await page.getByRole('dialog', { name: /^(Task knowledge bases|任务知识库)$/, exact: true }).waitFor()
}

async function cancelTaskKnowledge(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: /^(Task knowledge bases|任务知识库)$/, exact: true })
  await dialog.getByRole('button', { name: /^(Cancel|取消)$/, exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
}

async function setCodingView(page: Page, enabled: boolean): Promise<void> {
  await page.getByRole('button', { name: /^(More menu|更多菜单)$/, exact: true }).click()
  await page.getByRole('menuitem', { name: /^(Settings|设置)$/, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^(Settings|设置)$/, exact: true })
  await dialog.getByRole('button', { name: /^(General|通用设置)$/, exact: true }).click()
  const toggle = dialog.getByRole('switch', { name: /^(Show coding view|显示代码工作视图)$/, exact: true })
  if (await toggle.getAttribute('aria-checked') !== String(enabled)) await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-checked')).toBe(String(enabled))
  await dialog.getByRole('button', { name: /^(Close|关闭)$/, exact: true }).last().click()
}

const connectors = [
  { id: 'erp', displayName: 'Order management', summary: 'Orders, inventory, and fulfillment', category: 'business-systems',
    availabilityStatus: 'AVAILABLE', authMode: 'employee-bearer', status: 'ACTIVE', tools: [
      { name: 'orders_read', displayName: 'Read orders', description: 'Query order status and totals.', access: 'READ' },
      { name: 'orders_update', displayName: 'Update orders', description: 'Change order delivery details.', access: 'WRITE' },
    ] },
  { id: 'crm', displayName: 'Customer workspace', summary: 'Customer profiles and sales activity', category: 'business-systems',
    availabilityStatus: 'AUTHORIZATION_REQUIRED', authMode: 'oauth', authorizationStatus: 'REQUIRED', tools: [] },
]
const organizationKnowledge = [
  { id: 'personal-notes', name: 'Personal notes', scope: 'PERSONAL', companyId: 'fixture-company', ownerEmployeeId: 'fixture-employee', ownerName: 'Fixture user', canRead: true, canManage: true },
  { id: 'sales-policy', name: 'Sales procedures', scope: 'DEPARTMENT', companyId: 'fixture-company', ownerDepartmentId: '21', ownerName: 'Sales', canRead: true, canManage: false },
  { id: 'sales-guide', name: 'Sales playbook', scope: 'DEPARTMENT', companyId: 'fixture-company', ownerDepartmentId: '22', ownerName: 'Sales', canRead: true, canManage: false },
]
const parserDiagnostic = 'anydoc malformed archive; internal source path: /private/parser/uploads/document.docx'

function knowledgeDocuments(baseId: string, large = false) {
  return Array.from({ length: baseId === 'personal-notes' ? 21 : 2 }, (_, index) => ({
    id: `document-${index + 1}`, knowledgeBaseId: baseId,
    filename: index === 0 ? 'Order review.md' : index === 2 ? 'Office policy.docx' : index === 3 ? 'Order totals.xlsx'
      : index === 20 ? 'Handover guide.md' : `Policy ${index + 1}.pdf`,
    mediaType: index === 0 || index === 20 ? 'text/markdown' : index === 2 ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : index === 3 ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf',
    contentVersion: createHash('sha256').update(`${baseId}:document-${index + 1}:original-v1`).digest('hex'),
    sizeBytes: knowledgeOriginal(`document-${index + 1}`, large).data.byteLength, status: index === 1 ? 'FAILED' : 'READY', chunkCount: 51, updatedAt: '2026-10-10T01:00:00Z',
    ...(index === 1 ? { failureMessage: parserDiagnostic.repeat(20) } : {}),
    sourceType: index === 0 ? 'manual' : 'file', canManage: baseId === 'personal-notes',
    folderId: index === 1 ? 'folder-policies' : null,
    previewMaxBytes: 50 * 1024 * 1024, downloadMaxBytes: 250 * 1024 * 1024, uploadMaxBytes: 50 * 1024 * 1024,
  }))
}

function filteredKnowledgeDocuments(baseId: string, query = '', folderId?: string | null) {
  return knowledgeDocuments(baseId).filter(row => row.filename.toLowerCase().includes(query.toLowerCase())
    && (folderId === undefined || row.folderId === folderId))
}

async function openKnowledgeNavigation(page: Page) {
  const navigation = page.locator('[data-knowledge-navigation]')
  await navigation.waitFor({ state: 'attached' })
  if (!await navigation.isVisible()) await page.getByRole('button', { name: /^(Browse materials|浏览资料)$/, exact: true }).click()
  await navigation.waitFor({ state: 'visible' })
  return navigation
}

async function openKnowledgeFile(page: Page, name: string): Promise<void> {
  const browse = page.getByRole('button', { name: /^(Browse materials|浏览资料)$/, exact: true })
  if (await browse.isVisible() && await browse.getAttribute('aria-expanded') === 'true') await browse.click()
  const back = page.getByRole('button', { name: /^(Back to files|返回文件列表)$/, exact: true })
  if (await back.count()) await back.click()
  await page.getByRole('tab', { name: /^(All files|全部文件)$/, exact: true }).click()
  await page.locator('[data-knowledge-content]').getByRole('button', { name, exact: true }).click()
}

async function submitKnowledgeUpload(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: /^(Upload files|上传文件)$/, exact: true })
  await dialog.getByRole('button', { name: /^(Upload files|上传文件)$/, exact: true }).click()
  await dialog.getByText(/^(Uploaded; see processing status in materials|已上传，处理状态见资料列表)$/).waitFor()
  await expect.poll(() => dialog.getByRole('list').getAttribute('aria-busy')).toBe('false')
  await dialog.getByRole('button', { name: /^(Close|关闭)$/, exact: true }).last().click()
}

async function expectKnowledgeNavigationFits(navigation: Locator): Promise<void> {
  await expect.poll(async () => navigation.evaluate((element) => {
    const rect = (value: Element | null): DOMRect | undefined => value?.getBoundingClientRect()
    const heading = element.querySelector('button[aria-current="page"][class*="knowledgeLibraryRow"]')
    const tree = element.querySelector('[class*="knowledgeWorkspaceTree"]')
    const controls = tree === null ? [] : [...tree.querySelectorAll('button, input')]
    const navigationRect = element.getBoundingClientRect()
    const headingRect = rect(heading)
    const treeRect = rect(tree)
    const isInsideNavigation = (value: DOMRect | undefined): boolean => value !== undefined
      && value.width > 0 && value.height > 0
      && value.left >= navigationRect.left - 1 && value.right <= navigationRect.right + 1
    const controlsInsideNavigation = controls.length > 0 && controls.every(control => isInsideNavigation(rect(control)))
    return {
      headingHasWidth: (headingRect?.width ?? 0) > 0 && (heading?.querySelector('span')?.getBoundingClientRect().width ?? 0) > 0,
      headingIsAboveTree: headingRect !== undefined && treeRect !== undefined && headingRect.bottom <= treeRect.top + 1,
      treeInsideNavigation: isInsideNavigation(treeRect),
      controlsInsideNavigation,
      navigationOverflow: element.scrollWidth > element.clientWidth + 1,
      treeOverflow: tree !== null && tree.scrollWidth > tree.clientWidth + 1,
    }
  })).toMatchObject({
    headingHasWidth: true,
    headingIsAboveTree: true,
    treeInsideNavigation: true,
    controlsInsideNavigation: true,
    navigationOverflow: false,
    treeOverflow: false,
  })
}

async function expectKnowledgeMainFits(page: Page): Promise<void> {
  await expect.poll(async () => page.locator('[data-knowledge-content]').evaluate((element) => {
    const workspace = element.closest('[data-knowledge-workspace]')
    const workspaceWidth = workspace?.getBoundingClientRect().width ?? 0
    const layout = element.parentElement
    const grid = layout ? getComputedStyle(layout).gridTemplateColumns : ''
    return { hasOverflow: element.scrollWidth > element.clientWidth, visible: element.clientWidth > 0,
      responsiveColumns: grid.split(' ').length === (workspaceWidth <= 640 ? 1 : 2),
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, viewportWidth: window.innerWidth,
      workspaceWidth, mainWidth: element.getBoundingClientRect().width, grid,
      children: [...element.children].map(child => ({ tag: child.tagName,
        scrollWidth: child.scrollWidth, clientWidth: child.clientWidth })) }
  })).toMatchObject({ hasOverflow: false, visible: true, responsiveColumns: true })
}

function knowledgeContents(documentId: string, page: number, size: number) {
  return { items: [{ id: `${documentId}-chunk-${page}`, documentId,
    content: page === 1 ? '# Order review\n\nCheck order totals before changing delivery details.' : 'Final policy passage: preserve the audit record.',
    locator: `Section ${page}` }], page, size, total: 51 }
}

let largePdfFixture: Uint8Array | undefined
function largePdfOriginal(): Uint8Array {
  if (largePdfFixture !== undefined) return largePdfFixture
  const original = Buffer.from(pdfFixture())
  const footer = original.lastIndexOf('startxref\n')
  if (footer < 0) throw new Error('PDF fixture has no footer')
  largePdfFixture = Uint8Array.from(Buffer.concat([original.subarray(0, footer),
    Buffer.alloc(26 * 1024 * 1024, 32), original.subarray(footer)]))
  return largePdfFixture
}
function knowledgeOriginal(documentId: string, large = false): { mediaType: string; data: Uint8Array } {
  const bytes = documentId === 'document-2' && large
    ? largePdfOriginal()
    : documentId === 'document-3' ? realOfficeBytes('docx') : documentId === 'document-4' ? realOfficeBytes('xlsx')
      : documentId === 'document-1' || documentId === 'document-21' ? Buffer.from('# Order review\n\nCheck order totals before changing delivery details.\n\nFinal policy passage: preserve the audit record.')
        : pdfFixture()
  const mediaType = documentId === 'document-3' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : documentId === 'document-4' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : documentId === 'document-1' || documentId === 'document-21' ? 'text/markdown' : 'application/pdf'
  return { mediaType, data: Uint8Array.from(bytes) }
}

async function fixtureRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const value of request) {
    const chunk: unknown = value
    if (!Buffer.isBuffer(chunk)) throw new Error('Expected JSON bytes')
    chunks.push(chunk)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected JSON object')
  return value as Record<string, unknown>
}

async function expectOriginalPreviews(page: Page, prefix: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 })
  expect(await page.locator('[data-knowledge-workspace]').textContent()).not.toContain(parserDiagnostic)
  await openKnowledgeFile(page, 'Policy 2.pdf')
  const reader = page.locator('[data-knowledge-inline-reader]')
  await expectPdfPixels(page)
  expect(await reader.locator('[data-pdf-page]').count()).toBe(2)
  await reader.getByText('Selectable PDF text', { exact: true }).first().waitFor()
  expect(await reader.getByText(/^(Extracted content|解析正文)$/, { exact: true }).count()).toBe(0)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expectKnowledgeMainFits(page)
    await page.screenshot({ path: join(screenshots, `${prefix}-knowledge-original-pdf-${width}.png`), animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await openKnowledgeFile(page, 'Order totals.xlsx')
  await reader.locator('[data-excel-preview]').waitFor()
  await reader.getByText('Preview', { exact: true }).waitFor()
  await expect.poll(() => reader.locator('[data-excel-preview] canvas').first().evaluate((canvas) => {
    const element = canvas as HTMLCanvasElement
    const bounds = element.getBoundingClientRect()
    if (bounds.width < 335 || bounds.height < 50 || element.width === 0 || element.height === 0) return 0
    const scale = element.width / bounds.width
    const context = element.getContext('2d')
    if (context === null) return 0
    const pixels = context.getImageData(Math.round(55 * scale), Math.round(25 * scale),
      Math.min(Math.round(280 * scale), element.width - Math.round(55 * scale)),
      Math.min(Math.round(25 * scale), element.height - Math.round(25 * scale))).data
    let textPixels = 0
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index]! < 100 && pixels[index + 1]! < 100 && pixels[index + 2]! < 100 && pixels[index + 3]! > 200) textPixels += 1
    }
    return textPixels
  })).toBeGreaterThan(20)
  await page.screenshot({ path: join(screenshots, `${prefix}-knowledge-original-xlsx.png`), animations: 'disabled' })
  await openKnowledgeFile(page, 'Office policy.docx')
  await expect.poll(() => reader.locator('[data-pdf-page="1"] canvas').evaluate((canvas) => {
    const element = canvas as HTMLCanvasElement
    return element.width > 0 && element.height > 0
  })).toBe(true)
  await reader.getByText(prefix === 'web' ? 'Selectable PDF text' : 'Office preview 中文文档', { exact: true }).first().waitFor()
  await page.screenshot({ path: join(screenshots, `${prefix}-knowledge-original-docx.png`), animations: 'disabled' })
  await page.getByRole('button', { name: /^(Back to files|返回文件列表)$/, exact: true }).click()
}


async function expectPdfPixels(page: Page): Promise<void> {
  await expect.poll(() => page.locator('[data-knowledge-inline-reader] [data-pdf-page="1"] canvas').evaluate((canvas) => {
    const element = canvas as HTMLCanvasElement
    if (element.width === 0 || element.height === 0) return false
    const pixels = element.getContext('2d')?.getImageData(Math.floor(element.width / 2), Math.floor(element.height / 2), 1, 1).data
    return pixels !== undefined && pixels[3] === 255 && pixels[0]! - pixels[2]! > 150
  })).toBe(true)
}

async function expectLargeOriginalPreview(page: Page, prefix: string): Promise<void> {
  await openKnowledgeFile(page, 'Policy 2.pdf')
  await page.locator('[data-knowledge-inline-reader] [data-pdf-page="1"] canvas').waitFor({ timeout: 60_000 })
  await expectPdfPixels(page)
  await page.locator('[data-knowledge-inline-reader]').getByText('Selectable PDF text', { exact: true }).first().waitFor()
  await page.screenshot({ path: join(screenshots, `${prefix}-knowledge-original-large-pdf.png`), animations: 'disabled' })
  await page.getByRole('button', { name: /^(Back to files|返回文件列表)$/, exact: true }).click()
}


async function expectLayout(page: Page, catalog: string, columns: number): Promise<void> {
  await expect.poll(() => page.locator(`ul[data-catalog='${catalog}']`).evaluate(grid =>
    getComputedStyle(grid).gridTemplateColumns.split(' ').length)).toBe(columns)
  const overflow = await page.locator('#deepseek-harness-catalog-results').evaluate((region) => {
    const box = region.getBoundingClientRect()
    return [...region.querySelectorAll('li, button, input')].filter((element) => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && (rect.left < box.left - 1 || rect.right > box.right + 1
        || element.scrollWidth > element.clientWidth + 1)
    }).map(element => element.textContent?.trim())
  })
  expect(overflow).toEqual([])
  const cardPaint = await page.locator(`li[data-catalog='${catalog}']`).first().evaluate((card) => {
    const style = getComputedStyle(card)
    return { border: style.borderTopStyle, width: Number.parseFloat(style.borderTopWidth),
      missingTokens: ['--dsw-alias-border-l2', '--dsw-alias-border-l4', '--dsw-alias-bg-module-platform',
        '--dsw-alias-state-error-primary'].filter(token => style.getPropertyValue(token).trim() === '') }
  })
  expect(cardPaint.border).toBe('solid')
  expect(cardPaint.width).toBeGreaterThan(0)
  expect(cardPaint.missingTokens).toEqual([])
}

it('keeps a cited XLSX original visible inside the source modal on desktop and narrow viewports', async () => {
  const source = { sourceId: 'sheet-source', knowledgeBaseId: 'personal-notes', knowledgeBaseName: 'Personal notes',
    documentId: 'document-4', filename: 'Order totals.xlsx', locator: 'Preview!A1' }
  const session = Session.create(SessionId('knowledge-source-preview-fixture'))
  const callId = ToolCallId('knowledge-source-preview-call')
  const args = JSON.stringify({ query: 'office preview' })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Find the spreadsheet source.' }],
    source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createAssistantMessage({
    content: [{ type: 'tool-call', id: callId, name: 'knowledge_search', arguments: args }],
    source: { provider: 'fixture', model: 'fixture' },
  }) }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'knowledge_search', arguments: args })
  session.append('tool/result', { turn: 1, step: 1, meta: { kind: 'product-knowledge-sources-v1', sources: [source] },
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Recorded spreadsheet source' }], isError: false }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const fixture = [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
    cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: join(packageDir, 'cordis.patch.yml') })
  onTestFinished(() => scaffold.close())
  await seedSession(scaffold, fixture, 'knowledge-source-preview')
  const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath, args: ['--disable-crashpad-for-testing'] })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  page.setDefaultTimeout(15_000)
  const calls: string[] = []
  const file = knowledgeOriginal(source.documentId)
  await page.exposeFunction('__sourcePreviewInvoke', (method: string) => {
    calls.push(method)
    switch (method) {
      case 'auth.getSession': return { authenticated: true }
      case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
      case 'knowledge.sources.read': return { ...source, content: 'Office preview spreadsheet passage.' }
      case 'knowledge.documents.previewMetadata': return knowledgeDocuments(source.knowledgeBaseId).find(row => row.id === source.documentId)
      case 'knowledge.documents.preview.open': return { transferId: 'sheet-transfer', fileName: source.filename, mediaType: file.mediaType,
        byteLength: file.data.byteLength, maxBytes: 50 * 1024 * 1024, chunkSize: 256 * 1024 }
      case 'knowledge.documents.preview.read': return { data: [...file.data], offset: 0, eof: true }
      case 'knowledge.documents.preview.close': return { closed: true }
      default: throw new Error(`Unexpected source preview method: ${method}`)
    }
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __sourcePreviewInvoke(method: string): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string) => {
        let result = await api.__sourcePreviewInvoke(method)
        if (method === 'knowledge.documents.preview.read' && typeof result === 'object' && result !== null
          && 'data' in result && Array.isArray(result.data)) result = { ...result, data: Uint8Array.from(result.data) }
        return { ok: true, result }
      }, cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await mkdir(screenshots, { recursive: true })
  onTestFinished(async ({ task }) => {
    if (task.result?.state === 'fail') await page.screenshot({ path: join(screenshots, 'knowledge-source-modal-failure.png') })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.locator('[role="treeitem"]').first().click()
  await page.locator('[role="treeitem"]').nth(1).click()
  const row = page.locator('[data-tool="knowledge_search"]')
  await expandOwningTurnProcess(page, row)
  await row.getByText('Search knowledge', { exact: true }).click()
  await row.getByRole('button', { name: source.filename, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: source.filename, exact: true })
  await dialog.getByText('Office preview spreadsheet passage.', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'View original file', exact: true }).click()
  await dialog.locator('[data-excel-preview]').waitFor()
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 600 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport)
    await expect.poll(() => dialog.locator('[data-excel-preview] canvas').first().evaluate((canvas) => {
      const element = canvas as HTMLCanvasElement
      const bounds = element.getBoundingClientRect()
      if (bounds.width < 200 || bounds.height < 100 || element.width === 0 || element.height === 0) return 0
      const scale = element.width / bounds.width
      const context = element.getContext('2d')
      if (context === null) return 0
      const x = Math.round(55 * scale)
      const y = Math.round(25 * scale)
      const pixels = context.getImageData(x, y, Math.min(Math.round(280 * scale), element.width - x),
        Math.min(Math.round(25 * scale), element.height - y)).data
      let textPixels = 0
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index]! < 100 && pixels[index + 1]! < 100 && pixels[index + 2]! < 100 && pixels[index + 3]! > 200) textPixels += 1
      }
      return textPixels
    })).toBeGreaterThan(20)
    expect(await dialog.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const viewport = element.querySelector('[data-knowledge-original-viewport]')?.getBoundingClientRect()
      const header = element.querySelector('header')?.getBoundingClientRect()
      const footer = element.querySelector('footer')?.getBoundingClientRect()
      return bounds.top >= 23 && bounds.bottom <= window.innerHeight - 23 && element.scrollWidth <= element.clientWidth
        && viewport !== undefined && viewport.height > 150 && header !== undefined && footer !== undefined
        && viewport.top >= header.bottom && viewport.bottom <= footer.top + 1
    })).toBe(true)
    await page.screenshot({ path: join(screenshots, `knowledge-source-modal-xlsx-${viewport.width}-${viewport.height}.png`), animations: 'disabled' })
  }
  expect(await dialog.getByText(source.locator, { exact: true }).count()).toBe(1)
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  expect(calls.filter(method => method === 'knowledge.documents.preview.close')).toHaveLength(1)
  expect(calls).not.toContain('knowledge.documents.preview.renderOffice')
  expect(tripwire.pageErrors).toEqual([])
})

it('keeps native themes and responsive catalogs while using official details and composer actions', async () => {
  const scaffold = await launchWebScaffold({
    firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
  // System Chrome's Crashpad can keep process pipes open after browser exit.
  const browser = await chromium.launch(executablePath === undefined ? {} : {
    executablePath, args: ['--disable-crashpad-for-testing'],
  })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  onTestFinished(async ({ task }) => {
    if (task.result?.state !== 'fail') return
    await page.screenshot({ path: join(screenshots, 'failure.png') })
    console.error('Catalog workflow failure:', await page.locator('body').innerText(), tripwire)
  })
  const calls: string[] = []
  const uploadModes: string[] = []
  const uploadFolders: (string | null | undefined)[] = []
  const fileTransfers = new Map<string, { readonly mediaType: string; readonly data: Uint8Array }>()
  let transferSequence = 0
  let largePreview = false
  const newPersonalBases: Record<string, unknown>[] = []
  const managedFolders: { id: string; name: string; parentId: string | null; updatedAt: string }[] = [{
    id: 'folder-policies', name: 'Policies', parentId: null, updatedAt: '2026-10-10T01:00:00Z',
  }]
  const materialRequests: {
    readonly knowledgeBaseId?: string
    readonly documentId?: string
    readonly query?: string
    readonly page?: number
    readonly size?: number
    readonly folderId?: string | null
  }[] = []
  let connectorCatalog: readonly Record<string, unknown>[] = structuredClone(connectors)
  let capabilities: ProductTaskCapabilities = { knowledgeBaseIds: [] }
  const personalResources: Record<string, unknown>[] = []
  let failSave = true
  await page.exposeFunction('__productInvoke', (method: string, payload?: { sessionId?: string; revision?: number; id?: string; name?: string; kind?: string; version?: string; draft?: Record<string, unknown>; basePresetId?: string; knowledgeBaseIds?: string[]; knowledgeBaseId?: string; documentId?: string; query?: string; page?: number; size?: number; folderId?: string | null; parentId?: string | null; pdfParseMode?: string; rendered?: boolean; transferId?: string; offset?: number }): unknown => {
    calls.push(method)
    switch (method) {
      case 'auth.getSession': return { authenticated: true }
      case 'tasks.capabilities.read': return capabilities
      case 'tasks.capabilities.prepare': {
        capabilities = { ...capabilities, knowledgeBaseIds: payload?.knowledgeBaseIds ?? capabilities.knowledgeBaseIds }
        return { kind: 'CURRENT_SESSION', presetId: 'standard', capabilities, dependencyChecks: [] }
      }
      case 'connectors.list': return [...connectorCatalog, ...personalResources.filter(row => row.kind === 'connector')]
      case 'extensions.save': {
        if (failSave) { failSave = false; throw new Error('Transient fixture save failure') }
        personalResources.push({ ...payload, headers: {}, environment: {}, canEdit: true, canSubmit: true, canDelete: true, visibility: 'PERSONAL', reviewStatus: 'DRAFT' })
        return { kind: 'connector', id: payload?.id, version: payload?.version, visibility: 'PERSONAL' }
      }
      case 'extensions.connector.read': {
        const resource = personalResources.find(row => row.id === payload?.id)
        const fields = Object.fromEntries(Object.entries(resource ?? {}).filter(([key]) =>
          !['canEdit', 'canSubmit', 'canDelete', 'visibility', 'reviewStatus'].includes(key)))
        return { draft: { ...fields, version: '1.0.1', headers: { 'X-Api-Key': '' } }, configured: true, savePending: false }
      }
      case 'extensions.connector.update': {
        if (failSave) { failSave = false; throw new Error('Transient fixture save failure') }
        const resource = personalResources.find(row => row.id === payload?.id)
        if (!resource) throw new Error('Missing connector')
        Object.assign(resource, payload?.draft, { headers: {}, environment: {} })
        return { kind: 'connector', id: resource.id, version: resource.version, visibility: 'PERSONAL' }
      }
      case 'extensions.connector.delete': {
        const index = personalResources.findIndex(row => row.id === payload?.id)
        if (index < 0) throw new Error('Missing connector')
        personalResources.splice(index, 1)
        return { id: payload?.id, removed: true }
      }
      case 'extensions.submit': {
        const resource = personalResources.find(row => row.id === payload?.id)
        if (!resource) throw new Error('Missing resource')
        Object.assign(resource, { canSubmit: false, reviewStatus: 'SUBMITTED' })
        return { submitted: true }
      }
      case 'catalog.refresh': return undefined
      case 'knowledge.bases.list': return [...organizationKnowledge, ...newPersonalBases,
        { id: 'playbook', name: 'Operations playbook', scope: 'COMPANY', companyId: 'fixture-company', ownerName: 'Fixture company', canRead: true, canManage: false }]
      case 'knowledge.bases.create': {
        const base = { id: 'created-personal', name: payload?.name, scope: 'PERSONAL', ownerEmployeeId: 'fixture-employee', canRead: true, canManage: true }
        newPersonalBases.push(base)
        return base
      }
      case 'knowledge.bases.delete': {
        const index = newPersonalBases.findIndex(base => base.id === payload?.knowledgeBaseId)
        if (index < 0) throw new Error('Unknown personal library')
        newPersonalBases.splice(index, 1)
        return undefined
      }
      case 'knowledge.references.resolve': return [{ reference: 'company:playbook', status: 'RESOLVED', base: {
        id: 'playbook', name: 'Operations playbook', scope: 'COMPANY', companyId: 'fixture-company', ownerName: 'Fixture company',
      } }]
      case 'knowledge.documents.list': {
        materialRequests.push({ ...payload })
        const page = payload?.page ?? 1
        const size = payload?.size ?? 20
        const documents = filteredKnowledgeDocuments(payload?.knowledgeBaseId ?? '', payload?.query, payload?.folderId)
        return { items: documents.slice((page - 1) * size, page * size), page, size, total: documents.length }
      }
      case 'knowledge.folders.get': {
        const folder = managedFolders.find(row => row.id === payload?.folderId)
        if (!folder) throw new Error('Missing managed folder')
        return folder
      }
      case 'knowledge.folders.list': {
        const page = payload?.page ?? 1
        const size = payload?.size ?? 100
        const folders = managedFolders.filter(row => row.parentId === (payload?.parentId ?? null))
        return { items: folders.slice((page - 1) * size, page * size), page, size, total: folders.length }
      }
      case 'knowledge.folders.create': {
        const folder = { id: `created-folder${managedFolders.some(folder => folder.id === 'created-folder') ? '-child' : ''}`, name: payload?.name ?? '', parentId: payload?.parentId ?? null, updatedAt: '2026-10-10T01:00:00Z' }
        managedFolders.push(folder)
        return folder
      }
      case 'knowledge.folders.rename': {
        const folder = managedFolders.find(row => row.id === payload?.folderId)
        if (!folder) throw new Error('Missing managed folder')
        folder.name = payload?.name ?? ''
        return folder
      }
      case 'knowledge.folders.delete': {
        const index = managedFolders.findIndex(row => row.id === payload?.folderId)
        if (index < 0) throw new Error('Missing managed folder')
        managedFolders.splice(index, 1)
        return { folderId: payload?.folderId, deleted: true }
      }
      case 'knowledge.documents.upload.pending': return []
      case 'knowledge.documents.upload.select': uploadModes.push(payload?.pdfParseMode ?? 'STANDARD'); uploadFolders.push(payload?.folderId); return []
      case 'knowledge.documents.read': return knowledgeContents(payload?.documentId ?? '', payload?.page ?? 1, payload?.size ?? 50)
      case 'knowledge.documents.preview.open': {
        const file = payload?.rendered ? { mediaType: 'application/pdf', data: Uint8Array.from(pdfFixture()) }
          : knowledgeOriginal(payload?.documentId ?? '', largePreview)
        const transferId = `file-${++transferSequence}`
        fileTransfers.set(transferId, file)
        return { transferId, fileName: 'fixture', mediaType: file.mediaType, byteLength: file.data.byteLength,
          maxBytes: payload?.rendered ? 100 * 1024 * 1024 : 50 * 1024 * 1024, chunkSize: 256 * 1024 }
      }
      case 'knowledge.documents.preview.read': {
        const file = fileTransfers.get(payload?.transferId ?? '')
        if (!file) throw new Error('Missing transfer')
        const offset = payload?.offset ?? 0
        const data = file.data.slice(offset, offset + 256 * 1024)
        if (file.data.byteLength > 25 * 1024 * 1024) {
          // Playwright bindings serialize numeric arrays through JSON; generate fixture padding in the browser.
          const paddingStart = Buffer.from(pdfFixture()).lastIndexOf('startxref\n')
          return { fixtureChunk: { byteLength: data.byteLength,
            leading: [...data.slice(0, Math.max(0, paddingStart - offset))],
            trailing: [...data.slice(Math.max(0, paddingStart + 26 * 1024 * 1024 - offset))] },
          offset, eof: offset + data.byteLength === file.data.byteLength }
        }
        return { data: [...data], offset, eof: offset + data.byteLength === file.data.byteLength }
      }
      case 'knowledge.documents.preview.close': fileTransfers.delete(payload?.transferId ?? ''); return { closed: true }
      case 'knowledge.documents.download': return { cancelled: false }
      case 'knowledge.documents.previewMetadata': return knowledgeDocuments(payload?.knowledgeBaseId ?? '').find(row => row.id === payload?.documentId)
      case 'knowledge.documents.get': return { ...knowledgeDocuments(payload?.knowledgeBaseId ?? '').find(row => row.id === payload?.documentId), manualContent: '# Order review\n\nKeep the original evidence.' }
      case 'knowledge.search': return [{ sourceId: 'policy-source', documentId: 'document-1', filename: 'Order review.md',
        content: 'Check order totals before changing delivery details.', locator: 'Section 1' }]
      case 'knowledge.sources.read': return { sourceId: 'policy-source', documentId: 'document-1', filename: 'Order review.md',
        content: 'Check order totals before changing delivery details.', locator: 'Section 1' }
      default: throw new Error(`Unexpected external product method: ${method}`)
    }
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & {
      __productInvoke(method: string, payload?: unknown): Promise<unknown>
    }
    const listeners = new Set<(event: { type: string }) => void>()
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string, payload?: unknown) => {
        let result = await api.__productInvoke(method, payload)
        if (method === 'knowledge.documents.preview.read' && typeof result === 'object' && result !== null && 'data' in result && Array.isArray(result.data)) {
          result = { ...result, data: Uint8Array.from(result.data) }
        }
        if (method === 'knowledge.documents.preview.read' && typeof result === 'object' && result !== null && 'fixtureChunk' in result) {
          const fixture = result.fixtureChunk as { byteLength: number; leading: number[]; trailing: number[] }
          const data = new Uint8Array(fixture.byteLength).fill(32)
          data.set(fixture.leading, 0)
          data.set(fixture.trailing, fixture.byteLength - fixture.trailing.length)
          const { fixtureChunk: _fixture, ...progress } = result
          result = { ...progress, data }
        }
        return { ok: true, result }
      },
      cancel: () => {},
      subscribe: (_namespace: string, listener: (event: { type: string }) => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    } } })
  })
  await mkdir(screenshots, { recursive: true })
  await mkdir(expectedDir, { recursive: true })
  await page.goto(scaffold.authenticatedUrl)
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.fill('Design an API for order review.')
  const originalSession = await page.locator('[data-conversation-session]').last().getAttribute('data-conversation-session')
  const snapshot = async (name: string, selector = '#deepseek-harness-catalog-results'): Promise<void> => {
    await compareOrRefreshGolden(join(expectedDir, `${name}.expected.md`),
      await captureStableAria(page, selector, scaffold.workspaceCwd), webSnapshotMode())
  }

  await snapshot('extension-navigation', 'nav[aria-label="Global panels"]')

  for (const [label, sectionId] of [['Expert kits', 'agency-agents'], ['Skills', 'skills-manager']] as const) {
    await page.getByRole('button', { name: label, exact: true }).click()
    const unavailable = page.locator(`[data-extension-page="${sectionId}"]`).getByRole('alert')
    await unavailable.getByText('This extension page is unavailable. Enable the plugin in Settings and try again.', { exact: true }).waitFor()
    expect(await page.getByRole('dialog', { name: 'Settings', exact: true }).count()).toBe(0)
  }
  await page.locator(`[data-row-key="session:${originalSession}"]`).click()
  expect(await composer.textContent()).toBe('Design an API for order review.')

  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      for (const [label, catalog] of [['Connectors', 'connectors']] as const) {
        await page.getByRole('button', { name: label, exact: true }).click()
        await page.locator(`ul[data-catalog='${catalog}']`).waitFor()
        await expectLayout(page, catalog, viewport.width === 390 ? 1 : 2)
        await page.screenshot({ path: join(screenshots, `${catalog}-${theme}-${viewport.width}.png`) })
        if (theme === 'light' && viewport.width === 1440) await snapshot(catalog)
      }
      await page.getByRole('button', { name: 'Knowledge bases', exact: true }).click()
      const knowledgeList = await openKnowledgeNavigation(page)
      await knowledgeList.getByRole('button', { name: 'Sales procedures', exact: true }).waitFor()
      await knowledgeList.getByRole('heading', { name: 'Sales (21)', exact: true }).waitFor()
      await knowledgeList.getByRole('heading', { name: 'Sales (22)', exact: true }).waitFor()
      await knowledgeList.getByRole('button', { name: 'Policies', exact: true }).waitFor()
      await expectKnowledgeNavigationFits(knowledgeList)
      expect(await page.locator('[data-knowledge-workspace]').evaluate(region => region.scrollWidth > region.clientWidth)).toBe(false)
      await page.screenshot({ path: join(screenshots, `knowledge-${theme}-${viewport.width}.png`) })
      if (theme === 'light' && viewport.width === 1440) await snapshot('knowledge', '[data-knowledge-navigation]')
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Connectors', exact: true }).click()
  await page.locator('ul[data-catalog="connectors"]').waitFor()
  await snapshot('connector-directory', '[class*="catalogPage"]')
  const beforeFilter = calls.filter(method => method === 'tasks.capabilities.prepare').length
  await page.getByRole('tab', { name: 'Connected 1', exact: true }).click()
  expect(await page.getByText('Customer workspace', { exact: true }).count()).toBe(0)
  expect(calls.filter(method => method === 'tasks.capabilities.prepare')).toHaveLength(beforeFilter)
  await page.getByRole('tab', { name: 'Connected 1', exact: true }).press('ArrowLeft')
  await page.getByText('Customer workspace', { exact: true }).waitFor()
  await page.getByRole('button', { name: /Order management Orders/ }).click()
  const connectorDialog = page.getByRole('dialog', { name: 'Connector details' })
  await connectorDialog.waitFor()
  await snapshot('connector-detail', '[role="dialog"]')
  for (const expanded of [false, true]) {
    if (expanded) {
      await page.getByText('View capabilities (2)', { exact: true }).click()
      expect(await connectorDialog.getByText('Read orders', { exact: true }).first().isVisible()).toBe(true)
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await connectorDialog.evaluate(async (dialog) => {
        await Promise.all(dialog.getAnimations().map(animation => animation.finished))
      })
      const bounds = await connectorDialog.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      expect(await connectorDialog.evaluate(dialog => dialog.scrollWidth > dialog.clientWidth)).toBe(false)
      await page.screenshot({ path: join(screenshots, `connector-detail-dark-${width}-${expanded ? 'expanded' : 'collapsed'}.png`) })
    }
    await page.setViewportSize({ width: 1440, height: 900 })
  }
  await page.keyboard.press('Escape')
  await page.locator(`[data-row-key="session:${originalSession}"]`).click()
  expect(await composer.textContent()).toBe('Design an API for order review.')
  await openTaskKnowledge(page)
  const knowledgeDialog = page.getByRole('dialog', { name: 'Task knowledge bases' })
  await knowledgeDialog.getByRole('checkbox', { name: 'Operations playbook' }).waitFor()
  await knowledgeDialog.getByRole('heading', { name: 'Department · Sales (21)', exact: true }).waitFor()
  await knowledgeDialog.getByRole('heading', { name: 'Department · Sales (22)', exact: true }).waitFor()
  await snapshot('task-knowledge', '[role="dialog"]')
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await knowledgeDialog.evaluate(async (dialog) => {
      await Promise.all(dialog.getAnimations().map(animation => animation.finished))
    })
    expect(await knowledgeDialog.evaluate(dialog => dialog.scrollWidth > dialog.clientWidth)).toBe(false)
    await page.screenshot({ path: join(screenshots, `task-knowledge-${width}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await cancelTaskKnowledge(page)
  await page.getByRole('button', { name: 'Connectors', exact: true }).click()
  await page.getByRole('button', { name: /Order management Orders/ }).click()
  expect(await connectorDialog.getByRole('checkbox').count()).toBe(0)
  await page.keyboard.press('Escape')
  connectorCatalog = connectorCatalog.map(connector => connector.id === 'erp' ? {
    ...connector, authMode: 'oauth', authorizationStatus: 'EXPIRED', availabilityStatus: 'AUTHORIZATION_REQUIRED', status: 'UNAVAILABLE',
  } : connector)
  await page.getByRole('button', { name: 'Connectors', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByRole('button', { name: /Order management Orders/ }).click()
  expect(await connectorDialog.getByRole('checkbox').count()).toBe(0)
  await snapshot('connector-expired', '[role="dialog"]')
  await page.keyboard.press('Escape')
  connectorCatalog = structuredClone(connectors)
  await page.getByRole('button', { name: 'Connectors', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByRole('button', { name: /Order management Orders/ }).click()
  expect(await connectorDialog.getByRole('checkbox').count()).toBe(0)
  await snapshot('connector-required', '[role="dialog"]')
  await connectorDialog.evaluate(async (dialog) => {
    await Promise.all(dialog.getAnimations().map(animation => animation.finished))
  })
  await page.screenshot({ path: join(screenshots, 'connector-required-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await connectorDialog.evaluate(dialog => dialog.scrollWidth > dialog.clientWidth)).toBe(false)
  await page.screenshot({ path: join(screenshots, 'connector-required-mobile.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Knowledge bases', exact: true }).click()
  await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Operations playbook', exact: true }).click()
  const materials = page.locator('[data-knowledge-content]')
  await materials.getByRole('button', { name: 'Order review.md', exact: true }).waitFor()
  expect(await page.getByRole('checkbox').count()).toBe(0)
  expect(await materials.getByRole('button', { name: /^(Upload files|New)$/, exact: true }).count()).toBe(0)
  expect(await materials.getByRole('button', { name: /^Actions for/ }).count()).toBe(1)
  expect(await page.getByRole('dialog').count()).toBe(0)
  await snapshot('knowledge-detail', '[data-knowledge-workspace]')
  const beforeMaterials = calls.filter(method => method === 'tasks.capabilities.prepare').length
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expectKnowledgeMainFits(page)
    await page.screenshot({ path: join(screenshots, `knowledge-materials-readonly-${width}.png`), animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await openKnowledgeFile(page, 'Order review.md')
  const contentReader = page.locator('[data-knowledge-inline-reader]')
  await contentReader.getByText('Check order totals before changing delivery details.', { exact: true }).waitFor()
  await contentReader.getByRole('heading', { name: 'Order review', exact: true }).waitFor()
  await contentReader.getByText('Final policy passage: preserve the audit record.', { exact: true }).waitFor()
  expect(await contentReader.getByText('Extracted content', { exact: true }).count()).toBe(0)
  expect(calls.filter(method => method === 'knowledge.documents.read')).toEqual([])
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.getByRole('dialog').count()).toBe(0)
    await expectKnowledgeMainFits(page)
    expect(await page.locator('[data-knowledge-workspace]').evaluate(region => region.scrollWidth > region.clientWidth)).toBe(false)
    await page.screenshot({ path: join(screenshots, `knowledge-inline-reader-${width}.png`), animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Sales procedures', exact: true }).click()
  await materials.getByRole('button', { name: 'Order review.md', exact: true }).waitFor()
  expect(await contentReader.count()).toBe(0)
  await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Policies', exact: true }).click()
  await materials.getByRole('button', { name: 'Policy 2.pdf', exact: true }).waitFor()
  expect(await materials.getByRole('button', { name: 'Order review.md', exact: true }).count()).toBe(0)
  expect(materialRequests.at(-1)).toMatchObject({ knowledgeBaseId: 'sales-policy', folderId: 'folder-policies' })
  await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Personal notes', exact: true }).click()
  const personalMaterials = page.locator('[data-knowledge-content]')
  await personalMaterials.getByRole('button', { name: 'Order review.md', exact: true }).waitFor()
  expect(await personalMaterials.getByRole('button', { name: 'Upload files', exact: true }).isVisible()).toBe(true)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await personalMaterials.getByRole('button', { name: 'Upload files', exact: true }).click()
    const uploadMenu = page.getByRole('menu')
    await uploadMenu.getByRole('menuitem', { name: 'Upload text PDF (text layer, no OCR)', exact: true }).waitFor()
    expect(await uploadMenu.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
    await page.screenshot({ path: join(screenshots, `knowledge-upload-menu-${width}.png`), animations: 'disabled' })
    await page.keyboard.press('Escape')
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  for (const label of ['Upload file (standard parsing)', 'Upload text PDF (text layer, no OCR)']) {
    await personalMaterials.getByRole('button', { name: 'Upload files', exact: true }).click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
    await expect.poll(() => personalMaterials.getByRole('button', { name: 'Upload files', exact: true }).isEnabled()).toBe(true)
  }
  expect(uploadModes).toEqual(['STANDARD', 'TEXT'])
  await page.getByRole('tab', { name: 'All files', exact: true }).click()
  await personalMaterials.getByRole('button', { name: 'Next page', exact: true }).click()
  await personalMaterials.getByRole('button', { name: 'Handover guide.md', exact: true }).waitFor()
  expect(materialRequests.at(-1)).toMatchObject({ knowledgeBaseId: 'personal-notes', page: 2, size: 20 })
  await page.locator('[data-knowledge-content]').getByRole('searchbox').fill('handover')
  await page.locator('[data-knowledge-content]').getByRole('button', { name: 'Search', exact: true }).click()
  await expect.poll(() => personalMaterials.getByRole('row').count()).toBe(2)
  expect(materialRequests.at(-1)).toMatchObject({ knowledgeBaseId: 'personal-notes', query: 'handover', page: 1 })
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expectKnowledgeMainFits(page)
    await page.screenshot({ path: join(screenshots, `knowledge-materials-manager-${width}.png`), animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('[data-knowledge-content]').getByRole('searchbox').fill('')
  await page.locator('[data-knowledge-content]').getByRole('button', { name: 'Search', exact: true }).click()
  await personalMaterials.getByRole('button', { name: 'Order review.md', exact: true }).waitFor()
  await expectOriginalPreviews(page, 'web')
  largePreview = true
  const chunksBeforeLarge = calls.filter(method => method === 'knowledge.documents.preview.read').length
  try { await expectLargeOriginalPreview(page, 'web') }
  catch (error) {
    console.error('Large PDF preview diagnostics', { methods: calls.slice(-15),
      reads: calls.filter(method => method === 'knowledge.documents.preview.read').length - chunksBeforeLarge,
      transfers: [...fileTransfers].map(([id, file]) => ({ id, byteLength: file.data.byteLength })),
      reader: await page.locator('[data-knowledge-inline-reader]').textContent() })
    throw error
  }
  expect(calls.filter(method => method === 'knowledge.documents.preview.read').length - chunksBeforeLarge).toBeGreaterThan(100)
  largePreview = false
  expect(calls.filter(method => method === 'knowledge.documents.read')).toEqual([])
  await personalMaterials.getByRole('button', { name: /^Actions for.*Order review\.md/ }).click()
  await page.getByRole('menuitem', { name: 'Modify', exact: true }).click()
  const documentEditor = page.getByRole('dialog', { name: 'Edit document', exact: true })
  await expect.poll(() => documentEditor.getByRole('textbox', { name: 'Content', exact: true }).inputValue())
    .toBe('# Order review\n\nKeep the original evidence.')
  await documentEditor.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(calls.filter(method => method === 'tasks.capabilities.prepare')).toHaveLength(beforeMaterials)
  const knowledgeWrites = /^knowledge\.(documents\.(save|delete|move|reindex|importUrl)|folders\.(create|rename|delete))$/u
  expect(calls.filter(method => knowledgeWrites.test(method))).toEqual([])
  await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'New personal knowledge base', exact: true }).click()
  const baseEditor = page.getByRole('dialog', { name: 'New personal knowledge base', exact: true })
  await baseEditor.getByRole('textbox', { name: 'Knowledge base name', exact: true }).fill('Personal project files')
  await baseEditor.getByRole('button', { name: 'Create', exact: true }).click()
  await expect.poll(async () => (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Personal project files', exact: true }).getAttribute('aria-current')).toBe('page')
  await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'New folder', exact: true }).click()
  const folderEditor = page.getByRole('dialog', { name: 'New folder', exact: true })
  await folderEditor.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Project evidence')
  await folderEditor.getByRole('button', { name: 'Save', exact: true }).click()
  await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Project evidence', exact: true }).waitFor()
  await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Folder actions for Project evidence', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rename folder', exact: true }).click()
  const renameEditor = page.getByRole('dialog', { name: 'Rename folder', exact: true })
  await renameEditor.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Project records')
  await renameEditor.getByRole('button', { name: 'Save', exact: true }).click()
  await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Project records', exact: true }).click()
  await personalMaterials.getByRole('button', { name: 'Upload files', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Upload file (standard parsing)', exact: true }).click()
  await expect.poll(() => uploadFolders.at(-1)).toBe('created-folder')
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const tree = await openKnowledgeNavigation(page)
    await tree.getByRole('button', { name: 'Folder actions for Project records', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Rename folder', exact: true }).waitFor()
    expect(await page.getByRole('menuitem', { name: 'New folder', exact: true }).count()).toBe(0)
    expect(await page.getByRole('menu').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
    await page.screenshot({ path: join(screenshots, `knowledge-folder-actions-${width}.png`), animations: 'disabled' })
    await page.keyboard.press('Escape')
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Folder actions for Project records', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New subfolder', exact: true }).click()
  const subfolderEditor = page.getByRole('dialog', { name: 'New folder', exact: true })
  await expect.poll(() => subfolderEditor.getByRole('button', { name: 'Project records', exact: true }).getAttribute('aria-current')).toBe('page')
  await subfolderEditor.getByRole('textbox', { name: 'Folder name', exact: true }).fill('October')
  await subfolderEditor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await openKnowledgeNavigation(page)).getByRole('button', { name: 'October', exact: true }).getAttribute('aria-current')).toBe('page')
  expect(await personalMaterials.getByRole('navigation').textContent()).toContain('Project records')
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const tree = await openKnowledgeNavigation(page)
    await expectKnowledgeNavigationFits(tree)
    await page.screenshot({ path: join(screenshots, `knowledge-nested-folders-${width}.png`), animations: 'disabled' })
    await tree.getByRole('button', { name: 'October', exact: true }).click()
    await expectKnowledgeMainFits(page)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Folder actions for October', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete folder', exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete folder', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect.poll(async () => (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Project records', exact: true }).getAttribute('aria-current')).toBe('page')
  await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Folder actions for Project records', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete folder', exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete folder', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect.poll(async () => (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Project records', exact: true }).count()).toBe(0)
  await personalMaterials.getByRole('button', { name: /^Actions for.*Order review\.md/ }).click()
  expect(await page.getByRole('menuitem', { name: 'Open in system app', exact: true }).count()).toBe(0)
  await page.getByRole('menuitem', { name: 'Download original file', exact: true }).click()
  expect(calls.filter(method => method === 'knowledge.documents.download')).toHaveLength(1)
  expect(fileTransfers.size).toBe(0)
  expect(calls.filter(method => method === 'tasks.capabilities.prepare')).toHaveLength(beforeMaterials)
  await page.keyboard.press('Escape')
  const knowledgeNavigation = await openKnowledgeNavigation(page)
  await knowledgeNavigation.getByRole('button', { name: 'Sales procedures', exact: true }).click()
  await knowledgeNavigation.getByRole('button', { name: 'Actions for “Personal project files”', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete knowledge base', exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete knowledge base', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect.poll(() => knowledgeNavigation.getByRole('button', { name: 'Personal project files', exact: true }).count()).toBe(0)
  expect(await knowledgeNavigation.getByRole('button', { name: 'Sales procedures', exact: true }).getAttribute('aria-current')).toBe('page')
  expect(newPersonalBases).toHaveLength(0)
  expect(calls.filter(method => method === 'tasks.capabilities.prepare')).toHaveLength(beforeMaterials)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const navigation = await openKnowledgeNavigation(page)
    expect(await navigation.getByRole('button', { name: 'Sales procedures', exact: true }).getAttribute('aria-current')).toBe('page')
    await page.screenshot({ path: join(screenshots, `knowledge-unrelated-delete-${width}.png`), animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('[data-row-key^="session:"]').first().click()
  await openTaskKnowledge(page)
  await page.getByRole('checkbox', { name: 'Operations playbook' }).click()
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect.poll(() => capabilities.knowledgeBaseIds).toEqual(['playbook'])
  const selectedKnowledge = page.locator('[data-composer-card]').getByRole('button', { name: 'Operations playbook', exact: true })
  await selectedKnowledge.waitFor()
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => selectedKnowledge.evaluate((button) => {
      const bounds = button.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= window.innerWidth && button.scrollWidth <= button.clientWidth + 1
    })).toBe(true)
    await page.screenshot({ path: join(screenshots, `knowledge-reference-${width}.png`), animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  expect(await page.locator('[data-composer-card]').getByRole('button', { name: 'Remove knowledge base "Operations playbook"', exact: true }).count()).toBe(1)
  await page.locator('[data-composer-card]').getByRole('button', { name: 'Remove knowledge base "Operations playbook"', exact: true }).click()
  await expect.poll(() => capabilities.knowledgeBaseIds).toEqual([])
  await expect.poll(() => selectedKnowledge.count()).toBe(0)
  expect(await composer.textContent()).toBe('Design an API for order review.')
  await openTaskKnowledge(page)
  await page.getByRole('checkbox', { name: 'Operations playbook' }).click()
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect.poll(() => capabilities.knowledgeBaseIds).toEqual(['playbook'])
  const beforeCreation = calls.filter(method => method === 'tasks.capabilities.prepare').length
  await page.getByRole('button', { name: 'Connectors', exact: true }).click()
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const connectorEditor = page.getByRole('dialog', { name: 'Add MCP server', exact: true })
  expect(await page.getByRole('menu').count()).toBe(0)
  expect(await connectorEditor.getByText('Advanced information', { exact: true }).count()).toBe(0)
  await connectorEditor.getByLabel('Server name', { exact: true }).fill('Personal MCP')
  await connectorEditor.getByLabel('Command', { exact: true }).fill('npx -y @modelcontextprotocol/server-filesystem "/path with spaces"')
  await connectorEditor.getByLabel('Timeout', { exact: true }).fill('120')
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await connectorEditor.evaluate(dialog => dialog.scrollWidth > dialog.clientWidth)).toBe(false)
    for (const tab of await connectorEditor.getByRole('tab').all()) {
      expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(28)
    }
    await page.screenshot({ path: join(screenshots, `create-connector-stdio-${width}.png`), animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await connectorEditor.getByLabel('Server type', { exact: true }).selectOption('streamable-http')
  await connectorEditor.getByLabel('MCP endpoint', { exact: true }).fill('https://mcp.example.test/stream')
  await connectorEditor.getByRole('button', { name: 'Add entry', exact: true }).click()
  await connectorEditor.getByLabel('Key 1', { exact: true }).fill('X-Api-Key')
  await connectorEditor.getByLabel('Value 1', { exact: true }).fill('device-test-secret')
  await page.screenshot({ path: join(screenshots, 'create-connector-desktop.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 900 })
  expect(await connectorEditor.evaluate(dialog => dialog.scrollWidth > dialog.clientWidth)).toBe(false)
  await page.screenshot({ path: join(screenshots, 'create-connector-390.png'), animations: 'disabled' })
  const manualBounds = await connectorEditor.boundingBox()
  await connectorEditor.getByRole('tab', { name: 'Paste JSON', exact: true }).click()
  expect(await connectorEditor.boundingBox()).toEqual(manualBounds)
  await page.screenshot({ path: join(screenshots, 'create-connector-json-390.png'), animations: 'disabled' })
  await connectorEditor.getByRole('tab', { name: 'Manual configuration', exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 900 })
  await connectorEditor.getByRole('button', { name: 'Add', exact: true }).click()
  await connectorEditor.getByRole('alert').waitFor()
  expect(await connectorEditor.getByLabel('Server name', { exact: true }).inputValue()).toBe('Personal MCP')
  expect(await connectorEditor.getByLabel('Value 1', { exact: true }).inputValue()).toBe('device-test-secret')
  await connectorEditor.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByText('Personal MCP', { exact: true }).waitFor()
  expect(await page.getByRole('tab', { name: 'Mine', exact: true }).getAttribute('aria-selected')).toBe('true')
  expect(personalResources).toHaveLength(1)
  await page.getByText('Personal MCP', { exact: true }).click()
  await page.getByRole('dialog', { name: 'Connector details', exact: true }).getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Modify', exact: true }).click()
  const editConnector = page.getByRole('dialog', { name: 'Edit connector', exact: true })
  await expect.poll(() => editConnector.getByLabel('Server name', { exact: true }).inputValue()).toBe('Personal MCP')
  expect(await editConnector.getByLabel('Value 1', { exact: true }).inputValue()).toBe('')
  await editConnector.getByLabel('Server name', { exact: true }).fill('Updated personal MCP')
  failSave = true
  await editConnector.getByRole('button', { name: 'Save connector', exact: true }).click()
  await editConnector.getByRole('alert').waitFor()
  expect(await editConnector.getByLabel('Server name', { exact: true }).inputValue()).toBe('Updated personal MCP')
  await page.screenshot({ path: join(screenshots, 'edit-connector-desktop.png'), animations: 'disabled' })
  await editConnector.getByRole('button', { name: 'Save connector', exact: true }).click()
  await page.getByText('Updated personal MCP', { exact: true }).waitFor()
  expect(personalResources.find(row => row.kind === 'connector')?.version).toBe('1.0.1')
  expect(JSON.stringify(personalResources)).not.toContain('device-test-secret')
  await page.getByText('Updated personal MCP', { exact: true }).click()
  await page.getByRole('dialog', { name: 'Connector details', exact: true }).getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  const deleteConnector = page.getByRole('dialog', { name: 'Delete “Updated personal MCP”?', exact: true })
  await page.screenshot({ path: join(screenshots, 'delete-connector-desktop.png'), animations: 'disabled' })
  await deleteConnector.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect.poll(() => personalResources.filter(row => row.kind === 'connector').length).toBe(0)
  await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
  expect(calls.filter(method => method === 'tasks.capabilities.prepare')).toHaveLength(beforeCreation)
  await page.locator('[data-row-key^="session:"]').first().click()
  expect(await composer.textContent()).toBe('Design an API for order review.')
  expect(tripwire.pageErrors).toEqual([])
}, 120_000)

interface DesktopSmokeBridge {
  extensions: { invoke(namespace: string, method: string, payload?: object): Promise<unknown> }
}

const desktopCarriers: { mode: 'official' | 'product'; installed?: string; surface?: 'support' }[] = [
  { mode: 'official' }, { mode: 'product' }, { mode: 'product', surface: 'support' },
]
if (process.env.DSH_INSTALLED_EXECUTABLE) desktopCarriers.push({ mode: 'product', installed: process.env.DSH_INSTALLED_EXECUTABLE })
for (const { mode, installed, surface } of desktopCarriers) {
  const carrier = installed === undefined ? 'built' : 'installed'
  it.skipIf(process.env.DSH_DESKTOP_SMOKE !== '1' || (process.platform !== 'darwin' && process.platform !== 'win32'))(
    surface === 'support' ? 'checks updates and submits pasted feedback in the built product desktop'
      : `boots the ${carrier} ${mode} Electron assembly with an isolated profile`, async () => {
      const root = await mkdtemp(join(tmpdir(), `product-desktop-${mode}-`))
      const home = join(root, 'home')
      const userData = join(root, 'electron')
      const project = join(root, 'runtime')
      const secret = 'fixture-employee-secret'
      const expiresAt = Math.floor(Date.now() / 1000) + 3600
      const model = await startMockLlmServer({ sequence: ['success'], repeatLast: true,
        successText: 'Fixture review complete.', apiKey: 'fixture-model-key' })
      onTestFinished(() => model.close())
      const catalogRows: Record<string, object[]> = {
        '/api/v1/connectors': [{ id: 'erp', version: '1.0.0', name: 'Order management', displayName: 'Order management', reviewStatus: 'PUBLISHED',
          status: 'ready', ready: true, authorizationStatus: 'AUTHORIZED', authMode: 'employee-bearer',
          transport: 'streamable-http', url: '/api/v1/connectors/erp/mcp', arguments: [], headers: {}, environment: {},
          tools: [{ name: 'orders_read', access: 'READ' }] },
        { id: 'local-unconfigured', version: '1.0.0', name: 'Device configuration missing', reviewStatus: 'PUBLISHED',
          status: 'needs-configuration', ready: false, authorizationStatus: 'AUTHORIZED', authMode: 'none',
          transport: 'stdio', command: 'fixture-unconfigured', arguments: [], headers: {}, environment: {}, tools: [] }],
        '/api/v1/knowledge-bases': [...organizationKnowledge,
          { id: 'policy', name: 'Operations playbook', scope: 'COMPANY', companyId: 'fixture-company', ownerName: 'Fixture company', referenceKey: 'company:policy', canRead: true, canManage: false }],
      }
      let knowledgeUnavailable = false
      const uploadedFiles: { mode: string; filename: string; folderId?: string }[] = []
      const deviceReports: Record<string, unknown>[] = []
      const feedbackBodies: string[] = []
      const feedbackPayloads: unknown[] = []
      const folderRows: { id: string; name: string; parentId: string | null; updatedAt: string }[] = [{
        id: 'folder-policies', name: 'Policies', parentId: null, updatedAt: '2026-10-10T01:00:00Z',
      }]
      let largePreview = false
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const path = url.pathname
        response.setHeader('content-type', 'application/json')
        if (path === '/api/v1/employee-auth/session/refresh') {
          response.end(JSON.stringify({ success: true, data: { sessionToken: secret, expiresAt,
            employee: { employeeId: 'fixture-employee', employeeName: 'Fixture user' } } }))
        } else if (path === '/api/v1/bootstrap') {
          response.end(JSON.stringify({ success: true, data: { modelApiKey: 'fixture-model-key',
            endpoints: { litellm: model.baseURL + '/v1' }, models: ['deepseek-v4-flash'] } }))
        } else if (path === '/api/v1/device-capabilities' || path === '/api/v1/device-capabilities/presence') {
          void fixtureRequestBody(request).then((body) => {
            deviceReports.push(body)
            if (path.endsWith('/presence')) { response.statusCode = 204; response.end() }
            else response.end(JSON.stringify({ success: true, data: { createdAt: new Date().toISOString() } }))
          }).catch(() => { response.statusCode = 400; response.end() })
        } else if (path === '/api/v1/feedback' && request.method === 'POST') {
          void (async () => {
            const chunks: Buffer[] = []
            for await (const value of request) {
              const chunk: unknown = value
              if (!Buffer.isBuffer(chunk)) throw new Error('Expected feedback bytes')
              chunks.push(Buffer.from(new Uint8Array(chunk)))
            }
            const body = Buffer.concat(chunks)
            feedbackBodies.push(body.toString('utf8'))
            const multipart = await new Response(new Uint8Array(body), {
              headers: { 'content-type': request.headers['content-type'] ?? '' },
            }).formData()
            const feedback = multipart.get('feedback')
            if (!(feedback instanceof File)) throw new Error('Expected feedback metadata')
            feedbackPayloads.push(JSON.parse(await feedback.text()))
            expect(request.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u)
            expect(request.headers.authorization).toBe(`Bearer ${secret}`)
            response.end(JSON.stringify({ success: true, data: { id: 'feedback-fixture' } }))
          })().catch(() => { response.statusCode = 400; response.end() })
        } else if (path === '/api/v1/knowledge-file-limits') {
          response.end(JSON.stringify({ success: true, data: { previewMaxBytes: 50 * 1024 * 1024,
            downloadMaxBytes: 250 * 1024 * 1024, uploadMaxBytes: 50 * 1024 * 1024 } }))
        } else if (path === '/api/v1/knowledge-references/resolve') {
          response.end(JSON.stringify({ success: true, data: [{ reference: 'company:policy', status: 'RESOLVED',
            base: catalogRows['/api/v1/knowledge-bases']!.find(row => 'id' in row && row.id === 'policy') }] }))
        } else if (path === '/api/v1/knowledge-bases' && request.method === 'POST') {
          void fixtureRequestBody(request).then((body) => {
            expect(body.scope).toBe('PERSONAL')
            expect(body.ownerEmployeeId).toBeUndefined()
            const base = { id: 'created-personal', name: body.name, scope: 'PERSONAL',
              ownerEmployeeId: 'fixture-employee', canRead: true, canManage: true }
            catalogRows[path]!.push(base)
            response.end(JSON.stringify({ success: true, data: base }))
          }).catch(() => { response.statusCode = 400; response.end(JSON.stringify({ success: false, errCode: 'INVALID_PERSONAL_BASE' })) })
        } else if (/^\/api\/v1\/knowledge-bases\/(personal-notes|created-personal|policy|sales-policy|sales-guide)\/(documents|folders)/u
          .test(path)) {
          const parts = path.split('/')
          const baseId = parts[4] ?? ''
          const page = Number(url.searchParams.get('page') ?? 1)
          const size = Number(url.searchParams.get('size') ?? 20)
          if (parts[5] === 'documents' && parts[6] === undefined && request.method === 'POST') {
            void (async () => {
              const chunks: Buffer[] = []
              for await (const value of request) {
                const chunk: unknown = value
                if (!Buffer.isBuffer(chunk)) throw new Error('Expected multipart bytes')
                chunks.push(Buffer.from(new Uint8Array(chunk)))
              }
              const multipart = await new Response(new Uint8Array(Buffer.concat(chunks)), {
                headers: { 'content-type': request.headers['content-type'] ?? '' },
              }).formData()
              const file = multipart.get('file')
              if (!(file instanceof File)) throw new Error('Expected native-selected file')
              const pdfParseMode = multipart.get('pdfParseMode')
              if (typeof pdfParseMode !== 'string') throw new Error('Expected finite PDF mode')
              const folderId = multipart.get('folderId')
              uploadedFiles.push({ mode: pdfParseMode, filename: file.name, ...(typeof folderId === 'string' ? { folderId } : {}) })
              response.end(JSON.stringify({ success: true, data: {
                ...knowledgeDocuments(baseId)[0], filename: file.name, status: 'QUEUED',
                ...(typeof folderId === 'string' ? { folderId } : {}),
              } }))
            })().catch(() => { response.statusCode = 400; response.end(JSON.stringify({ success: false, errCode: 'INVALID_MULTIPART' })) })
          } else if (parts[5] === 'folders') {
            if (request.method === 'DELETE') {
              const index = folderRows.findIndex(row => row.id === parts[6])
              if (index >= 0) folderRows.splice(index, 1)
              response.end(JSON.stringify({ success: true, data: { folderId: parts[6], deleted: true } }))
            } else if (request.method === 'POST' || request.method === 'PUT') {
              void fixtureRequestBody(request).then((body) => {
                if (typeof body.name !== 'string') throw new Error('Missing folder name')
                const folder = request.method === 'PUT' ? folderRows.find(row => row.id === parts[6]) : { id: `created-folder${folderRows.some(folder => folder.id === 'created-folder') ? '-child' : ''}`, name: body.name, parentId: typeof body.parentId === 'string' ? body.parentId : null, updatedAt: '2026-10-10T01:00:00Z' }
                if (folder === undefined) throw new Error('Missing folder')
                folder.name = body.name
                if (request.method === 'POST') folderRows.push(folder)
                response.end(JSON.stringify({ success: true, data: folder }))
              }).catch(() => { response.statusCode = 400; response.end(JSON.stringify({ success: false, errCode: 'INVALID_FOLDER' })) })
            } else if (parts[6] !== undefined) {
              const folder = folderRows.find(row => row.id === parts[6])
              if (!folder) response.statusCode = 404
              response.end(JSON.stringify(folder ? { success: true, data: folder } : { success: false, errCode: 'FOLDER_NOT_FOUND' }))
            } else {
              const parentId = url.searchParams.get('parentId') || null
              const folders = folderRows.filter(row => row.parentId === parentId)
              response.end(JSON.stringify({ success: true, data: folders.slice((page - 1) * size, page * size),
                pageIndex: page, pageSize: size, totalCount: folders.length, totalPages: Math.ceil(folders.length / size) }))
            }
          } else if (parts[7] === 'contents') {
            const contents = knowledgeContents(parts[6] ?? '', page, size)
            response.end(JSON.stringify({ success: true, data: contents.items, pageIndex: page,
              pageSize: size, totalCount: contents.total, totalPages: Math.ceil(contents.total / size) }))
          } else if (parts[7] === 'preview' && parts[8] === 'metadata') {
            response.end(JSON.stringify({ success: true, data: knowledgeDocuments(baseId, largePreview).find(row => row.id === parts[6]) }))
          } else if (parts[7] === 'preview' || parts[7] === 'download') {
            const original = knowledgeOriginal(parts[6] ?? '', largePreview)
            response.setHeader('content-type', original.mediaType)
            response.end(original.data)
          } else if (parts[6] !== undefined) {
            response.end(JSON.stringify({ success: true, data: {
              ...knowledgeDocuments(baseId).find(row => row.id === parts[6]), manualContent: '# Order review\n\nKeep the original evidence.',
            } }))
          } else {
            const query = (url.searchParams.get('query') ?? '').toLowerCase()
            const documents = filteredKnowledgeDocuments(baseId, query,
              url.searchParams.has('folderId') ? url.searchParams.get('folderId') || null : undefined)
            response.end(JSON.stringify({ success: true, data: documents.slice((page - 1) * size, page * size),
              pageIndex: page, pageSize: size, totalCount: documents.length, totalPages: Math.ceil(documents.length / size) }))
          }
        } else if (path === '/api/v1/knowledge-searches' || path === '/api/v1/knowledge-bases/sources/policy-source') {
          const source = { sourceId: 'policy-source', documentId: 'document-1', filename: 'Order review.md',
            content: 'Check order totals before changing delivery details.', locator: 'Section 1' }
          response.end(JSON.stringify({ success: true, data: path === '/api/v1/knowledge-searches' ? [source] : source }))
        } else if (path === '/api/v1/connectors/erp/mcp') {
          void (async () => {
            const chunks: Buffer[] = []
            for await (const chunk of request) {
              if (!Buffer.isBuffer(chunk)) throw new Error('MCP fixture expected request bytes')
              chunks.push(chunk)
            }
            const call = JSON.parse(Buffer.concat(chunks).toString()) as { id?: string | number; method?: string }
            if (call.id === undefined) { response.statusCode = 202; response.end(); return }
            response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id,
              result: call.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} },
                serverInfo: { name: 'fixture', version: '1' } }
                : call.method === 'tools/list' ? { tools: [{ name: 'orders_read',
                  inputSchema: { type: 'object', properties: {} } }] } : {},
            }))
          })().catch(() => { response.statusCode = 500; response.end() })
        } else if (path === '/api/v1/knowledge-bases' && knowledgeUnavailable) {
          response.statusCode = 503
          response.end(JSON.stringify({ success: false, errCode: 'ORGANIZATION_SERVICE_UNAVAILABLE',
            errMessage: 'Private upstream diagnostic' }))
        } else if (catalogRows[path] !== undefined) {
          const data = catalogRows[path]
          response.end(JSON.stringify({ success: true, data, pageIndex: 1, pageSize: 100,
            totalCount: data.length, totalPages: 1 }))
        } else {
          response.statusCode = 404
          response.end(JSON.stringify({ success: false, errCode: 'FIXTURE_ROUTE_MISSING' }))
        }
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Fixture server has no port')
      const origin = `http://127.0.0.1:${address.port}`
      let app: ElectronApplication | undefined = undefined
      let nativeUpdate: NativeProductUpdateQualification | undefined
      onTestFinished(async () => {
        const closing = app
        app = undefined
        try { if (closing !== undefined) await closeElectronAcceptance(closing) }
        finally {
          try {
            server.closeAllConnections()
            await new Promise<void>((resolve, reject) => server.close((error) => {
              if (error === undefined) resolve()
              else reject(error)
            }))
          } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
        }
      })
      const electronExecutable: unknown = installed ?? createRequire(join(REPO_ROOT, 'apps/desktop/package.json'))('electron')
      if (typeof electronExecutable !== 'string') throw new Error('Electron executable is unavailable')
      if (installed !== undefined) {
        // The installer copy owns this configuration; production endpoints must not receive fixture identities.
        const installationRoot = process.env.DSH_INSTALLED_ROOT
        if (!installationRoot) throw new Error('Installed acceptance requires a private installation root')
        const resources = process.platform === 'darwin' ? resolve(dirname(installed), '../Resources') : join(dirname(installed), 'resources')
        const configPath = join(resources, 'deepseek-harness/product.json')
        if (!(await realpath(configPath)).startsWith(await realpath(installationRoot) + sep)) {
          throw new Error('Installed configuration is outside the private installation root')
        }
        const original = await readFile(configPath, 'utf8')
        onTestFinished(() => writeFile(configPath, original))
        await writeFile(configPath, JSON.stringify({ ...JSON.parse(original), serverUrl: origin }))
        if (['darwin', 'win32'].includes(process.platform) && process.env.PACKAGE_SIGNING === 'internal') {
          nativeUpdate = await prepareNativeProductUpdate({ installed, root, home, userData,
            modelUrl: model.baseURL + '/v1', token: secret, environment: process.env })
          onTestFinished(() => nativeUpdate!.dispose())
        }
      }
      if (installed === undefined) {
        const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'apps/desktop/package.json'), 'utf8')) as { version: unknown }
        const pnpm = JSON.parse(await readFile(join(REPO_ROOT, 'apps/desktop/node_modules/pnpm/package.json'), 'utf8')) as { version: unknown }
        const release = parseDesktopRelease({ schemaVersion: 1, version: manifest.version,
          hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
          nodeVersion: execFileSync(electronExecutable, ['-p', 'process.versions.node'],
            { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim(),
          pnpmVersion: pnpm.version })
        const target = resolveDesktopBuildTarget({}, process.platform, process.arch)
        prepareDevelopmentProject({ projectDir: project, cliDir: join(REPO_ROOT, 'apps/cli'),
          hostDir: join(REPO_ROOT, 'apps/desktop-host'), dependencyDir: join(REPO_ROOT, 'node_modules/.pnpm/node_modules'),
          target, release })
      }
      const profile = join(home, 'profiles/desktop')
      createPluginProfile(profile)
      const hostDiagnostic = join(root, 'host-modules.json')
      const diagnosticPlugin = join(root, 'desktop-module-diagnostics.mjs')
      await copyFile(join(REPO_ROOT, 'apps/product-desktop/tests/fixtures/desktop-module-diagnostics.mjs'), diagnosticPlugin)
      await writeFile(join(profile, 'cordis.patch.yml'),
        '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n'
        + '- id: ui-plugin-manager\n  config:\n    registryProbeEnabled: false\n'
        + `- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(join(root, 'Documents'))}\n`
        + `- insert:\n  - id: acceptance-module-diagnostics\n    name: ${JSON.stringify(pathToFileURL(diagnosticPlugin).href)}\n    config:\n      output: ${JSON.stringify(hostDiagnostic)}\n`)
      await mkdir(userData)
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !key.startsWith('DSH_') && !key.startsWith('DEEPSEEK_') && key !== 'ELECTRON_RUN_AS_NODE'))
      const startupDiagnostic = join(root, 'desktop-startup.txt')
      onTestFinished(async ({ task }) => {
        if (task.result?.state !== 'fail') return
        const diagnostic = await readFile(startupDiagnostic, 'utf8').catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
          throw error
        })
        if (diagnostic !== undefined) {
          const safe = diagnostic.replaceAll(secret, '<EMPLOYEE_TOKEN>').replaceAll('fixture-model-key', '<MODEL_KEY>')
          console.error('Desktop startup diagnostic:', safe)
          await mkdir(screenshots, { recursive: true })
          await writeFile(join(screenshots, `electron-${carrier}-${mode}-startup.txt`), safe)
        }
        const modules = await readFile(hostDiagnostic, 'utf8').catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
          throw error
        })
        if (modules !== undefined) console.error('Desktop Host module identities:', modules)
      })
      const launchOptions = { executablePath: electronExecutable,
        // A disposable profile must not wait for interactive access to a runner's login keychain.
        args: [`--user-data-dir=${userData}`, ...process.platform === 'darwin' ? ['--use-mock-keychain'] : [],
          ...installed === undefined ? [join(REPO_ROOT, 'apps/desktop')] : []],
        env: { ...environment, DSH_HOME: home,
          DSH_DESKTOP_DIAGNOSTIC_FILE: startupDiagnostic,
          DSH_DESKTOP_OPEN_DEVTOOLS: '0',
          ...installed === undefined ? { DSH_DESKTOP_DSH_DIR: project,
            DSH_DESKTOP_PRIMARY_RUNTIME_DIR: developmentRuntimeDirectory({}, process.platform, process.arch) } : {},
          DEEPSEEK_API_KEY: 'fixture-model-key',
          DEEPSEEK_BASE_URL: model.baseURL + '/v1',
          ...mode === 'official' ? {} : {
            DEEPSEEK_HARNESS_SERVER_URL: origin, DEEPSEEK_HARNESS_SESSION_TOKEN: secret,
            ...installed === undefined ? { DSH_DESKTOP_EXTENSION: pathToFileURL(join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/lib/index.js')).href,
              DEEPSEEK_HARNESS_NATIVE_BINARY: join(REPO_ROOT, 'native/deepseek-harness/target/release',
                process.platform === 'win32' ? 'deepseek-harness-native.exe' : 'deepseek-harness-native') } : {},
          },
        }, timeout: 60_000 }
      app = await _electron.launch(launchOptions)
      if (nativeUpdate !== undefined) {
        await app.firstWindow()
        expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isFocusable()))).toBe(true)
      }
      expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(installed !== undefined)
      const applicationVersion = await app.evaluate(({ app }) => app.getVersion())
      if (installed !== undefined) {
        const expectedVersion = nativeUpdate?.initialVersion ?? z.string().min(1).parse(process.env.PACKAGE_VERSION)
        expect(applicationVersion, 'Installed application version must match PACKAGE_VERSION').toBe(expectedVersion)
        const appPath = await app.evaluate(({ app }) => app.getAppPath())
        expect(appPath).toContain('app.asar')
        expect(appPath).not.toContain(REPO_ROOT)
      }
      const diagnostics: string[] = []
      const observeShutdown = async (application: ElectronApplication) => {
        const child = application.process()
        child.stderr?.on('data', (chunk: Buffer) => diagnostics.push(chunk.toString()))
        child.once('exit', (exitCode, signalCode) => diagnostics.push(
          `Acceptance child exit: ${JSON.stringify({ pid: child.pid, exitCode, signalCode })}\n`,
        ))
        child.once('close', (exitCode, signalCode) => diagnostics.push(
          `Acceptance child close: ${JSON.stringify({ pid: child.pid, exitCode, signalCode })}\n`,
        ))
        await application.evaluate(({ app, BrowserWindow }) => {
          let deadline: ReturnType<typeof setTimeout> | undefined
          const report = (phase: string, prevented?: boolean) => {
            // Node's diagnostic handle API is confined to this disposable acceptance process.
            const runtime = process as typeof process & { _getActiveHandles(): Array<{
              constructor: { name: string }
              pid?: number
              exitCode?: number | null
              signalCode?: string | null
              killed?: boolean
              connected?: boolean
              spawnfile?: string
            }> }
            process.stderr.write(`Acceptance shutdown: ${JSON.stringify({
              phase, prevented, pid: process.pid, resources: process.getActiveResourcesInfo(),
              windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible() })),
              children: runtime._getActiveHandles().filter(handle => handle.constructor.name === 'ChildProcess')
                .map(({ pid, exitCode, signalCode, killed, connected, spawnfile }) =>
                  ({ pid, exitCode, signalCode, killed, connected, spawnfile })),
            })}\n`)
          }
          app.on('before-quit', (event) => {
            report('before-quit', event.defaultPrevented)
            if (deadline !== undefined) return
            deadline = setTimeout(() => { report('still-closing') }, 9_000)
            deadline.unref()
          })
          app.on('will-quit', (event) => { report('will-quit', event.defaultPrevented) })
          app.once('quit', () => { clearTimeout(deadline); report('quit') })
        })
      }
      await observeShutdown(app)
      const startupWarnings: string[] = []
      app.context().on('console', (message) => {
        if (message.type() !== 'warning' && message.type() !== 'error') return
        startupWarnings.push(message.text().replaceAll(secret, '<EMPLOYEE_TOKEN>')
          .replaceAll('fixture-model-key', '<MODEL_KEY>'))
      })
      onTestFinished(({ task }) => {
        if (task.result?.state === 'fail') console.error('Desktop process diagnostics:', diagnostics.join(''))
      })
      let page = await app.firstWindow()
      let tripwire = watchConsole(page)
      onTestFinished(async ({ task }) => {
        if (task.result?.state !== 'fail') return
        if (page.isClosed()) {
          console.error('Desktop workflow failure after window closure:', tripwire, startupWarnings)
          return
        }
        await mkdir(screenshots, { recursive: true })
        await page.screenshot({ path: join(screenshots, `electron-${carrier}-${mode}-failure.png`), timeout: 5000 })
        console.error('Desktop workflow failure:', await page.locator('body').innerText(), tripwire, startupWarnings)
      })
      await page.waitForURL('dsh-app://app/', { timeout: 60_000 })
      await expect.poll(() => readFile(hostDiagnostic, 'utf8').catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      }), { timeout: 60_000 }).toBeDefined()
      const identities = z.object({ modules: z.array(z.string()), loaderSharesRoot: z.boolean() })
        .parse(JSON.parse(await readFile(hostDiagnostic, 'utf8')))
      expect(identities.loaderSharesRoot).toBe(true)
      expect(identities.modules.filter(url => /\/(?:dsh-)?app-boot\/lib\/index\.js$/u.test(url))).toHaveLength(1)
      for (const entry of [
        /\/(?:product-experts|experts)\/lib\/remote\.js$/u,
        /\/(?:product-experts|experts)\/lib\/index\.js$/u,
        /\/(?:product-skills|skills)\/lib\/index\.js$/u,
      ]) {
        expect(identities.modules.filter(url => entry.test(url)))
          .toHaveLength(mode === 'product' ? 1 : 0)
      }
      await page.setViewportSize({ width: 1440, height: 900 })
      let composer = page.locator('[data-composer-input][contenteditable="true"]').last()
      await composer.waitFor({ timeout: 60_000 })
      const invoke = async (method: string, payload?: object) => {
        const response = await page.evaluate(({ method, payload }) => {
          const bridge = Reflect.get(globalThis, 'dshDesktop') as DesktopSmokeBridge
          return bridge.extensions.invoke('product', method, payload)
        }, { method, payload }) as { ok: boolean; result?: unknown; failure?: { message: string } }
        if (response.ok) return response.result
        throw Object.assign(new Error(response.failure?.message ?? 'Invalid desktop reply'), response.failure)
      }
      if (mode === 'official') {
        expect(await page.getByRole('button', { name: /^(Expert kits|专家套件)$/, exact: true }).count()).toBe(0)
        await expect(invoke('auth.getSession')).rejects.toThrow()
      } else {
        const navigationSession = await page.locator('[data-conversation-session]').last().getAttribute('data-conversation-session')
        await composer.fill('Keep the extension navigation draft')
        for (const [label, content] of [[/^(Expert kits|专家套件)$/, '.aag-library-shell'], [/^(Skills|技能)$/, '.dssm-section']] as const) {
          const entry = page.getByRole('button', { name: label, exact: true })
          await entry.click()
          const capability = page.locator('.product-capability-page')
          await capability.locator(content).waitFor()
          expect(await entry.getAttribute('aria-current')).toBe('page')
          const settings = page.getByRole('dialog', { name: /^(Settings|设置)$/, exact: true })
          expect(await settings.count()).toBe(0)
          await expect.poll(() => capability.innerText()).toMatch(/.+/u)
          expect(await capability.getByRole('alert').count()).toBe(0)
          expect(await capability.evaluate(region => region.scrollWidth > region.clientWidth)).toBe(false)
        }
        await page.getByRole('button', { name: /^(More menu|更多菜单)$/, exact: true }).click()
        await page.getByRole('menuitem', { name: /^(Settings|设置)$/, exact: true }).click()
        const sharedSettings = page.getByRole('dialog', { name: /^(Settings|设置)$/, exact: true })
        await sharedSettings.waitFor()
        for (const section of [/^(Experts|专家)$/, /^(Skills|技能)$/]) {
          expect(await sharedSettings.getByRole('button', { name: section, exact: true }).count()).toBe(0)
        }
        await sharedSettings.getByRole('button', { name: /^(Close|关闭)$/, exact: true }).last().click()
        await sharedSettings.waitFor({ state: 'hidden' })
        await expect.poll(() => page.locator('.product-capability-page .dssm-section').innerText()).toMatch(/.+/u)
        await page.locator(`[data-row-key="session:${navigationSession}"]`).click()
        expect(await composer.textContent()).toBe('Keep the extension navigation draft')
        await expect.poll(() => deviceReports.length).toBeGreaterThan(0)
        expect(JSON.stringify(deviceReports)).not.toContain(secret)
        expect(deviceReports[0]?.deviceId).toMatch(/^[0-9a-f-]{36}$/u)
        expect(deviceReports[0]?.desktopVersion).toBe(applicationVersion)
        await page.getByRole('button', { name: /^(More menu|更多菜单)$/, exact: true }).click()
        expect(await page.getByRole('menuitem', { name: /^(Check for updates|检查更新)$/, exact: true }).count()).toBe(1)
        const signing = z.enum(['signed', 'unsigned', 'internal']).default('unsigned').parse(process.env.PACKAGE_SIGNING)
        if (installed === undefined || signing === 'unsigned') {
          await page.getByRole('menuitem', { name: /^(Check for updates|检查更新)$/, exact: true }).click()
          const updatePage = await dialogWithButton(app, /^(Close|关闭)$/)
          await expect.poll(() => updatePage.title()).toMatch(/^(Update Failed|更新失败)$/u)
          await expect.poll(() => updatePage.locator('#title').textContent()).toMatch(/Could not check for updates\. Please try again later\.|检查更新失败，请稍后重试。/u)
          expect(await updatePage.locator('#technical-details').getAttribute('open')).toBeNull()
          expect(await updatePage.locator('#technical-details-content').isVisible()).toBe(false)
          await updatePage.locator('#technical-details-label').click()
          await expect.poll(() => updatePage.locator('#technical-details-content').innerText()).toMatch(/no packaged update source/u)
          await updatePage.locator('#technical-details-label').click()
          for (const width of [1440, 390]) {
            await updatePage.setViewportSize({ width, height: 900 })
            expect(await updatePage.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
            await updatePage.screenshot({ path: join(screenshots, `electron-${carrier}-product-update-unavailable-${width}.png`), animations: 'disabled' })
          }
          await updatePage.locator('#close').click()
          await expect.poll(() => app!.windows().length).toBe(1)
          const retryUpdate = page.getByRole('button', { name: /^(Retry update|重试更新)$/, exact: true })
          await retryUpdate.waitFor()
          await retryUpdate.click()
          const retriedUpdatePage = await dialogWithButton(app, /^(Close|关闭)$/)
          await expect.poll(() => retriedUpdatePage.title()).toMatch(/^(Update Failed|更新失败)$/u)
          await retriedUpdatePage.locator('#close').click()
          await expect.poll(() => app!.windows().length).toBe(1)
          await page.getByRole('button', { name: /^(More menu|更多菜单)$/, exact: true }).click()
        }
        await page.getByRole('menuitem', { name: /^(Feedback|反馈)$/, exact: true }).click()
        const feedbackDialog = page.getByRole('dialog', { name: /^(Feedback|反馈)$/, exact: true })
        await feedbackDialog.getByLabel(/^(Message|反馈内容)$/, { exact: true }).fill('Desktop support acceptance')
        await feedbackDialog.getByRole('textbox').evaluate((element, bytes) => {
          const clipboardData = new DataTransfer()
          clipboardData.items.add(new File([new Uint8Array(bytes)], 'support-screenshot.png', { type: 'image/png' }))
          element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
        }, [...await page.screenshot()])
        await feedbackDialog.getByRole('img', { name: 'support-screenshot.png', exact: true }).waitFor()
        expect(await feedbackDialog.locator('input[type="file"]').count()).toBe(0)
        expect(await feedbackDialog.getByRole('button', { name: /^(Retry report|重试上报)$/ }).count()).toBe(0)
        expect(await feedbackDialog.locator('[aria-busy]').evaluate(element => element.querySelector('textarea') !== null
          && element.querySelector('img') !== null)).toBe(true)
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 })
          const box = await feedbackDialog.boundingBox()
          expect(box?.x).toBeGreaterThanOrEqual(0)
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width)
          await page.screenshot({ path: join(screenshots, `electron-${carrier}-product-feedback-${width}.png`), animations: 'disabled' })
        }
        await page.setViewportSize({ width: 1440, height: 900 })
        await feedbackDialog.getByRole('button', { name: /^(Submit feedback|提交反馈)$/, exact: true }).click()
        await feedbackDialog.getByText('feedback-fixture', { exact: true }).waitFor()
        expect(feedbackBodies).toHaveLength(1)
        expect(feedbackBodies[0]).toContain('Desktop support acceptance')
        expect(feedbackBodies[0]).toContain('support-screenshot.png')
        expect(feedbackBodies[0]).toContain('image/png')
        expect(feedbackBodies[0]).not.toContain(secret)
        expect(feedbackPayloads).toEqual([{ message: 'Desktop support acceptance', category: 'BUG',
          desktopVersion: applicationVersion, deviceId: deviceReports[0]?.deviceId, taskId: '' }])
        expect(await feedbackDialog.getByRole('img').count()).toBe(0)
        await feedbackDialog.getByRole('button', { name: /^(Close|关闭)$/, exact: true }).last().click()
        if (surface === 'support') {
          expect(tripwire.pageErrors).toEqual([])
          return
        }
        await composer.fill('Keep this task draft')
        const currentSession = async () => page.locator('[data-conversation-session]').last().getAttribute('data-conversation-session')
        const originalSession = await currentSession()
        for (const [name, content] of [[/^(Connectors|连接器)$/, 'Order management'],
          [/^(Knowledge bases|知识库)$/, 'Operations playbook']] as const) {
          await page.getByRole('button', { name, exact: true }).click()
          await page.getByText(content, { exact: true }).first().waitFor()
        }
        await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Operations playbook', exact: true }).click()
        const sharedMaterials = page.locator('[data-knowledge-content]')
        await sharedMaterials.getByRole('button', { name: 'Order review.md', exact: true }).waitFor()
        expect(await sharedMaterials.getByRole('button', { name: /^(Upload files|上传文件|New|新建)$/, exact: true }).count()).toBe(0)
        const navigation = await openKnowledgeNavigation(page)
        await navigation.getByRole('heading', { name: 'Sales (21)', exact: true }).waitFor()
        await navigation.getByRole('heading', { name: 'Sales (22)', exact: true }).waitFor()
        await openKnowledgeFile(page, 'Order review.md')
        const reader = page.locator('[data-knowledge-inline-reader]')
        await reader.getByRole('heading', { name: 'Order review', exact: true }).waitFor()
        await reader.getByText('Final policy passage: preserve the audit record.', { exact: true }).waitFor()
        expect(await reader.getByText(/^(Extracted content|解析正文)$/, { exact: true }).count()).toBe(0)
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 })
          await expectKnowledgeMainFits(page)
          expect(await page.getByRole('dialog').count()).toBe(0)
          expect(await page.locator('[data-knowledge-workspace]').evaluate(region => region.scrollWidth > region.clientWidth)).toBe(false)
          await page.screenshot({ path: join(screenshots, `electron-${carrier}-product-knowledge-inline-reader-${width}.png`), animations: 'disabled' })
          const tree = await openKnowledgeNavigation(page)
          await tree.getByRole('button', { name: 'Policies', exact: true }).waitFor()
          await page.screenshot({ path: join(screenshots, `electron-${carrier}-product-knowledge-navigation-${width}.png`), animations: 'disabled' })
          await openKnowledgeFile(page, 'Order review.md')
        }
        await page.setViewportSize({ width: 1440, height: 900 })
        await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Policies', exact: true }).click()
        await sharedMaterials.getByRole('button', { name: 'Policy 2.pdf', exact: true }).waitFor()
        expect(await sharedMaterials.getByRole('button', { name: 'Order review.md', exact: true }).count()).toBe(0)
        expect(await reader.count()).toBe(0)
        await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Personal notes', exact: true }).click()
        const ownMaterials = page.locator('[data-knowledge-content]')
        await ownMaterials.getByRole('button', { name: 'Order review.md', exact: true }).waitFor()
        await expectOriginalPreviews(page, 'electron')
        largePreview = true
        await expectLargeOriginalPreview(page, 'electron')
        largePreview = false
        expect(await ownMaterials.getByRole('button', { name: /^(Upload files|上传文件)$/, exact: true }).isVisible()).toBe(true)
        const uploadPaths = { text: join(root, 'text-policy.pdf'), standard: join(root, 'standard-policy.pdf') }
        await writeFile(uploadPaths.text, '%PDF-1.4 embedded text')
        await writeFile(uploadPaths.standard, '%PDF-1.4 standard document')
        await app.evaluate(({ dialog }, paths) => {
          Reflect.set(dialog, 'showOpenDialog', async (...args: unknown[]) => {
            const options = args.at(-1)
            Reflect.set(globalThis, '__knowledgePickerOptions', options)
            const textOnly = typeof options === 'object' && options !== null && 'filters' in options
            return { canceled: false, filePaths: [textOnly ? paths.text : paths.standard] }
          })
        }, uploadPaths)
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 })
          await ownMaterials.getByRole('button', { name: /^(Upload files|上传文件)$/, exact: true }).click()
          const uploadMenu = page.getByRole('menu')
          await uploadMenu.getByRole('menuitem', { name: /^(Upload text PDF \(text layer, no OCR\)|上传文本型 PDF（保留文字，无 OCR）)$/, exact: true }).waitFor()
          expect(await uploadMenu.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
          await page.screenshot({ path: join(screenshots, `electron-${carrier}-product-knowledge-upload-menu-${width}.png`), animations: 'disabled' })
          await page.keyboard.press('Escape')
        }
        await page.setViewportSize({ width: 1440, height: 900 })
        for (const [mode, label] of [['TEXT', /^(Upload text PDF \(text layer, no OCR\)|上传文本型 PDF（保留文字，无 OCR）)$/],
          ['STANDARD', /^(Upload file \(standard parsing\)|上传文件（通用解析）)$/]] as const) {
          await ownMaterials.getByRole('button', { name: /^(Upload files|上传文件)$/, exact: true }).click()
          await page.getByRole('menuitem', { name: label, exact: true }).click()
          await submitKnowledgeUpload(page)
          await expect.poll(() => uploadedFiles.at(-1)?.mode).toBe(mode)
          expect(await app.evaluate((): unknown => Reflect.get(globalThis, '__knowledgePickerOptions'))).toEqual({
            properties: ['openFile', 'multiSelections'], ...mode === 'TEXT' ? { filters: [{ name: 'PDF', extensions: ['pdf'] }] } : {},
          })
          await expect.poll(() => ownMaterials.getByRole('button', { name: /^(Upload files|上传文件)$/, exact: true }).isEnabled()).toBe(true)
        }
        expect(uploadedFiles).toEqual([{ mode: 'TEXT', filename: 'text-policy.pdf' }, { mode: 'STANDARD', filename: 'standard-policy.pdf' }])
        await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Policies', exact: true }).click()
        await ownMaterials.getByRole('button', { name: /^(Upload files|上传文件)$/, exact: true }).click()
        await page.getByRole('menuitem', { name: /^(Upload file \(standard parsing\)|上传文件（通用解析）)$/, exact: true }).click()
        await submitKnowledgeUpload(page)
        await expect.poll(() => uploadedFiles.at(-1)?.folderId).toBe('folder-policies')
        expect(await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Policies', exact: true }).getAttribute('aria-current')).toBe('page')
        await (await openKnowledgeNavigation(page)).getByRole('button', { name: /^(New personal knowledge base|新建个人知识库)$/, exact: true }).click()
        const baseEditor = page.getByRole('dialog', { name: /^(New personal knowledge base|新建个人知识库)$/, exact: true })
        await baseEditor.getByRole('textbox', { name: /^(Knowledge base name|知识库名称)$/, exact: true }).fill('Desktop personal files')
        await baseEditor.getByRole('button', { name: /^(Create|创建)$/, exact: true }).click()
        await expect.poll(async () => (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Desktop personal files', exact: true }).getAttribute('aria-current')).toBe('page')
        await (await openKnowledgeNavigation(page)).getByRole('button', { name: /^(New folder|新建文件夹)$/, exact: true }).click()
        const folderEditor = page.getByRole('dialog', { name: /^(New folder|新建文件夹)$/, exact: true })
        await folderEditor.getByRole('textbox', { name: /^(Folder name|文件夹名称)$/, exact: true }).fill('Desktop evidence')
        await folderEditor.getByRole('button', { name: /^(Save|保存)$/, exact: true }).click()
        await (await openKnowledgeNavigation(page)).getByRole('button', { name: /^(Folder actions for Desktop evidence|Desktop evidence的文件夹操作)$/, exact: true }).click()
        await page.getByRole('menuitem', { name: /^(Rename folder|重命名文件夹)$/, exact: true }).click()
        const renameEditor = page.getByRole('dialog', { name: /^(Rename folder|重命名文件夹)$/, exact: true })
        await renameEditor.getByRole('textbox', { name: /^(Folder name|文件夹名称)$/, exact: true }).fill('Desktop records')
        await renameEditor.getByRole('button', { name: /^(Save|保存)$/, exact: true }).click()
        const folderAction = (await openKnowledgeNavigation(page)).getByRole('button', { name: /^(Folder actions for Desktop records|Desktop records的文件夹操作)$/, exact: true })
        await folderAction.click()
        await page.getByRole('menuitem', { name: /^(New subfolder|新建子文件夹)$/, exact: true }).click()
        const subfolderEditor = page.getByRole('dialog', { name: /^(New folder|新建文件夹)$/, exact: true })
        await expect.poll(() => subfolderEditor.getByRole('button', { name: 'Desktop records', exact: true }).getAttribute('aria-current')).toBe('page')
        await subfolderEditor.getByRole('textbox', { name: /^(Folder name|文件夹名称)$/, exact: true }).fill('October')
        await subfolderEditor.getByRole('button', { name: /^(Save|保存)$/, exact: true }).click()
        await expect.poll(async () => (await openKnowledgeNavigation(page)).getByRole('button', { name: 'October', exact: true }).getAttribute('aria-current')).toBe('page')
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 })
          const tree = await openKnowledgeNavigation(page)
          await expectKnowledgeNavigationFits(tree)
          await page.screenshot({ path: join(screenshots, `electron-${carrier}-knowledge-nested-folders-${width}.png`), animations: 'disabled' })
          await tree.getByRole('button', { name: 'October', exact: true }).click()
          await expectKnowledgeMainFits(page)
        }
        await page.setViewportSize({ width: 1440, height: 900 })
        await (await openKnowledgeNavigation(page)).getByRole('button', { name: /^(Folder actions for October|October的文件夹操作)$/, exact: true }).click()
        await page.getByRole('menuitem', { name: /^(Delete folder|删除文件夹)$/, exact: true }).click()
        await page.getByRole('dialog', { name: /^(Delete folder|删除文件夹)$/, exact: true })
          .getByRole('button', { name: /^(Delete|删除)$/, exact: true }).click()
        await expect.poll(async () => (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Desktop records', exact: true }).getAttribute('aria-current')).toBe('page')
        await folderAction.click()
        await page.screenshot({ path: join(screenshots, `electron-${carrier}-product-knowledge-folder-actions.png`), animations: 'disabled' })
        await page.getByRole('menuitem', { name: /^(Delete folder|删除文件夹)$/, exact: true }).click()
        await page.getByRole('dialog', { name: /^(Delete folder|删除文件夹)$/, exact: true })
          .getByRole('button', { name: /^(Delete|删除)$/, exact: true }).click()
        await expect.poll(async () => (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Desktop records', exact: true }).count()).toBe(0)
        await (await openKnowledgeNavigation(page)).getByRole('button', { name: 'Personal notes', exact: true }).click()
        await ownMaterials.getByRole('button', { name: 'Office policy.docx', exact: true }).waitFor()
        const originalDownload = join(root, 'downloaded-original.docx')
        await app.evaluate(({ dialog, shell }, downloadPath) => {
          Reflect.set(dialog, 'showSaveDialog', async () => ({ canceled: false, filePath: downloadPath }))
          Reflect.set(shell, 'openPath', async (path: string) => { Reflect.set(globalThis, '__knowledgeOpenedPath', path); return '' })
        }, originalDownload)
        const originalMenu = () => ownMaterials.getByRole('button', { name: /^(Actions for “Office policy.docx”|“Office policy.docx”的操作)$/, exact: true })
        await originalMenu().click()
        await page.getByRole('menuitem', { name: /^(Download original file|下载原文件)$/, exact: true }).click()
        await expect.poll(async () => createHash('sha256').update(await readFile(originalDownload)).digest('hex'))
          .toBe(createHash('sha256').update(realOfficeBytes('docx')).digest('hex'))
        await expect.poll(() => originalMenu().isEnabled()).toBe(true)
        await originalMenu().click()
        await page.getByRole('menuitem', { name: /^(Open in system app|用系统应用打开)$/, exact: true }).click()
        await expect.poll(() => app!.evaluate((): unknown => Reflect.get(globalThis, '__knowledgeOpenedPath'))).toEqual(expect.any(String))
        const openedPath = await app.evaluate((): unknown => Reflect.get(globalThis, '__knowledgeOpenedPath'))
        if (typeof openedPath !== 'string') throw new Error('Missing system-open file')
        expect(createHash('sha256').update(await readFile(openedPath)).digest('hex'))
          .toBe(createHash('sha256').update(realOfficeBytes('docx')).digest('hex'))
        await page.getByRole('tab', { name: /^(All files|全部文件)$/, exact: true }).click()
        await ownMaterials.getByRole('button', { name: /^(Next page|下一页)$/, exact: true }).click()
        await ownMaterials.getByRole('button', { name: 'Handover guide.md', exact: true }).waitFor()
        await page.locator('[data-knowledge-content]').getByRole('searchbox').fill('handover')
        await page.locator('[data-knowledge-content]').getByRole('button', { name: /^(Search|搜索)$/, exact: true }).click()
        await expect.poll(() => ownMaterials.getByRole('row').count()).toBe(2)
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 })
          await expectKnowledgeMainFits(page)
          await mkdir(screenshots, { recursive: true })
          await page.screenshot({ path: join(screenshots, `electron-${carrier}-product-knowledge-materials-${width}.png`), animations: 'disabled' })
        }
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.keyboard.press('Escape')
        await page.locator(`[data-row-key="session:${originalSession}"]`).click()
        expect(await currentSession()).toBe(originalSession)
        expect(await composer.textContent()).toBe('Keep this task draft')
        await expect(invoke('tasks.capabilities.read', { sessionId: originalSession })).resolves.toMatchObject({ knowledgeBaseIds: [] })
        await page.getByRole('button', { name: /^(Knowledge bases|知识库)$/, exact: true }).click()
        knowledgeUnavailable = true
        const failure = await page.evaluate(() => {
          const bridge = Reflect.get(globalThis, 'dshDesktop') as DesktopSmokeBridge
          return bridge.extensions.invoke('product', 'knowledge.bases.list')
        })
        expect(failure).toMatchObject({ ok: false, failure: { code: 'ORGANIZATION_SERVICE_UNAVAILABLE',
          retryable: true, resources: [] } })
        await page.getByRole('button', { name: /^(Connectors|连接器)$/, exact: true }).click()
        await page.getByRole('button', { name: /^(Knowledge bases|知识库)$/, exact: true }).click()
        await expect.poll(() => page.getByRole('alert').textContent()).toContain('ORGANIZATION_SERVICE_UNAVAILABLE')
        expect(await page.locator('body').innerText()).not.toContain('Private upstream diagnostic')
        await page.locator(`[data-row-key="session:${originalSession}"]`).click()
        expect(await composer.textContent()).toBe('Keep this task draft')
        await openTaskKnowledge(page)
        const unavailableDialog = page.getByRole('dialog')
        await expect.poll(() => unavailableDialog.getByRole('alert').textContent()).toContain('ORGANIZATION_SERVICE_UNAVAILABLE')
        expect(await unavailableDialog.getByRole('button', { name: /^(Apply|应用)$/ }).isDisabled()).toBe(true)
        expect(await unavailableDialog.getByRole('button', { name: /^(Restore available knowledge|恢复可用知识库)$/ }).count()).toBe(0)
        knowledgeUnavailable = false
        await unavailableDialog.getByRole('button', { name: /^(Retry|重试)$/ }).click()
        await unavailableDialog.getByRole('checkbox', { name: 'Operations playbook' }).waitFor()
        await page.keyboard.press('Escape')
        expect(await currentSession()).toBe(originalSession)
        expect(await composer.textContent()).toBe('Keep this task draft')
        await openTaskKnowledge(page)
        await page.getByRole('heading', { name: /(?:Department|部门).*Sales \(21\)/ }).waitFor()
        await page.getByRole('heading', { name: /(?:Department|部门).*Sales \(22\)/ }).waitFor()
        await page.getByRole('checkbox', { name: 'Operations playbook' }).click()
        await page.getByRole('button', { name: /^(Apply|应用)$/ }).click()
        await expect.poll(async () => invoke('tasks.capabilities.read', { sessionId: await currentSession() }))
          .toMatchObject({ knowledgeBaseIds: ['policy'] })
        await page.locator('[data-composer-card]').getByRole('button', { name: 'Operations playbook', exact: true }).waitFor()
        const sessionId = await currentSession()
        await page.keyboard.press('Escape')
        await page.getByRole('button', { name: /^(Connectors|连接器)$/, exact: true }).click()
        await page.getByRole('button', { name: /Order management/ }).click()
        expect(await page.getByRole('dialog').getByRole('checkbox').count()).toBe(0)
        await expect.poll(() => invoke('tasks.capabilities.read', { sessionId }))
          .toMatchObject({ knowledgeBaseIds: ['policy'] })
        await page.keyboard.press('Escape')
        await page.locator('[data-row-key^="session:"]').first().click()
        expect(await currentSession()).toBe(sessionId)
        expect(await composer.textContent()).toBe('Keep this task draft')
        expect(JSON.stringify(await invoke('auth.getSession'))).not.toContain(secret)
        expect(JSON.stringify(await invoke('connectors.list'))).not.toContain('/mcp')
        await page.keyboard.press('Escape')
        await setCodingView(page, true)
        const modePicker = page.locator('[data-slot="conversation.hero.agentPreset"]').getByRole('button')
        expect(await page.getByRole('button', { name: /^(Execution mode|执行模式)$/, exact: true }).count()).toBe(0)
        await modePicker.click()
        const standardEntry = page.getByRole('menuitem', { name: /^(Standard mode|标准模式)/ })
        expect(await standardEntry.textContent()).toMatch(/Work with code, files, and information|处理代码、文件和资料/)
        expect(await standardEntry.locator('svg').count()).toBe(1)
        await page.getByRole('menuitem', { name: /^PTC / }).click()
        await expect.poll(() => invoke('tasks.capabilities.read', { sessionId }))
          .toMatchObject({ basePresetId: 'ptc', knowledgeBaseIds: ['policy'] })
        expect(await currentSession()).toBe(sessionId)
        expect(await composer.textContent()).toBe('Keep this task draft')
        expect(await modePicker.textContent()).toContain('PTC')
        expect(await modePicker.textContent()).not.toContain('product-task-')
        await modePicker.click()
        await page.getByRole('menuitem', { name: /^(Standard mode|标准模式)/ }).click()
        await expect.poll(() => invoke('tasks.capabilities.read', { sessionId }))
          .toMatchObject({ basePresetId: 'standard', knowledgeBaseIds: ['policy'] })
        await page.getByRole('button', { name: /^(Connectors|连接器)$/, exact: true }).click()
        await page.getByRole('button', { name: /Order management/ }).waitFor()
        await page.getByRole('button', { name: /Device configuration missing/ }).waitFor()
        expect(await page.getByText(/^(Needs configuration|待配置)$/, { exact: true }).count()).toBe(0)
        expect(await page.getByRole('tab', { name: /^(Connected|已连接)/ }).count()).toBe(0)
        await page.getByRole('button', { name: /Order management/ }).click()
        expect(await page.getByRole('dialog').getByRole('checkbox').count()).toBe(0)
        await expect.poll(() => invoke('tasks.capabilities.read', { sessionId }))
          .toMatchObject({ knowledgeBaseIds: ['policy'] })
        await page.keyboard.press('Escape')
        await page.locator('[data-row-key^="session:"]').first().click()
        expect(await currentSession()).toBe(sessionId)
        expect(await composer.textContent()).toBe('Keep this task draft')
        await page.keyboard.press('Escape')
        await openTaskKnowledge(page)
        await page.screenshot({ path: join(screenshots, `electron-${carrier}-product-knowledge-groups.png`), animations: 'disabled' })
        await cancelTaskKnowledge(page)
        await composer.fill('Review enterprise policy')
        await composer.press('Enter')
        await page.locator('p').filter({ hasText: /^Fixture review complete\.$/ }).waitFor()
        expect(await modePicker.count()).toBe(0)
        const nativeHeader = page.locator('[data-slot="conversation.session.header.actions"]')
        const modeLabel = nativeHeader.getByText(/^(Standard mode|标准模式)$/, { exact: true })
        await modeLabel.waitFor()
        expect(await nativeHeader.innerText()).not.toContain('product-task-')
        expect(await nativeHeader.getByRole('button', { name: /^(Standard mode|标准模式|Execution mode|执行模式)$/, exact: true }).count()).toBe(0)
        expect(await nativeHeader.getByText(/^(Expert kits|专家套件|Retail operations)$/, { exact: true }).count()).toBe(0)
        await compareOrRefreshGolden(join(expectedDir, 'task-header-without-kit.expected.md'),
          await captureStableAria(page, '[data-slot="conversation.session.header.actions"]', root, {
            replacements: [['标准模式', 'Standard mode'], ['专家套件', 'Expert kits']],
          }), webSnapshotMode())
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 })
          if (width === 390) await expect.poll(() => modeLabel.isVisible()).toBe(false)
          else {
            await expect.poll(async () => {
              const bounds = await modeLabel.boundingBox()
              return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= width
            }).toBe(true)
            expect(await modeLabel.evaluate(label => label.scrollWidth > label.clientWidth)).toBe(false)
          }
          await page.screenshot({ path: join(screenshots, `electron-${carrier}-product-native-header-${width}.png`), animations: 'disabled' })
        }
        await page.setViewportSize({ width: 1440, height: 900 })
        await composer.fill('Replacement task draft')
        await openTaskKnowledge(page)
        await page.getByRole('checkbox', { name: 'Personal notes' }).click()
        await page.getByRole('button', { name: /^(Apply|应用)$/ }).click()
        await expect.poll(currentSession).not.toBe(sessionId)
        const replacementSession = await currentSession()
        await expect.poll(() => invoke('tasks.capabilities.read', { sessionId: replacementSession }))
          .toMatchObject({ knowledgeBaseIds: ['personal-notes', 'policy'] })
        expect(await composer.textContent()).toBe('Replacement task draft')
        await expect.poll(() => page.evaluate(id => localStorage.getItem(`dsh.conversation.${id}`), replacementSession))
          .toContain('Replacement task draft')
        await expect(invoke('tasks.capabilities.read', { sessionId })).resolves.toMatchObject({ knowledgeBaseIds: ['policy'] })
        const prepared = await invoke('tasks.capabilities.prepare', { sessionId: replacementSession }) as { presetId: string }
        const pinnedPath = join(home, 'product-knowledge-tasks-v1', `${prepared.presetId}.json`)
        const restart = async (reason: string) => {
          expect(tripwire.pageErrors).toEqual([])
          await expect.poll(() => page.locator('[data-chat-running]').count()).toBe(0)
          const closing = app!
          app = undefined
          diagnostics.push(`Acceptance restart: ${reason}\n`)
          await closeElectronAcceptance(closing)
          app = await _electron.launch(launchOptions)
          await observeShutdown(app)
          page = await app.firstWindow()
          tripwire = watchConsole(page)
          await page.waitForURL('dsh-app://app/', { timeout: 60_000 })
          await page.setViewportSize({ width: 1440, height: 900 })
          composer = page.locator('[data-composer-input][contenteditable="true"]').last()
          await composer.waitFor({ timeout: 60_000 })
          await page.locator(`[data-row-key="session:${replacementSession}"]`).click()
          await expect.poll(currentSession).toBe(replacementSession)
        }
        await restart('restore prepared task')
        await expect(invoke('tasks.capabilities.read', { sessionId: replacementSession }))
          .resolves.toMatchObject({ knowledgeBaseIds: ['personal-notes', 'policy'] })
        await expect.poll(() => composer.textContent()).toBe('Replacement task draft')
        await composer.fill('Continue the scoped review')
        await composer.press('Enter')
        await page.locator('p').filter({ hasText: /^Fixture review complete\.$/ }).waitFor()
        expect(await page.locator('[data-slot="conversation.hero.agentPreset"]').getByRole('button').count()).toBe(0)
        const resumedHeader = page.locator('[data-slot="conversation.session.header.actions"]')
        await resumedHeader.getByText(/^(Standard mode|标准模式)$/, { exact: true }).waitFor()
        expect(await resumedHeader.innerText()).not.toContain('product-task-')
        expect(await resumedHeader.getByRole('button', { name: /^(Choose expert kit|选择专家套件)$/, exact: true }).count()).toBe(0)
        expect(await resumedHeader.getByText(/^(Expert kits|专家套件|Retail operations)$/, { exact: true }).count()).toBe(0)
        await composer.fill('Replacement task draft')
        await expect.poll(() => page.evaluate(id => localStorage.getItem(`dsh.conversation.${id}`), replacementSession))
          .toContain('Replacement task draft')
        await writeFile(pinnedPath, '{broken snapshot')
        await restart('isolate damaged snapshot')
        await expect(invoke('tasks.capabilities.read', { sessionId: replacementSession }))
          .resolves.toMatchObject({ unavailable: { code: 'TASK_SNAPSHOT_INVALID', retryable: false } })
        await expect.poll(() => composer.textContent()).toBe('Replacement task draft')
        await openTaskKnowledge(page)
        await page.getByRole('dialog').getByRole('button', { name: /^(Recover task capabilities|恢复任务配置)$/ }).click()
        await expect.poll(currentSession).not.toBe(replacementSession)
        const recoveredSession = await currentSession()
        await expect.poll(async () => (await invoke('tasks.capabilities.read', { sessionId: recoveredSession }) as ProductTaskCapabilities).unavailable)
          .toBeUndefined()
        expect(await composer.textContent()).toBe('Replacement task draft')
        await expect(invoke('tasks.capabilities.read', { sessionId: replacementSession }))
          .resolves.toMatchObject({ unavailable: { code: 'TASK_SNAPSHOT_INVALID' } })
        expect(await readFile(pinnedPath, 'utf8')).toBe('{broken snapshot')
        expect(await readFile(`${pinnedPath}.diagnostic.json`, 'utf8')).toContain('TASK_SNAPSHOT_INVALID')
        await expect(invoke('tasks.capabilities.read', { sessionId })).resolves.toMatchObject({ knowledgeBaseIds: ['policy'] })
        expect(model.requests.length).toBeGreaterThan(0)
        expect(model.requests[0]?.body).toMatchObject({ model: 'deepseek-v4-flash' })
        expect(JSON.stringify(model.requests.map(request => request.body))).not.toContain(secret)
        await page.screenshot({ path: join(screenshots, `electron-${carrier}-product-recovered-task.png`), animations: 'disabled' })
      }
      expect(tripwire.pageErrors).toEqual([])
      if (nativeUpdate !== undefined) {
        if (app === undefined) throw new Error('Native update qualification has no application owner')
        page = await nativeUpdate.upgrade(app, page, () => { app = undefined })
      }
      await mkdir(screenshots, { recursive: true })
      await page.screenshot({ path: join(screenshots, `electron-${carrier}-${mode}.png`) })
    },
  )
}
