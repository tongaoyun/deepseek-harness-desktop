/** Product interactions mounted through the real Harness Web composition. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { REPO_ROOT, newEnglishPage, controlIsUnclipped } from './support.ts'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'

const packageDir = join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product')

const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-catalog')

const connectors = [
  { id: 'erp', displayName: 'Order management', summary: 'Orders, inventory, and fulfillment', category: 'business-systems',
    visibility: 'COMPANY', reviewStatus: 'PUBLISHED', version: '1.0.0',
    availabilityStatus: 'AVAILABLE', authMode: 'employee-bearer', status: 'ACTIVE', tools: [
      { name: 'orders_read', displayName: 'Read orders', description: 'Query order status and totals.', access: 'READ' },
      { name: 'orders_update', displayName: 'Update orders', description: 'Change order delivery details.', access: 'WRITE' },
    ] },
  { id: 'crm', displayName: 'Customer workspace', summary: 'Customer profiles and sales activity', category: 'business-systems',
    visibility: 'COMPANY', reviewStatus: 'PUBLISHED', version: '1.0.0',
    availabilityStatus: 'AUTHORIZATION_REQUIRED', authMode: 'oauth', authorizationStatus: 'REQUIRED', tools: [] },
]

it('keeps composer login, partial library uploads and cancelled selections stable', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  await seedSession(scaffold, await readFile(join(REPO_ROOT, 'snapshots/web/present-after-closing-reply/session.v4.jsonl'), 'utf8'), 'library-upload-access')
  const browser = await chromium.launch()
  const page = await newEnglishPage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state !== 'fail' || page.isClosed()) return
      await mkdir(screenshots, { recursive: true })
      await page.screenshot({ path: join(screenshots, 'library-upload-access-failure.png') })
      await writeFile(join(screenshots, 'library-upload-access-failure.txt'), await page.locator('body').ariaSnapshot())
    } finally { await browser.close() }
  })
  const loginGate = Promise.withResolvers<undefined>(), retryGate = Promise.withResolvers<undefined>()
  const selectionGate = Promise.withResolvers<undefined>()
  const firstUploadGate = Promise.withResolvers<undefined>()
  onTestFinished(() => {
    loginGate.resolve(undefined); retryGate.resolve(undefined); selectionGate.resolve(undefined); firstUploadGate.resolve(undefined)
  })
  let authenticated = false, resourceReads = 0, selects = 0, discards = 0
  const now = '2026-11-13T01:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: 'Upload library', description: 'Reference files',
    scope: 'PERSONAL', ownerId: 'fixture-employee', managerEmployeeId: 'fixture-employee', canManage: true,
    version: 1, createdAt: now, updatedAt: now }
  const files = [
    { selectionId: '22222222-2222-4222-8222-222222222222', name: 'First.md', sizeBytes: 12 },
    { selectionId: '33333333-3333-4333-8333-333333333333', name: 'Second.md', sizeBytes: 12 },
  ]
  const singleFile = { selectionId: '55555555-5555-4555-8555-555555555555', name: 'New.md', sizeBytes: 12 }
  const invalidFile = { selectionId: '66666666-6666-4666-8666-666666666666', name: '中文参考资料'.repeat(18) + '.md', sizeBytes: 12 }
  const recoveredFile = { ...invalidFile, selectionId: '77777777-7777-4777-8777-777777777777' }
  const writes: unknown[] = []
  const uploaded: string[] = []
  await page.exposeFunction('__libraryUploadInvoke', async (method: string, payload?: unknown) => {
    if (method === 'auth.getSession') return authenticated ? { authenticated, employeeId: 'fixture-employee' } : { authenticated }
    if (method === 'auth.ensureDingTalk') { await loginGate.promise; return { authenticated: false } }
    if (method === 'library.files.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
    if (method === 'library.list') { resourceReads++; return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 } }
    if (method === 'library.get') return library
    if (method === 'library.entries.list') return { data: uploaded.map(id => ({ id, libraryId: library.id, parentId: null,
      name: [...files, singleFile, recoveredFile].find(file => file.selectionId === id)!.name, kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown',
      sizeBytes: 12, favorite: false, version: 1, createdAt: now, updatedAt: now })), pageIndex: 1, pageSize: 20,
    totalCount: uploaded.length, totalPages: uploaded.length ? 1 : 0 }
    if (method === 'library.files.upload.select') {
      const attempt = ++selects
      if (attempt === 2) return []
      if (attempt === 3) await selectionGate.promise
      if (attempt === 4) return [singleFile]
      if (attempt === 5) return [invalidFile]
      if (attempt === 6) return [recoveredFile]
      return attempt === 1 ? files : [{ ...files[0], selectionId: '44444444-4444-4444-8444-444444444444' }]
    }
    if (method === 'library.files.upload') {
      writes.push(payload)
      if (writes.length === 1) await firstUploadGate.promise
      if (writes.length === 6) return { fixtureFailure: productFailure(new ProductError('LIBRARY_FILE_INVALID', 'Selected file changed', false)) }
      if (writes.length === 2 || writes.length === 4) return { fixtureFailure: productFailure(new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Upload result pending', true)) }
      if (writes.length === 3) await retryGate.promise
      if (typeof payload !== 'object' || payload === null || !('selectionId' in payload) || typeof payload.selectionId !== 'string') {
        throw new Error('Invalid fixture upload')
      }
      uploaded.push(payload.selectionId)
      return true
    }
    if (method === 'library.files.upload.discard') { discards++; return true }
    throw new Error(`Unexpected upload access method: ${method}`)
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __libraryUploadInvoke(method: string, payload?: unknown): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string, payload?: unknown) => {
        const result = await api.__libraryUploadInvoke(method, payload)
        return typeof result === 'object' && result !== null && 'fixtureFailure' in result
          ? { ok: false, failure: result.fixtureFailure } : { ok: true, result }
      }, cancel: () => {}, subscribe: (_namespace: string, listener: (event: unknown) => void) => {
        const receive = (event: Event) => { if (event instanceof CustomEvent) listener(event.detail) }
        globalThis.addEventListener('library-upload-session', receive)
        return () => { globalThis.removeEventListener('library-upload-session', receive) }
      },
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  const initialLogin = page.getByRole('dialog', { name: 'Sign in to use organization resources', exact: true })
  await initialLogin.waitFor()
  await initialLogin.getByRole('button', { name: 'Cancel', exact: true }).click()
  await initialLogin.waitFor({ state: 'hidden' })
  await page.locator('[role="treeitem"]').first().click()
  await page.locator('[role="treeitem"]').nth(1).click()
  await page.getByText('REPORT_READY', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Not signed in', exact: true }).waitFor()
  const input = page.locator('[data-composer-input]').first()
  // Complete native Session autofocus before opening a product overlay.
  await expect.poll(() => input.evaluate(node => node === document.activeElement)).toBe(true)
  await input.fill('Retain this composer draft')
  const inputNode = await input.elementHandle()
  await page.getByRole('button', { name: 'Add files or run commands', exact: true }).click()
  await page.getByRole('option', { name: /Choose library files/ }).click()
  const login = page.getByRole('dialog', { name: 'Sign in to use organization resources', exact: true })
  await login.waitFor()
  expect(await page.getByRole('dialog', { name: 'Choose library files', exact: true }).count()).toBe(0)
  expect(resourceReads).toBe(0)
  await login.getByRole('button', { name: 'Cancel', exact: true }).click()
  loginGate.resolve(undefined)
  expect(await input.evaluate((node, previous) => node === previous, inputNode)).toBe(true)
  expect(await input.textContent()).toBe('Retain this composer draft')
  authenticated = true
  await page.evaluate(() => { globalThis.dispatchEvent(new CustomEvent('library-upload-session', { detail: {
    type: 'session.changed', payload: { authenticated: true, employeeId: 'fixture-employee' },
  } })) })
  await page.getByRole('button', { name: 'Libraries', exact: true }).click()
  await page.getByRole('button', { name: 'Library directory', exact: true }).click()
  await page.getByRole('button', { name: /Upload library Reference files/ }).click()
  const trigger = page.getByRole('button', { name: 'Upload files', exact: true })
  const triggerNode = await trigger.elementHandle()
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true })
  const choose = dialog.getByRole('button', { name: 'Choose local files', exact: true })
  const upload = dialog.getByRole('button', { name: 'Upload files', exact: true })
  await choose.click()
  await dialog.getByText('Second.md · 1 KB', { exact: true }).waitFor()
  await upload.click()
  await expect.poll(() => writes.length).toBe(1)
  const pendingRemove = dialog.getByRole('button', { name: `Remove: ${files[0]!.name}`, exact: true })
  expect(await pendingRemove.getAttribute('aria-disabled')).toBe('true')
  await pendingRemove.focus(); await pendingRemove.press('Enter')
  expect(writes).toHaveLength(1)
  expect(discards).toBe(0)
  firstUploadGate.resolve(undefined)
  const alert = dialog.getByRole('alert')
  await alert.waitFor()
  expect(await choose.evaluate(node => node === document.activeElement)).toBe(true)
  const alertNode = await alert.elementHandle(), uploadNode = await upload.elementHandle(), uploadBounds = await upload.boundingBox()
  const row = dialog.getByText('Second.md · 1 KB', { exact: true }), rowNode = await row.elementHandle()
  expect(await dialog.getByText('First.md · 1 KB', { exact: true }).count()).toBe(0)
  await choose.click()
  await expect.poll(() => selects).toBe(2)
  expect(await alert.evaluate((node, previous) => node === previous, alertNode)).toBe(true)
  expect(await row.evaluate((node, previous) => node === previous, rowNode)).toBe(true)
  await upload.focus(); await upload.press('Enter'); await upload.press(' ')
  await expect.poll(() => writes.length).toBe(3)
  expect(writes[2]).toEqual(writes[1])
  expect(await upload.evaluate((node, previous) => node === previous && node === document.activeElement, uploadNode)).toBe(true)
  expect(await upload.boundingBox()).toEqual(uploadBounds)
  await page.keyboard.press('Escape')
  expect(await dialog.count()).toBe(1)
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-upload-retry-${theme}-${width}.png`) })
    }
  }
  retryGate.resolve(undefined)
  await dialog.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Second.md 1 KB', exact: true }).waitFor()
  expect(await trigger.evaluate((node, previous) => node === previous && node === document.activeElement, triggerNode)).toBe(true)
  await trigger.click()
  await choose.click()
  await expect.poll(() => selects).toBe(3)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  selectionGate.resolve(undefined)
  await expect.poll(() => discards).toBe(3)
  expect(writes).toHaveLength(3)
  await trigger.click()
  await choose.click()
  const remaining = dialog.getByText('New.md · 1 KB', { exact: true })
  await remaining.waitFor()
  const stableDialog = await dialog.boundingBox(), stableUpload = await upload.boundingBox(), stableChoose = await choose.boundingBox()
  const stableRow = await remaining.elementHandle(), stableButton = await upload.elementHandle()
  await upload.focus(); await upload.press('Enter')
  await alert.waitFor()
  expect(await dialog.boundingBox()).toEqual(stableDialog)
  expect(await upload.boundingBox()).toEqual(stableUpload)
  expect(await choose.boundingBox()).toEqual(stableChoose)
  expect(await remaining.evaluate((node, previous) => node === previous, stableRow)).toBe(true)
  expect(await upload.evaluate((node, previous) => node === previous && node === document.activeElement, stableButton)).toBe(true)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await dialog.locator('[role="alert"]').evaluate(node => node.getBoundingClientRect().right <= innerWidth)).toBe(true)
      if (width === 390) {
        expect(await alert.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
        await alert.focus(); await alert.press('End')
        await expect.poll(() => alert.evaluate(node => node.scrollTop > 0)).toBe(true)
        await upload.focus()
      }
      await page.screenshot({ path: join(screenshots, `library-upload-error-${theme}-${width}.png`) })
    }
  }
  await upload.press('Enter')
  await dialog.waitFor({ state: 'detached' })
  expect(writes).toHaveLength(5)
  expect(writes[4]).toEqual(writes[3])
  expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true)
  await trigger.click()
  await choose.click()
  const invalidRow = dialog.getByText(`${invalidFile.name} · 1 KB`, { exact: true })
  await invalidRow.waitFor()
  await upload.click()
  await alert.waitFor()
  expect(await alert.textContent()).toBe('File validation failed. Select the file again. (LIBRARY_FILE_INVALID)')
  const remove = dialog.getByRole('button', { name: `Remove: ${invalidFile.name}`, exact: true })
  const retainedChoose = await choose.elementHandle(), retainedUpload = await upload.elementHandle()
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      expect(await controlIsUnclipped(remove)).toBe(true)
      expect(await controlIsUnclipped(upload)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-upload-reselect-${theme}-${width}.png`) })
    }
  }
  await remove.focus(); await remove.press('Enter')
  await invalidRow.waitFor({ state: 'detached' })
  await expect.poll(() => discards).toBe(5)
  expect(await choose.evaluate((node, previous) => node === previous && node === document.activeElement, retainedChoose)).toBe(true)
  expect(await upload.evaluate((node, previous) => node === previous, retainedUpload)).toBe(true)
  expect(await upload.getAttribute('aria-disabled')).toBe('true')
  await choose.press('Enter')
  await dialog.getByText(`${recoveredFile.name} · 1 KB`, { exact: true }).waitFor()
  await upload.click()
  await dialog.waitFor({ state: 'detached' })
  expect(writes).toHaveLength(7)
  expect(writes[5]).toMatchObject({ selectionId: invalidFile.selectionId })
  expect(writes[6]).toMatchObject({ selectionId: recoveredFile.selectionId })
  expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('keeps library attachment errors visible and preserves the native composer through retry', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  await seedSession(scaffold, await readFile(join(REPO_ROOT, 'snapshots/web/present-after-closing-reply/session.v4.jsonl'), 'utf8'), 'library-attachment-retry')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  const gate = Promise.withResolvers<undefined>()
  onTestFinished(() => { gate.resolve(undefined) })
  let attempts = 0, closed = 0
  let cancellationPhase: 'open' | 'read' | undefined, reading = false, cancellations = 0
  const cancelledOpen = Promise.withResolvers<undefined>(), cancelledRead = Promise.withResolvers<undefined>()
  onTestFinished(() => { cancelledOpen.resolve(undefined); cancelledRead.resolve(undefined) })
  const now = '2026-11-13T01:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: 'Attachment library', description: 'Reference files',
    scope: 'PERSONAL', ownerId: 'fixture-employee', managerEmployeeId: 'fixture-employee', canManage: true,
    version: 1, createdAt: now, updatedAt: now }
  const files = Array.from({ length: 20 }, (_, index) => ({
    id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`, libraryId: library.id, parentId: null,
    name: `Reference ${index}.md`, kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 3,
    favorite: false, version: 1, createdAt: now, updatedAt: now,
  }))
  await page.exposeFunction('__libraryAttachmentInvoke', async (method: string, payload?: unknown) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'fixture-employee' }
    if (method === 'library.files.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
    if (method === 'library.list') return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    if (method === 'library.get') return library
    if (method === 'library.entries.list') return { data: files, pageIndex: 1, pageSize: 20, totalCount: 20, totalPages: 1 }
    if (method === 'library.files.preview.open') {
      expect(payload).toMatchObject({ libraryId: library.id, entryId: files[0]!.id, attachment: true, sha256: files[0]!.sha256 })
      const phase = cancellationPhase
      if (phase !== undefined) {
        attempts++
        if (phase === 'open') await cancelledOpen.promise
        return { transferId: `cancelled-${phase}`, mediaType: 'text/markdown', byteLength: 3, maxBytes: 1024, chunkSize: 1024 }
      }
      if (++attempts === 1) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'PRIVATE_FILE_READER_OFFLINE', true)) }
      await gate.promise
      return { transferId: 'library-attachment', mediaType: 'text/markdown', byteLength: 3, maxBytes: 1024, chunkSize: 1024 }
    }
    if (method === 'library.files.preview.read') {
      if (cancellationPhase === 'read') { reading = true; await cancelledRead.promise }
      return { data: [65, 66, 67], offset: 0, eof: true }
    }
    if (method === 'library.files.preview.close') { closed++; return { closed: true } }
    if (method === 'library.entries.access') return true
    throw new Error(`Unexpected attachment method: ${method}`)
  })
  await page.exposeFunction('__libraryAttachmentCancel', () => { cancellations++ })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & {
      __libraryAttachmentInvoke(method: string, payload?: unknown): Promise<unknown>
      __libraryAttachmentCancel(): Promise<void>
    }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string, payload?: unknown) => {
        const result = await api.__libraryAttachmentInvoke(method, payload)
        if (method === 'library.files.preview.read' && typeof result === 'object' && result !== null
          && 'data' in result && Array.isArray(result.data)) return { ok: true, result: { ...result, data: new Uint8Array(result.data) } }
        return typeof result === 'object' && result !== null && 'fixtureFailure' in result
          ? { ok: false, failure: result.fixtureFailure } : { ok: true, result }
      }, cancel: () => { void api.__libraryAttachmentCancel() }, subscribe: () => () => {},
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.locator('[role="treeitem"]').first().click()
  await page.locator('[role="treeitem"]').nth(1).click()
  await page.getByText('REPORT_READY', { exact: true }).waitFor()
  const composer = page.locator('[data-composer-input]').first()
  await expect.poll(() => composer.evaluate(node => node === document.activeElement)).toBe(true)
  await composer.fill('Retained attachment draft')
  const composerNode = await composer.elementHandle()
  const add = page.getByRole('button', { name: 'Add files or run commands', exact: true })
  const addNode = await add.elementHandle()
  await add.click()
  await page.getByRole('option', { name: /Choose library files/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Choose library files', exact: true })
  await dialog.getByRole('button', { name: /Attachment library Reference files/ }).click()
  const row = dialog.getByRole('button', { name: 'Reference 0.md 1 KB', exact: true })
  await row.locator('..').getByRole('button', { name: 'Choose', exact: true }).click()
  const search = dialog.getByRole('searchbox')
  await search.fill('Reference')
  await expect.poll(() => dialog.getByRole('button', { name: 'Refresh', exact: true }).getAttribute('aria-busy')).toBe('false')
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(2, 7) })
  const rowNode = await row.elementHandle(), searchNode = await search.elementHandle()
  const scroller = dialog.locator('[class*="detailModalContent"] > div:last-child')
  await scroller.evaluate((node) => { node.scrollTop = 100 })
  const scroll = await scroller.evaluate(node => node.scrollTop)
  expect(scroll).toBeGreaterThan(0)
  const attach = dialog.getByRole('button', { name: 'Add 1 files', exact: true })
  const attachNode = await attach.elementHandle(), attachBounds = await attach.boundingBox(), bounds = await dialog.boundingBox()
  await attach.focus(); await attach.press('Enter')
  const alert = dialog.getByRole('alert')
  await alert.waitFor()
  expect(await alert.evaluate((node) => {
    const bounds = node.getBoundingClientRect()
    return document.elementsFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2).includes(node)
  })).toBe(true)
  expect(await alert.textContent()).toBe('Could not add these files. Retry.')
  expect(await dialog.boundingBox()).toEqual(bounds)
  expect(await attach.boundingBox()).toEqual(attachBounds)
  expect(await scroller.evaluate(node => node.scrollTop)).toBe(scroll)
  expect(await attach.evaluate((node, original) => node === original && node === document.activeElement, attachNode)).toBe(true)
  const alertNode = await alert.elementHandle()
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-attachment-error-${theme}-${width}.png`) })
    }
  }
  await attach.press('Enter'); await attach.press(' ')
  await expect.poll(() => attempts).toBe(2)
  expect(await alert.evaluate((node, original) => node === original, alertNode)).toBe(true)
  expect(await row.evaluate((node, original) => node === original, rowNode)).toBe(true)
  expect(await search.evaluate((node, original) => node === original && node instanceof HTMLInputElement
    && node.value === 'Reference' && node.selectionStart === 2 && node.selectionEnd === 7, searchNode)).toBe(true)
  expect(await attach.evaluate(node => node === document.activeElement)).toBe(true)
  gate.resolve(undefined)
  await dialog.waitFor({ state: 'detached' })
  await expect.poll(() => closed).toBe(1)
  expect(await composer.evaluate((node, original) => node === original
    && node.textContent === 'Retained attachment draft', composerNode)).toBe(true)
  await page.locator('[title="Reference 0.md"]').waitFor()
  await expect.poll(() => page.getByRole('button', { name: 'Send message', exact: true }).isEnabled()).toBe(true)
  expect(await add.evaluate((node, original) => node === original, addNode)).toBe(true)
  expect(await composer.evaluate(node => node === document.activeElement)).toBe(true)
  expect(attempts).toBe(2)
  for (const phase of ['open', 'read'] as const) {
    cancellationPhase = phase
    await page.setViewportSize({ width: phase === 'open' ? 1440 : 390, height: 900 })
    await page.emulateMedia({ colorScheme: phase === 'open' ? 'light' : 'dark' })
    await add.click()
    await page.getByRole('option', { name: /Choose library files/ }).click()
    await dialog.getByRole('button', { name: /Attachment library Reference files/ }).click()
    await row.locator('..').getByRole('button', { name: 'Choose', exact: true }).click()
    await dialog.getByRole('button', { name: 'Add 1 files', exact: true }).click()
    await expect.poll(() => attempts).toBe(phase === 'open' ? 3 : 4)
    if (phase === 'read') await expect.poll(() => reading).toBe(true)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await expect.poll(() => cancellations).toBe(phase === 'open' ? 1 : 2)
    await expect.poll(() => composer.evaluate(node => node === document.activeElement)).toBe(true)
    await add.click()
    await page.getByRole('option', { name: /Choose library files/ }).click()
    await dialog.getByRole('button', { name: /Attachment library Reference files/ }).waitFor()
    const reopened = await dialog.elementHandle()
    const reopenedSearch = dialog.getByRole('searchbox')
    await reopenedSearch.fill('Attachment')
    await reopenedSearch.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
    const reopenedSearchNode = await reopenedSearch.elementHandle()
    if (phase === 'open') cancelledOpen.resolve(undefined)
    else cancelledRead.resolve(undefined)
    await expect.poll(() => closed).toBe(phase === 'open' ? 2 : 3)
    expect(await dialog.evaluate((node, original) => node === original, reopened)).toBe(true)
    expect(await composer.evaluate((node, original) => node === original
      && node.textContent === 'Retained attachment draft', composerNode)).toBe(true)
    expect(await reopenedSearch.evaluate((node, original) => node === original && node === document.activeElement
      && node instanceof HTMLInputElement && node.value === 'Attachment'
      && node.selectionStart === 1 && node.selectionEnd === 4, reopenedSearchNode)).toBe(true)
    expect(await page.locator('[title="Reference 0.md"]').count()).toBe(1)
    expect(await dialog.getByRole('button', { name: 'Add 0 files', exact: true }).getAttribute('aria-disabled')).toBe('true')
    expect(await page.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await dialog.evaluate(async (node) => { await Promise.allSettled(node.getAnimations().map(animation => animation.finished)) })
    await page.screenshot({ path: join(screenshots, `library-attachment-cancel-${phase}.png`) })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
  }
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('cancels native library archive preparation and keeps retry focus and employee ownership stable', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    openInAppEnvironment: createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  await writeFile(join(scaffold.workspaceCwd, 'report.txt'), 'DRAFT_REPORT\n')
  await seedSession(scaffold, await readFile(join(REPO_ROOT, 'snapshots/web/present-after-closing-reply/session.v4.jsonl'), 'utf8'), 'library-archive-lifecycle')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  const late = Promise.withResolvers<undefined>(), retryGate = Promise.withResolvers<undefined>()
  const saveGate = Promise.withResolvers<undefined>(), failureGate = Promise.withResolvers<undefined>()
  onTestFinished(() => {
    late.resolve(undefined); retryGate.resolve(undefined); saveGate.resolve(undefined); failureGate.resolve(undefined)
  })
  let selections = 0, discards = 0, saves = 0
  const now = '2026-11-13T01:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: 'Archive library', description: 'Reference files',
    scope: 'PERSONAL', ownerId: 'fixture-employee', managerEmployeeId: 'fixture-employee', canManage: true,
    version: 1, createdAt: now, updatedAt: now }
  const alternate = { ...library, id: '44444444-4444-4444-8444-444444444444', name: 'Archive alternate' }
  const writes: unknown[] = []
  await page.exposeFunction('__libraryArchiveInvoke', async (method: string, payload?: unknown) => {
    switch (method) {
      case 'auth.getSession': return { authenticated: true, employeeId: 'fixture-employee' }
      case 'library.files.archive.select': {
        const attempt = ++selections
        if (attempt === 1) await late.promise
        if (attempt === 2) {
          await failureGate.promise
          return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Snapshot unavailable', true)) }
        }
        if (attempt === 3) await retryGate.promise
        return [{ selectionId: '22222222-2222-4222-8222-222222222222', name: 'Report.txt', sizeBytes: 12 }]
      }
      case 'library.files.upload':
        writes.push(payload)
        if (++saves === 1) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Archive unavailable', true)) }
        await saveGate.promise
        return true
      case 'library.get': return typeof payload === 'object' && payload !== null && 'libraryId' in payload
        && payload.libraryId === alternate.id ? alternate : library
      case 'library.entries.list': return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
      case 'library.files.upload.discard': discards++; return true
      case 'library.files.list': return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
      case 'library.list': return { data: [library, alternate], pageIndex: 1, pageSize: 20, totalCount: 2, totalPages: 1 }
      default: throw new Error(`Unexpected archive lifecycle method: ${method}`)
    }
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __libraryArchiveInvoke(method: string, payload?: unknown): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string, payload?: unknown) => {
        const result = await api.__libraryArchiveInvoke(method, payload)
        return typeof result === 'object' && result !== null && 'fixtureFailure' in result
          ? { ok: false, failure: result.fixtureFailure } : { ok: true, result }
      }, cancel: () => {}, subscribe: (_namespace: string, listener: (event: unknown) => void) => {
        const receive = (event: Event) => { if (event instanceof CustomEvent) listener(event.detail) }
        globalThis.addEventListener('library-identity-test', receive)
        return () => { globalThis.removeEventListener('library-identity-test', receive) }
      },
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.locator('[role="treeitem"]').first().click()
  await page.locator('[role="treeitem"]').nth(1).click()
  await page.getByText('REPORT_READY', { exact: true }).waitFor()
  const trigger = page.getByRole('button', { name: 'Save to library', exact: true })
  await expect.poll(() => trigger.getAttribute('aria-disabled')).toBe('false')
  const original = await trigger.elementHandle()
  await trigger.focus(); await trigger.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Save to library', exact: true })
  await dialog.waitFor()
  await expect.poll(() => selections).toBe(1)
  await page.keyboard.press('Escape')
  expect(await dialog.count()).toBe(0)
  expect(await trigger.evaluate((node, previous) => node === previous && node === document.activeElement, original)).toBe(true)
  await trigger.press('Enter')
  await expect.poll(() => selections).toBe(2)
  const preparationBounds = await dialog.boundingBox()
  const cancelBounds = await dialog.getByRole('button', { name: 'Cancel', exact: true }).boundingBox()
  failureGate.resolve(undefined)
  const retry = dialog.getByRole('button', { name: 'Retry', exact: true })
  await retry.waitFor()
  expect(await dialog.boundingBox()).toEqual(preparationBounds)
  expect(await dialog.getByRole('button', { name: 'Cancel', exact: true }).boundingBox()).toEqual(cancelBounds)
  const alert = await dialog.getByRole('alert').elementHandle(), retryNode = await retry.elementHandle()
  await retry.focus(); await retry.press('Enter'); await retry.press(' ')
  await expect.poll(() => selections).toBe(3)
  late.resolve(undefined)
  await expect.poll(() => discards).toBe(1)
  expect(await retry.evaluate((node, previous) => node === previous && node === document.activeElement, retryNode)).toBe(true)
  expect(await dialog.getByRole('alert').evaluate((node, previous) => node === previous, alert)).toBe(true)
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-archive-retry-${theme}-${width}.png`) })
    }
  }
  retryGate.resolve(undefined)
  const search = dialog.getByRole('searchbox', { name: 'Search names', exact: true })
  await search.waitFor()
  expect(await dialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate(node => node === document.activeElement)).toBe(true)
  await search.fill('Archive')
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
  const searchNode = await search.elementHandle()
  await page.evaluate(() => { globalThis.dispatchEvent(new CustomEvent('library-identity-test', { detail: {
    type: 'session.changed', payload: { authenticated: true, employeeId: 'fixture-employee' },
  } })) })
  expect(await search.evaluate((node, previous) => node === previous && node === document.activeElement, searchNode)).toBe(true)
  expect(await search.evaluate(node => node instanceof HTMLInputElement && [node.value, node.selectionStart, node.selectionEnd])).toEqual(['Archive', 1, 4])
  await dialog.getByRole('button', { name: /Archive library Reference files/ }).click()
  const save = dialog.getByRole('button', { name: 'Save', exact: true })
  await expect.poll(() => save.getAttribute('aria-disabled')).toBe('false')
  const bounds = await dialog.boundingBox(), saveBounds = await save.boundingBox(), searchBounds = await search.boundingBox()
  const saveNode = await save.elementHandle()
  await save.focus(); await save.press('Enter')
  await dialog.getByRole('alert').waitFor()
  expect(await dialog.boundingBox()).toEqual(bounds)
  expect(await save.boundingBox()).toEqual(saveBounds)
  expect(await search.boundingBox()).toEqual(searchBounds)
  expect(await save.evaluate((node, previous) => node === previous && node === document.activeElement, saveNode)).toBe(true)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.screenshot({ path: join(screenshots, `library-archive-save-error-${theme}-${width}.png`) })
    }
  }
  await dialog.getByRole('button', { name: 'Libraries', exact: true }).click()
  await dialog.getByRole('button', { name: /Archive alternate Reference files/ }).click()
  await expect.poll(() => save.getAttribute('aria-disabled')).toBe('false')
  const previousError = await dialog.getByRole('alert').elementHandle()
  const alternateBounds = await dialog.boundingBox()
  await save.press('Enter')
  expect(await dialog.getByRole('alert').textContent()).toBe('Retry in the original folder, or close and save again.')
  expect(await dialog.getByRole('alert').evaluate((node, previous) => node === previous, previousError)).toBe(true)
  expect(await save.evaluate((node, previous) => node === previous && node === document.activeElement, saveNode)).toBe(true)
  expect(await search.evaluate((node, previous) => node === previous, searchNode)).toBe(true)
  expect(await dialog.boundingBox()).toEqual(alternateBounds)
  expect(saves).toBe(1)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
      expect(await controlIsUnclipped(save)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-archive-destination-${theme}-${width}.png`) })
    }
  }
  await page.setViewportSize({ width: 390, height: 900 })
  await dialog.getByRole('button', { name: 'Libraries', exact: true }).click()
  await dialog.getByRole('button', { name: /Archive library Reference files/ }).click()
  await expect.poll(() => save.getAttribute('aria-disabled')).toBe('false')
  const saveError = await dialog.getByRole('alert').elementHandle()
  await save.press('Enter'); await save.press(' ')
  await expect.poll(() => saves).toBe(2)
  expect(writes[1]).toEqual(writes[0])
  expect(await search.getAttribute('readonly')).toBe('')
  expect(await dialog.getByRole('button', { name: 'Refresh', exact: true }).getAttribute('aria-disabled')).toBe('true')
  await dialog.getByRole('button', { name: 'Libraries', exact: true }).evaluate((node) => {
    if (node instanceof HTMLButtonElement) node.click()
  })
  expect(await dialog.getByRole('button', { name: library.name, exact: true }).count()).toBe(1)
  expect(await search.evaluate((node, previous) => node === previous, searchNode)).toBe(true)
  await page.keyboard.press('Escape')
  expect(await dialog.getByRole('alert').evaluate((node, previous) => node === previous, saveError)).toBe(true)
  expect(await dialog.boundingBox()).toEqual(bounds)
  saveGate.resolve(undefined)
  await dialog.waitFor({ state: 'detached' })
  expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true)
  await trigger.press('Enter')
  await dialog.getByRole('searchbox').waitFor()
  await page.evaluate(() => { globalThis.dispatchEvent(new CustomEvent('library-identity-test', { detail: {
    type: 'session.changed', payload: { authenticated: true, employeeId: 'another-employee' },
  } })) })
  expect(await dialog.count()).toBe(0)
  expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('keeps library move destinations, retry focus and committed refreshes stable', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  page.setDefaultTimeout(15_000)
  const tripwire = watchConsole(page)
  const now = '2026-11-13T01:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: 'Move library', description: 'Reference files',
    scope: 'PERSONAL', ownerId: 'fixture-employee', managerEmployeeId: 'fixture-employee', canManage: true,
    version: 1, createdAt: now, updatedAt: now }
  const file = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id, parentId: null,
    name: 'Move me.md', kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12,
    favorite: false, version: 1, createdAt: now, updatedAt: now }
  const folder = { ...file, id: '33333333-3333-4333-8333-333333333333', name: 'Destination', kind: 'FOLDER',
    sha256: null, mediaType: null, sizeBytes: 0 }
  const children = Array.from({ length: 21 }, (_, index) => ({ ...folder,
    id: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`, parentId: folder.id, name: `Destination child ${index}` }))
  let writes = 0, reads = 0, moved = false, failRead = false
  const gate = Promise.withResolvers<undefined>()
  onTestFinished(() => { gate.resolve(undefined) })
  await page.exposeFunction('__libraryMoveInvoke', async (method: string, payload?: {
    parentId?: string | null
    view?: string
    query?: string
    page?: number
    entryId?: string
    version?: number
  }) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'fixture-employee' }
    if (method === 'library.files.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
    if (method === 'library.list') return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    if (method === 'library.get') return library
    if (method === 'library.entries.list') {
      reads++
      if (failRead) {
        failRead = false
        return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Directory unavailable', true)) }
      }
      const all = [folder, ...children, { ...file, parentId: moved ? folder.id : null, version: moved ? 2 : 1 }]
      const rows = all.filter(entry => (payload?.query ? entry.name.includes(payload.query) : entry.parentId === payload?.parentId)
        && (payload?.view !== 'folders' || entry.kind === 'FOLDER'))
      const pageIndex = payload?.page ?? 1
      return { data: rows.slice((pageIndex - 1) * 20, pageIndex * 20), pageIndex, pageSize: 20,
        totalCount: rows.length, totalPages: Math.ceil(rows.length / 20) }
    }
    if (method === 'library.entries.update') {
      expect(payload).toMatchObject({ entryId: file.id, parentId: folder.id, version: 1 })
      if (++writes === 1) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Move unavailable', true)) }
      await gate.promise
      moved = true
      failRead = true
      return true
    }
    throw new Error(`Unexpected move method: ${method}`)
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __libraryMoveInvoke(method: string, payload?: unknown): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string, payload?: unknown) => {
        const result = await api.__libraryMoveInvoke(method, payload)
        return typeof result === 'object' && result !== null && 'fixtureFailure' in result
          ? { ok: false, failure: result.fixtureFailure } : { ok: true, result }
      }, cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Libraries', exact: true }).click()
  await page.getByRole('button', { name: 'Library directory', exact: true }).click()
  await page.getByRole('button', { name: /Move library Reference files/ }).click()
  const fileRow = page.getByRole('button', { name: 'Move me.md 1 KB', exact: true })
  await fileRow.waitFor()
  await fileRow.locator('..').getByRole('button', { name: 'Move', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Move', exact: true })
  const save = dialog.getByRole('button', { name: 'Save', exact: true })
  expect(await save.getAttribute('aria-disabled')).toBe('true')
  await save.press('Enter')
  expect(writes).toBe(0)
  await dialog.getByRole('button', { name: 'Destination Folder', exact: true }).click()
  const search = dialog.getByRole('searchbox')
  await search.fill('Destination child')
  await expect.poll(() => dialog.getByRole('button', { name: 'Refresh', exact: true }).getAttribute('aria-busy')).toBe('false')
  const child = dialog.getByRole('button', { name: 'Destination child 0 Folder', exact: true })
  const childNode = await child.elementHandle(), searchNode = await search.elementHandle(), saveNode = await save.elementHandle()
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(2, 9) })
  const scroller = dialog.locator('[class*="detailModalContent"] > div:last-child')
  await scroller.evaluate((node) => { node.scrollTop = 150 })
  const scrollTop = await scroller.evaluate(node => node.scrollTop)
  expect(scrollTop).toBeGreaterThan(0)
  await save.focus()
  const saveBounds = await save.boundingBox(), dialogBounds = await dialog.boundingBox()
  await save.press('Enter')
  const error = dialog.getByRole('alert')
  await error.waitFor()
  const errorNode = await error.elementHandle()
  expect(await save.boundingBox()).toEqual(saveBounds)
  expect(await dialog.boundingBox()).toEqual(dialogBounds)
  expect(await scroller.evaluate(node => node.scrollTop)).toBe(scrollTop)
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-move-error-${theme}-${width}.png`) })
    }
  }
  const retryBounds = await save.boundingBox()
  await save.press('Enter'); await save.press(' ')
  await expect.poll(() => writes).toBe(2)
  const lockedReads = reads
  expect(await search.getAttribute('readonly')).toBe('')
  for (const button of [child, dialog.getByRole('button', { name: library.name, exact: true }),
    dialog.getByRole('button', { name: 'Refresh', exact: true }), dialog.getByRole('button', { name: 'Next', exact: true })]) {
    expect(await button.getAttribute('aria-disabled')).toBe('true')
    await button.evaluate((node) => { if (node instanceof HTMLButtonElement) node.click() })
  }
  await page.keyboard.press('Escape')
  await dialog.getByRole('status').waitFor()
  expect(reads).toBe(lockedReads)
  expect(await child.evaluate((node, previous) => node === previous, childNode)).toBe(true)
  expect(await search.evaluate((node, previous) => node === previous && node instanceof HTMLInputElement
    && node.value === 'Destination child' && node.selectionStart === 2 && node.selectionEnd === 9, searchNode)).toBe(true)
  expect(await save.evaluate((node, previous) => node === previous && node === document.activeElement, saveNode)).toBe(true)
  expect(await save.boundingBox()).toEqual(retryBounds)
  expect(await error.evaluate((node, previous) => node === previous, errorNode)).toBe(true)
  gate.resolve(undefined)
  await dialog.waitFor({ state: 'detached' })
  await page.getByRole('alert').waitFor()
  await fileRow.waitFor()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await fileRow.waitFor({ state: 'detached' })
  expect(writes).toBe(2)
  expect(await page.getByRole('searchbox').evaluate(node => node === document.activeElement)).toBe(true)
  await page.getByRole('button', { name: 'Destination Folder', exact: true }).click()
  await page.getByRole('searchbox').fill('Move me')
  await fileRow.waitFor()
  const move = fileRow.locator('..').getByRole('button', { name: 'Move', exact: true })
  await move.click()
  await dialog.getByRole('button', { name: 'Destination Folder', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  expect(await move.evaluate(node => node === document.activeElement)).toBe(true)
  expect(writes).toBe(2)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('keeps library navigation, favorite retry and discard confirmation stable', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  const now = '2026-11-13T01:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: 'Library fixture', description: 'Reference files',
    scope: 'PERSONAL', ownerId: 'fixture-employee', managerEmployeeId: 'fixture-employee', canManage: true,
    version: 1, createdAt: now, updatedAt: now }
  const file = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id, parentId: null,
    name: 'Reference.md', kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12,
    favorite: false, version: 1, createdAt: now, updatedAt: now }
  const gate = Promise.withResolvers<undefined>()
  const renameGate = Promise.withResolvers<undefined>(), deleteGate = Promise.withResolvers<undefined>()
  const downloadGate = Promise.withResolvers<undefined>()
  const creationGates = {
    'library.create': Promise.withResolvers<undefined>(),
    'library.folders.create': Promise.withResolvers<undefined>(),
  }
  const creationRequests = new Map<string, unknown[]>()
  const previewText = Array.from({ length: 80 }, (_, index) => `Reference paragraph ${index}.`).join('\n\n')
  onTestFinished(() => {
    gate.resolve(undefined); renameGate.resolve(undefined); deleteGate.resolve(undefined); downloadGate.resolve(undefined)
    for (const pending of Object.values(creationGates)) pending.resolve(undefined)
  })
  let writes = 0, saved = false, reads = 0, renames = 0, renamed = false, deletes = 0, deleted = false
  let downloads = 0, previewReads = 0
  await page.exposeFunction('__libraryStabilityInvoke', async (method: string, payload?: unknown) => {
    switch (method) {
      case 'auth.getSession': return { authenticated: true, employeeId: 'fixture-employee' }
      case 'library.files.list': return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
      case 'library.list': return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
      case 'library.get': return library
      case 'library.create':
      case 'library.folders.create': {
        const requests = creationRequests.get(method) ?? []
        requests.push(payload)
        creationRequests.set(method, requests)
        if (requests.length === 1) {
          await creationGates[method].promise
          return { fixtureFailure: productFailure(new ProductError('EXTENSION_REQUEST_TIMEOUT', 'Creation receipt unavailable', true)) }
        }
        return true
      }
      case 'library.entries.list':
        reads++
        return { data: deleted ? [] : [{ ...file, name: renamed ? 'Retained reference.md' : file.name, favorite: saved,
          version: renamed ? 2 : 1 }], pageIndex: 1, pageSize: 20, totalCount: deleted ? 0 : 1, totalPages: deleted ? 0 : 1 }
      case 'library.files.preview.open':
        if (++previewReads === 1) return { fixtureFailure:
          productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Preview unavailable', true)) }
        if (previewReads === 2) return { fixtureFailure:
          productFailure(new ProductError('LIBRARY_ACCESS_DENIED', 'PRIVATE_EMPLOYEE_IDENTITY_CHANGED', false)) }
        return { transferId: 'library-reference-preview', mediaType: 'text/markdown', byteLength: Buffer.byteLength(previewText),
          maxBytes: 1024 * 1024, chunkSize: 1024 * 1024 }
      case 'library.files.preview.read': return { data: [...new TextEncoder().encode(previewText)], offset: 0, eof: true }
      case 'library.files.preview.close': return { closed: true }
      case 'library.entries.access': return true
      case 'library.files.download':
        if (++downloads === 1) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Download unavailable', true)) }
        if (downloads === 3) return { fixtureFailure:
          productFailure(new ProductError('LIBRARY_PREVIEW_SOURCE_CHANGED', 'PRIVATE_EXPECTED_FILE_DIGEST', true)) }
        await downloadGate.promise
        return { cancelled: false }
      case 'library.entries.favorite':
        if (++writes === 1) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Favorite unavailable', true)) }
        await gate.promise
        saved = true
        return true
      case 'library.entries.update':
        if (++renames === 1) return { fixtureFailure: productFailure(new ProductError('EXTENSION_REQUEST_TIMEOUT', 'Rename timed out', true)) }
        await renameGate.promise
        renamed = true
        return true
      case 'library.entries.delete':
        if (++deletes === 1) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Delete unavailable', true)) }
        await deleteGate.promise
        deleted = true
        return true
      default: throw new Error(`Unexpected library stability method: ${method}`)
    }
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __libraryStabilityInvoke(method: string, payload?: unknown): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string, payload?: unknown) => {
        const result = await api.__libraryStabilityInvoke(method, payload)
        if (method === 'library.files.preview.read' && typeof result === 'object' && result !== null
          && 'data' in result && Array.isArray(result.data)) return { ok: true, result: { ...result, data: new Uint8Array(result.data) } }
        return typeof result === 'object' && result !== null && 'fixtureFailure' in result
          ? { ok: false, failure: result.fixtureFailure } : { ok: true, result }
      }, cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Libraries', exact: true }).click()
  await page.getByRole('button', { name: 'Library directory', exact: true }).click()
  await page.getByRole('button', { name: /Library fixture Reference files/ }).click()
  const row = page.getByRole('button', { name: 'Reference.md 1 KB', exact: true })
  await row.waitFor()
  const original = await row.elementHandle()
  const search = page.getByRole('searchbox', { name: 'Search names' })
  const originalSearch = await search.elementHandle()
  const breadcrumb = page.getByRole('button', { name: library.name, exact: true })
  await breadcrumb.focus()
  await breadcrumb.press('Enter')
  expect(await row.evaluate((node, previous) => node === previous, original)).toBe(true)
  expect(await breadcrumb.evaluate(node => node === document.activeElement)).toBe(true)
  expect(reads).toBe(1)
  await row.focus(); await row.press('Enter')
  const preview = page.getByRole('dialog', { name: file.name, exact: true })
  await preview.getByText('Could not read this file. Retry.', { exact: true }).waitFor()
  await preview.getByRole('button', { name: 'Retry', exact: true }).click()
  await preview.getByText('You cannot access this library. (LIBRARY_ACCESS_DENIED)', { exact: true }).waitFor()
  expect(await preview.textContent()).not.toContain('PRIVATE_EMPLOYEE_IDENTITY_CHANGED')
  await preview.getByRole('button', { name: 'Retry', exact: true }).click()
  const viewport = preview.locator('[data-document-preview-surface-body]')
  await viewport.getByText('Reference paragraph 79.', { exact: true }).waitFor()
  const viewportNode = await viewport.elementHandle()
  await viewport.evaluate((node) => { node.scrollTop = 250 })
  const scroll = await viewport.evaluate(node => node.scrollTop), viewportBounds = await viewport.boundingBox()
  expect(scroll).toBeGreaterThan(0)
  const download = preview.getByRole('button', { name: 'Download original', exact: true })
  const closePreview = preview.getByRole('button', { name: 'Close', exact: true }).last()
  const downloadNode = await download.elementHandle(), downloadBounds = await download.boundingBox()
  const previewBounds = await preview.boundingBox(), closeBounds = await closePreview.boundingBox()
  await download.focus()
  expect(await viewport.getByText('Reference paragraph 10.', { exact: true }).evaluate((node) => {
    const range = document.createRange(), selection = document.getSelection()!
    range.setStart(node.firstChild!, 0); range.setEnd(node.firstChild!, 9)
    selection.removeAllRanges(); selection.addRange(range)
    return selection.toString()
  })).toBe('Reference')
  await download.press('Enter')
  const downloadError = preview.getByRole('alert')
  await downloadError.waitFor()
  expect(await downloadError.textContent()).toBe('Could not download this file. Retry.')
  expect(await downloadError.evaluate((node) => {
    const rect = node.getBoundingClientRect(), dialog = node.closest('[role="dialog"]')!.getBoundingClientRect()
    return rect.top >= dialog.top && rect.bottom <= dialog.bottom
      && document.elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2).includes(node)
  })).toBe(true)
  expect(await preview.boundingBox()).toEqual(previewBounds)
  expect(await viewport.boundingBox()).toEqual(viewportBounds)
  expect(await download.boundingBox()).toEqual(downloadBounds)
  expect(await closePreview.boundingBox()).toEqual(closeBounds)
  expect(await viewport.evaluate((node, previous) => node === previous, viewportNode)).toBe(true)
  expect(await viewport.evaluate(node => node.scrollTop)).toBe(scroll)
  expect(await preview.evaluate(() => document.getSelection()?.toString())).toBe('Reference')
  expect(await download.evaluate((node, previous) => node === previous && node === document.activeElement, downloadNode)).toBe(true)
  const retainedError = await downloadError.elementHandle()
  await download.press('Enter'); await download.press(' ')
  await expect.poll(() => downloads).toBe(2)
  expect(await downloadError.evaluate((node, previous) => node === previous, retainedError)).toBe(true)
  expect(await viewport.evaluate(node => node.scrollTop)).toBe(scroll)
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await preview.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-preview-download-error-${theme}-${width}.png`) })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  downloadGate.resolve(undefined)
  await downloadError.waitFor({ state: 'detached' })
  expect(await viewport.evaluate((node, previous) => node === previous, viewportNode)).toBe(true)
  expect(await viewport.evaluate(node => node.scrollTop)).toBe(scroll)
  expect(await preview.evaluate(() => document.getSelection()?.toString())).toBe('Reference')
  expect(previewReads).toBe(3)
  await download.press('Enter')
  await downloadError.waitFor()
  expect(await downloadError.textContent()).toBe('This item changed. Refresh and retry. (LIBRARY_PREVIEW_SOURCE_CHANGED)')
  expect(await preview.textContent()).not.toContain('PRIVATE_EXPECTED_FILE_DIGEST')
  expect(await viewport.evaluate((node, previous) => node === previous, viewportNode)).toBe(true)
  expect(await viewport.evaluate(node => node.scrollTop)).toBe(scroll)
  await page.keyboard.press('Escape')
  expect(await row.evaluate((node, previous) => node === previous && node === document.activeElement, original)).toBe(true)
  const create = page.getByRole('button', { name: 'New library', exact: true })
  const originalCreate = await create.elementHandle(), createBounds = await create.boundingBox()
  await page.getByRole('button', { name: 'Favorite', exact: true }).click()
  const retry = page.getByRole('button', { name: 'Retry', exact: true })
  await retry.waitFor()
  const alert = await page.getByRole('alert').elementHandle()
  await retry.focus(); await retry.press('Enter')
  await expect.poll(() => writes).toBe(2)
  const retryBounds = await retry.boundingBox()
  await retry.press('Enter'); await retry.press(' ')
  expect(writes).toBe(2)
  expect(await retry.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await create.evaluate((node, previous) => node === previous, originalCreate)).toBe(true)
  expect(await create.boundingBox()).toEqual(createBounds)
  expect(await page.getByRole('alert').evaluate((node, previous) => node === previous, alert)).toBe(true)
  expect(await retry.boundingBox()).toEqual(retryBounds)
  gate.resolve(undefined)
  await page.getByRole('button', { name: 'Remove favorite', exact: true }).waitFor()
  await expect.poll(() => reads).toBe(2)
  expect(await row.evaluate((node, previous) => node === previous, original)).toBe(true)
  expect(await search.evaluate((node, previous) => node === previous, originalSearch)).toBe(true)
  expect(await search.evaluate(node => node === document.activeElement)).toBe(true)
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Rename', exact: true })
  const input = dialog.getByRole('textbox', { name: 'Name', exact: true })
  await input.fill('Retained reference.md')
  await input.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(2, 8) })
  const originalInput = await input.elementHandle()
  await input.press('Escape')
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).waitFor()
  expect(await dialog.getByRole('button', { name: 'Save', exact: true }).count()).toBe(0)
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await dialog.getByRole('button', { name: 'Save', exact: true }).count()).toBe(0)
      expect(await page.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-discard-${theme}-${width}.png`) })
    }
  }
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click()
  expect(await input.evaluate((node, previous) => node === previous && node === document.activeElement, originalInput)).toBe(true)
  expect(await input.evaluate(node => node instanceof HTMLInputElement && [node.value, node.selectionStart, node.selectionEnd])).toEqual(['Retained reference.md', 2, 8])
  const save = dialog.getByRole('button', { name: 'Save', exact: true })
  const saveNode = await save.elementHandle(), saveBounds = await save.boundingBox(), inputBounds = await input.boundingBox()
  const dialogBounds = await dialog.boundingBox()
  await save.focus(); await save.press('Enter')
  const renameError = dialog.getByRole('alert')
  await renameError.waitFor()
  expect(await dialog.boundingBox()).toEqual(dialogBounds)
  expect(await save.boundingBox()).toEqual(saveBounds)
  expect(await input.boundingBox()).toEqual(inputBounds)
  expect(await save.evaluate((node, previous) => node === previous && node === document.activeElement, saveNode)).toBe(true)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.screenshot({ path: join(screenshots, `library-rename-error-${theme}-${width}.png`) })
    }
  }
  const renameErrorNode = await renameError.elementHandle()
  await save.press('Enter'); await save.press(' ')
  await expect.poll(() => renames).toBe(2)
  await page.keyboard.press('Escape')
  await dialog.getByRole('status').waitFor()
  expect(await dialog.boundingBox()).toEqual(dialogBounds)
  expect(await save.boundingBox()).toEqual(saveBounds)
  expect(await renameError.evaluate((node, previous) => node === previous, renameErrorNode)).toBe(true)
  renameGate.resolve(undefined)
  await dialog.waitFor({ state: 'detached' })
  const renamedRow = page.getByRole('button', { name: 'Retained reference.md 1 KB', exact: true })
  await renamedRow.waitFor()
  expect(await renamedRow.evaluate((node, previous) => node === previous, original)).toBe(true)
  const deleteEntry = page.getByRole('button', { name: 'Delete', exact: true })
  await deleteEntry.click()
  const deletion = page.getByRole('dialog', { name: 'Delete', exact: true })
  const confirm = deletion.getByRole('button', { name: 'Delete', exact: true })
  const confirmNode = await confirm.elementHandle(), confirmBounds = await confirm.boundingBox()
  const deletionBounds = await deletion.boundingBox()
  await confirm.focus(); await confirm.press('Enter')
  await deletion.getByRole('alert').waitFor()
  expect(await deletion.boundingBox()).toEqual(deletionBounds)
  expect(await confirm.boundingBox()).toEqual(confirmBounds)
  expect(await confirm.evaluate((node, previous) => node === previous && node === document.activeElement, confirmNode)).toBe(true)
  await confirm.press('Enter'); await confirm.press(' ')
  await expect.poll(() => deletes).toBe(2)
  deleteGate.resolve(undefined)
  await deletion.waitFor({ state: 'detached' })
  await expect.poll(() => renamedRow.count()).toBe(0)
  expect(await search.evaluate(node => node === document.activeElement)).toBe(true)
  for (const [title, method] of [['New library', 'library.create'], ['New folder', 'library.folders.create']] as const) {
    const opener = page.getByRole('button', { name: title, exact: true })
    await opener.click()
    const creation = page.getByRole('dialog', { name: title, exact: true })
    const name = creation.getByRole('textbox', { name: 'Name', exact: true })
    const submit = creation.getByRole('button', { name: 'Save', exact: true })
    await name.fill('  Retained library  ')
    const nameNode = await name.elementHandle(), submitNode = await submit.elementHandle()
    const creationBounds = await creation.boundingBox(), nameBounds = await name.boundingBox(), submitBounds = await submit.boundingBox()
    await name.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(2, 10) })
    await submit.click()
    await name.focus(); await name.press('Escape')
    await expect.poll(() => creationRequests.get(method)?.length).toBe(1)
    await creation.getByRole('status').waitFor()
    expect(await creation.boundingBox()).toEqual(creationBounds)
    expect(await name.boundingBox()).toEqual(nameBounds)
    expect(await submit.boundingBox()).toEqual(submitBounds)
    creationGates[method].resolve(undefined)
    const creationError = creation.getByRole('alert')
    await creationError.waitFor()
    expect(await creation.getByRole('status').count()).toBe(0)
    expect(await creation.boundingBox()).toEqual(creationBounds)
    expect(await name.boundingBox()).toEqual(nameBounds)
    expect(await submit.boundingBox()).toEqual(submitBounds)
    expect(await submit.evaluate((node, previous) => node === previous, submitNode)).toBe(true)
    expect(await name.evaluate((node, previous) => node === previous && node === document.activeElement, nameNode)).toBe(true)
    expect(await name.evaluate(node => node instanceof HTMLInputElement && [node.value, node.selectionStart, node.selectionEnd]))
      .toEqual(['  Retained library  ', 2, 10])
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 })
        expect(await creation.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
        expect(await creation.getByRole('status').count()).toBe(0)
        await page.screenshot({ path: join(screenshots, `library-${method}-receipt-${theme}-${width}.png`) })
      }
    }
    await name.fill('Retained library')
    await submit.click()
    await creation.waitFor({ state: 'detached' })
    expect(creationRequests.get(method)).toHaveLength(2)
    expect(creationRequests.get(method)?.[1]).toEqual(creationRequests.get(method)?.[0])
    expect(await opener.evaluate(node => node === document.activeElement)).toBe(true)
  }
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it.each(['edit', 'device', 'providers'] as const)('keeps connector %s retry focus and its form stable', async (surface) => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  const pending = Promise.withResolvers<undefined>()
  onTestFinished(() => { pending.resolve(undefined) })
  const method = surface === 'edit' ? 'extensions.connector.read' : surface === 'device'
    ? 'extensions.connector.configuration.read' : 'connectors.list'
  let opened = false
  let reads = 0
  await page.exposeFunction('__connectorRetryInvoke', async (requested: string) => {
    if (opened && requested === method) {
      if (++reads > 1) await pending.promise
      return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'PRIVATE_CONNECTOR_READ_FAILURE', true)) }
    }
    switch (requested) {
      case 'auth.getSession': return { authenticated: true, employeeId: 'fixture-employee' }
      case 'connectors.list': return [{ ...connectors[0], id: 'fixture-connector', displayName: 'Fixture connector',
        visibility: surface === 'edit' ? 'PERSONAL' : 'COMPANY', canEdit: surface === 'edit',
        canConfigure: true, authMode: 'none' }]
      default: throw new Error(`Unexpected connector retry method: ${requested}`)
    }
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __connectorRetryInvoke(method: string): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string) => {
        const result = await api.__connectorRetryInvoke(method)
        return typeof result === 'object' && result !== null && 'fixtureFailure' in result
          ? { ok: false, failure: result.fixtureFailure } : { ok: true, result }
      }, cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Connectors', exact: true }).click()
  if (surface === 'edit') await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  await page.getByText('Fixture connector', { exact: true }).waitFor()
  opened = true
  if (surface === 'providers') {
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByLabel('Server type', { exact: true }).selectOption('streamable-http')
    await page.getByLabel('Server name', { exact: true }).fill('Retained connector name')
  } else {
    await page.getByText('Fixture connector', { exact: true }).click()
    const details = page.getByRole('dialog', { name: 'Connector details', exact: true })
    if (surface === 'device') await details.getByRole('button', { name: 'Configure this device', exact: true }).click()
    else {
      await details.getByRole('button', { name: 'More actions', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Modify', exact: true }).click()
    }
  }
  const retry = page.getByRole('button', { name: 'Retry', exact: true })
  await retry.waitFor()
  const button = await retry.elementHandle()
  const notice = await page.getByRole('alert').elementHandle()
  await retry.focus()
  const box = await retry.boundingBox()
  await retry.press('Enter')
  await expect.poll(() => reads).toBe(2)
  await expect.poll(() => retry.getAttribute('aria-busy')).toBe('true')
  expect(await retry.evaluate(node => node === document.activeElement), 'retry keeps keyboard focus during its read').toBe(true)
  expect(await retry.getAttribute('aria-disabled')).toBe('true')
  expect(await retry.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
  expect(await retry.boundingBox()).toEqual(box)
  await page.keyboard.press('Enter')
  await page.keyboard.press(' ')
  expect(reads).toBe(2)
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await retry.focus()
      await retry.scrollIntoViewIfNeeded()
      expect(await page.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `connector-retry-${surface}-${theme}-${width}.png`), animations: 'disabled' })
    }
  }
  pending.resolve(undefined)
  await expect.poll(() => retry.getAttribute('aria-busy')).toBe('false')
  expect(await retry.getAttribute('aria-disabled')).toBe('false')
  expect(await retry.evaluate((node, original) => node === original, button)).toBe(true)
  expect(await page.getByRole('alert').evaluate((node, original) => node === original, notice)).toBe(true)
  expect(await retry.evaluate(node => node === document.activeElement)).toBe(true)
  if (surface === 'providers') expect(await page.getByLabel('Server name', { exact: true }).inputValue()).toBe('Retained connector name')
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it.each([
  { removed: false, elsewhere: false }, { removed: true, elsewhere: false },
  { removed: false, elsewhere: true }, { removed: true, elsewhere: true },
])('retains confirmed connector browsing through a failed refresh (removed=$removed, elsewhere=$elsewhere)', async ({ removed, elsewhere }) => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  const failure = Promise.withResolvers<undefined>(), retry = Promise.withResolvers<undefined>()
  onTestFinished(() => { failure.resolve(undefined); retry.resolve(undefined) })
  let reads = 0, reconnects = 0
  const failedRead = elsewhere ? 3 : 2
  const catalogRows = elsewhere ? [...connectors, ...Array.from({ length: 24 }, (_, index) => ({
    ...connectors[0], id: `archive-${index}`, displayName: `Archive ${index}`, summary: 'Order reference archive',
  }))] : connectors
  await page.exposeFunction('__connectorCatalogInvoke', async (method: string) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'fixture-employee' }
    if (method === 'connectors.refresh') { reconnects++; return { connectedIds: [], unavailableIds: elsewhere ? ['erp'] : [] } }
    if (method === 'connectors.list') {
      const attempt = ++reads
      if (attempt === failedRead) {
        await failure.promise
        return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Directory unavailable', true)) }
      }
      if (attempt === failedRead + 1) await retry.promise
      return attempt > failedRead && removed ? [] : catalogRows
    }
    throw new Error(`Unexpected connector catalog method: ${method}`)
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __connectorCatalogInvoke(method: string): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string) => {
        const result = await api.__connectorCatalogInvoke(method)
        return typeof result === 'object' && result !== null && 'fixtureFailure' in result
          ? { ok: false, failure: result.fixtureFailure } : { ok: true, result }
      }, cancel: () => {}, subscribe: (_namespace: string, listener: (event: unknown) => void) => {
        const receive = (event: Event) => { if (event instanceof CustomEvent) listener(event.detail) }
        globalThis.addEventListener('connector-catalog-test', receive)
        return () => { globalThis.removeEventListener('connector-catalog-test', receive) }
      },
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Connectors', exact: true }).click()
  const section = page.getByRole('region', { name: 'Connectors', exact: true }).last()
  const search = section.getByRole('searchbox')
  const card = section.getByRole('button', { name: /Order management Orders/ })
  const tabs = section.getByRole('tablist'), panel = section.getByRole('tabpanel')
  const refresh = section.getByRole('button', { name: 'Refresh', exact: true })
  const create = section.getByRole('button', { name: 'Add', exact: true })
  await card.waitFor()
  if (elsewhere) {
    await refresh.click()
    await section.getByRole('alert').waitFor()
    await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('false')
  }
  const warningNode = elsewhere ? await section.getByRole('alert').elementHandle() : undefined
  await search.fill('Order')
  await search.evaluate((node) => { (node as HTMLInputElement).setSelectionRange(1, 4) })
  const scroller = section.locator(':scope > div').first()
  const scrollTop = await scroller.evaluate((node, scroll) => { node.scrollTop = scroll; return node.scrollTop }, elsewhere ? 60 : 0)
  if (elsewhere) expect(scrollTop).toBe(60)
  const cardNode = await card.elementHandle(), searchNode = await search.elementHandle()
  const tabsNode = await tabs.elementHandle(), panelNode = await panel.elementHandle(), createNode = await create.elementHandle()
  const cardBox = await card.boundingBox(), tabsBox = await tabs.boundingBox(), createBox = await create.boundingBox()
  await card.focus()
  await page.evaluate(() => { globalThis.dispatchEvent(new CustomEvent('connector-catalog-test', { detail: { type: 'catalog.changed' } })) })
  await expect.poll(() => reads).toBe(failedRead)
  failure.resolve(undefined)
  const alert = section.getByRole('alert').filter({ hasText: 'Product catalogs are temporarily unavailable' })
  await alert.waitFor()
  const alertNode = await alert.elementHandle()
  expect(await card.evaluate((node, original) => node === original && node === document.activeElement, cardNode)).toBe(true)
  expect(await tabs.evaluate((node, original) => node === original, tabsNode)).toBe(true)
  expect(await panel.evaluate((node, original) => node === original, panelNode)).toBe(true)
  expect(await card.boundingBox()).toEqual(cardBox)
  expect(await tabs.boundingBox()).toEqual(tabsBox)
  expect(await create.boundingBox()).toEqual(createBox)
  expect(await create.evaluate((node, original) => node === original, createNode)).toBe(true)
  expect(await create.getAttribute('aria-busy')).toBe(null)
  expect(await scroller.evaluate(node => node.scrollTop)).toBe(scrollTop)
  if (warningNode) expect(await warningNode.evaluate(node => node.isConnected)).toBe(true)
  await mkdir(screenshots, { recursive: true })
  if (!removed && !elsewhere) {
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 })
        if (width < 600) await expect.poll(() => page.locator('[data-sidebar-drawer]').count()).toBe(1)
        if (await page.locator('[data-sidebar-drawer]:not([data-sidebar-collapsed])').count()) {
          await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
        }
        if (width < 600) await expect.poll(() => page.locator('[data-sidebar-drawer] > [inert]').first()
          .evaluate(node => node.getBoundingClientRect().right <= 1 && getComputedStyle(node).visibility === 'hidden')).toBe(true)
        await search.focus()
        expect(await section.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
        expect(await controlIsUnclipped(alert)).toBe(true)
        await page.screenshot({ path: join(screenshots, `connector-directory-failure-${theme}-${width}.png`) })
      }
    }
  }
  await refresh.click()
  await expect.poll(() => reads).toBe(failedRead + 1)
  await refresh.press('Enter')
  expect(reads).toBe(failedRead + 1)
  expect(reconnects).toBe(elsewhere ? 2 : 1)
  expect(await alert.evaluate((node, original) => node === original, alertNode)).toBe(true)
  expect(await card.evaluate((node, original) => node === original, cardNode)).toBe(true)
  expect(await search.evaluate((node, original) => node === original, searchNode)).toBe(true)
  expect(await search.inputValue()).toBe('Order')
  expect(await scroller.evaluate(node => node.scrollTop)).toBe(scrollTop)
  expect(await search.evaluate(node => [
    (node as HTMLInputElement).selectionStart, (node as HTMLInputElement).selectionEnd,
  ])).toEqual([1, 4])
  await (elsewhere ? search : card).focus()
  const beforeRecovery = await card.boundingBox(), tabsBeforeRecovery = await tabs.boundingBox()
  const scrollBeforeRecovery = await scroller.evaluate(node => node.scrollTop)
  retry.resolve(undefined)
  await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('false')
  expect(await alert.count()).toBe(0)
  if (warningNode) expect(await warningNode.evaluate(node => node.isConnected)).toBe(true)
  expect(await tabs.evaluate((node, original) => node === original, tabsNode)).toBe(true)
  expect(await panel.evaluate((node, original) => node === original, panelNode)).toBe(true)
  const scrollAfterRecovery = await scroller.evaluate(node => node.scrollTop)
  // Removing the complete long list lets the browser clamp the scroll offset; compare the tab's content position.
  expect(await tabs.boundingBox()).toEqual(tabsBeforeRecovery && {
    ...tabsBeforeRecovery, y: tabsBeforeRecovery.y + scrollBeforeRecovery - scrollAfterRecovery,
  })
  if (removed) expect(await card.count()).toBe(0)
  else {
    expect(await card.evaluate((node, original) => node === original, cardNode)).toBe(true)
    expect(await card.boundingBox()).toEqual(beforeRecovery)
    expect(await scroller.evaluate(node => node.scrollTop)).toBe(scrollTop)
  }
  expect(await (elsewhere ? search : removed ? section : card).evaluate(node => node === document.activeElement)).toBe(true)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('restores connector capability browsing after a failed refresh without remounting its controls', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  const failure = Promise.withResolvers<undefined>(), retry = Promise.withResolvers<undefined>()
  onTestFinished(() => { failure.resolve(undefined); retry.resolve(undefined) })
  let reads = 0, revocations = 0
  const descriptor = { ...connectors[0], authMode: 'oauth', authorizationStatus: 'AUTHORIZED',
    tools: Array.from({ length: 45 }, (_, index) => ({ name: `order.read_${index}`, displayName: `Read order ${index}`,
      description: `Read-only order instructions ${index}`, access: 'READ' })) }
  await page.exposeFunction('__capabilityRetryInvoke', async (method: string) => {
    switch (method) {
      case 'auth.getSession': return { authenticated: true, employeeId: 'fixture-employee' }
      case 'connectors.list': {
        reads++
        if (reads === 2) { await failure.promise; throw new Error('Directory unavailable') }
        if (reads === 3) await retry.promise
        return [{ ...descriptor, authorizationStatus: reads > 1 ? 'REQUIRED' : 'AUTHORIZED' }]
      }
      case 'connectors.authorization.revoke': { revocations++; return { connectorId: 'erp', status: 'REQUIRED' } }
      default: throw new Error(`Unexpected capability refresh method: ${method}`)
    }
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __capabilityRetryInvoke(method: string): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string) => ({ ok: true, result: await api.__capabilityRetryInvoke(method) }),
      cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Connectors', exact: true }).click()
  await page.getByRole('button', { name: /Order management Orders/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Connector details', exact: true })
  const disclosure = dialog.locator('details').first()
  await disclosure.locator(':scope > summary').click()
  const search = dialog.getByRole('searchbox', { name: 'Search capabilities', exact: true })
  const searchNode = await search.elementHandle()
  await search.fill('order')
  const access = dialog.getByRole('combobox')
  await access.selectOption('READ')
  const first = dialog.locator('summary').filter({ hasText: /^Read order 0/ })
  await first.click()
  const firstNode = await first.elementHandle()
  await dialog.getByRole('button', { name: 'Show more (20 / 45 shown)', exact: true }).click()
  const more = dialog.getByRole('button', { name: 'Show more (40 / 45 shown)', exact: true })
  const moreNode = await more.elementHandle()
  await dialog.getByRole('button', { name: 'Disconnect account', exact: true }).click()
  await expect.poll(() => reads).toBe(2)
  await first.focus()
  failure.resolve(undefined)
  const refresh = dialog.getByRole('button', { name: 'Refresh', exact: true })
  await refresh.waitFor()
  await expect.poll(() => refresh.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await search.isVisible()).toBe(false)
  expect(await dialog.getByRole('listitem').count()).toBe(0)
  await refresh.press('Enter')
  await expect.poll(() => reads).toBe(3)
  expect(await search.isVisible()).toBe(false)
  expect(await refresh.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await refresh.getAttribute('aria-busy')).toBe('true')
  await refresh.press('Enter')
  expect(reads).toBe(3)
  retry.resolve(undefined)
  await search.waitFor()
  expect(await search.evaluate((node, original) => node === original, searchNode)).toBe(true)
  expect(await search.inputValue()).toBe('order')
  expect(await access.inputValue()).toBe('READ')
  expect(await disclosure.evaluate((node: HTMLDetailsElement) => node.open)).toBe(true)
  expect(await first.evaluate((node, original) => node === original, firstNode)).toBe(true)
  expect(await first.locator('..').evaluate((node: HTMLDetailsElement) => node.open)).toBe(true)
  expect(await more.evaluate((node, original) => node === original, moreNode)).toBe(true)
  expect(await dialog.getByRole('listitem').count()).toBe(40)
  expect(await dialog.getByRole('button', { name: 'Connect account', exact: true }).evaluate(node => node === document.activeElement)).toBe(true)
  expect(revocations).toBe(1)
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await search.focus()
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `connector-tools-recovered-${theme}-${width}.png`), animations: 'disabled' })
    }
  }
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it.each(['libraries', 'files'] as const)('keeps %s geometry and focus stable across read feedback in light, dark and narrow layouts', async (source) => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  page.setDefaultTimeout(15_000)
  const tripwire = watchConsole(page)
  const timestamp = '2026-11-13T01:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: '项目资料', description: '团队文件', scope: 'PERSONAL',
    ownerId: 'employee', managerEmployeeId: 'employee', canManage: true, version: 1, createdAt: timestamp, updatedAt: timestamp }
  const file = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id, parentId: null, name: '中文资料.md', kind: 'FILE',
    sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12, favorite: false, version: 1, createdAt: timestamp, updatedAt: timestamp }
  let reads = 0, mode: 'ready' | 'failed' | 'pending' = 'ready'
  let pending: ReturnType<typeof Promise.withResolvers<undefined>> | undefined
  onTestFinished(() => pending?.resolve(undefined))
  const readMethod = source === 'files' ? 'library.entries.list' : 'library.list'
  await page.exposeFunction('__libraryFeedbackInvoke', async (method: string) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee' }
    if (method === 'connectors.list') return []
    if (method === 'library.get') return library
    if (method === readMethod) {
      reads++
      if (mode === 'pending') await pending?.promise
      if (mode === 'failed') throw new Error('Directory unavailable')
    }
    if (method === 'library.list' || method === 'library.entries.list') {
      return { data: [method === 'library.list' ? library : file], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    }
    throw new Error(`Unexpected library method ${method}`)
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __libraryFeedbackInvoke(method: string): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string) => {
        try { return { ok: true, result: await api.__libraryFeedbackInvoke(method) } }
        catch { return { ok: false, failure: { code: 'EXTERNAL_SERVICE_ERROR', message: 'Directory unavailable', retryable: true } } }
      }, cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Libraries', exact: true }).click()
  await page.getByRole('button', { name: 'Library directory', exact: true }).click()
  if (source === 'files') await page.getByRole('button', { name: /项目资料/ }).click()
  const row = page.getByRole('button', { name: source === 'files' ? /中文资料.md/ : /项目资料/ })
  const search = page.getByRole('searchbox', { name: 'Search names', exact: true })
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
  await row.waitFor()
  await search.fill('资料')
  await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('false')
  const rowNode = await row.elementHandle(), searchNode = await search.elementHandle()
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      if (width < 600) await expect.poll(() => page.locator('[data-sidebar-drawer]').count()).toBe(1)
      if (await page.locator('[data-sidebar-drawer]:not([data-sidebar-collapsed])').count()) {
        await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      }
      if (width < 600) await expect.poll(() => page.locator('[data-sidebar-drawer] > [inert]').first()
        .evaluate(node => node.getBoundingClientRect().right <= 1 && getComputedStyle(node).visibility === 'hidden')).toBe(true)
      await refresh.scrollIntoViewIfNeeded()
      const before = { row: await row.boundingBox(), search: await search.boundingBox(), refresh: await refresh.boundingBox() }
      mode = 'failed'
      await refresh.click()
      const retry = page.getByRole('button', { name: 'Retry', exact: true })
      await retry.waitFor()
      const region = page.getByRole('region', { name: 'Product catalogs are temporarily unavailable. Try again later.', exact: true })
      const alertNode = await page.getByRole('alert').elementHandle(), retryNode = await retry.elementHandle()
      expect({ row: await row.boundingBox(), search: await search.boundingBox(), refresh: await refresh.boundingBox() }).toEqual(before)
      expect(await controlIsUnclipped(retry)).toBe(true)
      const section = page.getByRole('region', { name: 'Libraries', exact: true }).last()
      expect(await section.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-read-feedback-${source}-${theme}-${width}.png`) })
      mode = 'pending'; pending = Promise.withResolvers<undefined>()
      const beforeRetry = reads
      await retry.focus(); await retry.press('Enter')
      await expect.poll(() => reads).toBe(beforeRetry + 1)
      await retry.press('Enter')
      expect(reads).toBe(beforeRetry + 1)
      expect(await retry.evaluate((node, original) => node === original && node === document.activeElement, retryNode)).toBe(true)
      expect(await page.getByRole('alert').evaluate((node, original) => node === original, alertNode)).toBe(true)
      await search.evaluate((input) => { (input as HTMLInputElement).setSelectionRange(0, 1) })
      if (theme === 'light') { await region.scrollIntoViewIfNeeded(); await region.focus() }
      else await search.focus()
      const scroll = await section.evaluate(node => node.scrollTop)
      mode = 'ready'; pending.resolve(undefined)
      await expect.poll(() => page.getByRole('alert').count()).toBe(0)
      expect(await row.evaluate((node, original) => node === original, rowNode)).toBe(true)
      expect(await search.evaluate((node, original) => node === original && node === document.activeElement, searchNode)).toBe(true)
      expect(await search.inputValue()).toBe('资料')
      expect(await search.evaluate(input => [
        (input as HTMLInputElement).selectionStart, (input as HTMLInputElement).selectionEnd,
      ])).toEqual([0, 1])
      expect(await section.evaluate(node => node.scrollTop)).toBe(scroll)
      expect({ row: await row.boundingBox(), search: await search.boundingBox(), refresh: await refresh.boundingBox() }).toEqual(before)
    }
  }
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
}, 120_000)

it('keeps library files, drafts and focus stable through refresh, retry and deletion in the real Harness page', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  page.setDefaultTimeout(15_000)
  const tripwire = watchConsole(page)
  const timestamp = '2026-11-13T01:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: '项目资料', description: '团队文件', scope: 'PERSONAL',
    ownerId: 'employee', managerEmployeeId: 'employee', canManage: true, version: 1, createdAt: timestamp, updatedAt: timestamp }
  const file = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id, parentId: null, name: '中文资料.md', kind: 'FILE',
    sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12, favorite: false, version: 1, createdAt: timestamp, updatedAt: timestamp }
  let reads = 0, deletes = 0, mode: 'ready' | 'failed' | 'pending' = 'ready'
  let removed = false
  let background: ReturnType<typeof Promise.withResolvers<undefined>> | undefined
  const pending = Promise.withResolvers<undefined>()
  onTestFinished(() => { pending.resolve(undefined); background?.resolve(undefined) })
  await page.exposeFunction('__libraryInvoke', async (method: string) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee' }
    if (method === 'connectors.list') return []
    if (method === 'library.files.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
    if (method === 'library.list') return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    if (method === 'library.get') return library
    if (method === 'library.entries.list') {
      reads++
      if (mode === 'pending') await pending.promise
      await background?.promise
      if (mode === 'failed') throw new Error('Directory unavailable')
      return { data: removed ? [] : [file], pageIndex: 1, pageSize: 20, totalCount: removed ? 0 : 1, totalPages: removed ? 0 : 1 }
    }
    if (method === 'library.entries.delete') { deletes++; removed = true; return true }
    throw new Error(`Unexpected library method ${method}`)
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __libraryInvoke(method: string): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string) => {
        try { return { ok: true, result: await api.__libraryInvoke(method) } }
        catch { return { ok: false, failure: { code: 'EXTERNAL_SERVICE_ERROR', message: 'Directory unavailable', retryable: true } } }
      }, cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Libraries', exact: true }).click()
  await page.getByRole('button', { name: 'Library directory', exact: true }).click()
  await page.getByRole('button', { name: /项目资料/ }).click()
  const fileButton = page.getByRole('button', { name: /中文资料.md/ }), search = page.getByRole('searchbox', { name: 'Search names', exact: true })
  await fileButton.waitFor()
  const fileNode = await fileButton.elementHandle(), searchNode = await search.elementHandle()
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true }), refreshNode = await refresh.elementHandle()
  const refreshBox = await refresh.boundingBox(), fileBox = await fileButton.boundingBox(), searchBox = await search.boundingBox()
  mode = 'failed'
  await refresh.click()
  const retry = page.getByRole('button', { name: 'Retry', exact: true })
  await retry.waitFor()
  expect(await fileButton.boundingBox()).toEqual(fileBox)
  expect(await search.boundingBox()).toEqual(searchBox)
  const retryNode = await retry.elementHandle(), alertNode = await page.getByRole('alert').elementHandle()
  mode = 'pending'
  await retry.focus(); await retry.press('Enter')
  await expect.poll(() => reads).toBe(3)
  expect(await retry.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await fileButton.evaluate((node, original) => node === original, fileNode)).toBe(true)
  expect(await refresh.evaluate((node, original) => node === original, refreshNode)).toBe(true)
  expect(await refresh.boundingBox()).toEqual(refreshBox)
  expect(await fileButton.boundingBox()).toEqual(fileBox)
  await retry.press('Enter'); expect(reads).toBe(3)
  expect(await retry.evaluate((node, original) => node === original, retryNode)).toBe(true)
  expect(await page.getByRole('alert').evaluate((node, original) => node === original, alertNode)).toBe(true)
  mode = 'ready'; pending.resolve(undefined)
  await expect.poll(() => page.getByRole('alert').count()).toBe(0)
  expect(await fileButton.boundingBox()).toEqual(fileBox)
  expect(await search.evaluate((node, original) => node === original && node === document.activeElement, searchNode)).toBe(true)
  await page.getByRole('button', { name: 'New folder', exact: true }).click()
  const dialog = page.getByRole('dialog'), name = dialog.getByRole('textbox', { name: 'Name', exact: true })
  await name.fill('保留的目录草稿'); await name.evaluate((input) => { (input as HTMLInputElement).setSelectionRange(2,5) })
  const inputNode = await name.elementHandle()
  await name.press('Escape')
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click()
  expect(await name.evaluate((node, original) => node === original && node === document.activeElement, inputNode)).toBe(true)
  expect(await name.evaluate(input => [
    (input as HTMLInputElement).selectionStart, (input as HTMLInputElement).selectionEnd,
  ])).toEqual([2,5])
  await name.press('Escape'); await dialog.getByRole('button', { name: 'Discard', exact: true }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect.poll(() => fileButton.count()).toBe(0)
  expect(deletes).toBe(1)
  expect(await search.evaluate(node => node === document.activeElement)).toBe(true)
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      if (width < 600) await expect.poll(() => page.locator('[data-sidebar-drawer]').count()).toBe(1)
      if (await page.locator('[data-sidebar-drawer]:not([data-sidebar-collapsed])').count()) {
        await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      }
      if (width < 600) await expect.poll(() => page.locator('[data-sidebar-drawer][data-sidebar-collapsed]').count()).toBe(1)
      if (width < 600) await expect.poll(() => page.locator('[data-sidebar-drawer] > [inert]').first()
        .evaluate(node => node.getBoundingClientRect().right <= 1 && getComputedStyle(node).visibility === 'hidden')).toBe(true)
      const section = page.getByRole('region', { name: 'Libraries', exact: true }).last()
      await expect.poll(() => section.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-${theme}-${width}.png`) })
      removed = false
      await refresh.click()
      await fileButton.waitFor()
      await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('false')
      background = Promise.withResolvers<undefined>()
      await refresh.click()
      const opener = page.getByRole('button', { name: width === 390 ? 'Rename' : 'Delete', exact: true })
      await opener.click()
      const overlay = page.getByRole('dialog'), overlayNode = await overlay.elementHandle()
      await overlay.evaluate(async (node) => {
        await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished))
      })
      const close = overlay.getByRole('button', { name: 'Close', exact: true })
      await close.focus()
      const bounds = await overlay.boundingBox(), beforeScroll = await overlay.evaluate(node => node.scrollTop)
      removed = true
      background.resolve(undefined)
      await fileButton.waitFor({ state: 'detached' })
      expect(await close.evaluate(node => node === document.activeElement)).toBe(true)
      expect(await overlay.evaluate((node, previous) => node === previous, overlayNode)).toBe(true)
      expect(await overlay.boundingBox()).toEqual(bounds)
      expect(await overlay.evaluate(node => node.scrollTop)).toBe(beforeScroll)
      expect(await search.evaluate((node, previous) => node === previous, searchNode)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-removed-modal-opener-${theme}-${width}.png`) })
      await close.press('Escape')
      await overlay.waitFor({ state: 'detached' })
      expect(await search.evaluate(node => node === document.activeElement)).toBe(true)
      background = undefined
    }
  }
  expect(tripwire.pageErrors).toEqual([])
}, 120_000)
