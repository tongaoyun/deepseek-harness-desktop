/** File-first product views exercised in the real native Web composition. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'

it('keeps global files, filters, dialogs and refresh stable in light, dark and narrow windows', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch(), page = await newEnglishPage(browser)
  page.setDefaultTimeout(10000)
  onTestFinished(() => browser.close())
  const tripwire = watchConsole(page)
  const now = '2026-11-14T01:00:00Z'
  const files = ['Project proposal.docx', 'Review presentation.pptx', '网页示例.html', '参考图片.png', '资料归档.zip'].map((name, i) => ({
    entry: { id: `22222222-2222-4222-8222-${String(i + 1).padStart(12, '0')}`, libraryId: '11111111-1111-4111-8111-111111111111',
      parentId: null, name, kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'application/octet-stream', sizeBytes: (i + 1) * 5120,
      favorite: true, version: 1, createdAt: now, updatedAt: now },
    libraryName: 'Project files', canManage: true, lastAccessedAt: now, sourceKind: i === 0 ? 'CONVERSATION' : 'UPLOAD', sourceSessionId: i === 0 ? 'native-source' : null,
  }))
  let fail = false, reads = 0
  let refreshGate: Promise<undefined> | undefined
  await page.exposeFunction('__libraryHomeInvoke', async (method: string, input: { category?: string; query?: string; sort?: string; direction?: string; view?: string; entryId?: string }) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee', displayName: 'Test employee' }
    if (method === 'library.files.list') {
      reads++
      if (refreshGate) await refreshGate
      if (fail) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Read unavailable', true)) }
      const matches = files.filter(file => file.entry.name.toLowerCase().includes((input.query ?? '').toLowerCase())
        && (input.view !== 'favorites' || file.entry.favorite)
        && (input.category === 'all' || (input.category === 'html' ? file.entry.name.endsWith('.html')
          : input.category === 'document' ? /\.(docx|pptx)$/.test(file.entry.name)
            : input.category === 'media' ? file.entry.name.endsWith('.png') : file.entry.name.endsWith('.zip'))))
      if (input.sort === 'size') matches.sort((a, b) => (a.entry.sizeBytes - b.entry.sizeBytes) * (input.direction === 'asc' ? 1 : -1))
      return { data: matches, pageIndex: 1, pageSize: 20, totalCount: matches.length, totalPages: matches.length ? 1 : 0 }
    }
    if (method === 'library.entries.favorite') {
      const file = files.find(value => value.entry.id === input.entryId)
      if (file) file.entry.favorite = false
      return false
    }
    if (method === 'library.entries.delete') {
      const index = files.findIndex(value => value.entry.id === input.entryId)
      if (index >= 0) files.splice(index, 1)
      return true
    }
    if (method === 'library.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
    throw new Error(`Unexpected library home method: ${method}`)
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __libraryHomeInvoke(method: string, input: unknown): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string, input: unknown) => {
        const result = await api.__libraryHomeInvoke(method, input)
        return typeof result === 'object' && result !== null && 'fixtureFailure' in result
          ? { ok: false, failure: result.fixtureFailure } : { ok: true, result }
      }, cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Libraries', exact: true }).click()
  const row = page.getByRole('button', { name: 'Project proposal.docx Project files', exact: true })
  await row.waitFor()
  const node = await row.elementHandle()
  const upload = page.getByRole('button', { name: 'Upload files', exact: true }), uploadNode = await upload.elementHandle()
  const search = page.getByRole('searchbox', { name: 'Search names' }), searchNode = await search.elementHandle()
  await page.getByRole('button', { name: 'Grid', exact: true }).click()
  expect(await row.evaluate((current, previous) => current === previous, node)).toBe(true)
  await page.getByRole('button', { name: 'List', exact: true }).click()
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
  const bounds = await upload.boundingBox()
  const gate = Promise.withResolvers<undefined>()
  onTestFinished(() => { gate.resolve(undefined) })
  refreshGate = gate.promise
  await refresh.focus(); await refresh.press('Enter'); await refresh.press(' ')
  await expect.poll(() => reads).toBe(2)
  expect(await upload.boundingBox()).toEqual(bounds)
  expect(await upload.evaluate((current, previous) => current === previous, uploadNode)).toBe(true)
  expect(await row.evaluate((current, previous) => current === previous, node)).toBe(true)
  fail = true; gate.resolve(undefined); refreshGate = undefined
  await page.getByRole('alert').waitFor()
  const retry = page.getByRole('button', { name: 'Retry', exact: true }), retryNode = await retry.elementHandle()
  const alertNode = await page.getByRole('alert').elementHandle()
  const retryGate = Promise.withResolvers<undefined>()
  onTestFinished(() => { retryGate.resolve(undefined) })
  refreshGate = retryGate.promise
  await retry.focus(); await retry.press('Enter'); await retry.press(' ')
  await expect.poll(() => reads).toBe(3)
  expect(await retry.evaluate((current, previous) => current === previous && current === document.activeElement, retryNode)).toBe(true)
  expect(await page.getByRole('alert').evaluate((current, previous) => current === previous, alertNode)).toBe(true)
  fail = false; retryGate.resolve(undefined); refreshGate = undefined
  await page.getByRole('alert').waitFor({ state: 'detached' })
  expect(await search.evaluate(current => current === document.activeElement)).toBe(true)
  expect(await search.evaluate((current, previous) => current === previous, searchNode)).toBe(true)
  await page.getByRole('button', { name: 'HTML', exact: true }).click()
  await page.getByRole('button', { name: '网页示例.html Project files', exact: true }).waitFor()
  await row.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await row.waitFor()
  const action = page.getByRole('button', { name: 'More actions · Project proposal.docx', exact: true })
  await action.click(); await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Name', exact: true }), inputNode = await input.elementHandle()
  await input.fill('Retained draft.docx')
  await input.evaluate((current) => { if (current instanceof HTMLInputElement) current.setSelectionRange(2, 7) })
  await input.press('Escape')
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  expect(await input.evaluate((current, previous) => current === previous && current === document.activeElement, inputNode)).toBe(true)
  expect(await input.evaluate(current => current instanceof HTMLInputElement
    && [current.selectionStart, current.selectionEnd])).toEqual([2, 7])
  await input.press('Escape'); await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  expect(await action.evaluate(current => current === document.activeElement)).toBe(true)
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-catalog')
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      if (width === 390) {
        await page.locator('[data-sidebar-drawer]').waitFor({ state: 'attached' })
        if (await page.locator('[data-sidebar-drawer]:not([data-sidebar-collapsed])').count()) {
          await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
        }
        await expect.poll(() => page.locator('[data-sidebar-drawer][data-sidebar-collapsed]').count()).toBe(1)
        await expect.poll(() => page.locator('[data-sidebar-drawer] > [inert]').first()
          .evaluate(current => current.getBoundingClientRect().right <= 1 && getComputedStyle(current).visibility === 'hidden')).toBe(true)
      }
      for (const layout of ['List', 'Grid']) {
        await page.getByRole('button', { name: layout, exact: true }).click()
        expect(await page.locator('body').evaluate(current => current.scrollWidth <= current.clientWidth + 1)).toBe(true)
        await page.screenshot({ path: join(screenshots, `library-home-${theme}-${width}-${layout.toLowerCase()}.png`) })
      }
    }
  }
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
