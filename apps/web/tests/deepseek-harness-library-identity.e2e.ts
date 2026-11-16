import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import type { LibraryEntry } from '@deepseek-harness/product/library'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

const packageDir = join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product')
const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-catalog')

it('keeps library identity retry and renewal stable and disposes old employee edits', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  const page = await newEnglishPage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state === 'fail') {
        await mkdir(screenshots, { recursive: true })
        await page.screenshot({ path: join(screenshots, 'library-panel-identity-failure.png') })
        await writeFile(join(screenshots, 'library-panel-identity-failure.txt'), await page.locator('body').ariaSnapshot())
      }
    } finally { await browser.close() }
  })
  const retryGate = Promise.withResolvers<undefined>(), staleGate = Promise.withResolvers<undefined>()
  const writeGate = Promise.withResolvers<undefined>()
  onTestFinished(() => { retryGate.resolve(undefined); staleGate.resolve(undefined); writeGate.resolve(undefined) })
  let mode: 'ready' | 'failed' | 'retry' | 'stale' = 'ready'
  let employeeId = 'alice', identityReads = 0, listReads = 0, writes = 0, cancellations = 0
  const now = '2026-11-13T01:00:00Z'
  await page.exposeFunction('__libraryIdentityInvoke', async (method: string) => {
    if (method === 'auth.getSession') {
      identityReads++
      const current = employeeId
      if (mode === 'failed') return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Identity unavailable', true)) }
      if (mode === 'retry') await retryGate.promise
      if (mode === 'stale') await staleGate.promise
      return { authenticated: true, employeeId: current, displayName: current }
    }
    if (method === 'library.files.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
    if (method === 'library.personal.ensure' || method === 'library.get') return {
      id: '11111111-1111-4111-8111-111111111111', name: `${employeeId} library`, description: 'Private files',
      scope: 'PERSONAL', ownerId: employeeId, companyId: 'company', role: 'OWNER', canManage: true,
      version: 1, createdAt: now, updatedAt: now }
    if (method === 'library.entries.list') { listReads++; return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 } }
    if (method === 'library.list') {
      listReads++
      return { data: [{ id: '11111111-1111-4111-8111-111111111111', name: `${employeeId} library`, description: 'Private files',
        scope: 'PERSONAL', ownerId: employeeId, companyId: 'company', role: 'OWNER', canManage: true,
        version: 1, createdAt: now, updatedAt: now }], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    }
    if (method === 'library.folders.create') { writes++; await writeGate.promise; return true }
    throw new Error(`Unexpected library identity method: ${method}`)
  })
  await page.exposeFunction('__libraryIdentityCancel', () => { cancellations++ })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & {
      __libraryIdentityInvoke(method: string): Promise<unknown>
      __libraryIdentityCancel(): Promise<void>
    }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string) => {
        const result = await api.__libraryIdentityInvoke(method)
        return typeof result === 'object' && result !== null && 'fixtureFailure' in result
          ? { ok: false, failure: result.fixtureFailure } : { ok: true, result }
      }, cancel: () => { void api.__libraryIdentityCancel() },
      subscribe: (_namespace: string, listener: (event: unknown) => void) => {
        const receive = (event: Event) => { if (event instanceof CustomEvent) listener(event.detail) }
        globalThis.addEventListener('library-panel-identity', receive)
        return () => { globalThis.removeEventListener('library-panel-identity', receive) }
      },
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'alice', exact: true }).waitFor()
  mode = 'failed'
  await page.getByRole('button', { name: 'Libraries', exact: true }).click()
  const retry = page.getByRole('button', { name: 'Retry', exact: true })
  await retry.waitFor()
  const retryNode = await retry.elementHandle(), alert = await page.getByRole('alert').elementHandle()
  const retryBounds = await retry.boundingBox(), beforeRetry = identityReads
  mode = 'retry'
  await retry.focus(); await retry.press('Enter'); await retry.press(' ')
  await expect.poll(() => identityReads).toBe(beforeRetry + 1)
  expect(await retry.evaluate((node, previous) => node === previous && node === document.activeElement, retryNode)).toBe(true)
  expect(await retry.getAttribute('aria-busy')).toBe('true')
  expect(await retry.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
  expect(await retry.boundingBox()).toEqual(retryBounds)
  expect(await page.getByRole('alert').evaluate((node, previous) => node === previous, alert)).toBe(true)
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
          .evaluate(node => node.getBoundingClientRect().right <= 1 && getComputedStyle(node).visibility === 'hidden')).toBe(true)
      }
      await retry.focus()
      expect(await page.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-identity-retry-${theme}-${width}.png`) })
    }
  }
  mode = 'ready'
  retryGate.resolve(undefined)
  const homeSearch = page.getByRole('searchbox', { name: 'Search names', exact: true })
  await homeSearch.waitFor()
  expect(await homeSearch.evaluate(node => node === document.activeElement)).toBe(true)
  await page.getByRole('button', { name: 'Upload files', exact: true }).click()
  const row = page.getByRole('button', { name: 'alice library', exact: true, includeHidden: true })
  await row.waitFor()
  const search = page.getByRole('dialog', { name: 'Choose upload destination', exact: true, includeHidden: true })
    .getByRole('searchbox', { name: 'Search names', exact: true, includeHidden: true })
  await search.focus()
  const rowNode = await row.elementHandle(), searchNode = await search.elementHandle(), beforeRenewal = listReads
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('dialog', { name: 'Choose upload destination', exact: true })
    .getByRole('button', { name: 'New folder', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New folder', exact: true })
  const input = dialog.getByRole('textbox', { name: 'Name', exact: true })
  await input.fill('Retain this private draft')
  await input.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(7, 11) })
  const inputNode = await input.elementHandle(), save = dialog.getByRole('button', { name: 'Save', exact: true })
  const saveNode = await save.elementHandle(), saveBounds = await save.boundingBox()
  const scroll = await dialog.evaluate(node => node.scrollTop)
  mode = 'stale'
  await page.evaluate(() => { globalThis.dispatchEvent(new CustomEvent('library-panel-identity', { detail: {
    type: 'session.changed', payload: { authenticated: true, employeeId: 'alice', displayName: 'alice' },
  } })) })
  expect(await input.evaluate((node, previous) => node === previous && node === document.activeElement, inputNode)).toBe(true)
  expect(await input.evaluate(node => node instanceof HTMLInputElement && [node.value, node.selectionStart, node.selectionEnd]))
    .toEqual(['Retain this private draft', 7, 11])
  expect(await save.evaluate((node, previous) => node === previous, saveNode)).toBe(true)
  expect(await save.boundingBox()).toEqual(saveBounds)
  expect(await dialog.evaluate(node => node.scrollTop)).toBe(scroll)
  expect(listReads).toBe(beforeRenewal)
  expect(await row.evaluate((node, previous) => node === previous, rowNode)).toBe(true)
  expect(await search.evaluate((node, previous) => node === previous, searchNode)).toBe(true)
  await save.click()
  await expect.poll(() => writes).toBe(1)
  employeeId = 'bob'
  await page.evaluate(() => { globalThis.dispatchEvent(new CustomEvent('library-panel-identity', { detail: {
    type: 'session.changed', payload: { authenticated: true, employeeId: 'bob', displayName: 'bob' },
  } })) })
  await dialog.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Upload files', exact: true }).click()
  await page.getByRole('button', { name: 'bob library', exact: true }).waitFor()
  expect(await row.count()).toBe(0)
  await expect.poll(() => cancellations).toBe(1)
  await search.focus()
  await page.getByRole('dialog', { name: 'Choose upload destination', exact: true })
    .getByRole('button', { name: 'New folder', exact: true }).click()
  await dialog.waitFor()
  writeGate.resolve(undefined)
  staleGate.resolve(undefined)
  expect(await input.inputValue()).toBe('')
  expect(await dialog.count()).toBe(1)
  await page.evaluate(() => { globalThis.dispatchEvent(new CustomEvent('library-panel-identity', { detail: {
    type: 'session.changed', payload: { authenticated: false },
  } })) })
  await dialog.waitFor({ state: 'detached' })
  await page.getByRole('dialog', { name: 'Sign in to DeepSeek Harness', exact: true }).waitFor()
  expect(await page.getByRole('button', { name: 'Sign in with DingTalk', exact: true }).count()).toBe(1)
  expect(await search.count()).toBe(0)
  expect(await page.getByRole('button', { name: 'bob library', exact: true }).count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('keeps searched folder navigation and shrinking pagination stable in the real client', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch(), page = await newEnglishPage(browser)
  onTestFinished(() => browser.close())
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  const now = '2026-11-13T01:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: 'Audit library', description: '',
    scope: 'PERSONAL', ownerId: 'alice', companyId: 'company', role: 'OWNER', canManage: true,
    version: 1, createdAt: now, updatedAt: now }
  const parent: LibraryEntry = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id,
    name: 'Actual parent', parentId: null, kind: 'FOLDER', sha256: null, mediaType: null,
    sizeBytes: 0, version: 1, createdAt: now, updatedAt: now }
  const nested = { ...parent, id: '33333333-3333-4333-8333-333333333333', name: 'Nested match', parentId: parent.id }
  const file = { ...parent, id: '44444444-4444-4444-8444-444444444444', name: 'Old tail file.md', kind: 'FILE',
    sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12 }
  let ancestryReads = 0, correcting = false, tail = false, removed = false
  const ancestry = Promise.withResolvers<LibraryEntry>(), correction = Promise.withResolvers<undefined>()
  onTestFinished(() => { ancestry.resolve(parent); correction.resolve(undefined) })
  await page.exposeFunction('__libraryBrowseInvoke', async (method: string, payload?: {
    readonly query?: string
    readonly parentId?: string | null
    readonly page?: number
  }) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'alice', displayName: 'alice' }
    if (method === 'library.files.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
    if (method === 'library.list') return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    if (method === 'library.get') return library
    if (method === 'library.entries.get') {
      if (++ancestryReads === 1) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Folder read failed', true)) }
      return ancestry.promise
    }
    if (method === 'library.entries.list') {
      const pageIndex = payload?.page ?? 1
      if (tail) {
        if (removed && pageIndex === 1) { correcting = true; await correction.promise }
        const data = removed && pageIndex === 2 ? [] : [removed ? { ...file, id: parent.id, name: 'Remaining file.md' } : file]
        return { data, pageIndex, pageSize: 20, totalCount: removed ? 20 : 21, totalPages: removed ? 1 : 2 }
      }
      const data = payload?.query ? [nested] : payload?.parentId === nested.id ? [file] : [parent]
      return { data, pageIndex, pageSize: 20, totalCount: 1, totalPages: 1 }
    }
    throw new Error(`Unexpected library browse method: ${method}`)
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __libraryBrowseInvoke(method: string, payload?: unknown): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string, payload?: unknown) => {
        const result = await api.__libraryBrowseInvoke(method, payload)
        return typeof result === 'object' && result !== null && 'fixtureFailure' in result
          ? { ok: false, failure: result.fixtureFailure } : { ok: true, result }
      }, cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Add files or run commands', exact: true }).click()
  await page.getByRole('option', { name: /Choose library files/ }).click()
  await page.getByRole('button', { name: library.name, exact: true }).click()
  const search = page.getByRole('searchbox', { name: 'Search names', exact: true })
  await search.fill(nested.name)
  const row = page.getByRole('button', { name: `${nested.name} Folder`, exact: true })
  const rowNode = await row.elementHandle(), searchNode = await search.elementHandle()
  await row.click()
  const alert = page.getByRole('alert')
  await alert.waitFor()
  const alertNode = await alert.elementHandle(), before = await row.boundingBox()
  await row.press('Enter'); await row.press(' ')
  await expect.poll(() => ancestryReads).toBe(2)
  expect(await row.evaluate((node, previous) => node === previous && node === document.activeElement, rowNode)).toBe(true)
  expect(await row.boundingBox()).toEqual(before)
  expect(await alert.evaluate((node, previous) => node === previous, alertNode)).toBe(true)
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
          .evaluate(node => node.getBoundingClientRect().right <= 1 && getComputedStyle(node).visibility === 'hidden')).toBe(true)
      }
      expect(await page.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      expect(await row.evaluate((node) => {
        const bounds = node.getBoundingClientRect()
        return bounds.left >= 0 && bounds.right <= innerWidth
      })).toBe(true)
      await mkdir(screenshots, { recursive: true })
      await page.screenshot({ path: join(screenshots, `library-folder-navigation-${theme}-${width}.png`) })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  ancestry.resolve(parent)
  await page.getByRole('button', { name: `${file.name} 1 KB`, exact: true }).waitFor()
  expect(await search.evaluate((node, previous) => node === previous, searchNode)).toBe(true)
  expect(await search.inputValue()).toBe('')
  await page.getByRole('button', { name: parent.name, exact: true }).waitFor()
  await page.getByRole('button', { name: library.name, exact: true }).click()
  tail = true
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
  await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('false')
  await refresh.click()
  await page.getByText('1 / 2', { exact: true }).waitFor()
  await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('false')
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.getByText('2 / 2', { exact: true }).waitFor()
  await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('false')
  const tailRow = page.getByRole('button', { name: `${file.name} 1 KB`, exact: true })
  const tailNode = await tailRow.elementHandle(), refreshNode = await refresh.elementHandle(), refreshBounds = await refresh.boundingBox()
  removed = true
  await refresh.click()
  await expect.poll(() => correcting).toBe(true)
  expect(await tailRow.evaluate((node, previous) => node === previous, tailNode)).toBe(true)
  expect(await page.getByText('No files yet', { exact: true }).filter({ visible: true }).count()).toBe(0)
  expect(await refresh.evaluate((node, previous) => node === previous && node === document.activeElement, refreshNode)).toBe(true)
  expect(await refresh.boundingBox()).toEqual(refreshBounds)
  expect(await refresh.getAttribute('aria-busy')).toBe('true')
  correction.resolve(undefined)
  await page.getByRole('button', { name: 'Remaining file.md 1 KB', exact: true }).waitFor()
  await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('false')
  expect(await page.getByRole('button', { name: 'Previous', exact: true }).isVisible()).toBe(false)
  expect(await refresh.evaluate(node => node === document.activeElement)).toBe(true)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
