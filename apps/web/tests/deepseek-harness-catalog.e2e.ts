/** Product interactions mounted through the real Harness Web composition. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { REPO_ROOT, newEnglishPage, controlIsUnclipped } from './support.ts'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import type { LibraryEntry } from '@deepseek-harness/product/library'

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
  const library = { id: '11111111-1111-4111-8111-111111111111', name: 'Upload library',
    scope: 'PERSONAL', ownerId: 'fixture-employee', companyId: 'company', role: 'OWNER', canManage: true,
    version: 1, createdAt: now, updatedAt: now }
  const files = [
    { selectionId: '22222222-2222-4222-8222-222222222222', name: 'First.md', kind: 'FILE' as const, sizeBytes: 12 },
    { selectionId: '33333333-3333-4333-8333-333333333333', name: 'Second.md', kind: 'FILE' as const, sizeBytes: 12 },
  ]
  const singleFile = { selectionId: '55555555-5555-4555-8555-555555555555', name: 'New.md', kind: 'FILE' as const, sizeBytes: 12 }
  const invalidFile = { selectionId: '66666666-6666-4666-8666-666666666666', name: '中文参考资料'.repeat(18) + '.md', kind: 'FILE' as const, sizeBytes: 12 }
  const recoveredFile = { ...invalidFile, selectionId: '77777777-7777-4777-8777-777777777777' }
  const writes: unknown[] = []
  const uploaded: string[] = []
  await page.exposeFunction('__libraryUploadInvoke', async (method: string, payload?: unknown) => {
    if (method === 'auth.getSession') return authenticated ? { authenticated, employeeId: 'fixture-employee' } : { authenticated }
    if (method === 'auth.ensureDingTalk') { await loginGate.promise; return { authenticated: false } }
    if (method === 'library.files.list') return { data: uploaded.map(id => ({
      entry: { id, libraryId: library.id, parentId: null,
        name: [...files, singleFile, recoveredFile].find(file => file.selectionId === id)!.name,
        kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12, version: 1, createdAt: now, updatedAt: now },
      libraryName: library.name, canManage: true, lastAccessedAt: now, sourceKind: 'UPLOAD', sourceSessionId: null,
    })), pageIndex: 1, pageSize: 20, totalCount: uploaded.length, totalPages: uploaded.length ? 1 : 0 }
    if (method === 'library.list') { resourceReads++; return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 } }
    if (method === 'library.get' || method === 'library.personal.ensure') return library
    if (method === 'library.entries.list') return { data: uploaded.map(id => ({ id, libraryId: library.id, parentId: null,
      name: [...files, singleFile, recoveredFile].find(file => file.selectionId === id)!.name, kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown',
      sizeBytes: 12, version: 1, createdAt: now, updatedAt: now })), pageIndex: 1, pageSize: 20,
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
  const initialLogin = page.getByRole('dialog', { name: 'Sign in to DeepSeek Harness', exact: true })
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
  try {
    await page.getByRole('option', { name: /Choose library files/ }).click()
  } catch (failure) {
    await page.screenshot({ path: join(screenshots, 'library-upload-menu-failure.png') })
    await writeFile(join(screenshots, 'library-upload-menu-failure.txt'), await page.locator('body').ariaSnapshot())
    throw failure
  }
  const login = page.getByRole('dialog', { name: 'Sign in to DeepSeek Harness', exact: true })
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
  const trigger = page.getByRole('button', { name: 'Upload files', exact: true })
  const triggerNode = await trigger.elementHandle()
  let uploadOpens = 0
  const openUpload = async () => {
    await trigger.click()
    const destination = page.getByRole('dialog', { name: 'Choose upload destination', exact: true })
    if (++uploadOpens === 1) {
      await expect.poll(() => destination.getByRole('button', { name: 'Choose', exact: true }).getAttribute('aria-disabled')).toBe('false')
      await destination.getByRole('button', { name: 'Choose', exact: true }).click()
    } else {
      await page.getByRole('dialog', { name: 'Upload files', exact: true }).waitFor()
      expect(await destination.count()).toBe(0)
    }
  }
  await openUpload()
  const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true })
  const choose = dialog.getByRole('button', { name: 'Choose files', exact: true })
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
  await page.getByRole('button', { name: 'Second.md Upload library', exact: true }).waitFor()
  expect(await trigger.evaluate((node, previous) => node === previous && node === document.activeElement, triggerNode)).toBe(true)
  await openUpload()
  await choose.click()
  await expect.poll(() => selects).toBe(3)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  selectionGate.resolve(undefined)
  await expect.poll(() => discards).toBe(3)
  expect(writes).toHaveLength(3)
  await openUpload()
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
        const errorRegion = dialog.getByRole('region', { name: 'Save failed. Please retry.', exact: true })
        expect(await errorRegion.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
        await errorRegion.focus(); await errorRegion.press('End')
        await expect.poll(() => errorRegion.evaluate(node => node.scrollTop > 0)).toBe(true)
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
  await openUpload()
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
  let attempts = 0, closed = 0, listingReads = 0, pathReads = 0
  let failPath = false, pathRetrying = false
  const pathRetryGate = Promise.withResolvers<undefined>()
  onTestFinished(() => { pathRetryGate.resolve(undefined) })
  let cancellationPhase: 'open' | 'read' | undefined, reading = false, cancellations = 0
  const cancelledOpen = Promise.withResolvers<undefined>(), cancelledRead = Promise.withResolvers<undefined>()
  onTestFinished(() => { cancelledOpen.resolve(undefined); cancelledRead.resolve(undefined) })
  const folderRead = Promise.withResolvers<undefined>()
  onTestFinished(() => { folderRead.resolve(undefined) })
  const now = '2026-11-13T01:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: 'Attachment library',
    scope: 'PERSONAL', ownerId: 'fixture-employee', companyId: 'company', role: 'OWNER', canManage: true,
    version: 1, createdAt: now, updatedAt: now }
  const files = Array.from({ length: 19 }, (_, index) => ({
    id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`, libraryId: library.id, parentId: null,
    name: `Reference ${index}.md`, kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 3,
    version: 1, createdAt: now, updatedAt: now,
  }))
  const parent = { ...files[0]!, id: '33333333-3333-4333-8333-333333333333', name: 'Other directory',
    kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0 }
  const nested = { ...parent, id: '44444444-4444-4444-8444-444444444444', parentId: parent.id, name: 'Reference nested folder' }
  const nestedFile = { ...files[0]!, id: '77777777-7777-4777-8777-777777777777', parentId: nested.id, name: 'Nested reference.md' }
  const sharedLibrary = { ...library, id: '55555555-5555-4555-8555-555555555555', scope: 'TEAM', name: 'Shared reference materials', role: 'VIEWER', canManage: false }
  const sharedFolder = { ...parent, libraryId: sharedLibrary.id, name: '参考模板' }
  const sharedFile = { ...files[0]!, id: '66666666-6666-4666-8666-666666666666', libraryId: sharedLibrary.id, parentId: sharedFolder.id,
    name: '共享模板与项目交付说明-Long project delivery reference.docx' }
  await page.exposeFunction('__libraryAttachmentInvoke', async (method: string, payload?: unknown) => {
    if (['library.list', 'library.get', 'library.entries.list'].includes(method)) listingReads++
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'fixture-employee' }
    if (method === 'library.files.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
    if (method === 'library.list') return { data: [library, sharedLibrary], pageIndex: 1, pageSize: 20, totalCount: 2, totalPages: 1 }
    if (method === 'library.get' || method === 'library.personal.ensure') return typeof payload === 'object' && payload !== null
      && 'libraryId' in payload && payload.libraryId === sharedLibrary.id ? sharedLibrary : library
    if (method === 'library.entries.list') {
      if (typeof payload === 'object' && payload !== null && 'parentId' in payload && payload.parentId === nested.id)
        return { data: [nestedFile], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
      if (typeof payload === 'object' && payload !== null && 'libraryId' in payload && payload.libraryId === sharedLibrary.id) {
        const data = 'parentId' in payload && payload.parentId === sharedFolder.id ? [sharedFile] : [sharedFolder]
        return { data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: 1 }
      }
      const data = typeof payload === 'object' && payload !== null && 'query' in payload && payload.query !== ''
        ? [...files, nested] : files
      return { data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: 1 }
    }
    if (method === 'library.entries.get') {
      expect(payload).toMatchObject({ libraryId: library.id, entryId: parent.id })
      pathReads++
      if (failPath) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Path unavailable', true)) }
      await folderRead.promise
      if (pathRetrying) await pathRetryGate.promise
      return parent
    }
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
  try { await page.getByRole('option', { name: /Choose library files/ }).click() }
  catch (error) {
    await mkdir(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, 'library-attachment-menu-failure.png') })
    await writeFile(join(screenshots, 'library-attachment-menu-failure.txt'), await page.locator('body').ariaSnapshot())
    throw error
  }
  const dialog = page.getByRole('dialog', { name: 'Choose library files', exact: true })
  await dialog.getByRole('tab', { name: 'My files', exact: true }).click()
  const row = dialog.getByRole('button', { name: 'Reference 0.md', exact: true })
  await dialog.getByRole('checkbox', { name: 'Reference 0.md', exact: true }).click()
  const search = dialog.getByRole('searchbox')
  await search.fill('Reference')
  await expect.poll(() => dialog.getByRole('tabpanel').getAttribute('aria-busy')).toBe('false')
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(2, 7) })
  const rowNode = await row.elementHandle(), searchNode = await search.elementHandle()
  const scroller = dialog.locator('[class*=libraryPickerTable]')
  await scroller.evaluate((node) => { node.scrollTop = 100 })
  const scroll = await scroller.evaluate(node => node.scrollTop)
  expect(scroll).toBeGreaterThan(0)
  const attach = dialog.getByRole('button', { name: 'Confirm', exact: true })
  const attachNode = await attach.elementHandle(), attachBounds = await attach.boundingBox(), bounds = await dialog.boundingBox()
  await attach.focus(); await attach.press('Enter')
  const alert = dialog.getByRole('alert')
  await alert.waitFor()
  expect(await alert.evaluate((node) => {
    const bounds = node.getBoundingClientRect()
    return document.elementsFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2).includes(node)
  })).toBe(true)
  expect(await alert.textContent()).toBe('Could not add these files. Retry.')
  expect(await search.evaluate(node => node instanceof HTMLInputElement && !node.readOnly)).toBe(true)
  const selected = dialog.getByRole('checkbox', { name: 'Reference 0.md', exact: true })
  const selectedNode = await selected.elementHandle()
  expect(await selected.isDisabled()).toBe(false)
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
  const folder = dialog.getByRole('button', { name: 'Reference nested folder', exact: true })
  const folderNode = await folder.elementHandle()
  await folder.focus(); await folder.press('Enter')
  await expect.poll(() => pathReads).toBe(1)
  expect(await folder.getAttribute('aria-busy')).toBe('true')
  await attach.focus(); await attach.press('Enter'); await attach.press(' ')
  await expect.poll(() => attempts).toBe(2)
  expect(await alert.evaluate((node, original) => node === original, alertNode)).toBe(true)
  expect(await row.evaluate((node, original) => node === original, rowNode)).toBe(true)
  expect(await search.evaluate((node, original) => node === original && node instanceof HTMLInputElement
    && node.value === 'Reference' && node.selectionStart === 2 && node.selectionEnd === 7, searchNode)).toBe(true)
  expect(await attach.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await search.evaluate(node => node instanceof HTMLInputElement && node.readOnly)).toBe(true)
  expect(await selected.evaluate((node, original) => node === original, selectedNode)).toBe(true)
  expect(await selected.isDisabled()).toBe(true)
  expect(await row.getAttribute('aria-disabled')).toBe('true')
  const recent = dialog.getByRole('tab', { name: 'Recent', exact: true })
  const root = dialog.getByRole('tab', { name: 'My files', exact: true })
  expect(await recent.locator('..').locator('..').getAttribute('aria-disabled')).toBe('true')
  expect(await root.locator('..').locator('..').getAttribute('aria-disabled')).toBe('true')
  const reads = listingReads, lockedBounds = await dialog.boundingBox()
  folderRead.resolve(undefined)
  await expect.poll(() => cancellations).toBe(1)
  expect(await folder.evaluate((node, original) => node === original, folderNode)).toBe(true)
  expect(await folder.getAttribute('aria-busy')).not.toBe('true')
  await recent.dispatchEvent('click'); await root.dispatchEvent('click'); await selected.dispatchEvent('click')
  await search.focus(); await search.press('x')
  expect(await search.inputValue()).toBe('Reference')
  expect(await search.evaluate(node => node instanceof HTMLInputElement
    ? [node.selectionStart, node.selectionEnd] : null)).toEqual([2, 7])
  expect(await selected.isChecked()).toBe(true)
  expect(listingReads).toBe(reads)
  expect(await dialog.boundingBox()).toEqual(lockedBounds)
  await attach.focus()
  await page.screenshot({ path: join(screenshots, 'library-attachment-admission-dark-390.png') })
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
  const previousCancellations = cancellations
  for (const phase of ['open', 'read'] as const) {
    cancellationPhase = phase
    await page.setViewportSize({ width: phase === 'open' ? 1440 : 390, height: 900 })
    await page.emulateMedia({ colorScheme: phase === 'open' ? 'light' : 'dark' })
    await add.click()
    await page.getByRole('option', { name: /Choose library files/ }).click()
    await dialog.getByRole('tab', { name: 'My files', exact: true }).click()
    await dialog.getByRole('checkbox', { name: 'Reference 0.md', exact: true }).click()
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(() => attempts).toBe(phase === 'open' ? 3 : 4)
    if (phase === 'read') await expect.poll(() => reading).toBe(true)
    await dialog.evaluate(async (node) => { await Promise.allSettled(node.getAnimations().map(animation => animation.finished)) })
    await page.screenshot({ path: join(screenshots, `library-attachment-admission-${phase}.png`) })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await expect.poll(() => cancellations).toBe(previousCancellations + (phase === 'open' ? 1 : 2))
    await expect.poll(() => composer.evaluate(node => node === document.activeElement)).toBe(true)
    await add.click()
    await page.getByRole('option', { name: /Choose library files/ }).click()
    await dialog.getByRole('tab', { name: 'My files', exact: true }).waitFor()
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
    expect(await dialog.getByRole('button', { name: 'Confirm', exact: true }).getAttribute('aria-disabled')).toBe('true')
    expect(await page.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await dialog.evaluate(async (node) => { await Promise.allSettled(node.getAnimations().map(animation => animation.finished)) })
    await page.screenshot({ path: join(screenshots, `library-attachment-cancel-${phase}.png`) })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await add.click()
  await page.getByRole('option', { name: /Choose library files/ }).click()
  await dialog.getByRole('tab', { name: 'My files', exact: true }).click()
  await dialog.getByRole('checkbox', { name: 'Reference 0.md', exact: true }).waitFor()
  const pathSearch = dialog.getByRole('searchbox')
  await pathSearch.focus()
  await page.keyboard.insertText('x'.repeat(181))
  expect((await pathSearch.inputValue()).length).toBe(180)
  await pathSearch.fill('Reference')
  failPath = true
  await dialog.getByRole('button', { name: nested.name, exact: true }).click()
  const pathError = dialog.getByRole('alert'), pathErrorNode = await pathError.elementHandle()
  await pathError.waitFor()
  pathRetrying = true; failPath = false
  const pathRetryButton = dialog.getByRole('button', { name: 'Retry', exact: true })
  await expect.poll(() => pathRetryButton.getAttribute('aria-disabled')).toBe('false')
  const beforeRetryReads = listingReads, beforePathReads = pathReads
  await pathRetryButton.focus(); await pathRetryButton.press('Enter'); await pathRetryButton.press('Enter')
  await expect.poll(() => pathReads).toBe(beforePathReads + 1)
  expect(listingReads).toBe(beforeRetryReads)
  expect(await pathError.evaluate((node, original) => node === original, pathErrorNode)).toBe(true)
  expect(await pathRetryButton.evaluate(node => node === document.activeElement)).toBe(true)
  pathRetryGate.resolve(undefined)
  await expect.poll(() => pathError.count()).toBe(0)
  await dialog.getByRole('navigation', { name: 'Folder path', exact: true }).getByRole('button', { name: nested.name }).waitFor()
  await dialog.getByRole('checkbox', { name: nestedFile.name, exact: true }).waitFor()
  expect(await pathSearch.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await pathSearch.inputValue()).toBe('')
  await dialog.getByRole('tab', { name: 'Shared spaces', exact: true }).click()
  await dialog.getByRole('button', { name: sharedLibrary.name, exact: true }).click()
  await dialog.getByRole('button', { name: sharedFolder.name, exact: true }).click()
  await dialog.getByRole('checkbox', { name: sharedFile.name, exact: true }).check()
  await dialog.getByText('1 selected', { exact: true }).waitFor()
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      expect(await dialog.getByRole('tab').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth))).toBe(true)
      await dialog.evaluate(async (node) => {
        await Promise.allSettled(node.getAnimations({ subtree: true }).map(animation => animation.finished))
      })
      await page.screenshot({ path: join(screenshots, `library-picker-shared-${theme}-${width}.png`) })
    }
  }
  await dialog.getByRole('tab', { name: 'Recent', exact: true }).click()
  await dialog.getByText('No files yet', { exact: true }).waitFor()
  expect(await dialog.getByText('1 selected', { exact: true }).count()).toBe(1)
  await dialog.getByRole('tab', { name: 'Shared spaces', exact: true }).click()
  expect(await dialog.getByRole('checkbox', { name: sharedFile.name, exact: true }).isChecked()).toBe(true)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('retains the newest library picker rows and errors while changing queries across sources', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  await seedSession(scaffold, await readFile(join(REPO_ROOT, 'snapshots/web/present-after-closing-reply/session.v4.jsonl'), 'utf8'),
    'library-picker-current-rows')
  const browser = await chromium.launch(), page = await newEnglishPage(browser)
  onTestFinished(() => browser.close())
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page), now = '2026-11-17T01:00:00Z'
  const personal = { id: '11111111-1111-4111-8111-111111111111', name: 'Personal references', scope: 'PERSONAL',
    ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: now, updatedAt: now }
  const shared = { ...personal, id: '22222222-2222-4222-8222-222222222222', name: 'Shared references', scope: 'TEAM',
    role: 'VIEWER', canManage: false }
  const listing = (data: readonly unknown[]) => ({ data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: 1 })
  let version = 1, fail = false, listReads = 0
  let waiting: Promise<undefined> | undefined
  const gates: ReturnType<typeof Promise.withResolvers<undefined>>[] = []
  onTestFinished(() => { for (const gate of gates) gate.resolve(undefined) })
  await page.exposeFunction('__libraryPickerCurrentInvoke', async (method: string, input?: { libraryId?: string; query?: string }) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: personal.ownerId }
    if (method === 'library.list') return listing([shared])
    if (method === 'library.personal.ensure') return personal
    if (method === 'library.get') return input?.libraryId === shared.id ? shared : personal
    if (method === 'library.files.list' || method === 'library.entries.list') {
      listReads++; await waiting
      if (fail) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Listing unavailable', true)) }
      const entries = Array.from({ length: 20 }, (_, index) => ({
        id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`, libraryId: input?.libraryId ?? personal.id,
        parentId: null, name: `Reference v${version} ${index}.md`, kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown',
        sizeBytes: 12, version, createdAt: now, updatedAt: now,
      })).filter(entry => entry.name.includes(input?.query ?? ''))
      return listing(method === 'library.files.list' ? entries.map(entry => ({ entry, libraryName: personal.name,
        canManage: true, lastAccessedAt: now, sourceKind: 'UPLOAD', sourceSessionId: null })) : entries)
    }
    throw new Error(`Unexpected picker fixture operation: ${method}`)
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __libraryPickerCurrentInvoke(method: string, input?: unknown): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string, input?: unknown) => {
        const result = await api.__libraryPickerCurrentInvoke(method, input)
        return result && typeof result === 'object' && 'fixtureFailure' in result
          ? { ok: false, failure: result.fixtureFailure } : { ok: true, result }
      }, cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.locator('[role="treeitem"]').first().click()
  await page.locator('[role="treeitem"]').nth(1).click()
  await page.getByText('REPORT_READY', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Add files or run commands', exact: true }).click()
  await page.getByRole('option', { name: /Choose library files/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Choose library files', exact: true })
  const search = dialog.getByRole('searchbox'), searchNode = await search.elementHandle()
  const table = dialog.getByRole('tabpanel'), scroller = dialog.locator('[class*=libraryPickerTable]')
  await mkdir(screenshots, { recursive: true })
  for (const scene of [{ source: 'Recent', width: 1440, theme: 'light' },
    { source: 'My files', width: 390, theme: 'dark' }, { source: 'Shared spaces', width: 600, theme: 'light' }] as const) {
    version = 1
    await page.emulateMedia({ colorScheme: scene.theme }); await page.setViewportSize({ width: scene.width, height: 900 })
    await dialog.getByRole('tab', { name: scene.source, exact: true }).click()
    if (scene.source === 'Shared spaces') await dialog.getByRole('button', { name: shared.name, exact: true }).click()
    await dialog.getByRole('button', { name: 'Reference v1 0.md', exact: true }).waitFor()
    version = 2
    await search.fill('Reference')
    const row = dialog.getByRole('button', { name: 'Reference v2 0.md', exact: true })
    await row.waitFor()
    const rowNode = await row.elementHandle(), dialogNode = await dialog.elementHandle()
    await scroller.evaluate((node) => { node.scrollTop = 100 })
    const scroll = await scroller.evaluate(node => node.scrollTop)
    const gate = Promise.withResolvers<undefined>(); gates.push(gate); waiting = gate.promise; fail = true
    await search.fill('')
    await expect.poll(() => table.getAttribute('aria-busy')).toBe('true')
    expect(await row.evaluate((node, original) => node === original, rowNode)).toBe(true)
    expect(await dialog.getByRole('button', { name: 'Reference v1 0.md', exact: true }).count()).toBe(0)
    gate.resolve(undefined); waiting = undefined
    const alert = dialog.getByRole('alert'); await alert.waitFor()
    const alertNode = await alert.elementHandle(), retry = dialog.getByRole('button', { name: 'Retry', exact: true })
    const retryNode = await retry.elementHandle()
    const queryGate = Promise.withResolvers<undefined>(); gates.push(queryGate); waiting = queryGate.promise
    await search.fill('Reference v')
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(2, 5) })
    expect(await alert.evaluate((node, original) => node === original, alertNode)).toBe(true)
    expect(await retry.evaluate((node, original) => node === original, retryNode)).toBe(true)
    queryGate.resolve(undefined); waiting = undefined
    await expect.poll(() => retry.getAttribute('aria-disabled')).toBe('false')
    const recovery = Promise.withResolvers<undefined>(); gates.push(recovery); waiting = recovery.promise; fail = false
    const reads = listReads
    await retry.focus(); await retry.press('Enter'); await retry.press('Enter')
    await expect.poll(() => listReads).toBe(reads + 1)
    expect(await retry.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await scroller.evaluate(node => node.scrollTop)).toBe(scroll)
    await dialog.evaluate(async (node) => { await Promise.allSettled(node.getAnimations({ subtree: true }).map(a => a.finished)) })
    await page.screenshot({ path: join(screenshots, `library-picker-current-${scene.theme}-${scene.width}.png`) })
    recovery.resolve(undefined); waiting = undefined
    await alert.waitFor({ state: 'detached' })
    expect(await dialog.evaluate((node, original) => node === original, dialogNode)).toBe(true)
    expect(await row.evaluate((node, original) => node === original, rowNode)).toBe(true)
    expect(await search.evaluate((node, original) => node === original && node === document.activeElement
      && node instanceof HTMLInputElement && node.selectionStart === 2 && node.selectionEnd === 5, searchNode)).toBe(true)
    expect(await scroller.evaluate(node => node.scrollTop)).toBe(scroll)
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  }
  const sourceQueries = [
    { source: 'Recent', query: 'Reference', start: 0, end: 4, direction: 'backward' },
    { source: 'My files', query: 'Reference v2', start: 1, end: 6, direction: 'forward' },
    { source: 'Shared spaces', query: 'Reference v', start: 2, end: 5, direction: 'backward' },
  ] as const
  for (const item of sourceQueries) {
    await dialog.getByRole('tab', { name: item.source, exact: true }).click()
    await search.focus(); await search.fill(item.query)
    await expect.poll(() => table.getAttribute('aria-busy')).toBe('false')
    await search.evaluate((node, item) => {
      if (node instanceof HTMLInputElement) node.setSelectionRange(item.start, item.end, item.direction)
    }, item)
  }
  for (const scene of [{ width: 1440, theme: 'light' }, { width: 390, theme: 'dark' }] as const) {
    await page.emulateMedia({ colorScheme: scene.theme }); await page.setViewportSize({ width: scene.width, height: 900 })
    for (const item of sourceQueries) {
      const tab = dialog.getByRole('tab', { name: item.source, exact: true })
      await tab.click()
      await expect.poll(() => table.getAttribute('aria-busy')).toBe('false')
      expect(await tab.evaluate(node => node === document.activeElement)).toBe(true)
      await search.focus()
      expect(await search.evaluate((node, original) => node === original && node === document.activeElement, searchNode)).toBe(true)
      expect(await search.evaluate(node => node instanceof HTMLInputElement
        && [node.value, node.selectionStart, node.selectionEnd, node.selectionDirection]))
        .toEqual([item.query, item.start, item.end, item.direction])
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    }
    await page.screenshot({ path: join(screenshots, `library-picker-search-range-${scene.theme}-${scene.width}.png`) })
  }
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
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
  const archiveName = `验收-${'A'.repeat(160)}.txt`
  const now = '2026-11-13T01:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: 'Archive library',
    scope: 'PERSONAL', ownerId: 'fixture-employee', companyId: 'company', role: 'OWNER', canManage: true,
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
        return [{ selectionId: '22222222-2222-4222-8222-222222222222', name: archiveName, kind: 'FILE' as const, sizeBytes: 12 }]
      }
      case 'library.files.upload':
        writes.push(payload)
        if (++saves === 1) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Archive unavailable', true)) }
        await saveGate.promise
        return true
      case 'library.personal.ensure': return library
      case 'library.get': return typeof payload === 'object' && payload !== null && 'libraryId' in payload
        && payload.libraryId === alternate.id ? alternate : library
      case 'library.entries.list': return { data: [{ id: '33333333-3333-4333-8333-333333333333',
        libraryId: library.id, parentId: null, name: 'Archive folder', kind: 'FOLDER',
        sha256: null, mediaType: null, sizeBytes: 0,
        version: 1, createdAt: now, updatedAt: now }], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
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
  const save = dialog.getByRole('button', { name: 'Save', exact: true })
  expect(await save.getAttribute('aria-busy')).toBe('false')
  await page.keyboard.press('Escape')
  expect(await dialog.count()).toBe(0)
  expect(await trigger.evaluate((node, previous) => node === previous && node === document.activeElement, original)).toBe(true)
  await trigger.press('Enter')
  await expect.poll(() => selections).toBe(2)
  const preparationBounds = await dialog.boundingBox()
  const cancelBounds = await dialog.getByRole('button', { name: 'Cancel', exact: true }).boundingBox()
  const saveNode = await save.elementHandle(), preparationSaveBounds = await save.boundingBox()
  const preparationSaveStyle = await save.evaluate(node => [getComputedStyle(node).opacity, getComputedStyle(node).backgroundColor])
  expect(await save.getAttribute('aria-busy')).toBe('false')
  failureGate.resolve(undefined)
  const retry = dialog.getByRole('button', { name: 'Retry', exact: true })
  await retry.waitFor()
  expect(await dialog.boundingBox()).toEqual(preparationBounds)
  expect(await dialog.getByRole('button', { name: 'Cancel', exact: true }).boundingBox()).toEqual(cancelBounds)
  const alert = await dialog.getByRole('alert').elementHandle(), retryNode = await retry.elementHandle()
  await retry.focus(); await retry.press('Enter'); await retry.press(' ')
  await expect.poll(() => selections).toBe(3)
  expect(await retry.getAttribute('aria-busy')).toBe('true')
  expect(await save.getAttribute('aria-busy')).toBe('false')
  expect(await save.getAttribute('aria-disabled')).toBe('true')
  expect(await save.evaluate((node, previous) => node === previous, saveNode)).toBe(true)
  expect(await save.boundingBox()).toEqual(preparationSaveBounds)
  expect(await save.evaluate(node => [getComputedStyle(node).opacity, getComputedStyle(node).backgroundColor]))
    .toEqual(preparationSaveStyle)
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
      expect(await retry.getAttribute('aria-busy')).toBe('true')
      expect(await save.getAttribute('aria-busy')).toBe('false')
      expect(await retry.evaluate((node, previous) => node === previous && node === document.activeElement, retryNode)).toBe(true)
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
  await expect.poll(() => save.getAttribute('aria-disabled')).toBe('false')
  expect(await save.getAttribute('aria-busy')).toBe('false')
  expect(await save.evaluate((node, previous) => node === previous, saveNode)).toBe(true)
  const bounds = await dialog.boundingBox(), saveBounds = await save.boundingBox(), searchBounds = await search.boundingBox()
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
      expect(await dialog.getByText(archiveName, { exact: true }).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-archive-save-error-${theme}-${width}.png`) })
    }
  }
  await dialog.getByRole('button', { name: 'Libraries', exact: true }).click()
  await dialog.getByRole('button', { name: alternate.name, exact: true }).click()
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
      const folder = dialog.getByRole('button', { name: 'Archive folder Folder', exact: true })
      await folder.scrollIntoViewIfNeeded()
      expect(await controlIsUnclipped(folder)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-archive-destination-${theme}-${width}.png`) })
    }
  }
  await page.setViewportSize({ width: 390, height: 900 })
  await dialog.getByRole('button', { name: 'Libraries', exact: true }).click()
  await dialog.getByRole('button', { name: library.name, exact: true }).click()
  await expect.poll(() => save.getAttribute('aria-disabled')).toBe('false')
  const saveError = await dialog.getByRole('alert').elementHandle()
  await save.press('Enter'); await save.press(' ')
  await expect.poll(() => saves).toBe(2)
  expect(await save.getAttribute('aria-busy')).toBe('true')
  expect(writes[1]).toEqual(writes[0])
  expect(await search.getAttribute('readonly')).toBe('')
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
  const library = { id: '11111111-1111-4111-8111-111111111111', name: 'Move library',
    scope: 'TEAM', ownerId: 'fixture-employee', companyId: 'company', role: 'OWNER', canManage: true,
    version: 1, createdAt: now, updatedAt: now }
  const file = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id, parentId: null,
    name: 'Move me.md', kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12,
    version: 1, createdAt: now, updatedAt: now }
  const folder = { ...file, id: '33333333-3333-4333-8333-333333333333', name: 'Destination', kind: 'FOLDER',
    sha256: null, mediaType: null, sizeBytes: 0 }
  const children = Array.from({ length: 21 }, (_, index) => ({ ...folder,
    id: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`, parentId: folder.id, name: `Destination child ${index}` }))
  let writes = 0, reads = 0, catalogReads = 0, moved = false, failRead = false, holdFiles = false, revokeManagement = false
  const gate = Promise.withResolvers<undefined>()
  const olderFiles = Promise.withResolvers<undefined>()
  onTestFinished(() => { gate.resolve(undefined); olderFiles.resolve(undefined) })
  await page.exposeFunction('__libraryMoveInvoke', async (method: string, payload?: {
    parentId?: string | null
    view?: string
    query?: string
    page?: number
    entryId?: string
    version?: number
    size?: number
  }) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'fixture-employee' }
    if (method === 'library.files.list') {
      reads++
      if (failRead) { failRead = false; return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Directory unavailable', true)) } }
      if (holdFiles) await olderFiles.promise
      return { data: [{ entry: { ...file, parentId: moved ? folder.id : null, version: moved ? 2 : 1 },
        libraryName: library.name, canManage: true, lastAccessedAt: now, sourceKind: 'UPLOAD', sourceSessionId: null }],
      pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    }
    if (method === 'library.list') {
      catalogReads++
      return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    }
    if (method === 'library.get') return revokeManagement
      ? { ...library, name: 'Read-only project library', role: 'VIEWER', canManage: false, version: 2 } : library
    if (method === 'library.entries.list') {
      reads++
      if (failRead && payload?.size === 20) {
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
  const fileRow = page.getByRole('button', { name: 'Move me.md Move library', exact: true })
  await fileRow.waitFor()
  const move = async () => {
    await page.getByRole('button', { name: 'More actions · Move me.md', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Move', exact: true }).click()
  }
  await move()
  const dialog = page.getByRole('dialog', { name: 'Move', exact: true })
  const save = dialog.getByRole('button', { name: 'Save', exact: true })
  expect(await save.getAttribute('aria-disabled')).toBe('true')
  await save.press('Enter')
  expect(writes).toBe(0)
  await dialog.getByRole('button', { name: 'Destination Folder', exact: true }).click()
  const search = dialog.getByRole('searchbox')
  await search.fill('Destination child')
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
    dialog.getByRole('button', { name: 'Next', exact: true })]) {
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
  await expect.poll(() => page.getByRole('alert').count()).toBe(0)
  await fileRow.waitFor()
  expect(writes).toBe(2)
  expect(await page.getByRole('searchbox').evaluate(node => node === document.activeElement)).toBe(true)
  await move()
  await dialog.getByRole('button', { name: 'Destination Folder', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  expect(await page.getByRole('button', { name: 'More actions · Move me.md', exact: true })
    .evaluate(node => node === document.activeElement)).toBe(true)
  expect(writes).toBe(2)
  await page.setViewportSize({ width: 600, height: 900 })
  const homeSearch = page.getByRole('searchbox', { name: 'Search names', exact: true })
  const homeSearchNode = await homeSearch.elementHandle(), fileNode = await fileRow.elementHandle()
  const nav = page.getByRole('navigation', { name: 'Library navigation', exact: true })
  const libraryRootNode = await nav.getByRole('button', { name: library.name, exact: true }).elementHandle()
  const folderNode = await nav.getByRole('button', { name: folder.name, exact: true }).elementHandle()
  const beforeCatalog = catalogReads
  holdFiles = true
  const beforeRead = reads
  await homeSearch.fill('Move')
  await expect.poll(() => reads).toBe(beforeRead + 1)
  await homeSearch.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
  revokeManagement = true
  await move()
  const readonlyRow = page.getByRole('button', { name: 'Move me.md Read-only project library', exact: true })
  await readonlyRow.waitFor()
  await page.getByText('You cannot manage this library. (LIBRARY_MANAGEMENT_FORBIDDEN)', { exact: true }).waitFor()
  expect(await dialog.count()).toBe(0)
  expect(await page.getByRole('button', { name: 'More actions · Move me.md', exact: true }).count()).toBe(0)
  expect(await readonlyRow.evaluate((node, previous) => node === previous
    && node instanceof HTMLElement && !node.draggable, fileNode)).toBe(true)
  expect(await homeSearch.evaluate((node, previous) => node === previous && node === document.activeElement
    && node instanceof HTMLInputElement && node.value === 'Move' && node.selectionStart === 1 && node.selectionEnd === 3,
  homeSearchNode)).toBe(true)
  olderFiles.resolve(undefined)
  await expect.poll(() => page.locator('div[role="region"][aria-busy]').getAttribute('aria-busy')).toBe('false')
  expect(await readonlyRow.evaluate((node, previous) => node === previous
    && node instanceof HTMLElement && !node.draggable, fileNode)).toBe(true)
  expect(await page.getByRole('button', { name: 'More actions · Move me.md', exact: true }).count()).toBe(0)
  expect(await homeSearch.evaluate((node, previous) => node === previous && node === document.activeElement
    && node instanceof HTMLInputElement && node.selectionStart === 1 && node.selectionEnd === 3, homeSearchNode)).toBe(true)
  const readonlyRoot = nav.getByRole('button', { name: 'Read-only project library', exact: true })
  await readonlyRoot.waitFor()
  expect(await readonlyRoot.evaluate((node, previous) => node === previous, libraryRootNode)).toBe(true)
  expect(await nav.getByRole('button', { name: folder.name, exact: true }).evaluate((node, previous) =>
    node === previous && node instanceof HTMLButtonElement && !node.draggable, folderNode)).toBe(true)
  expect(await nav.getByRole('button', { name: `New: ${library.name}`, exact: true }).count()).toBe(0)
  expect(await nav.getByRole('button', { name: 'New: Read-only project library', exact: true }).count()).toBe(0)
  expect(await nav.getByRole('button', { name: `New: ${folder.name}`, exact: true }).count()).toBe(0)
  expect(await nav.getByRole('button', { name: `More actions · ${folder.name}`, exact: true }).count()).toBe(0)
  expect(catalogReads).toBe(beforeCatalog)
  expect(reads).toBe(beforeRead + 1)
  for (const scene of [{ theme: 'dark', width: 600 }, { theme: 'light', width: 1440 }] as const) {
    await page.emulateMedia({ colorScheme: scene.theme })
    await page.setViewportSize({ width: scene.width, height: 900 })
    expect(await page.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.screenshot({ path: join(screenshots, `library-move-permission-${scene.theme}-${scene.width}.png`) })
  }
  expect(writes).toBe(2)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('keeps library navigation and discard confirmation stable', async () => {
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
  const library = { id: '11111111-1111-4111-8111-111111111111', name: 'Library fixture',
    scope: 'PERSONAL', ownerId: 'fixture-employee', companyId: 'company', role: 'OWNER', canManage: true,
    version: 1, createdAt: now, updatedAt: now }
  const file = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id, parentId: null,
    name: 'Reference.md', kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12,
    version: 1, createdAt: now, updatedAt: now }
  const renameGate = Promise.withResolvers<undefined>(), deleteGate = Promise.withResolvers<undefined>()
  const downloadGate = Promise.withResolvers<undefined>()
  const creationGates = {
    'library.folders.create': Promise.withResolvers<undefined>(),
  }
  const creationRequests = new Map<string, unknown[]>()
  const previewText = Array.from({ length: 80 }, (_, index) => `Reference paragraph ${index}.`).join('\n\n')
  onTestFinished(() => {
    renameGate.resolve(undefined); deleteGate.resolve(undefined); downloadGate.resolve(undefined)
    for (const pending of Object.values(creationGates)) pending.resolve(undefined)
  })
  let reads = 0, renames = 0, renamed = false, deletes = 0, deleted = false
  let downloads = 0, previewReads = 0
  await page.exposeFunction('__libraryStabilityInvoke', async (method: string, payload?: unknown) => {
    switch (method) {
      case 'auth.getSession': return { authenticated: true, employeeId: 'fixture-employee' }
      case 'library.files.list':
        reads++
        return { data: deleted ? [] : [{ entry: { ...file, name: renamed ? 'Retained reference.md' : file.name,
          version: renamed ? 2 : 1 }, libraryName: library.name, canManage: true,
        lastAccessedAt: now, sourceKind: 'UPLOAD', sourceSessionId: null }],
        pageIndex: 1, pageSize: 20, totalCount: deleted ? 0 : 1, totalPages: deleted ? 0 : 1 }
      case 'library.list': return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
      case 'library.get':
      case 'library.personal.ensure': return library
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
      case 'library.entries.list': return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
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
  const row = page.getByRole('button', { name: 'Reference.md Library fixture', exact: true })
  await row.waitFor()
  const original = await row.elementHandle()
  const search = page.getByRole('searchbox', { name: 'Search names' })
  const originalSearch = await search.elementHandle()
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
  expect(await search.evaluate((node, previous) => node === previous, originalSearch)).toBe(true)
  const actions = page.getByRole('button', { name: 'More actions · Reference.md', exact: true })
  await actions.click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
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
  const waitStatus = dialog.getByRole('region', { name: 'Wait for the current operation to finish.', exact: true })
  expect(await controlIsUnclipped(waitStatus)).toBe(true)
  await waitStatus.focus(); await waitStatus.press('End')
  expect(await waitStatus.evaluate(node => node === document.activeElement)).toBe(true)
  await page.screenshot({ path: join(screenshots, 'library-rename-wait-dark-390.png') })
  renameGate.resolve(undefined)
  await dialog.waitFor({ state: 'detached' })
  const renamedRow = page.getByRole('button', { name: 'Retained reference.md Library fixture', exact: true })
  await renamedRow.waitFor()
  expect(await renamedRow.evaluate((node, previous) => node === previous, original)).toBe(true)
  await page.getByRole('button', { name: 'More actions · Retained reference.md', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
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
  for (const [title, method] of [['New folder', 'library.folders.create']] as const) {
    const opener = page.getByRole('button', { name: 'New: My files', exact: true })
    await opener.click()
    await page.getByRole('menuitem', { name: title, exact: true }).click()
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
        return [{ ...descriptor, version: reads > 1 ? '1.0.1' : '1.0.0',
          authorizationStatus: reads > 1 ? 'REQUIRED' : 'AUTHORIZED' }]
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
  const library = { id: '11111111-1111-4111-8111-111111111111', name: '项目资料', scope: 'PERSONAL',
    ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: timestamp, updatedAt: timestamp }
  const file = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id, parentId: null, name: '中文资料.md', kind: 'FILE',
    sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12, version: 1, createdAt: timestamp, updatedAt: timestamp }
  let reads = 0, mode: 'ready' | 'failed' | 'pending' = 'ready'
  let pending: ReturnType<typeof Promise.withResolvers<undefined>> | undefined
  onTestFinished(() => pending?.resolve(undefined))
  const readMethod = source === 'files' ? 'library.entries.list' : 'library.list'
  await page.exposeFunction('__libraryFeedbackInvoke', async (method: string) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee' }
    if (method === 'connectors.list') return []
    if (method === 'library.get') return library
    if (method === 'library.files.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
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
  await page.getByRole('button', { name: 'Add files or run commands', exact: true }).click()
  await page.getByRole('option', { name: /Choose library files/ }).click()
  if (source === 'files') await page.getByRole('button', { name: /项目资料/ }).click()
  const row = page.getByRole('button', { name: source === 'files' ? /中文资料.md/ : /项目资料/ })
  const search = page.getByRole('searchbox', { name: 'Search names', exact: true })
  const directory = page.getByRole('dialog', { name: 'Choose library files', exact: true })
  const rows = directory.locator('[class*=libraryRows]')
  await row.waitFor()
  await search.fill('资料')
  await expect.poll(() => rows.getAttribute('aria-busy')).toBe('false')
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
      await search.scrollIntoViewIfNeeded()
      const before = { row: await row.boundingBox(), search: await search.boundingBox() }
      mode = 'failed'
      await search.fill('资')
      const retry = page.getByRole('button', { name: 'Retry', exact: true })
      await retry.waitFor()
      const region = page.getByRole('region', { name: 'Could not load the library. Retry.', exact: true })
      const alertNode = await page.getByRole('alert').elementHandle(), retryNode = await retry.elementHandle()
      expect({ row: await row.boundingBox(), search: await search.boundingBox() }).toEqual(before)
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
      expect(await search.inputValue()).toBe('资')
      expect(await search.evaluate(input => [
        (input as HTMLInputElement).selectionStart, (input as HTMLInputElement).selectionEnd,
      ])).toEqual([0, 1])
      expect(await section.evaluate(node => node.scrollTop)).toBe(scroll)
      expect({ row: await row.boundingBox(), search: await search.boundingBox() }).toEqual(before)
      await search.fill('资料')
      await expect.poll(() => rows.getAttribute('aria-busy')).toBe('false')
    }
  }
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
}, 120_000)

it('keeps library files, drafts and focus stable through reads, retry and deletion in the real Harness page', async () => {
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
  const library = { id: '11111111-1111-4111-8111-111111111111', name: '项目资料', scope: 'PERSONAL',
    ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: timestamp, updatedAt: timestamp }
  const file = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id, parentId: null, name: '中文资料.md', kind: 'FILE',
    sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12, version: 1, createdAt: timestamp, updatedAt: timestamp }
  let reads = 0, deletes = 0, mode: 'ready' | 'failed' | 'pending' = 'ready'
  let removed = false
  let background: ReturnType<typeof Promise.withResolvers<undefined>> | undefined
  const pending = Promise.withResolvers<undefined>()
  onTestFinished(() => { pending.resolve(undefined); background?.resolve(undefined) })
  await page.exposeFunction('__libraryInvoke', async (method: string) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee' }
    if (method === 'connectors.list') return []
    if (method === 'library.list') return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    if (method === 'library.get' || method === 'library.personal.ensure') return library
    if (method === 'library.files.list') {
      reads++
      if (mode === 'pending') await pending.promise
      await background?.promise
      if (mode === 'failed') throw new Error('Directory unavailable')
      return { data: removed ? [] : [{ entry: file, libraryName: library.name, canManage: true, lastAccessedAt: timestamp, sourceKind: 'UPLOAD', sourceSessionId: null }], pageIndex: 1, pageSize: 20, totalCount: removed ? 0 : 1, totalPages: removed ? 0 : 1 }
    }
    if (method === 'library.entries.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
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
  const fileButton = page.getByRole('button', { name: '中文资料.md 项目资料', exact: true }), search = page.getByRole('searchbox', { name: 'Search names', exact: true })
  await fileButton.waitFor()
  const fileNode = await fileButton.elementHandle(), searchNode = await search.elementHandle()
  const mine = page.getByRole('button', { name: 'My files', exact: true }), mineNode = await mine.elementHandle()
  const mineBox = await mine.boundingBox(), fileBox = await fileButton.boundingBox(), searchBox = await search.boundingBox()
  const nextView = async () => {
    await search.fill(await search.inputValue() === '' ? '资料' : '')
  }
  mode = 'failed'
  await nextView()
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
  expect(await mine.evaluate((node, original) => node === original, mineNode)).toBe(true)
  expect(await mine.boundingBox()).toEqual(mineBox)
  expect(await fileButton.boundingBox()).toEqual(fileBox)
  await retry.press('Enter'); expect(reads).toBe(3)
  expect(await retry.evaluate((node, original) => node === original, retryNode)).toBe(true)
  expect(await page.getByRole('alert').evaluate((node, original) => node === original, alertNode)).toBe(true)
  mode = 'ready'; pending.resolve(undefined)
  await expect.poll(() => page.getByRole('alert').count()).toBe(0)
  expect(await fileButton.boundingBox()).toEqual(fileBox)
  expect(await search.evaluate((node, original) => node === original && node === document.activeElement, searchNode)).toBe(true)
  await page.getByRole('button', { name: 'New: My files', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New folder', exact: true }).click()
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
  await page.getByRole('button', { name: 'More actions · 中文资料.md', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
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
      await nextView()
      await fileButton.waitFor()
      background = Promise.withResolvers<undefined>()
      await nextView()
      await page.getByRole('button', { name: 'More actions · 中文资料.md', exact: true }).click()
      await page.getByRole('menuitem', { name: width === 390 ? 'Rename' : 'Delete', exact: true }).click()
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

it('keeps signed-out product pages behind one global authorization dialog', async () => {
  const en = { library: 'Libraries', connectors: 'Connectors', skills: 'Skills', expertKits: 'Expert kits',
    authTitle: 'Sign in to DeepSeek Harness', signIn: 'Sign in with DingTalk', cancel: 'Cancel',
    employeeSignedOut: 'Not signed in', authRequired: 'Sign in with your organization DingTalk account to access authorized resources.',
    librarySearch: 'Search names', addExtension: 'Add' }
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  await seedSession(scaffold, await readFile(join(REPO_ROOT, 'snapshots/web/present-after-closing-reply/session.v4.jsonl'), 'utf8'), 'full-window-employee-login')
  const browser = await chromium.launch()
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state === 'fail') {
        const directory = join(REPO_ROOT, '.artifacts/employee-login-nov16')
        await mkdir(directory, { recursive: true })
        await page.screenshot({ path: join(directory, 'full-window-login-failure.png') })
      }
    } finally { await browser.close() }
  })
  const page = await newEnglishPage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  let authorization = Promise.withResolvers<undefined>()
  authorization.resolve(undefined)
  onTestFinished(() => { authorization.resolve(undefined) })
  await page.exposeFunction('__employeeAuthorization', async () => {
    try { await authorization.promise }
    catch (error) { return productFailure(error) }
    return undefined
  })
  let signOutGate = Promise.withResolvers<undefined>()
  let signOutCalls = 0
  onTestFinished(() => { signOutGate.resolve(undefined) })
  await page.exposeFunction('__employeeSignOut', async () => {
    signOutCalls++
    try { await signOutGate.promise }
    catch (error) { return productFailure(error) }
    return undefined
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & {
      __employeeAuthorization(): Promise<unknown>
      __employeeSignOut(): Promise<unknown>
    }
    let authenticated = false
    const listeners = new Set<(event: object) => void>()
    const session = () => authenticated ? { authenticated, employeeId: 'fixture-employee', displayName: 'Fixture employee' }
      : { authenticated }
    globalThis.addEventListener('fixture-employee-identity', (event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== 'boolean') return
      authenticated = event.detail
      for (const listener of listeners) listener({ type: 'session.changed', payload: session() })
    })
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string) => {
        if (method === 'auth.getSession') return { ok: true, result: session() }
        if (method === 'auth.ensureDingTalk') {
          const failure = await api.__employeeAuthorization()
          if (failure) return { ok: false, failure }
          authenticated = true
          for (const listener of listeners) listener({ type: 'session.changed', payload: session() })
          return { ok: true, result: session() }
        }
        if (method === 'auth.signOut') {
          const failure = await api.__employeeSignOut()
          if (failure) return { ok: false, failure }
          authenticated = false
          for (const listener of listeners) listener({ type: 'session.changed', payload: session() })
          return { ok: true, result: session() }
        }
        if (!authenticated) throw new Error('Signed-out product content requested private data')
        return { ok: true, result: method === 'connectors.list' ? []
          : { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 } }
      },
      cancel: () => {},
      subscribe: (_namespace: string, listener: (event: object) => void) => {
        listeners.add(listener); return () => { listeners.delete(listener) }
      },
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  const dialog = page.getByRole('dialog', { name: en.authTitle, exact: true })
  await dialog.waitFor()
  expect(await page.getByRole('dialog').count()).toBe(1)
  expect(await page.getByRole('button', { name: en.signIn, exact: true }).count()).toBe(1)
  await dialog.getByRole('button', { name: en.cancel, exact: true }).click()
  for (const name of [en.library, en.connectors, en.skills, en.expertKits]) {
    await page.getByRole('button', { name, exact: true }).click()
    expect(await page.getByText(en.authRequired, { exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: en.signIn, exact: true }).count()).toBe(0)
    expect(await page.getByRole('alert').count()).toBe(0)
    expect(await page.getByRole('dialog').count()).toBe(0)
  }
  await page.getByRole('button', { name: en.employeeSignedOut, exact: true }).click()
  await page.getByRole('menuitem', { name: en.signIn, exact: true }).click()
  await page.getByRole('button', { name: 'Fixture employee', exact: true }).waitFor()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: en.library, exact: true }).click()
  await page.getByRole('searchbox', { name: en.librarySearch, exact: true }).waitFor()
  await page.getByRole('button', { name: en.connectors, exact: true }).click()
  await page.getByRole('button', { name: en.addExtension, exact: true }).waitFor()
  await page.locator('[role="treeitem"]').first().click()
  await page.locator('[role="treeitem"]').nth(1).click()
  const composer = page.locator('[data-composer-input]').first()
  await expect.poll(() => composer.evaluate(node => node === document.activeElement)).toBe(true)
  await composer.fill('Keep this workspace draft and selection')
  const composerNode = await composer.elementHandle()
  await composer.evaluate((node) => {
    const range = document.createRange(), selection = document.getSelection()!
    const text = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()!
    range.setStart(text, 5); range.setEnd(text, 9)
    selection.removeAllRanges(); selection.addRange(range)
  })
  authorization = Promise.withResolvers<undefined>()
  await page.evaluate(() => { globalThis.dispatchEvent(new CustomEvent('fixture-employee-identity', { detail: false })) })
  await dialog.waitFor()
  const originalDialog = await dialog.elementHandle()
  const signIn = dialog.getByRole('button', { name: en.signIn, exact: true })
  const signInNode = await signIn.elementHandle()
  const cancel = dialog.getByRole('button', { name: en.cancel, exact: true })
  await signIn.click()
  await dialog.getByRole('heading', { name: 'Connecting to DingTalk', exact: true }).waitFor()
  const screenshots = join(REPO_ROOT, '.artifacts/employee-login-nov16')
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(() => dialog.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return [rect.x, rect.y, rect.width - innerWidth, rect.height - innerHeight]
      })).toEqual([0, 0, 0, 0])
      await expect.poll(() => dialog.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
      expect(await controlIsUnclipped(cancel)).toBe(true)
      expect(await page.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `full-window-login-${theme}-${width}.png`) })
    }
  }
  authorization.reject(new ProductError('EXTERNAL_SERVICE_ERROR', 'Authorization unavailable', true))
  const notice = dialog.getByRole('alert')
  await notice.waitFor()
  const noticeNode = await notice.elementHandle(), actionsBox = await cancel.boundingBox()
  expect(await signIn.evaluate((node, previous) => node === previous, signInNode)).toBe(true)
  authorization = Promise.withResolvers<undefined>()
  await signIn.click()
  await dialog.getByRole('heading', { name: 'Connecting to DingTalk', exact: true }).waitFor()
  expect(await dialog.evaluate((node, previous) => node === previous, originalDialog)).toBe(true)
  expect(await notice.evaluate((node, previous) => node === previous, noticeNode)).toBe(true)
  expect(await cancel.boundingBox()).toEqual(actionsBox)
  expect(await dialog.getByRole('button', { name: 'Waiting for DingTalk…', exact: true })
    .evaluate((node, previous) => node === previous && node === document.activeElement, signInNode)).toBe(true)
  await page.screenshot({ path: join(screenshots, 'full-window-login-retry-dark-390.png') })
  authorization.resolve(undefined)
  await dialog.waitFor({ state: 'hidden' })
  expect(await composer.evaluate((node, previous) => node === previous
    && node.textContent === 'Keep this workspace draft and selection', composerNode)).toBe(true)
  await expect.poll(() => composer.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('this')
  await page.setViewportSize({ width: 1440, height: 900 })
  const employee = page.getByRole('button', { name: 'Fixture employee', exact: true })
  const employeeNode = await employee.elementHandle()
  await employee.click()
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
  await expect.poll(() => signOutCalls).toBe(1)
  expect(await employee.evaluate((node, previous) => node === previous, employeeNode)).toBe(true)
  expect(await composer.evaluate((node, previous) => node === previous, composerNode)).toBe(true)
  signOutGate.reject(new ProductError('PRODUCT_NETWORK_UNAVAILABLE', 'Offline', true))
  await page.getByRole('alert').filter({ hasText: 'Could not sign out' }).waitFor()
  expect(await dialog.count()).toBe(0)
  expect(await employee.evaluate((node, previous) => node === previous, employeeNode)).toBe(true)
  await employee.click()
  expect(await page.getByRole('menuitem', { name: 'Settings', exact: true }).getAttribute('aria-disabled')).not.toBe('true')
  signOutGate = Promise.withResolvers<undefined>()
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
  await expect.poll(() => signOutCalls).toBe(2)
  signOutGate.resolve(undefined)
  await dialog.waitFor()
  expect(await composer.evaluate((node, previous) => node === previous
    && node.textContent === 'Keep this workspace draft and selection', composerNode)).toBe(true)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('keeps member-confirmed permissions across late directory reads and failed member close', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser), tripwire = watchConsole(page)
  const now = '2026-11-17T01:00:00Z'
  const original = { id: '11111111-1111-4111-8111-111111111111', name: '项目交付共享空间', scope: 'TEAM',
    ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: now, updatedAt: now }
  let library = original
  const latest = { ...original, name: '只读项目共享空间', role: 'VIEWER', canManage: false, version: 2 }
  const newest = { ...latest, name: '再次更新的共享空间', version: 3 }
  const file = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id, parentId: null,
    name: '协作说明.md', kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12,
    version: 1, createdAt: now, updatedAt: now }
  const listing = (data: readonly unknown[]) => ({
    data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: data.length ? 1 : 0,
  })
  const gates: ReturnType<typeof Promise.withResolvers<typeof library>>[] = []
  const recentGates: ReturnType<typeof Promise.withResolvers<unknown>>[] = []
  let nextRecent: Promise<unknown> | undefined, recentVisible = false
  let nextDirectory: typeof gates[number] | undefined, failMetadata = false, failMembers = true, reads = 0
  let nextMember: typeof gates[number] | undefined
  onTestFinished(() => { for (const gate of gates) gate.resolve(latest) })
  onTestFinished(() => { for (const gate of recentGates) gate.resolve(listing([])) })
  await page.exposeFunction('__memberConfirmationInvoke', async (method: string, input?: { parentId?: string | null }) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: library.ownerId }
    if (method === 'library.list') return listing([library])
    if (method === 'library.files.list') {
      const pending = nextRecent; nextRecent = undefined
      return pending ?? listing(recentVisible ? [{ entry: file, libraryName: library.name,
        canManage: library.canManage, lastAccessedAt: now, sourceKind: 'UPLOAD', sourceSessionId: null }] : [])
    }
    if (method === 'library.get') {
      reads++
      const pending = nextDirectory; nextDirectory = undefined
      if (pending) return pending.promise
      const member = nextMember; nextMember = undefined
      if (member) return member.promise
      if (failMetadata) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Metadata unavailable', true)) }
      return library
    }
    if (method === 'library.entries.list') return listing(input?.parentId ? [] : [file])
    if (method === 'library.members.list') {
      if (failMembers) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Members unavailable', true)) }
      return listing([{ subjectType: 'EMPLOYEE', subjectId: library.ownerId, name: 'Owner employee', role: 'OWNER' }])
    }
    throw new Error(`Unexpected member confirmation fixture method: ${method}`)
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __memberConfirmationInvoke(method: string, input?: unknown): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string, input?: unknown) => {
        const result = await api.__memberConfirmationInvoke(method, input)
        return result && typeof result === 'object' && 'fixtureFailure' in result
          ? { ok: false, failure: result.fixtureFailure } : { ok: true, result }
      }, cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await mkdir(screenshots, { recursive: true })
  for (const scene of [{ theme: 'light', width: 1440, lateDirectory: true, newer: false, lateMember: false },
    { theme: 'dark', width: 600, lateDirectory: false, newer: false, lateMember: false },
    { theme: 'dark', width: 600, lateDirectory: true, newer: true, lateMember: false },
    { theme: 'light', width: 1440, lateDirectory: false, newer: false, lateMember: true }] as const) {
    const confirmed = scene.newer ? newest : latest
    library = original; failMetadata = false; failMembers = true; recentVisible = false
    await page.emulateMedia({ colorScheme: scene.theme })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: 'Libraries', exact: true }).click()
    await page.setViewportSize({ width: scene.width, height: 900 })
    if (await page.locator('[data-sidebar-drawer]:not([data-sidebar-collapsed])').count()) {
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    }
    const nav = page.getByRole('navigation', { name: 'Library navigation', exact: true })
    await nav.getByRole('button', { name: original.name, exact: true }).click()
    const files = page.locator('div[role="region"][aria-busy]')
    const row = files.getByRole('button', { name: /^协作说明.md/ })
    await row.waitFor()
    const rowNode = await row.elementHandle()
    const search = page.getByRole('searchbox', { name: 'Search names', exact: true })
    const searchNode = await search.elementHandle()
    const gate = Promise.withResolvers<typeof library>(); gates.push(gate); nextDirectory = gate
    const before = reads
    await search.fill('协作')
    await expect.poll(() => reads).toBe(before + 1)
    library = latest; failMetadata = !scene.lateDirectory && !scene.lateMember
    const memberGate = scene.lateMember ? Promise.withResolvers<typeof library>() : undefined
    if (memberGate) { gates.push(memberGate); nextMember = memberGate }
    const members = page.getByRole('button', { name: 'Members', exact: true })
    const membersNode = await members.elementHandle()
    await members.click()
    const dialog = page.getByRole('dialog', { name: 'Manage members', exact: true })
    if (memberGate) {
      await expect.poll(() => reads).toBe(before + 2)
      gate.resolve(latest)
      await expect.poll(() => files.getAttribute('aria-busy')).toBe('false')
      await expect.poll(() => row.textContent()).toContain(latest.name)
      memberGate.resolve(original)
    }
    await dialog.getByRole('alert').waitFor()
    if (!memberGate) gate.resolve(scene.newer ? newest : scene.lateDirectory ? original : latest)
    library = confirmed
    await expect.poll(() => files.getAttribute('aria-busy')).toBe('false')
    await expect.poll(() => row.textContent()).toContain(confirmed.name)
    if (memberGate) expect(await dialog.getByRole('button', { name: 'Add members', exact: true }).count()).toBe(0)
    const box = await row.boundingBox()
    const close = dialog.getByRole('button', { name: 'Close', exact: true }).last()
    const beforeClose = reads
    if (scene.lateDirectory) await close.click()
    else await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    expect(reads).toBe(beforeClose)
    expect(await page.getByRole('button', { name: 'Upload files', exact: true }).count()).toBe(0)
    expect(await row.evaluate((node, previous) => node === previous && !node.closest('[draggable="true"]'), rowNode)).toBe(true)
    expect(await row.boundingBox()).toEqual(box)
    expect(await search.evaluate((node, previous) => node === previous, searchNode)).toBe(true)
    expect(await search.inputValue()).toBe('协作')
    expect(await members.evaluate((node, previous) => node === previous && node === document.activeElement, membersNode)).toBe(true)
    failMetadata = false
    await members.click()
    await dialog.getByRole('alert').waitFor()
    const errorNode = await dialog.getByRole('alert').elementHandle()
    const retry = dialog.getByRole('button', { name: 'Retry', exact: true })
    const retryGate = Promise.withResolvers<typeof library>(); gates.push(retryGate); nextDirectory = retryGate
    const beforeRetry = reads
    await retry.click(); await retry.dispatchEvent('click')
    await expect.poll(() => reads).toBe(beforeRetry + 1)
    expect(await dialog.getByRole('alert').evaluate((node, previous) => node === previous, errorNode)).toBe(true)
    expect(await retry.evaluate(node => node === document.activeElement)).toBe(true)
    failMembers = false; retryGate.resolve(confirmed)
    await dialog.getByText('Owner employee', { exact: true }).waitFor()
    expect(await dialog.getByRole('alert').count()).toBe(0)
    expect(await dialog.getByRole('searchbox').evaluate(node => node === document.activeElement)).toBe(true)
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    const suffix = scene.newer ? '-newer' : scene.lateMember ? '-late-member' : ''
    await page.screenshot({ path: join(screenshots, `library-member-confirmed-${scene.theme}-${scene.width}${suffix}.png`) })
    await close.click()
    await dialog.waitFor({ state: 'detached' })
    expect(await row.evaluate((node, previous) => node === previous, rowNode)).toBe(true)
    library = original; recentVisible = true
    await nav.getByRole('button', { name: 'Recent', exact: true }).click()
    await expect.poll(() => row.textContent()).toContain(original.name)
    const recentNode = await row.elementHandle()
    const recent = Promise.withResolvers<unknown>(); recentGates.push(recent); nextRecent = recent.promise
    await search.fill('说明')
    await expect.poll(() => nextRecent).toBeUndefined()
    library = confirmed; failMembers = true
    const actions = nav.getByRole('button', { name: `Library actions: ${confirmed.name}`, exact: true })
    await actions.click()
    await page.getByRole('menuitem', { name: 'Manage members', exact: true }).click()
    await dialog.getByRole('alert').waitFor()
    await expect.poll(() => row.textContent()).toContain(confirmed.name)
    recent.resolve(listing([{ entry: file, libraryName: original.name, canManage: true, lastAccessedAt: now,
      sourceKind: 'UPLOAD', sourceSessionId: null }]))
    await expect.poll(() => files.getAttribute('aria-busy')).toBe('false')
    await close.click()
    await dialog.waitFor({ state: 'detached' })
    expect(await row.textContent()).toContain(confirmed.name)
    expect(await row.evaluate((node, previous) => node === previous && !node.closest('[draggable="true"]'), recentNode)).toBe(true)
    expect(await actions.evaluate(node => node === document.activeElement)).toBe(true)
  }
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('retains member search nodes and selection across permission changes and retries', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser), tripwire = watchConsole(page)
  page.setDefaultTimeout(10_000)
  const now = '2026-11-17T01:00:00Z'
  const original = { id: '11111111-1111-4111-8111-111111111111', name: '项目成员共享空间', scope: 'TEAM',
    ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: now, updatedAt: now }
  let library = original, failMembers = false, metadataReads = 0
  const listing = (data: readonly unknown[]) => ({
    data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: data.length ? 1 : 0,
  })
  const members = [{ subjectType: 'EMPLOYEE', subjectId: 'employee', name: 'Alice', role: 'OWNER' },
    { subjectType: 'EMPLOYEE', subjectId: 'bob', name: 'Bob', role: 'VIEWER' }]
  const reads: { method: string; query: string | undefined }[] = []
  const gates: ReturnType<typeof Promise.withResolvers<typeof library>>[] = []
  let nextMetadata: typeof gates[number] | undefined
  onTestFinished(() => { for (const gate of gates) gate.resolve(library) })
  await page.exposeFunction('__memberSearchInvoke', async (method: string, input?: { query?: string }) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee' }
    if (method === 'library.list') return listing([library])
    if (method === 'library.files.list' || method === 'library.entries.list') return listing([])
    if (method === 'library.get') {
      metadataReads++
      const gate = nextMetadata; nextMetadata = undefined
      return gate ? gate.promise : library
    }
    reads.push({ method, query: input?.query })
    if (method === 'library.members.list') {
      if (failMembers) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Members unavailable', true)) }
      return listing(input?.query ? members.filter(member => member.name.includes(input.query ?? '')) : members)
    }
    if (method === 'library.memberOptions.employees') return listing([{ id: 'bob', name: 'Bob' }])
    throw new Error(`Unexpected member search fixture method: ${method}`)
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __memberSearchInvoke(method: string, input?: unknown): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string, input?: unknown) => {
        const result = await api.__memberSearchInvoke(method, input)
        return result && typeof result === 'object' && 'fixtureFailure' in result
          ? { ok: false, failure: result.fixtureFailure } : { ok: true, result }
      }, cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await mkdir(screenshots, { recursive: true })
  for (const scene of [{ role: 'OWNER', fail: false, theme: 'light', width: 1440 },
    { role: 'OWNER', fail: true, theme: 'dark', width: 600 },
    { role: 'VIEWER', fail: false, theme: 'dark', width: 600 },
    { role: 'VIEWER', fail: true, theme: 'light', width: 1440 }] as const) {
    library = { ...original, role: scene.role, canManage: scene.role === 'OWNER' }; failMembers = false
    await page.emulateMedia({ colorScheme: scene.theme })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: 'Libraries', exact: true }).click()
    await page.setViewportSize({ width: scene.width, height: 900 })
    if (await page.locator('[data-sidebar-drawer]:not([data-sidebar-collapsed])').count()) {
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    }
    await page.getByRole('navigation', { name: 'Library navigation', exact: true }).getByRole('button', { name: library.name, exact: true }).click()
    await expect.poll(() => page.locator('div[role="region"][aria-busy]').getAttribute('aria-busy')).toBe('false')
    const trigger = page.getByRole('button', { name: 'Members', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Manage members', exact: true })
    const search = dialog.getByRole('searchbox', { name: 'Search members', exact: true })
    await dialog.getByText('Alice', { exact: true }).waitFor()
    if (scene.role === 'OWNER') await expect.poll(() => dialog.getByRole('button', { name: 'Bob', exact: true }).getAttribute('aria-disabled')).toBe('false')
    const searchNode = await search.elementHandle(), dialogNode = await dialog.elementHandle()
    const gate = Promise.withResolvers<typeof library>(); gates.push(gate); nextMetadata = gate
    const before = metadataReads
    await search.fill('Bob')
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(0, 2) })
    await expect.poll(() => metadataReads).toBe(before + 1)
    library = { ...library, role: scene.role === 'OWNER' ? 'VIEWER' : 'OWNER', canManage: scene.role !== 'OWNER', version: 2 }
    failMembers = scene.fail; gate.resolve(library)
    if (scene.fail) await dialog.getByRole('alert').waitFor()
    else if (library.role === 'OWNER') await expect.poll(() => dialog.getByRole('group', { name: 'Choose a member', exact: true }).getAttribute('aria-busy')).toBe('false')
    else await expect.poll(() => dialog.getByText('Alice', { exact: true }).count()).toBe(0)
    expect(await search.evaluate((node, previous) => node === previous && node === document.activeElement, searchNode)).toBe(true)
    expect(await search.inputValue()).toBe('Bob')
    expect(await search.evaluate(node => node instanceof HTMLInputElement
      ? [node.selectionStart, node.selectionEnd] : null)).toEqual([0, 2])
    expect(await dialog.evaluate((node, previous) => node === previous, dialogNode)).toBe(true)
    if (scene.fail) {
      const retry = dialog.getByRole('button', { name: 'Retry', exact: true })
      const retryNode = await retry.elementHandle(), errorNode = await dialog.getByRole('alert').elementHandle()
      const retryGate = Promise.withResolvers<typeof library>(); gates.push(retryGate); nextMetadata = retryGate
      const retryBefore = metadataReads
      await retry.click(); await retry.dispatchEvent('click')
      await expect.poll(() => metadataReads).toBe(retryBefore + 1)
      const bounds = await search.boundingBox()
      const scrollPositions = () => dialog.locator('div').evaluateAll(nodes => nodes
        .filter(node => getComputedStyle(node).overflowY === 'auto').map(node => node.scrollTop))
      const scroll = await scrollPositions()
      expect(await dialog.getByRole('alert').evaluate((node, previous) => node === previous, errorNode)).toBe(true)
      expect(await retry.evaluate((node, previous) => node === previous && node === document.activeElement, retryNode)).toBe(true)
      retryGate.resolve(library)
      await expect.poll(() => retry.getAttribute('aria-disabled')).toBe('false')
      expect(await search.boundingBox()).toEqual(bounds)
      expect(await scrollPositions()).toEqual(scroll)
      failMembers = false; await retry.click()
      await dialog.getByRole('alert').waitFor({ state: 'detached' })
      expect(await search.evaluate(node => node === document.activeElement)).toBe(true)
      expect(await search.evaluate(node => node instanceof HTMLInputElement
        ? [node.selectionStart, node.selectionEnd] : null)).toEqual([0, 2])
    }
    await expect.poll(() => reads.filter(read => read.method === 'library.members.list').at(-1)?.query).toBe(library.role === 'OWNER' ? '' : 'Bob')
    if (library.role === 'OWNER') {
      await expect.poll(() => dialog.getByRole('button', { name: 'Bob', exact: true }).getAttribute('aria-disabled')).toBe('false')
      expect(reads.filter(read => read.method === 'library.memberOptions.employees').at(-1)?.query).toBe('Bob')
      expect(await dialog.getByText('Alice', { exact: true }).count()).toBe(1)
    }
    expect(await search.inputValue()).toBe('Bob')
    expect(await search.evaluate((node, previous) => node === previous, searchNode)).toBe(true)
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await dialog.evaluate(async (node) => {
      await Promise.all(node.getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished))
    })
    await page.screenshot({ path: join(screenshots, `library-member-search-${scene.role}-${scene.fail ? 'retry' : 'success'}-${scene.theme}-${scene.width}.png`) })
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
    await dialog.waitFor({ state: 'detached' })
    expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true)
  }
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('retains confirmed root search rows when navigating to the same library through failure and retry', async () => {
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
  const now = '2026-11-17T01:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: '项目交付共享空间', scope: 'TEAM',
    ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: now, updatedAt: now }
  let file = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id, parentId: null,
    name: '产品方案.md', kind: 'FILE',
    sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12, version: 1, createdAt: now, updatedAt: now }
  const listing = (data: readonly unknown[]) => ({
    data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: data.length ? 1 : 0,
  })
  const gates: ReturnType<typeof Promise.withResolvers<undefined>>[] = []
  let metadata: Promise<undefined> | undefined, failMetadata = false, failList = false, metadataReads = 0
  const previewText = 'Read-only library reference'
  onTestFinished(() => { for (const gate of gates) gate.resolve(undefined) })
  await page.exposeFunction('__libraryRootSearchInvoke', async (method: string, input?: { size?: number; parentId?: string | null }) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: library.ownerId }
    if (method === 'library.list') return listing([library])
    if (method === 'library.files.list') return listing([])
    if (method === 'library.get') {
      metadataReads++; await metadata
      if (failMetadata) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Metadata unavailable', true)) }
      return library
    }
    if (method === 'library.entries.list') {
      if (input?.size === 20 && failList) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Directory unavailable', true)) }
      return listing(input?.parentId ? [] : [file])
    }
    if (method === 'library.files.preview.open') return { transferId: 'root-search-preview', mediaType: 'text/markdown',
      byteLength: Buffer.byteLength(previewText), maxBytes: 1024, chunkSize: 1024 }
    if (method === 'library.files.preview.read') return { data: [...new TextEncoder().encode(previewText)], offset: 0, eof: true }
    if (method === 'library.files.preview.close') return { closed: true }
    if (method === 'library.entries.access') return true
    throw new Error(`Unexpected root search fixture method: ${method}`)
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __libraryRootSearchInvoke(method: string, input?: unknown): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string, input?: unknown) => {
        const result = await api.__libraryRootSearchInvoke(method, input)
        if (method === 'library.files.preview.read' && result && typeof result === 'object' && 'data' in result && Array.isArray(result.data)) {
          return { ok: true, result: { ...result, data: new Uint8Array(result.data) } }
        }
        return result && typeof result === 'object' && 'fixtureFailure' in result
          ? { ok: false, failure: result.fixtureFailure } : { ok: true, result }
      }, cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Libraries', exact: true }).click()
  const nav = page.getByRole('navigation', { name: 'Library navigation', exact: true })
  const root = nav.getByRole('button', { name: library.name, exact: true })
  const search = page.getByRole('searchbox', { name: 'Search names', exact: true })
  const files = page.locator('div[role="region"][aria-busy]')
  await root.click()
  await files.getByRole('button', { name: `${file.name} ${library.name}`, exact: true }).waitFor()
  const searchNode = await search.elementHandle(), rootNode = await root.elementHandle()
  await mkdir(screenshots, { recursive: true })
  for (const scene of [{ theme: 'light', width: 1440, expired: false }, { theme: 'dark', width: 600, expired: true }] as const) {
    await page.emulateMedia({ colorScheme: scene.theme })
    await page.setViewportSize({ width: scene.width, height: 900 })
    if (await page.locator('[data-sidebar-drawer]:not([data-sidebar-collapsed])').count()) {
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    }
    file = { ...file, name: `产品方案-已更新${file.version}.md`, version: file.version + 1 }
    await search.fill('产品')
    const row = files.getByRole('button', { name: `${file.name} ${library.name}`, exact: true })
    await row.waitFor()
    if (scene.expired) {
      await row.click()
      const preview = page.getByRole('dialog', { name: file.name, exact: true })
      await preview.getByText(previewText, { exact: true }).waitFor()
      await preview.getByRole('button', { name: 'Close', exact: true }).last().click()
      await preview.waitFor({ state: 'detached' })
      await expect.poll(() => files.getAttribute('aria-busy')).toBe('false')
    }
    const rowNode = await row.elementHandle(), bounds = await row.boundingBox()
    failList = true
    await search.fill('方案')
    const alert = files.getByRole('alert')
    await alert.waitFor()
    const alertNode = await alert.elementHandle()
    const gate = Promise.withResolvers<undefined>(); gates.push(gate); metadata = gate.promise
    await root.click()
    expect(await search.inputValue()).toBe('')
    expect(await row.evaluate((node, previous) => node === previous, rowNode)).toBe(true)
    expect(await alert.evaluate((node, previous) => node === previous, alertNode)).toBe(true)
    expect(await row.boundingBox()).toEqual(bounds)
    expect(await page.getByRole('status', { name: 'Loading…', exact: true }).count()).toBe(0)
    expect(await root.evaluate((node, previous) => node === previous && node === document.activeElement, rootNode)).toBe(true)
    failMetadata = true; gate.resolve(undefined)
    const retry = files.getByRole('button', { name: 'Retry', exact: true })
    await expect.poll(() => retry.getAttribute('aria-disabled')).toBe('false')
    const recovery = Promise.withResolvers<undefined>(); gates.push(recovery); metadata = recovery.promise
    const before = metadataReads
    await retry.click(); await retry.dispatchEvent('click')
    await expect.poll(() => metadataReads).toBe(before + 1)
    expect(await retry.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await row.evaluate((node, previous) => node === previous, rowNode)).toBe(true)
    expect(await alert.evaluate((node, previous) => node === previous, alertNode)).toBe(true)
    expect(await row.boundingBox()).toEqual(bounds)
    expect(await search.evaluate((node, previous) => node === previous, searchNode)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(screenshots, `library-home-root-search-${scene.theme}-${scene.width}.png`) })
    failMetadata = false; failList = false; recovery.resolve(undefined)
    await alert.waitFor({ state: 'detached' })
    expect(await row.evaluate((node, previous) => node === previous, rowNode)).toBe(true)
    expect(await search.evaluate((node, previous) => node === previous && node === document.activeElement, searchNode)).toBe(true)
    metadata = undefined
  }
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('keeps library navigation aligned and directory loading stable without spinning indicators', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  const now = '2026-11-17T01:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: 'My files',
    scope: 'PERSONAL', ownerId: 'fixture-employee', companyId: 'company', role: 'OWNER', canManage: true,
    version: 1, createdAt: now, updatedAt: now }
  const folder = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id, parentId: null,
    name: '中文合同模板与项目参考资料', kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0,
    version: 1, createdAt: now, updatedAt: now }
  const other = { ...folder, id: '33333333-3333-4333-8333-333333333333', name: '项目文档' }
  const listing = (data: readonly unknown[]) => ({
    data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: data.length ? 1 : 0,
  })
  const first = Promise.withResolvers<unknown>(), second = Promise.withResolvers<unknown>(), refreshed = Promise.withResolvers<unknown>()
  let firstRead = first.promise
  let childReads = 0
  onTestFinished(() => { first.resolve(listing([])); second.resolve(listing([])); refreshed.resolve(listing([])) })
  await page.exposeFunction('__libraryNavigationInvoke', async (method: string, input?: { parentId?: string | null; entryId?: string }) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'fixture-employee' }
    if (method === 'library.list') return listing([library])
    if (method === 'library.get' || method === 'library.personal.ensure') return library
    if (method === 'library.files.list') return listing([])
    if (method === 'library.entries.get') return input?.entryId === folder.id ? folder : other
    if (method === 'library.entries.list') {
      if (input?.parentId === folder.id) { childReads++; return firstRead }
      if (input?.parentId === other.id) return second.promise
      return listing([folder, other])
    }
    throw new Error(`Unexpected navigation fixture method: ${method}`)
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __libraryNavigationInvoke(method: string, payload?: unknown): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string, payload?: unknown) => ({
        ok: true, result: await api.__libraryNavigationInvoke(method, payload),
      }),
      cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Libraries', exact: true }).click()
  const nav = page.getByRole('navigation', { name: 'Library navigation', exact: true })
  const firstFolder = nav.getByRole('button', { name: folder.name, exact: true })
  const secondFolder = nav.getByRole('button', { name: other.name, exact: true })
  await firstFolder.waitFor()
  const folderNode = await firstFolder.elementHandle()
  const search = page.getByRole('searchbox', { name: 'Search names', exact: true })
  const searchNode = await search.elementHandle()
  const secondBounds = await secondFolder.boundingBox()
  await firstFolder.click()
  const pending = page.getByRole('status', { name: 'Loading…', exact: true })
  await pending.waitFor()
  expect(await pending.locator('svg').count()).toBe(0)
  expect(await nav.locator('[data-files-row="loading"]').count()).toBe(0)
  expect(await secondFolder.boundingBox()).toEqual(secondBounds)
  expect(await firstFolder.evaluate((node, previous) => node === previous && node === document.activeElement, folderNode)).toBe(true)
  await expect.poll(() => childReads).toBe(2)
  first.resolve(listing([]))
  await page.getByText('No files yet', { exact: true }).waitFor()
  expect(await firstFolder.getAttribute('aria-busy')).not.toBe('true')
  expect(await secondFolder.boundingBox()).toEqual(secondBounds)
  await secondFolder.click()
  await pending.waitFor()
  firstRead = refreshed.promise
  await firstFolder.click()
  expect(await pending.count()).toBe(0)
  expect(await page.getByRole('heading', { name: folder.name, exact: true }).count()).toBe(1)
  expect(await search.evaluate((node, previous) => node === previous, searchNode)).toBe(true)
  second.resolve(listing([{ ...other, id: '44444444-4444-4444-8444-444444444444', parentId: other.id, name: '过期目录' }]))
  refreshed.resolve(listing([]))
  await page.getByText('No files yet', { exact: true }).waitFor()
  expect(await page.getByRole('heading', { name: other.name, exact: true }).count()).toBe(0)
  expect(await page.locator('div[role="region"][aria-busy]').getByRole('button', { name: /^过期目录/ }).count()).toBe(0)
  const sectionMetrics = await nav.evaluate((node) => {
    const personal = Array.from(node.querySelectorAll('button')).find(button => button.textContent === 'My files')!
    const team = Array.from(node.querySelectorAll('h2')).find(heading => heading.textContent === 'Shared spaces')!
    const a = getComputedStyle(personal), b = getComputedStyle(team)
    return { left: personal.getBoundingClientRect().left + Number.parseFloat(a.paddingLeft),
      right: team.getBoundingClientRect().left + Number.parseFloat(b.paddingLeft),
      personalFont: a.fontSize, teamFont: b.fontSize, personalWeight: a.fontWeight, teamWeight: b.fontWeight }
  })
  expect(Math.abs(sectionMetrics.left - sectionMetrics.right)).toBeLessThan(1)
  expect(sectionMetrics.personalFont).toBe(sectionMetrics.teamFont)
  expect(sectionMetrics.personalWeight).toBe(sectionMetrics.teamWeight)
  const iconStarts = await nav.locator('button').evaluateAll(buttons => buttons.filter(button => ['New', 'Recent', '中文合同模板与项目参考资料'].includes(button.textContent ?? ''))
    .map(button => button.querySelector('svg')!.getBoundingClientRect().left))
  expect(iconStarts).toHaveLength(3)
  expect(Math.abs(iconStarts[0]! - iconStarts[1]!)).toBeLessThan(1)
  expect(iconStarts[2]! - iconStarts[0]!).toBe(18)
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 1080, 1000, 600]) {
      await page.setViewportSize({ width, height: 900 })
      await firstFolder.scrollIntoViewIfNeeded()
      expect(await controlIsUnclipped(firstFolder)).toBe(true)
      expect(await search.evaluate((node, previous) => node === previous, searchNode)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-navigation-${theme}-${width}.png`) })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await nav.getByRole('button', { name: 'Recent', exact: true }).click()
  const upload = page.getByRole('button', { name: 'Upload files', exact: true })
  await upload.click()
  const picker = page.getByRole('dialog', { name: 'Choose upload destination', exact: true })
  const pickerFolder = picker.getByRole('button', { name: new RegExp(`^${folder.name}`) })
  await pickerFolder.waitFor()
  const pickerSearch = picker.getByRole('searchbox'), pickerSearchNode = await pickerSearch.elementHandle()
  const pickerGate = Promise.withResolvers<unknown>()
  onTestFinished(() => { pickerGate.resolve(listing([])) })
  firstRead = pickerGate.promise
  await pickerFolder.click()
  const pickerLoading = picker.getByRole('status', { name: 'Loading…', exact: true })
  await pickerLoading.waitFor()
  const cancel = picker.getByRole('button', { name: 'Cancel', exact: true }), cancelBounds = await cancel.boundingBox()
  expect(await pickerLoading.locator('svg').count()).toBe(0)
  expect(await pickerSearch.evaluate((node, previous) => node === previous, pickerSearchNode)).toBe(true)
  await page.screenshot({ path: join(screenshots, 'library-picker-loading-dark.png') })
  pickerGate.resolve(listing([]))
  await pickerLoading.waitFor({ state: 'hidden' })
  expect(await cancel.boundingBox()).toEqual(cancelBounds)
  await cancel.click()
  await picker.waitFor({ state: 'hidden' })
  expect(await upload.evaluate(node => node === document.activeElement)).toBe(true)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('creates files and folders at their add trigger and moves files between authorized directories by dragging', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser), tripwire = watchConsole(page)
  const now = '2026-11-17T02:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: '个人验收资料', scope: 'PERSONAL',
    ownerId: 'fixture-employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: now, updatedAt: now }
  const readonly = { ...library, id: '22222222-2222-4222-8222-222222222222', name: '只读团队', scope: 'TEAM',
    role: 'VIEWER', canManage: false }
  const folder: LibraryEntry = { id: '33333333-3333-4333-8333-333333333333', libraryId: library.id, parentId: null,
    name: '项目合同', kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0, version: 1, createdAt: now, updatedAt: now }
  const file: LibraryEntry = { ...folder, id: '44444444-4444-4444-8444-444444444444', name: '拖拽资料.md', kind: 'FILE',
    sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 24 }
  const sharedFolder = { ...folder, id: '77777777-7777-4777-8777-777777777777', libraryId: readonly.id, name: '共享目录' }
  const sharedFile = { ...file, id: '88888888-8888-4888-8888-888888888888', libraryId: readonly.id, name: '共享资料.md' }
  let stored = [folder, file, sharedFolder, sharedFile], sequence = 0
  const selection = { selectionId: '55555555-5555-4555-8555-555555555555', name: '上传资料.md', kind: 'FILE' as const, sizeBytes: 24 }
  const directorySelections = [
    { selectionId: '99999999-9999-4999-8999-999999999999', name: '整目录上传', kind: 'FOLDER', sizeBytes: 0 },
    { selectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '空目录', kind: 'FOLDER', sizeBytes: 0, folders: ['整目录上传'] },
    { ...selection, folders: ['整目录上传'] },
  ]
  let failEmptyFolder = true
  let staleFolderId: string | undefined = undefined
  let failCollapsedTree = false, failRename = false, failConflictRead = false, failRowDrop = false
  const folderRetry = Promise.withResolvers<undefined>()
  const treeRetry = Promise.withResolvers<undefined>(), conflictRetry = Promise.withResolvers<undefined>()
  onTestFinished(() => { folderRetry.resolve(undefined); treeRetry.resolve(undefined); conflictRetry.resolve(undefined) })
  type Command = {
    libraryId?: string
    parentId?: string | null
    entryId?: string
    name?: string
    version?: number
    mode?: string
    size?: number
  }
  const writes: Array<{ method: string; input: Command }> = []
  const listing = (data: readonly unknown[]) => ({
    data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: data.length ? 1 : 0,
  })
  await page.exposeFunction('__libraryDirectoryInvoke', async (method: string, input: Command = {}) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'fixture-employee' }
    if (method === 'library.list') return listing([library, readonly])
    if (method === 'library.personal.ensure' || method === 'library.get') return input.libraryId === readonly.id ? readonly : library
    if (method === 'library.files.list') return listing([])
    if (method === 'library.entries.get') {
      if (input.entryId === staleFolderId && failConflictRead) {
        failConflictRead = false
        return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Metadata read unavailable', true)) }
      }
      if (input.entryId === staleFolderId) await conflictRetry.promise
      return stored.find(entry => entry.id === input.entryId)
    }
    if (method === 'library.entries.list') {
      if (input.parentId === staleFolderId && input.size === 50) {
        if (failCollapsedTree) {
          failCollapsedTree = false
          return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Tree read unavailable', true)) }
        }
        await treeRetry.promise
      }
      return listing(stored.filter(entry => entry.libraryId === input.libraryId && entry.parentId === (input.parentId ?? null)))
    }
    if (method === 'library.files.upload.select') return input.mode === 'folder' ? directorySelections : [selection]
    if (method === 'library.files.upload.discard') return true
    if (['library.folders.create', 'library.files.upload', 'library.entries.update'].includes(method)) {
      writes.push({ method, input })
      if (method === 'library.folders.create' && input.name === '空目录') {
        if (failEmptyFolder) {
          failEmptyFolder = false
          return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Folder creation unavailable', true)) }
        }
        await folderRetry.promise
      }
      if (method === 'library.entries.update') {
        if (failRowDrop && input.entryId === file.id) {
          failRowDrop = false
          return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Move unavailable', true)) }
        }
        if (failRename && input.entryId === staleFolderId) {
          failRename = false
          stored = stored.map(entry => entry.id === input.entryId ? { ...entry, version: entry.version + 1, name: '其他窗口修改的目录' } : entry)
          return { fixtureFailure: productFailure(new ProductError('LIBRARY_CONFLICT', 'Changed elsewhere', true)) }
        }
        stored = stored.map(entry => entry.id === input.entryId
          ? { ...entry, name: input.name ?? entry.name, parentId: input.parentId ?? null, version: entry.version + 1 } : entry)
        return stored.find(entry => entry.id === input.entryId)
      }
      const entry: LibraryEntry = { ...folder, id: `66666666-6666-4666-8666-${String(++sequence).padStart(12, '0')}`,
        name: input.name ?? selection.name, parentId: input.parentId ?? null,
        ...(method === 'library.files.upload' ? { kind: 'FILE', mediaType: 'text/markdown', sha256: 'b'.repeat(64), sizeBytes: 24 } : {}) }
      stored.push(entry)
      return entry
    }
    throw new Error(`Unexpected directory fixture method: ${method}`)
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __libraryDirectoryInvoke(method: string, input?: unknown): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string, input?: unknown) => {
        const result = await api.__libraryDirectoryInvoke(method, input)
        if (typeof result === 'object' && result !== null && 'fixtureFailure' in result) return { ok: false, failure: result.fixtureFailure }
        return { ok: true, result }
      }, cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Libraries', exact: true }).click()
  const nav = page.getByRole('navigation', { name: 'Library navigation', exact: true })
  const directory = nav.getByRole('button', { name: folder.name, exact: true })
  const root = nav.getByRole('button', { name: 'My files', exact: true })
  const rootAdd = nav.getByRole('button', { name: 'New: My files', exact: true })
  const folderAdd = nav.getByRole('button', { name: `New: ${folder.name}`, exact: true })
  await directory.waitFor()
  expect(await page.getByRole('group', { name: 'Display', exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Grid', exact: true }).count()).toBe(0)
  const newShared = nav.getByRole('button', { name: 'New shared space', exact: true })
  for (const action of ['Close', 'Cancel', 'Escape']) {
    await newShared.click()
    const dialog = page.getByRole('dialog', { name: 'New shared space', exact: true })
    const name = dialog.getByRole('textbox', { name: 'Name', exact: true })
    await name.fill('Unsaved shared space')
    if (action === 'Escape') await name.press('Escape')
    else await dialog.getByRole('button', { name: action, exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    expect(await newShared.evaluate(node => node === document.activeElement)).toBe(true)
    expect(writes).toHaveLength(0)
  }
  await nav.getByRole('heading', { name: 'Shared spaces', exact: true }).waitFor()
  const sharedRoot = nav.getByRole('button', { name: readonly.name, exact: true })
  await sharedRoot.click()
  const sharedDirectory = nav.getByRole('button', { name: sharedFolder.name, exact: true })
  await sharedDirectory.waitFor()
  const sharedIndent = await nav.evaluate((node) => {
    const heading = Array.from(node.querySelectorAll('h2')).find(item => item.textContent === 'Shared spaces')!
    const root = Array.from(node.querySelectorAll('button')).find(item => item.textContent === '只读团队')!
    const folder = Array.from(node.querySelectorAll('button')).find(item => item.textContent === '共享目录')!
    const file = Array.from(node.querySelectorAll('button')).find(item => item.textContent === '共享资料.md')!
    return { heading: heading.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(heading).paddingLeft),
      root: root.querySelector('svg')!.getBoundingClientRect().left,
      folder: folder.querySelector('svg')!.getBoundingClientRect().left,
      file: file.querySelector('svg')!.getBoundingClientRect().left }
  })
  expect(sharedIndent.root - sharedIndent.heading).toBe(18)
  expect(sharedIndent.folder - sharedIndent.root).toBe(18)
  expect(sharedIndent.file).toBe(sharedIndent.folder)
  await root.click()
  const directoryNode = await directory.elementHandle(), directoryBounds = await directory.boundingBox()
  await page.mouse.move(1200, 100)
  expect(await folderAdd.evaluate(node => getComputedStyle(node).opacity)).toBe('0')
  await directory.hover()
  expect(await folderAdd.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
  expect(await directory.boundingBox()).toEqual(directoryBounds)
  await directory.click()
  await page.getByRole('heading', { name: folder.name, exact: true }).waitFor()
  await page.mouse.move(1200, 100)
  expect(await folderAdd.evaluate(node => getComputedStyle(node).opacity)).toBe('0')
  await rootAdd.click()
  await page.getByRole('menuitem', { name: 'Upload files', exact: true }).click()
  const upload = page.getByRole('dialog', { name: 'Upload files', exact: true })
  await upload.getByRole('group', { name: 'Drop files here to upload', exact: true }).waitFor()
  expect(await page.getByRole('dialog', { name: 'Choose upload destination', exact: true }).count()).toBe(0)
  const dropArea = upload.getByRole('group', { name: 'Drop files here to upload', exact: true })
  const dropNode = await dropArea.elementHandle()
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 600]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await controlIsUnclipped(upload.getByRole('button', { name: 'Choose files', exact: true }))).toBe(true)
      expect(await controlIsUnclipped(upload.getByRole('button', { name: 'Choose folder', exact: true }))).toBe(true)
      expect(await dropArea.evaluate((node, previous) => node === previous, dropNode)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-upload-drop-${theme}-${width}.png`) })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await upload.getByRole('button', { name: 'Choose files', exact: true }).click()
  await upload.getByText(`${selection.name} · 1 KB`, { exact: true }).waitFor()
  await upload.getByRole('button', { name: 'Upload files', exact: true }).click()
  await upload.waitFor({ state: 'hidden' })
  expect(writes.at(-1)).toMatchObject({ method: 'library.files.upload', input: { libraryId: library.id, parentId: null } })
  await directory.click()
  await rootAdd.click()
  await page.getByRole('menuitem', { name: 'New folder', exact: true }).click()
  const creation = page.getByRole('dialog', { name: 'New folder', exact: true })
  await creation.getByRole('textbox', { name: 'Name', exact: true }).fill('根目录验收')
  await creation.getByRole('button', { name: 'Save', exact: true }).click()
  await creation.waitFor({ state: 'hidden' })
  expect(writes.at(-1)).toMatchObject({ method: 'library.folders.create', input: { parentId: null, name: '根目录验收' } })
  await folderAdd.focus(); await folderAdd.press('Enter')
  await page.getByRole('menuitem', { name: 'New folder', exact: true }).click()
  await creation.getByRole('textbox', { name: 'Name', exact: true }).fill('子目录验收')
  await creation.getByRole('button', { name: 'Save', exact: true }).click()
  await creation.waitFor({ state: 'hidden' })
  expect(writes.at(-1)).toMatchObject({ method: 'library.folders.create', input: { parentId: folder.id, name: '子目录验收' } })
  await page.getByRole('heading', { name: folder.name, exact: true }).waitFor()
  await page.locator('div[role="region"][aria-busy]').getByRole('button', { name: /^子目录验收/ }).click()
  await page.getByRole('heading', { name: '子目录验收', exact: true }).waitFor()
  const nestedPath = page.getByRole('navigation', { name: 'Folder path', exact: true })
  expect(await nestedPath.getByRole('button').allTextContents()).toEqual(['My files', folder.name, '子目录验收'])
  await nestedPath.getByRole('button', { name: folder.name, exact: true }).click()
  await page.getByRole('heading', { name: folder.name, exact: true }).waitFor()
  await root.click()
  await folderAdd.click()
  await page.getByRole('menuitem', { name: 'Upload files', exact: true }).click()
  await upload.getByRole('button', { name: 'Choose folder', exact: true }).waitFor()
  await upload.getByRole('button', { name: 'Close', exact: true }).last().click()
  await upload.waitFor({ state: 'hidden' })
  expect(await folderAdd.evaluate(node => node === document.activeElement)).toBe(true)
  const source = nav.getByRole('button', { name: file.name, exact: true })
  expect(await source.getAttribute('draggable')).toBe('true')
  const writeCount = writes.length
  await source.dragTo(root)
  await source.dragTo(nav.getByRole('button', { name: readonly.name, exact: true }))
  expect(writes).toHaveLength(writeCount)
  await directory.click()
  await source.dragTo(directory)
  await expect.poll(() => writes.length).toBe(writeCount + 1)
  expect(writes.at(-1)).toMatchObject({ method: 'library.entries.update', input: { entryId: file.id, parentId: folder.id, version: 1 } })
  await expect.poll(() => source.locator('..').locator('..').getAttribute('data-files-path')).toBe(`${library.id}/${folder.id}/${file.id}`)
  expect((await source.locator('svg').first().boundingBox())!.x - (await directory.locator('svg').first().boundingBox())!.x).toBe(18)
  await page.locator('div[role="region"][aria-busy]').getByRole('button', { name: new RegExp(`^${file.name}`) }).dragTo(root)
  await expect.poll(() => writes.length).toBe(writeCount + 2)
  expect(writes.at(-1)).toMatchObject({ method: 'library.entries.update', input: { parentId: null, version: 2 } })
  await expect.poll(() => source.locator('..').locator('..').getAttribute('data-files-path')).toBe(`${library.id}/${file.id}`)
  expect(await directory.evaluate((node, previous) => node === previous, directoryNode)).toBe(true)
  const childFolder = stored.find(entry => entry.name === '子目录验收')!
  const childSource = nav.getByRole('button', { name: childFolder.name, exact: true })
  expect(await directory.getAttribute('draggable')).toBe('true')
  expect(await childSource.getAttribute('draggable')).toBe('true')
  await directory.dragTo(childSource)
  expect(writes).toHaveLength(writeCount + 2)
  await childSource.dragTo(root)
  await expect.poll(() => writes.length).toBe(writeCount + 3)
  expect(writes.at(-1)).toMatchObject({ method: 'library.entries.update', input: { entryId: childFolder.id, parentId: null, version: 1 } })
  await expect.poll(() => childSource.locator('..').locator('..').getAttribute('data-files-path')).toBe(`${library.id}/${childFolder.id}`)
  await root.click()
  const folderRow = page.locator('div[role="region"][aria-busy]').getByRole('button', { name: new RegExp(`^${childFolder.name}`) })
  expect(await folderRow.getAttribute('draggable')).toBe('true')
  await folderRow.dragTo(directory)
  await expect.poll(() => writes.length).toBe(writeCount + 4)
  expect(writes.at(-1)).toMatchObject({ method: 'library.entries.update', input: { entryId: childFolder.id, parentId: folder.id, version: 2 } })
  await expect.poll(() => childSource.locator('..').locator('..').getAttribute('data-files-path')).toBe(`${library.id}/${folder.id}/${childFolder.id}`)
  await mkdir(screenshots, { recursive: true })
  if (await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  }
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 600]) {
      await page.setViewportSize({ width, height: 900 })
      await root.click()
      const listFolder = page.getByRole('button', { name: `${folder.name} ${library.name}`, exact: true })
      const listRow = listFolder.locator('..')
      const listNode = await listFolder.elementHandle()
      const rowBounds = await listRow.boundingBox()
      const search = page.getByRole('searchbox', { name: 'Search names', exact: true })
      const searchNode = await search.elementHandle()
      const target = width === 1440 ? listRow.locator('time') : listRow.locator(':scope > span').first()
      const transfer = await page.evaluateHandle(() => new DataTransfer())
      const highlightWrites = writes.length
      await source.dispatchEvent('dragstart', { dataTransfer: transfer })
      await listFolder.dispatchEvent('dragover', { dataTransfer: transfer })
      expect(await listRow.getAttribute('data-library-drop-target')).toBe('true')
      await listFolder.dispatchEvent('dragleave', { dataTransfer: transfer, relatedTarget: await target.elementHandle() })
      expect(await listRow.getAttribute('data-library-drop-target')).toBe('true')
      await root.dispatchEvent('dragleave', { dataTransfer: transfer, relatedTarget: await listFolder.elementHandle() })
      expect(await listRow.getAttribute('data-library-drop-target')).toBe('true')
      expect(await listFolder.evaluate((node, previous) => node === previous, listNode)).toBe(true)
      expect(await listRow.boundingBox()).toEqual(rowBounds)
      await page.screenshot({ path: join(screenshots, `library-folder-row-highlight-${theme}-${width}.png`) })
      await source.dispatchEvent('dragend', { dataTransfer: transfer })
      expect(await listRow.getAttribute('data-library-drop-target')).toBeNull()
      expect(writes).toHaveLength(highlightWrites)
      await transfer.dispose()
      failRowDrop = true
      const before = writes.length
      await source.dragTo(target)
      await expect.poll(() => writes.length).toBe(before + 1)
      await page.getByRole('alert').waitFor()
      expect(writes.at(-1)).toMatchObject({ method: 'library.entries.update', input: { entryId: file.id, parentId: folder.id } })
      expect(stored.find(entry => entry.id === file.id)?.parentId).toBeNull()
      expect(await listFolder.evaluate((node, previous) => node === previous, listNode)).toBe(true)
      expect(await listRow.boundingBox()).toEqual(rowBounds)
      await source.dragTo(target)
      await expect.poll(() => writes.length).toBe(before + 2)
      await expect.poll(() => source.locator('..').locator('..').getAttribute('data-files-path')).toBe(`${library.id}/${folder.id}/${file.id}`)
      expect(await search.evaluate((node, previous) => node === previous, searchNode)).toBe(true)
      expect(await listFolder.evaluate((node, previous) => node === previous, listNode)).toBe(true)
      expect(await listRow.boundingBox()).toEqual(rowBounds)
      await page.screenshot({ path: join(screenshots, `library-folder-row-drop-${theme}-${width}.png`) })
      await source.dragTo(page.locator('div[role="region"][aria-busy]'), { targetPosition: { x: 5, y: 5 } })
      await expect.poll(() => source.locator('..').locator('..').getAttribute('data-files-path')).toBe(`${library.id}/${file.id}`)
      expect(writes).toHaveLength(before + 3)
      expect(writes.at(-1)).toMatchObject({ method: 'library.entries.update', input: { entryId: file.id, parentId: null } })
    }
  }
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 600]) {
      await page.setViewportSize({ width, height: 900 })
      await directory.scrollIntoViewIfNeeded(); await directory.click()
      const path = page.getByRole('navigation', { name: 'Folder path', exact: true })
      const heading = page.getByRole('heading', { name: folder.name, exact: true })
      const pathBounds = (await path.boundingBox())!, headingBounds = (await heading.boundingBox())!
      expect(pathBounds.y + pathBounds.height).toBeLessThan(headingBounds.y)
      expect(await path.getByRole('button', { name: 'My files', exact: true }).count()).toBe(1)
      expect(await path.getByRole('button', { name: folder.name, exact: true }).getAttribute('aria-current')).toBe('page')
      expect(await heading.locator('..').locator('svg').count()).toBe(1)
      expect(await path.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      expect(await path.getByRole('button').evaluateAll(nodes => nodes.map(node => ({
        size: getComputedStyle(node).fontSize, line: getComputedStyle(node).lineHeight,
      })))).toEqual([{ size: '16px', line: '24px' }, { size: '16px', line: '24px' }])
      const selection = await directory.evaluate((node) => {
        const row = node.parentElement!
        const accessory = row.lastElementChild!
        return { background: getComputedStyle(row).backgroundColor, buttonBackground: getComputedStyle(node).backgroundColor,
          rowRight: row.getBoundingClientRect().right, accessoryRight: accessory.getBoundingClientRect().right,
          width: row.getBoundingClientRect().width }
      })
      expect(selection.background).not.toBe('rgba(0, 0, 0, 0)')
      expect(selection.buttonBackground).toBe('rgba(0, 0, 0, 0)')
      expect(selection.rowRight).toBeGreaterThanOrEqual(selection.accessoryRight)
      expect(selection.width).toBeGreaterThan(100)
      await root.click()
      expect(await root.evaluate(node => getComputedStyle(node.parentElement!).backgroundColor)).toBe(selection.background)
      await sharedRoot.click()
      expect(await sharedRoot.evaluate(node => getComputedStyle(node.parentElement!).backgroundColor)).toBe(selection.background)
      expect(await sharedRoot.evaluate((node) => {
        const row = node.parentElement!
        return row.getBoundingClientRect().left <= row.querySelector('button[aria-expanded]')!.getBoundingClientRect().left
      })).toBe(true)
      await directory.click()
      await page.mouse.move(1200, 100)
      expect(await folderAdd.evaluate(node => getComputedStyle(node).opacity)).toBe('0')
      await folderAdd.scrollIntoViewIfNeeded(); await folderAdd.click()
      const menu = page.getByRole('menu')
      await menu.waitFor()
      expect(await controlIsUnclipped(menu.getByRole('menuitem', { name: 'Upload files', exact: true }))).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-directory-menu-${theme}-${width}.png`) })
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await directory.click()
  const titleRename = page.getByRole('button', { name: `Rename: ${folder.name}`, exact: true })
  const titleNode = await titleRename.elementHandle()
  await titleRename.click()
  const rename = page.getByRole('dialog', { name: 'Rename', exact: true })
  await rename.getByRole('button', { name: 'Cancel', exact: true }).click()
  await rename.waitFor({ state: 'hidden' })
  expect(await titleRename.evaluate(node => node === document.activeElement)).toBe(true)
  const treeActions = nav.getByRole('button', { name: `More actions · ${folder.name}`, exact: true })
  await treeActions.click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  await rename.getByRole('textbox', { name: 'Name', exact: true }).fill('重命名后的合同资料')
  await rename.getByRole('button', { name: 'Save', exact: true }).click()
  await rename.waitFor({ state: 'hidden' })
  const renamedTree = nav.getByRole('button', { name: '重命名后的合同资料', exact: true })
  await renamedTree.waitFor()
  expect(await renamedTree.evaluate((node, previous) => node === previous, directoryNode)).toBe(true)
  expect(await page.getByRole('button', { name: 'Rename: 重命名后的合同资料', exact: true })
    .evaluate((node, previous) => node === previous, titleNode)).toBe(true)
  await page.getByRole('navigation', { name: 'Folder path', exact: true }).getByRole('button', { name: '重命名后的合同资料', exact: true }).waitFor()
  expect(writes.at(-1)).toMatchObject({ method: 'library.entries.update', input: { entryId: folder.id, version: 1, name: '重命名后的合同资料' } })
  await sharedDirectory.click()
  expect(await page.getByRole('button', { name: `Rename: ${sharedFolder.name}`, exact: true }).count()).toBe(0)
  expect(await nav.getByRole('button', { name: `More actions · ${sharedFolder.name}`, exact: true }).count()).toBe(0)
  await rootAdd.click()
  await page.getByRole('menuitem', { name: 'Upload files', exact: true }).click()
  await upload.getByRole('button', { name: 'Choose folder', exact: true }).click()
  await upload.getByText('整目录上传/空目录', { exact: true }).waitFor()
  await upload.evaluate(async (node) => { await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished)) })
  const uploadNode = await upload.elementHandle()
  const uploadAction = upload.getByRole('button', { name: 'Upload files', exact: true })
  const uploadActionNode = await uploadAction.elementHandle()
  const folderWritesStart = writes.length
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 390, height: 900 })
    expect(await controlIsUnclipped(uploadAction)).toBe(true)
    expect(await upload.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.screenshot({ path: join(screenshots, `library-whole-folder-${theme}-390.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await uploadAction.click()
  const uploadError = upload.getByRole('alert')
  await uploadError.waitFor()
  const uploadErrorNode = await uploadError.elementHandle()
  expect(writes.slice(folderWritesStart).map(write => write.input.name)).toEqual(['整目录上传', '空目录'])
  await uploadAction.click(); await uploadAction.click({ force: true })
  await expect.poll(() => writes.length).toBe(folderWritesStart + 3)
  expect(await upload.evaluate((node, previous) => node === previous, uploadNode)).toBe(true)
  expect(await uploadAction.evaluate((node, previous) => node === previous, uploadActionNode)).toBe(true)
  expect(await uploadError.evaluate((node, previous) => node === previous, uploadErrorNode)).toBe(true)
  expect(await uploadAction.evaluate(node => node === document.activeElement)).toBe(true)
  expect(writes.at(-1)).toEqual(writes.at(-2))
  folderRetry.resolve(undefined)
  await upload.waitFor({ state: 'hidden' })
  const uploadedRoot = stored.filter(entry => entry.name === '整目录上传')
  expect(uploadedRoot).toHaveLength(1)
  const uploadedEmpty = stored.filter(entry => entry.name === '空目录')
  expect(uploadedEmpty).toHaveLength(1)
  expect(uploadedEmpty[0]?.parentId).toBe(uploadedRoot[0]?.id)
  const folderFileWrites = writes.slice(folderWritesStart).filter(write => write.method === 'library.files.upload')
  expect(folderFileWrites).toHaveLength(1)
  expect(folderFileWrites[0]?.input.parentId).toBe(uploadedRoot[0]?.id)
  await nav.getByRole('button', { name: '整目录上传', exact: true }).click()
  await nav.getByRole('button', { name: '空目录', exact: true }).waitFor()
  await nav.getByRole('button', { name: '空目录', exact: true }).click()
  await page.getByRole('heading', { name: '空目录', exact: true }).waitFor()
  const uploadedDirectory = nav.getByRole('button', { name: '整目录上传', exact: true })
  const uploadedDirectoryNode = await uploadedDirectory.elementHandle()
  await uploadedDirectory.click(); await uploadedDirectory.click()
  expect(await uploadedDirectory.getAttribute('aria-expanded')).toBe('false')
  await nav.getByRole('button', { name: 'New: 整目录上传', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New folder', exact: true }).click()
  const newFolder = page.getByRole('dialog', { name: 'New folder', exact: true })
  await newFolder.getByRole('textbox').fill('折叠期间新建目录')
  await newFolder.getByRole('button', { name: 'Save', exact: true }).click()
  await newFolder.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: `折叠期间新建目录 ${library.name}`, exact: true }).waitFor()
  expect(await uploadedDirectory.getAttribute('aria-expanded')).toBe('false')
  staleFolderId = uploadedRoot[0]!.id; failCollapsedTree = true
  await uploadedDirectory.click()
  const cachedEmpty = nav.getByRole('button', { name: '空目录', exact: true })
  const cachedEmptyNode = await cachedEmpty.elementHandle()
  const retryTree = nav.getByRole('button', { name: 'Retry', exact: true })
  await retryTree.click(); await retryTree.click({ force: true })
  expect(await cachedEmpty.evaluate((node, previous) => node === previous, cachedEmptyNode)).toBe(true)
  expect(await retryTree.evaluate(node => node === document.activeElement)).toBe(true)
  treeRetry.resolve(undefined)
  await nav.getByRole('button', { name: '折叠期间新建目录', exact: true }).waitFor()
  expect(await uploadedDirectory.evaluate((node, previous) => node === previous, uploadedDirectoryNode)).toBe(true)
  expect(await cachedEmpty.evaluate((node, previous) => node === previous, cachedEmptyNode)).toBe(true)
  await nav.getByRole('button', { name: 'More actions · 整目录上传', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const renameConflict = page.getByRole('dialog', { name: 'Rename', exact: true })
  const conflictDraft = renameConflict.getByRole('textbox')
  const conflictDraftNode = await conflictDraft.elementHandle()
  await conflictDraft.fill('保留我的目录草稿')
  await conflictDraft.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 5) })
  failRename = true; failConflictRead = true
  const conflictSave = renameConflict.getByRole('button', { name: 'Save', exact: true })
  const conflictSaveNode = await conflictSave.elementHandle()
  await conflictSave.click()
  await renameConflict.getByRole('alert').waitFor()
  const reread = renameConflict.getByRole('button', { name: 'Read latest version', exact: true })
  await reread.click()
  await expect.poll(() => renameConflict.getByRole('alert').textContent()).toBe('Could not load the library. Retry.')
  const readErrorNode = await renameConflict.getByRole('alert').elementHandle()
  const writesBeforeReread = writes.length
  await reread.click(); await reread.click({ force: true })
  expect(await renameConflict.getByRole('alert').evaluate((node, previous) => node === previous, readErrorNode)).toBe(true)
  expect(await reread.evaluate(node => node === document.activeElement)).toBe(true)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width: 390, height: 900 })
    expect(await controlIsUnclipped(reread)).toBe(true)
    expect(await renameConflict.getByRole('alert').evaluate(node => node.scrollHeight <= node.clientHeight)).toBe(true)
    await page.screenshot({ path: join(screenshots, `library-conflict-reread-${theme}-390.png`) })
  }
  conflictRetry.resolve(undefined)
  await reread.waitFor({ state: 'hidden' })
  expect(writes.length).toBe(writesBeforeReread)
  expect(await conflictDraft.evaluate((node, previous) => node === previous && node instanceof HTMLInputElement
    && node.value === '保留我的目录草稿' && node.selectionStart === 1 && node.selectionEnd === 5
    && node === document.activeElement, conflictDraftNode)).toBe(true)
  expect(await conflictSave.evaluate((node, previous) => node === previous, conflictSaveNode)).toBe(true)
  const currentVersion = stored.find(entry => entry.id === staleFolderId)!.version
  await conflictSave.click()
  await renameConflict.waitFor({ state: 'hidden' })
  expect(writes.at(-1)?.input).toMatchObject({ entryId: staleFolderId, version: currentVersion, name: '保留我的目录草稿' })
  await nav.getByRole('button', { name: '保留我的目录草稿', exact: true }).waitFor()
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('shares personal directory interactions and keeps member management stable', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser), tripwire = watchConsole(page)
  const now = '2026-11-17T03:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: '项目协作与交付共享空间', scope: 'TEAM',
    ownerId: 'fixture-employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: now, updatedAt: now }
  const file = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id, parentId: null, name: '协作说明.md',
    kind: 'FILE', mediaType: 'text/markdown', sha256: 'a'.repeat(64), sizeBytes: 24, version: 1, createdAt: now, updatedAt: now }
  const folder = { ...file, parentId: null as string | null, id: '33333333-3333-4333-8333-333333333333', name: '共享交付文件夹',
    kind: 'FOLDER', mediaType: null, sha256: null, sizeBytes: 0 }
  const archive = { ...folder, id: '44444444-4444-4444-8444-444444444444', name: '共享归档' }
  let folderCreated = false, folderMoved = false, folderDeleted = false, failDelete = true
  let folderDeleteWrites = 0
  const members = [
    { subjectType: 'EMPLOYEE', subjectId: library.ownerId, name: 'Owner employee', role: 'OWNER' },
    { subjectType: 'DEPARTMENT', subjectId: 'design', name: '设计与产品部门', role: 'VIEWER' },
  ]
  const listing = (data: readonly unknown[]) => ({
    data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: data.length ? 1 : 0,
  })
  let writes = 0, fail = true, failMemberRead = false, failMoveMetadata = false
  let moveMetadataGate: Promise<undefined> | undefined
  type Command = {
    libraryId?: string
    parentId?: string | null
    entryId?: string
    name?: string
    key?: string
    size?: number
    query?: string
    subjectId?: string
    subjectType?: string
    role?: string
    version?: number
  }
  await page.exposeFunction('__sharedSpaceInvoke', async (method: string, input: Command = {}) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: library.ownerId }
    if (method === 'library.list') return listing([library])
    if (method === 'library.get') {
      if (moveMetadataGate) await moveMetadataGate
      if (failMoveMetadata) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Move metadata unavailable', true)) }
      if (failMemberRead) { failMemberRead = false; return { fixtureFailure: productFailure(new Error('read failed')) } }
      return library
    }
    if (method === 'library.files.list') return listing([])
    if (method === 'library.entries.list') {
      const visible = input.parentId === archive.id ? folderMoved && !folderDeleted ? [folder] : []
        : input.parentId ? [] : [file, ...(folderCreated ? [archive, ...(!folderMoved && !folderDeleted ? [folder] : [])] : [])]
      return listing(visible)
    }
    if (method === 'library.entries.get') return input.entryId === archive.id ? archive : folder
    if (method === 'library.entries.update') {
      expect(input).toMatchObject({ entryId: folder.id, parentId: archive.id, version: folder.version })
      folderMoved = true; folder.parentId = archive.id; folder.version++
      return folder
    }
    if (method === 'library.entries.delete') {
      folderDeleteWrites++
      expect(input).toMatchObject({ entryId: folder.id, version: folder.version })
      if (failDelete) {
        folder.version++
        return { fixtureFailure: productFailure(new ProductError('LIBRARY_CONFLICT', 'Folder changed', true)) }
      }
      folderDeleted = true
      return null
    }
    if (method === 'library.folders.create') {
      expect(input).toMatchObject({ libraryId: library.id, parentId: null, name: folder.name })
      expect(input.key).toBeTypeOf('string')
      expect(folderCreated).toBe(false)
      folderCreated = true
      return folder
    }
    if (method === 'library.members.list') return listing(members)
    if (method === 'library.memberOptions.employees') return { ...listing([
      { id: 'bob', name: 'Bob employee' },
      ...Array.from({ length: 19 }, (_, index) => ({ id: `employee-${index}`, name: `跨部门项目协作与交付员工 ${index + 1}` })),
    ]), totalCount: 820, totalPages: 41 }
    if (method === 'library.memberOptions.departments') return [{ id: 'sales', name: '销售部门' }]
    if (method === 'library.members.save') {
      writes++
      if (fail) {
        library.version++
        return { fixtureFailure: productFailure(new ProductError('LIBRARY_CONFLICT', 'Membership changed', true)) }
      }
      expect(input).toMatchObject({ subjectType: 'EMPLOYEE', subjectId: 'bob', role: 'VIEWER', version: library.version })
      library.version++
      members.push({ subjectType: 'EMPLOYEE', subjectId: 'bob', name: 'Bob employee', role: 'VIEWER' })
      return library
    }
    throw new Error(`Unexpected shared-space fixture method: ${method}`)
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __sharedSpaceInvoke(method: string, input?: unknown): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string, input?: unknown) => {
        const result = await api.__sharedSpaceInvoke(method, input)
        return result && typeof result === 'object' && 'fixtureFailure' in result
          ? { ok: false, failure: result.fixtureFailure } : { ok: true, result }
      }, cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Libraries', exact: true }).click()
  const nav = page.getByRole('navigation', { name: 'Library navigation', exact: true })
  const space = nav.getByRole('button', { name: library.name, exact: true })
  await space.click()
  await page.getByRole('heading', { name: library.name, exact: true }).waitFor()
  const row = page.getByRole('button', { name: `${file.name} ${library.name}`, exact: true })
  const rowNode = await row.elementHandle()
  await nav.getByRole('button', { name: file.name, exact: true }).waitFor()
  expect(await nav.getByRole('button', { name: /^Expand:|^Collapse:/ }).count()).toBe(0)
  await space.click(); await space.click()
  expect(await row.evaluate((node, previous) => node === previous, rowNode)).toBe(true)
  const add = nav.getByRole('button', { name: `New: ${library.name}`, exact: true })
  await page.mouse.move(1400, 100)
  expect(await add.evaluate(node => getComputedStyle(node).opacity)).toBe('0')
  await space.hover()
  expect(await add.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
  for (const scene of [{ theme: 'light', width: 1440 }, { theme: 'dark', width: 600 }, { theme: 'light', width: 390 }] as const) {
    await page.emulateMedia({ colorScheme: scene.theme })
    await page.setViewportSize({ width: scene.width, height: 900 })
    const addTrigger = nav.getByRole('button', { name: `New: ${library.name}`, exact: true })
    const actionsTrigger = nav.getByRole('button', { name: `Library actions: ${library.name}`, exact: true })
    for (const trigger of [addTrigger, actionsTrigger]) {
      await page.mouse.move(1400, 100)
      const before = await trigger.evaluate(node => ({
        background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color,
      }))
      await trigger.hover()
      expect(await trigger.evaluate(node => ({
        background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color,
      }))).toEqual(before)
    }
    await addTrigger.click()
    await page.getByRole('menuitem', { name: 'New folder', exact: true }).click()
    const folderDialog = page.getByRole('dialog', { name: 'New folder', exact: true })
    const folderBox = await folderDialog.boundingBox()
    expect(await folderDialog.getByRole('textbox').count()).toBe(1)
    await folderDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await nav.getByRole('button', { name: `Library actions: ${library.name}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
    const editDialog = page.getByRole('dialog', { name: 'Edit', exact: true })
    expect(await editDialog.getByRole('textbox').count()).toBe(1)
    const editBox = await editDialog.boundingBox()
    expect(editBox?.x).toBe(folderBox?.x)
    expect(editBox?.y).toBe(folderBox?.y)
    await editDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await nav.getByRole('button', { name: `New: ${library.name}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Upload files', exact: true }).click()
    const uploadDialog = page.getByRole('dialog', { name: 'Upload files', exact: true })
    const uploadBox = await uploadDialog.boundingBox()
    expect(uploadBox?.x).toBe(folderBox?.x)
    expect(uploadBox?.y).toBe(folderBox?.y)
    expect(await uploadDialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    expect(await controlIsUnclipped(uploadDialog.getByRole('button', { name: 'Choose files', exact: true }))).toBe(true)
    await expect.poll(() => uploadDialog.evaluate(node => node.getAnimations().every(animation => animation.playState !== 'running'))).toBe(true)
    await page.screenshot({ path: join(screenshots, `shared-upload-${scene.theme}-${scene.width}.png`) })
    await uploadDialog.getByRole('button', { name: 'Close', exact: true }).first().click()
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await add.click()
  await page.getByRole('menuitem', { name: 'New folder', exact: true }).click()
  const create = page.getByRole('dialog', { name: 'New folder', exact: true })
  await create.getByRole('textbox', { name: 'Name', exact: true }).fill(folder.name)
  await create.getByRole('button', { name: 'Save', exact: true }).click()
  await create.waitFor({ state: 'hidden' })
  await nav.getByRole('button', { name: folder.name, exact: true }).waitFor()
  await page.getByRole('button', { name: `${folder.name} ${library.name}`, exact: true }).waitFor()
  expect(folderCreated).toBe(true)
  expect(await row.evaluate((node, previous) => node === previous, rowNode)).toBe(true)
  await nav.getByRole('button', { name: folder.name, exact: true }).click()
  await page.getByRole('heading', { name: folder.name, exact: true }).waitFor()
  const folderActions = nav.getByRole('button', { name: `More actions · ${folder.name}`, exact: true })
  await folderActions.click()
  expect(await page.getByRole('menuitem').allTextContents()).toEqual(['Rename', 'Move', 'Delete'])
  await page.getByRole('menuitem', { name: 'Move', exact: true }).click()
  const moveDialog = page.getByRole('dialog', { name: 'Move', exact: true })
  const targetFolder = moveDialog.getByRole('button', { name: `${archive.name} Folder`, exact: true })
  await targetFolder.waitFor()
  const targetNode = await targetFolder.elementHandle()
  const pickerSearch = moveDialog.getByRole('searchbox'), pickerSearchNode = await pickerSearch.elementHandle()
  for (const scene of [{ theme: 'light', width: 1440 }, { theme: 'dark', width: 600 }] as const) {
    await page.emulateMedia({ colorScheme: scene.theme })
    await page.setViewportSize({ width: scene.width, height: 900 })
    library.role = 'VIEWER'; library.canManage = false
    await pickerSearch.fill('共享')
    await moveDialog.getByRole('button', { name: 'New folder', exact: true }).waitFor({ state: 'detached' })
    const metadata = Promise.withResolvers<undefined>()
    onTestFinished(() => { metadata.resolve(undefined) })
    moveMetadataGate = metadata.promise
    const root = moveDialog.getByRole('button', { name: 'Libraries', exact: true }), rootNode = await root.elementHandle()
    await root.click()
    expect(await moveDialog.getByRole('button', { name: 'New folder', exact: true }).count()).toBe(0)
    expect(await targetFolder.evaluate((node, previous) => node === previous, targetNode)).toBe(true)
    expect(await pickerSearch.evaluate((node, previous) => node === previous, pickerSearchNode)).toBe(true)
    expect(await pickerSearch.inputValue()).toBe('')
    expect(await root.evaluate((node, previous) => node === previous && node === document.activeElement, rootNode)).toBe(true)
    expect(await moveDialog.getByRole('status').count()).toBe(0)
    failMoveMetadata = true
    metadata.resolve(undefined); moveMetadataGate = undefined
    await moveDialog.getByRole('alert').waitFor()
    const retry = moveDialog.getByRole('button', { name: 'Retry', exact: true })
    const retryNode = await retry.elementHandle()
    const recovery = Promise.withResolvers<undefined>()
    onTestFinished(() => { recovery.resolve(undefined) })
    moveMetadataGate = recovery.promise
    library.role = 'OWNER'; library.canManage = true; failMoveMetadata = false
    await retry.click()
    expect(await moveDialog.getByRole('alert').count()).toBe(1)
    expect(await targetFolder.evaluate((node, previous) => node === previous, targetNode)).toBe(true)
    expect(await retry.evaluate((node, previous) => node === previous && node === document.activeElement, retryNode)).toBe(true)
    await expect.poll(() => moveDialog.evaluate(node =>
      node.getAnimations().every(animation => animation.playState !== 'running'))).toBe(true)
    await page.screenshot({ path: join(screenshots, `library-root-navigation-${scene.theme}-${scene.width}.png`) })
    recovery.resolve(undefined); moveMetadataGate = undefined
    await moveDialog.getByRole('alert').waitFor({ state: 'detached' })
    expect(await targetFolder.evaluate((node, previous) => node === previous, targetNode)).toBe(true)
    expect(await pickerSearch.evaluate(node => node === document.activeElement)).toBe(true)
    await moveDialog.getByRole('button', { name: 'New folder', exact: true }).waitFor()
  }
  await page.setViewportSize({ width: 1440, height: 900 })

  await moveDialog.getByRole('button', { name: `${archive.name} Folder`, exact: true }).click()
  const moveSave = moveDialog.getByRole('button', { name: 'Save', exact: true })
  await expect.poll(() => moveSave.getAttribute('aria-disabled')).toBe('false')
  await moveSave.click()
  await moveDialog.waitFor({ state: 'hidden' })
  await page.getByRole('heading', { name: library.name, exact: true }).waitFor()
  expect(folderMoved).toBe(true)
  await nav.getByRole('button', { name: archive.name, exact: true }).click()
  await nav.getByRole('button', { name: folder.name, exact: true }).click()
  await page.getByRole('heading', { name: folder.name, exact: true }).waitFor()
  await folderActions.click()
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  const deleteDialog = page.getByRole('dialog', { name: 'Delete', exact: true })
  const deleteButton = deleteDialog.getByRole('button', { name: 'Delete', exact: true })
  await deleteButton.click()
  await deleteDialog.getByRole('alert').waitFor()
  expect(await nav.getByRole('button', { name: folder.name, exact: true }).count()).toBe(1)
  failDelete = false
  await deleteDialog.getByRole('button', { name: 'Read latest version', exact: true }).click()
  await expect.poll(() => deleteButton.getAttribute('aria-disabled')).toBe('false')
  await deleteButton.click()
  await deleteDialog.waitFor({ state: 'hidden' })
  await page.getByRole('heading', { name: archive.name, exact: true }).waitFor()
  await expect.poll(() => nav.getByRole('button', { name: folder.name, exact: true }).count()).toBe(0)
  expect(folderDeleteWrites).toBe(2)
  expect(await space.evaluate(node => node === document.activeElement)).toBe(true)
  await space.click()
  const memberTrigger = page.getByRole('button', { name: 'Members', exact: true })
  await memberTrigger.click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByText(library.name, { exact: true }) })
  await page.getByRole('dialog', { name: 'Manage members', exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Bob employee', exact: true }).waitFor()
  for (const scene of [{ theme: 'light', width: 1440 }, { theme: 'dark', width: 600 }, { theme: 'light', width: 390 }] as const) {
    await page.emulateMedia({ colorScheme: scene.theme })
    await page.setViewportSize({ width: scene.width, height: 900 })
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    expect(await controlIsUnclipped(dialog.getByRole('button', { name: 'Add members', exact: true }))).toBe(true)
    expect(await controlIsUnclipped(dialog.getByRole('heading', { name: 'Manage members', exact: true }))).toBe(true)
    await expect.poll(() => dialog.evaluate(node => node.getAnimations().every(animation => animation.playState !== 'running'))).toBe(true)
    await page.screenshot({ path: join(screenshots, `shared-members-${scene.theme}-${scene.width}.png`) })
  }
  const departments = dialog.getByRole('tab', { name: 'Department', exact: true })
  await departments.click()
  const candidates = dialog.getByRole('group', { name: 'Choose a member', exact: true })
  await candidates.getByRole('button', { name: '销售部门', exact: true }).waitFor()
  expect(await dialog.getByRole('searchbox').count()).toBe(0)
  expect(await departments.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  expect(await controlIsUnclipped(dialog.getByRole('tab', { name: 'Everyone in company', exact: true }))).toBe(true)
  await page.screenshot({ path: join(screenshots, 'shared-invite-light-390.png') })
  await dialog.getByRole('tab', { name: 'Everyone in company', exact: true }).click()
  expect(await candidates.count()).toBe(0)
  await dialog.getByRole('tab', { name: 'Employee', exact: true }).click()
  const candidate = candidates.getByRole('button', { name: 'Bob employee', exact: true })
  await expect.poll(() => candidate.getAttribute('aria-disabled')).toBe('false')
  await candidate.click()
  const candidateNode = await candidate.elementHandle()
  const accessTrigger = dialog.getByRole('button', { name: 'Access', exact: true })
  await accessTrigger.click()
  await page.getByRole('menuitem', { name: 'Can edit', exact: true }).waitFor()
  expect(await page.getByRole('menu').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  await page.keyboard.press('Escape')
  expect(await dialog.count()).toBe(1)
  expect(await accessTrigger.evaluate(node => node === document.activeElement)).toBe(true)
  const save = dialog.getByRole('button', { name: 'Add members', exact: true })
  await expect.poll(() => save.getAttribute('aria-disabled')).toBe('false')
  const footerBox = await save.boundingBox()
  const dialogNode = await dialog.elementHandle()
  const existingOwner = dialog.getByText('Owner employee', { exact: true })
  const ownerNode = await existingOwner.elementHandle()
  await save.click()
  const error = dialog.getByRole('alert')
  await error.waitFor()
  expect(await save.getAttribute('aria-disabled')).toBe('true')
  await save.click({ force: true })
  expect(writes).toBe(1)
  expect(await save.boundingBox()).toEqual(footerBox)
  failMemberRead = true
  const retryRead = dialog.getByRole('button', { name: 'Retry', exact: true })
  const retryNode = await retryRead.elementHandle()
  await retryRead.click()
  await expect.poll(() => retryRead.getAttribute('aria-disabled')).toBe('false')
  expect(await retryRead.evaluate((node, previous) => node === previous, retryNode)).toBe(true)
  expect(await retryRead.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await dialog.getByRole('alert').count()).toBe(1)
  expect(await controlIsUnclipped(dialog.getByRole('heading', { name: 'Manage members', exact: true }))).toBe(true)
  expect(await dialog.getByRole('alert').evaluate(node => node.scrollHeight <= node.clientHeight)).toBe(true)
  expect(await save.getAttribute('aria-disabled')).toBe('true')
  await save.click({ force: true })
  expect(writes).toBe(1)
  await page.screenshot({ path: join(screenshots, 'shared-members-conflict-retry-light-390.png') })
  await retryRead.click()
  await expect.poll(() => save.getAttribute('aria-disabled')).toBe('false')
  expect(await dialog.getByRole('alert').count()).toBe(0)
  expect(await dialog.getByRole('searchbox').evaluate(node => node === document.activeElement)).toBe(true)
  expect(await candidate.evaluate((node, previous) => node === previous, candidateNode)).toBe(true)
  expect(await candidate.getAttribute('aria-pressed')).toBe('true')
  expect(writes).toBe(1)
  fail = false
  await save.scrollIntoViewIfNeeded()
  const successBox = await save.boundingBox()
  await save.click()
  await dialog.getByRole('button', { name: 'Access: Bob employee', exact: true }).waitFor()
  expect(writes).toBe(2)
  expect(await dialog.evaluate((node, previous) => node === previous, dialogNode)).toBe(true)
  expect(await existingOwner.evaluate((node, previous) => node === previous, ownerNode)).toBe(true)
  expect(await save.boundingBox()).toEqual(successBox)
  await dialog.getByRole('button', { name: 'Library actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Transfer ownership', exact: true }).click()
  const transfer = page.getByRole('dialog', { name: 'Transfer ownership', exact: true })
  await transfer.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.waitFor()
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  await dialog.waitFor({ state: 'hidden' })
  expect(await memberTrigger.evaluate(node => node === document.activeElement)).toBe(true)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('returns member action focus to visible subject tabs after removal and conflict retry', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true,
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [join(packageDir, 'cordis.patch.yml'), join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser), tripwire = watchConsole(page)
  page.setDefaultTimeout(10_000)
  const now = '2026-11-17T04:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: '成员操作验收共享空间', scope: 'TEAM',
    ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: now, updatedAt: now }
  const owner = { subjectType: 'EMPLOYEE', subjectId: 'employee', name: 'Alice', role: 'OWNER' }
  const member = { subjectType: 'EMPLOYEE', subjectId: 'bob', name: 'Bob', role: 'VIEWER' }
  const listing = (data: readonly unknown[]) => ({
    data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: data.length ? 1 : 0,
  })
  let removed = false, conflict = false, writes = 0, roleWrites = 0, memberReads = 0
  let writeGate: ReturnType<typeof Promise.withResolvers<undefined>> | undefined
  const gates: NonNullable<typeof writeGate>[] = []
  onTestFinished(() => { for (const gate of gates) gate.resolve(undefined) })
  await page.exposeFunction('__memberFocusInvoke', async (method: string) => {
    if (method === 'library.get' || method.startsWith('library.members.') || method.startsWith('library.memberOptions.')) {
      memberReads++
    }
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee' }
    if (method === 'library.list') return listing([library])
    if (method === 'library.get') return library
    if (method === 'library.files.list' || method === 'library.entries.list') return listing([])
    if (method === 'library.members.list') return listing(removed ? [owner] : [owner, member])
    if (method === 'library.memberOptions.employees') return listing([{ id: 'bob', name: 'Bob' }])
    if (method === 'library.memberOptions.departments') return [{ id: 'sales', name: 'Sales' }]
    if (method === 'library.members.save') { roleWrites++; return library }
    if (method === 'library.members.remove') {
      writes++
      await writeGate?.promise
      removed = true; library.version++
      if (conflict) return { fixtureFailure: productFailure(new ProductError('LIBRARY_CONFLICT', 'Changed elsewhere', true)) }
      return library
    }
    throw new Error(`Unexpected member-focus fixture method: ${method}`)
  })
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __memberFocusInvoke(method: string): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string) => {
        const result = await api.__memberFocusInvoke(method)
        return result && typeof result === 'object' && 'fixtureFailure' in result
          ? { ok: false, failure: result.fixtureFailure } : { ok: true, result }
      }, cancel: () => {}, subscribe: () => () => {},
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Libraries', exact: true }).click()
  await page.getByRole('navigation', { name: 'Library navigation', exact: true })
    .getByRole('button', { name: library.name, exact: true }).click()
  const trigger = page.getByRole('button', { name: 'Members', exact: true })
  for (const scene of [
    { subject: 'Department', retry: false, width: 1440, theme: 'light', moveFocus: false },
    { subject: 'Everyone in company', retry: false, width: 390, theme: 'dark', moveFocus: false },
    { subject: 'Department', retry: true, width: 600, theme: 'dark', moveFocus: false },
    { subject: 'Everyone in company', retry: true, width: 390, theme: 'light', moveFocus: false },
    { subject: 'Everyone in company', retry: false, width: 1440, theme: 'light', moveFocus: true },
  ] as const) {
    removed = false; conflict = scene.retry; writes = 0
    await page.emulateMedia({ colorScheme: scene.theme })
    await page.setViewportSize({ width: scene.width, height: 900 })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Manage members', exact: true })
    await dialog.getByRole('button', { name: 'Bob', exact: true }).waitFor()
    const access = dialog.getByRole('button', { name: 'Access: Bob', exact: true })
    await expect.poll(() => access.getAttribute('aria-disabled')).toBe('false')
    const search = dialog.getByRole('searchbox')
    await search.fill('Bob')
    await search.evaluate((node: HTMLInputElement) => { node.setSelectionRange(0, 2) })
    await expect.poll(() => access.getAttribute('aria-disabled')).toBe('false')
    const accessNode = await access.elementHandle(), searchNode = await search.elementHandle()
    const beforeReads = memberReads, accessBox = await access.boundingBox()
    await access.click()
    await page.getByRole('menuitem', { name: 'Can view', exact: true }).click()
    await page.getByRole('menu').waitFor({ state: 'detached' })
    expect(roleWrites).toBe(0)
    expect(memberReads).toBe(beforeReads)
    expect(await access.evaluate((node, previous) => node === previous && node === document.activeElement, accessNode)).toBe(true)
    expect(await search.evaluate((node: HTMLInputElement, previous) =>
      [node === previous, node.value, node.selectionStart, node.selectionEnd], searchNode)).toEqual([true, 'Bob', 0, 2])
    expect(await access.boundingBox()).toEqual(accessBox)
    expect(await dialog.getByRole('button', { name: 'Add members', exact: true }).getAttribute('aria-busy')).toBe('false')
    const tab = dialog.getByRole('tab', { name: scene.subject, exact: true })
    await tab.click()
    const remove = dialog.getByRole('button', { name: 'Remove: Bob', exact: true })
    await expect.poll(() => remove.getAttribute('aria-disabled')).toBe('false')
    expect(await dialog.getByRole('searchbox').count()).toBe(0)
    const tabNode = await tab.elementHandle(), dialogNode = await dialog.elementHandle()
    writeGate = Promise.withResolvers<undefined>(); gates.push(writeGate)
    await remove.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter')
    await expect.poll(() => writes).toBe(1)
    const close = dialog.getByRole('button', { name: 'Close', exact: true }).last()
    if (scene.moveFocus) await close.focus()
    writeGate.resolve(undefined)
    if (scene.retry) {
      await dialog.getByRole('alert').waitFor()
      expect(await remove.evaluate(node => node === document.activeElement)).toBe(true)
      const retry = dialog.getByRole('button', { name: 'Retry', exact: true })
      await retry.click()
      await dialog.getByRole('alert').waitFor({ state: 'detached' })
    }
    await remove.waitFor({ state: 'detached' })
    await expect.poll(() => (scene.moveFocus ? close : tab).evaluate(node => node === document.activeElement)).toBe(true)
    expect(await tab.evaluate((node, previous) => node === previous, tabNode)).toBe(true)
    expect(await dialog.evaluate((node, previous) => node === previous, dialogNode)).toBe(true)
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    expect(writes).toBe(1)
    await mkdir(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, `member-focus-${scene.theme}-${scene.width}-${scene.retry ? 'retry' : 'remove'}.png`) })
    await close.click()
    await dialog.waitFor({ state: 'hidden' })
    expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true)
  }
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
