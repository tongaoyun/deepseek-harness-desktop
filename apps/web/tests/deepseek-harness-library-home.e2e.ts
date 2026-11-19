/** File-first product views exercised in the real native Web composition. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Locator } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, writeComposerDraft } from './support.ts'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import type { LibraryEntry } from '@deepseek-harness/product/library'

async function settleDialog(dialog: Locator): Promise<void> {
  await dialog.evaluate(async (node) => {
    const animations = node.getAnimations({ subtree: true })
    for (let parent = node.parentElement; parent; parent = parent.parentElement) animations.push(...parent.getAnimations())
    await Promise.allSettled(animations.filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished))
  })
}

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
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-catalog')
  await mkdir(screenshots, { recursive: true })
  const now = '2026-11-14T01:00:00Z'
  const files = ['Project proposal.docx', 'Review presentation.pptx', '网页示例.html', '参考图片.png',
    '资料归档与项目交付说明-Long project delivery documents and reference templates.zip'].map((name, i) => ({
    entry: { id: `22222222-2222-4222-8222-${String(i + 1).padStart(12, '0')}`, libraryId: '11111111-1111-4111-8111-111111111111',
      parentId: null, name, kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'application/octet-stream', sizeBytes: (i + 1) * 5120,
      version: 1, createdAt: now, updatedAt: now },
    libraryName: 'Project files', canManage: true, lastAccessedAt: now, sourceKind: i === 0 ? 'CONVERSATION' : 'UPLOAD', sourceSessionId: i === 0 ? 'native-source' : null,
  }))
  const library = { id: files[0]!.entry.libraryId, name: 'Project files', scope: 'PERSONAL',
    ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: now, updatedAt: now }
  let teamLibrary = { ...library, id: '66666666-6666-4666-8666-666666666666', scope: 'TEAM', name: 'Team references', role: 'VIEWER', canManage: false }
  const teamFile = { ...files[0]!.entry, id: '77777777-7777-4777-8777-777777777777', libraryId: teamLibrary.id, name: 'Team handbook.md' }
  const folder = { ...files[0]!.entry, id: '55555555-5555-4555-8555-555555555555', name: 'Templates', kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0 }
  const sharedFolders: LibraryEntry[] = []
  let includeSharedRecent = false
  let ownedTeam: typeof library | undefined
  let teamCreated = false, failMember = true
  let grants = [{ subjectType:'EMPLOYEE',subjectId:'employee',name:'Test employee',role:'OWNER' }]
  const memberWrites: unknown[] = []
  let folderCreated = false
  const folderWrites: unknown[] = []
  const uploadWrites: unknown[] = []
  const selections = [
    { selectionId: '33333333-3333-4333-8333-333333333333', name: '中文参考资料.md', kind: 'FILE' as const, sizeBytes: 12 },
    { selectionId: '44444444-4444-4444-8444-444444444444', name: 'Another reference.md', kind: 'FILE' as const, sizeBytes: 24 },
  ]
  let selectionCount = 0, failUpload = true, failMove = false
  let failFolder = true
  let fail = false, reads = 0
  let refreshGate: Promise<undefined> | undefined
  let teamEntriesGate: Promise<undefined> | undefined, teamEntryReads = 0, teamDirectoryReads = 0
  let failTeamEntries = false, failTeamMembers = false, failTeamMetadata = false
  let teamMetadataReads = 0
  await page.exposeFunction('__libraryHomeInvoke', async (method: string, input: { query?: string; sort?: string; direction?: string; view?: string; entryId?: string; parentId?: string | null; size?: number; libraryId?: string; subjectType?: string; subjectId?: string; employeeId?: string; role?: string; version?: number; name?: string }) => {
    if (method === 'library.create') {
      ownedTeam = { ...library, id:'88888888-8888-4888-8888-888888888888', scope:'TEAM',name:input.name ?? '' }
      teamCreated = true
      return ownedTeam
    }
    if (method === 'library.members.list') {
      if (input.libraryId === teamLibrary.id && failTeamMembers) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Member list unavailable', true)) }
      const data = grants.filter(row => row.name.toLowerCase().includes((input.query ?? '').toLowerCase()))
      return { data,pageIndex:1,pageSize:20,totalCount:data.length,totalPages:data.length?1:0 }
    }
    if (method === 'library.memberOptions.employees') return { data:[{ id:'bob',name:'Bob' }],pageIndex:1,pageSize:20,totalCount:1,totalPages:1 }
    if (method === 'library.memberOptions.departments') return [{ id:'sales',name:'Sales' }]
    if (method === 'library.members.save' || method === 'library.members.remove' || method === 'library.owner.transfer') {
      memberWrites.push(input)
      if (failMember) return { fixtureFailure:productFailure(new ProductError('LIBRARY_CONFLICT','Changed by another editor',true)) }
      if (!ownedTeam || input.version !== ownedTeam.version) throw new Error('Invalid member version')
      if (method === 'library.owner.transfer') {
        grants = grants.map(row => row.subjectId === 'employee' ? { ...row,role:'EDITOR' } : row.subjectId === 'bob' ? { ...row,role:'OWNER' } : row)
        ownedTeam = { ...ownedTeam,ownerId:'bob',role:'EDITOR',version:ownedTeam.version+1 }
      } else {
        grants=grants.filter(row=>row.subjectType!==input.subjectType||row.subjectId!==input.subjectId)
        if (method==='library.members.save') grants.push({ subjectType:input.subjectType!,subjectId:input.subjectId!,name: input.subjectType==='EMPLOYEE'?'Bob':input.subjectType==='DEPARTMENT'?'Sales':'Everyone',role:input.role! })
        ownedTeam={ ...ownedTeam,version:ownedTeam.version+1 }
      }
      return ownedTeam
    }
    if (method === 'library.entries.list' && input.libraryId === ownedTeam?.id) {
      const data = sharedFolders.filter(entry => entry.parentId === (input.parentId ?? null))
      return { data,pageIndex:1,pageSize:input.size??20,totalCount:data.length,totalPages:data.length ? 1 : 0 }
    }
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee', displayName: 'Test employee' }
    if (method === 'library.entries.list' && input.libraryId === teamLibrary.id) {
      teamEntryReads++
      if (input.size === 20) teamDirectoryReads++
      if (teamEntriesGate) await teamEntriesGate
      if (failTeamEntries) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Team read unavailable', true)) }
      return { data: [teamFile], pageIndex: 1, pageSize: input.size ?? 20, totalCount: 1, totalPages: 1 }
    }
    if (method === 'library.entries.list' && input.size === 50) {
      const data = [...files.map(file => file.entry), ...(folderCreated ? [folder] : [])]
        .filter(entry => entry.parentId === (input.parentId ?? null))
      return { data, pageIndex: 1, pageSize: 50, totalCount: data.length, totalPages: data.length ? 1 : 0 }
    }
    if (method === 'library.files.list' || method === 'library.entries.list' && input.view === 'folder') {
      reads++
      if (refreshGate) await refreshGate
      if (fail) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Read unavailable', true)) }
      const candidates = method === 'library.files.list' && includeSharedRecent
        ? [...files, { entry: teamFile, libraryName: teamLibrary.name, canManage: false, lastAccessedAt: now, sourceKind: 'UPLOAD', sourceSessionId: null }]
        : files
      const matches = candidates.filter(file => file.entry.name.toLowerCase().includes((input.query ?? '').toLowerCase()))
      const data = method === 'library.files.list' ? matches : [...matches.map(file => file.entry), ...(folderCreated ? [folder] : [])]
        .filter(entry => entry.parentId === (input.parentId ?? null) && entry.name.toLowerCase().includes((input.query ?? '').toLowerCase()))
      return { data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: data.length ? 1 : 0 }
    }
    if (method === 'library.get' && failMove) {
      failMove = false
      return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Move unavailable', true)) }
    }
    if (method === 'library.entries.get') {
      const entry = [folder, teamFile, ...sharedFolders, ...files.map(file => file.entry)].find(item => item.id === input.entryId)
      if (!entry) throw new Error('Unknown library entry')
      return entry
    }
    if (method === 'library.entries.delete') {
      const index = files.findIndex(value => value.entry.id === input.entryId)
      if (index >= 0) files.splice(index, 1)
      return true
    }
    if (method === 'library.personal.ensure' || method === 'library.get') {
      if (input.libraryId === teamLibrary.id) {
        teamMetadataReads++
        if (failTeamMetadata) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Directory metadata unavailable', true)) }
        return teamLibrary
      }
      return ownedTeam && input.libraryId === ownedTeam.id ? ownedTeam : library
    }
    if (method === 'library.list') return { data: [library, teamLibrary, ...(teamCreated && ownedTeam ? [ownedTeam] : [])], pageIndex: 1, pageSize: 20, totalCount: teamCreated?3:2, totalPages: 1 }
    if (method === 'library.entries.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
    if (method === 'library.files.upload.select') {
      selectionCount++
      if (selectionCount === 2) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Selection unavailable', true)) }
      return [selections[selectionCount === 1 ? 0 : 1]]
    }
    if (method === 'library.files.upload') {
      uploadWrites.push(input)
      if (failUpload) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Upload unavailable', true)) }
      return true
    }
    if (method === 'library.files.upload.discard') return true
    if (method === 'library.folders.create') {
      folderWrites.push(input)
      if (failFolder) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Write unavailable', true)) }
      if (input.libraryId === ownedTeam?.id && ownedTeam) {
        const entry: LibraryEntry = { ...folder, kind: 'FOLDER', id: `99999999-9999-4999-8999-${String(sharedFolders.length + 1).padStart(12, '0')}`,
          libraryId: ownedTeam.id, parentId: input.parentId ?? null, name: input.name ?? '' }
        sharedFolders.push(entry)
        return entry
      }
      folderCreated = true
      return folder
    }
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
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  await expect.poll(async () => {
    const id = await page.locator('[data-conversation-session]').first().getAttribute('data-conversation-session')
    return scaffold.ctx.workspaceRegistry.list().some(workspace => workspace.path === join(scaffold.workspaceCwd, 'workspace')
      && workspace.sessionIds.some(sessionId => sessionId === id))
  }).toBe(true)
  const composer = page.locator('[data-composer-input]').first()
  const draftSession = await page.locator('[data-conversation-session]').first().getAttribute('data-conversation-session')
  await writeComposerDraft(page, composer, 'Keep this draft')
  await composer.press('Tab')
  expect(await composer.innerText()).toContain('Keep this draft')
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const nativeHeading = await page.getByRole('heading', { name: 'Plugins', exact: true }).evaluate((node) => {
    const style = getComputedStyle(node)
    return [style.fontSize, style.lineHeight, style.fontWeight]
  })
  await page.getByRole('button', { name: 'Libraries', exact: true }).click()
  await page.getByRole('navigation', { name: 'Library navigation', exact: true }).waitFor()
  expect(await page.getByRole('heading', { name: 'Libraries', exact: true }).evaluate((node) => {
    const style = getComputedStyle(node)
    return [style.fontSize, style.lineHeight, style.fontWeight]
  })).toEqual(nativeHeading)
  const row = page.getByRole('button', { name: 'Project proposal.docx Project files', exact: true })
  await row.waitFor()
  let node = await row.elementHandle()
  const upload = page.getByRole('button', { name: 'Upload files', exact: true }), uploadNode = await upload.elementHandle()
  const search = page.getByRole('searchbox', { name: 'Search names' }), searchNode = await search.elementHandle()
  const source = row.locator('xpath=..').getByRole('button', { name: 'Conversation', exact: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    for (const width of [1440, 600, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForFunction(drawer => Boolean(document.querySelector('[data-sidebar-drawer]')) === drawer, width < 768)
      if (await page.locator('[data-sidebar-drawer]:not([data-sidebar-collapsed])').count()) {
        await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      }
      await settleDialog(page.locator('body'))
      expect(await source.isVisible()).toBe(true)
      const sourceGeometry = await source.evaluate((node) => {
        const bounds = node.getBoundingClientRect(), row = node.closest('li')!.getBoundingClientRect()
        return {
          source: { left: bounds.left, right: bounds.right, bottom: bounds.bottom },
          row: { left: row.left, right: row.right, bottom: row.bottom },
        }
      })
      const fits = sourceGeometry.source.left >= sourceGeometry.row.left && sourceGeometry.source.right <= sourceGeometry.row.right
        && sourceGeometry.source.bottom <= sourceGeometry.row.bottom
      if (!fits) await page.screenshot({ path: join(screenshots, `library-source-layout-${colorScheme}-${width}.png`) })
      expect(fits, `${colorScheme} ${width}: ${JSON.stringify(sourceGeometry)}`).toBe(true)
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1440, height: 900 })
  expect(await page.getByRole('button', { name: 'Grid', exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'List', exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Refresh', exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Sort', exact: true }).count()).toBe(0)
  const mineTab = page.getByRole('navigation', { name: 'Library navigation', exact: true }).getByRole('button', { name: 'My files', exact: true })
  const bounds = await upload.boundingBox()
  const gate = Promise.withResolvers<undefined>()
  onTestFinished(() => { gate.resolve(undefined) })
  refreshGate = gate.promise
  await search.fill('Project')
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
  await search.fill('Project')
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
  const recent = page.getByRole('button', { name: 'Recent', exact: true })
  await recent.click()
  await mineTab.focus(); await mineTab.press('Enter')
  const mine = page.getByRole('navigation', { name: 'Library navigation', exact: true }).getByRole('button', { name: 'My files', exact: true })
  expect(await mine.getAttribute('aria-current')).toBe('page')
  expect(await mine.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await search.evaluate((node, previous) => node === previous && node instanceof HTMLInputElement
    && node.value === 'Project' && node.selectionStart === 1 && node.selectionEnd === 4, searchNode)).toBe(true)
  await recent.click()
  await search.fill('')
  expect(await page.getByRole('button', { name: 'Previous', exact: true }).isVisible()).toBe(false)
  expect(await page.getByRole('navigation', { name: 'Library navigation', exact: true }).getByRole('button', { name: 'New', exact: true }).count()).toBe(1)
  expect(await page.getByRole('navigation', { name: 'File type', exact: true }).count()).toBe(0)
  await page.getByRole('button', { name: '网页示例.html Project files', exact: true }).waitFor()
  node = await row.elementHandle()
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
  const folderTrigger = page.getByRole('button', { name: 'New', exact: true })
  const folderTriggerNode = await folderTrigger.elementHandle()
  await folderTrigger.click()
  await page.getByRole('menuitem', { name: 'New folder', exact: true }).click()
  const folderDialog = page.getByRole('dialog', { name: 'New folder', exact: true })
  const folderName = folderDialog.getByRole('textbox', { name: 'Name', exact: true })
  await folderName.fill('Templates')
  const folderNameNode = await folderName.elementHandle()
  await folderName.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
  await expect.poll(() => folderDialog.getByRole('button', { name: 'Save', exact: true }).getAttribute('aria-disabled')).toBe('false')
  await folderDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await folderDialog.getByRole('alert').waitFor()
  expect(await folderName.evaluate((current, previous) => current === previous, folderNameNode)).toBe(true)
  expect(await folderName.evaluate(current => current instanceof HTMLInputElement
    && [current.selectionStart, current.selectionEnd])).toEqual([1, 4])
  failFolder = false
  await folderDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await folderDialog.waitFor({ state: 'detached' })
  expect(folderWrites).toHaveLength(2)
  expect(folderWrites[1]).toEqual(folderWrites[0])
  expect(await folderTrigger.evaluate((current, previous) =>
    current === previous && current === document.activeElement, folderTriggerNode)).toBe(true)
  await page.getByRole('button', { name: 'Templates Project files', exact: true }).waitFor()
  expect(await mineTab.getAttribute('aria-current')).toBe('page')
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 740, 700, 390]) {
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
      {
        expect(await page.locator('body').evaluate(current => current.scrollWidth <= current.clientWidth + 1)).toBe(true)
        const heading = page.getByRole('heading', { name: 'Libraries', exact: true })
        const header = heading.locator('xpath=ancestor::nav')
        expect(await header.evaluate(current => current.scrollWidth <= current.clientWidth + 1)).toBe(true)
        expect(await upload.evaluate((current, previous) => current === previous, uploadNode)).toBe(true)
        expect(await search.evaluate((current, previous) => current === previous, searchNode)).toBe(true)
        const searchBounds = (await search.locator('..').boundingBox())!
        if (width >= 700) expect(searchBounds.width).toBeLessThanOrEqual(240)
        const longFile = page.getByRole('button', { name: `${files[files.length - 1]!.entry.name} Project files`, exact: true })
        expect(await longFile.evaluate(current => current.scrollWidth <= current.clientWidth + 1)).toBe(true)
        expect(await page.getByRole('navigation', { name: 'Library navigation', exact: true }).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
        expect(await folderTrigger.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true)
        if (width === 390) {
          const navigation = page.getByRole('navigation', { name: 'Library navigation', exact: true })
          const main = upload.locator('xpath=ancestor::header/..')
          expect(await navigation.getByRole('button', { name: 'New', exact: true }).evaluate(node => node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1)).toBe(true)
          const navigationScroll = await navigation.evaluate(node => node.scrollTop)
          await main.evaluate((node) => { node.scrollTop = 80 })
          expect(await main.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
          expect(await navigation.evaluate(node => node.scrollTop)).toBe(navigationScroll)
          await navigation.evaluate((node) => { node.scrollTop = 40 })
          expect(await main.evaluate(node => node.scrollTop)).toBe(80)
          await main.evaluate((node) => { node.scrollTop = 0 })
          await navigation.evaluate((node, scrollTop) => { node.scrollTop = scrollTop }, navigationScroll)
        }
        await page.screenshot({ path: join(screenshots, `library-home-${theme}-${width}-list.png`) })
      }
      const rowBounds = await row.boundingBox()
      fail = true
      await search.fill(await search.inputValue() ? '' : 'Project')
      const readError = page.getByRole('region', { name: 'Could not load the library. Retry.', exact: true })
      await readError.waitFor()
      failMove = true
      await action.click()
      await page.getByRole('menuitem', { name: 'Move', exact: true }).click()
      const writeError = page.getByRole('region', { name: 'Save failed. Please retry.', exact: true })
      await writeError.waitFor()
      const writeNode = await writeError.elementHandle()
      const readBounds = (await readError.boundingBox())!, writeBounds = (await writeError.boundingBox())!
      expect(readBounds.y + readBounds.height).toBeLessThanOrEqual(writeBounds.y)
      expect(await row.boundingBox()).toEqual(rowBounds)
      expect(await row.evaluate((current, previous) => current === previous, node)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-home-errors-${theme}-${width}.png`) })
      fail = false
      await retry.click()
      await readError.waitFor({ state: 'detached' })
      expect(await writeError.evaluate((current, previous) => current === previous, writeNode)).toBe(true)
      failMove = false
      await action.click()
      await page.getByRole('menuitem', { name: 'Move', exact: true }).click()
      await writeError.waitFor({ state: 'detached' })
      await page.getByRole('dialog', { name: 'Move', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click()
      await folderTrigger.click()
      await page.getByRole('menuitem', { name: 'New folder', exact: true }).click()
      const form = page.getByRole('dialog', { name: 'New folder', exact: true })
      const name = form.getByRole('textbox', { name: 'Name', exact: true }), nameNode = await name.elementHandle()
      expect(await name.evaluate(node => node === document.activeElement)).toBe(true)
      await name.fill('A long folder name 中文文件夹')
      await name.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(2, 8) })
      await settleDialog(form)
      expect(await form.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-folder-form-${theme}-${width}.png`) })
      expect(await form.getByRole('button', { name: 'Change', exact: true }).count()).toBe(0)
      expect(await name.evaluate((node, previous) => node === previous && node instanceof HTMLInputElement
        && node.value === 'A long folder name 中文文件夹' && node.selectionStart === 2 && node.selectionEnd === 8, nameNode)).toBe(true)
      await name.press('Escape')
      await page.getByRole('button', { name: 'Discard', exact: true }).click()
      expect(await folderTrigger.evaluate(node => node === document.activeElement)).toBe(true)
      await upload.click()
      if (await mineTab.getAttribute('aria-current') !== 'page') {
        const uploadPicker = page.getByRole('dialog', { name: 'Choose upload destination', exact: true })
        await uploadPicker.getByRole('button', { name: /Project files/ }).waitFor()
        await settleDialog(uploadPicker)
        expect(await uploadPicker.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
        expect(await uploadPicker.getByRole('searchbox').evaluate(node => node.getBoundingClientRect().height <= 36)).toBe(true)
        await page.screenshot({ path: join(screenshots, `library-upload-picker-${theme}-${width}.png`) })
        await uploadPicker.getByRole('button', { name: /Project files/ }).click()
        await uploadPicker.getByRole('button', { name: 'Choose', exact: true }).click()
      }
      const uploadDialog = page.getByRole('dialog', { name: 'Upload files', exact: true })
      const chooseFiles = uploadDialog.getByRole('button', { name: 'Choose files', exact: true })
      const submitUpload = uploadDialog.getByRole('button', { name: 'Upload files', exact: true })
      selectionCount = 0; failUpload = true
      const writesBefore = uploadWrites.length
      await chooseFiles.click()
      const selectedFile = uploadDialog.getByText('中文参考资料.md · 1 KB', { exact: true })
      await selectedFile.waitFor()
      const selectedNode = await selectedFile.elementHandle()
      await submitUpload.click()
      const uploadError = uploadDialog.getByRole('region', { name: 'Save failed. Please retry.', exact: true })
      await uploadError.waitFor()
      const uploadErrorNode = await uploadError.elementHandle()
      await settleDialog(uploadDialog)
      const submitBounds = await submitUpload.boundingBox()
      await chooseFiles.click()
      const selectionError = uploadDialog.getByRole('region', { name: 'Could not select files. Retry.', exact: true })
      await selectionError.waitFor()
      const selectionBounds = (await selectionError.boundingBox())!, uploadBounds = (await uploadError.boundingBox())!
      expect(selectionBounds.y + selectionBounds.height).toBeLessThanOrEqual(uploadBounds.y)
      expect(await submitUpload.boundingBox()).toEqual(submitBounds)
      await page.screenshot({ path: join(screenshots, `library-upload-errors-${theme}-${width}.png`) })
      await chooseFiles.click()
      await selectionError.waitFor({ state: 'detached' })
      expect(await uploadError.evaluate((current, previous) => current === previous, uploadErrorNode)).toBe(true)
      expect(await selectedFile.evaluate((current, previous) => current === previous, selectedNode)).toBe(true)
      expect(await submitUpload.boundingBox()).toMatchObject({
        x: submitBounds!.x, width: submitBounds!.width, height: submitBounds!.height,
      })
      failUpload = false
      await submitUpload.click()
      await uploadDialog.waitFor({ state: 'detached' })
      expect(uploadWrites.slice(writesBefore)).toHaveLength(3)
      expect(uploadWrites[writesBefore + 1]).toEqual(uploadWrites[writesBefore])
      expect(await upload.evaluate(node => node === document.activeElement)).toBe(true)
    }
  }
  for (const width of [1050, 1030, 610, 580, 470, 450]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.locator('body').evaluate(current => current.scrollWidth <= current.clientWidth + 1)).toBe(true)
    expect(await search.evaluate((current, previous) => current === previous, searchNode)).toBe(true)
    expect(await upload.evaluate((current, previous) => current === previous, uploadNode)).toBe(true)
    expect(await upload.evaluate((current) => {
      const rect = current.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
    })).toBe(true)
    await page.screenshot({ path: join(screenshots, `library-home-responsive-${width}.png`) })
  }
  includeSharedRecent = true
  const writesBeforeScopeCheck = [folderWrites.length, uploadWrites.length, memberWrites.length]
  for (const scene of [{ theme: 'light', width: 1440 }, { theme: 'dark', width: 600 }] as const) {
    await page.emulateMedia({ colorScheme: scene.theme })
    await page.setViewportSize({ width: scene.width, height: 900 })
    await recent.click()
    await search.fill('Team handbook')
    const sharedFile = page.getByRole('button', { name: `${teamFile.name} ${teamLibrary.name}`, exact: true })
    await sharedFile.waitFor()
    const rootGate = Promise.withResolvers<undefined>()
    onTestFinished(() => { rootGate.resolve(undefined) })
    refreshGate = rootGate.promise
    const before = reads
    await mineTab.click()
    await expect.poll(() => reads).toBe(before + 1)
    expect(await sharedFile.count()).toBe(0)
    expect(await page.getByText('No matching files', { exact: true }).count()).toBe(0)
    await search.focus()
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
    fail = true; rootGate.resolve(undefined); refreshGate = undefined
    const error = page.getByRole('region', { name: 'Could not load the library. Retry.', exact: true })
    await error.waitFor()
    expect(await sharedFile.count()).toBe(0)
    expect(await search.evaluate((node, previous) => node === previous && node === document.activeElement
      && node instanceof HTMLInputElement
      && node.selectionStart === 1 && node.selectionEnd === 4, searchNode)).toBe(true)
    await settleDialog(page.locator('body'))
    await page.screenshot({ path: join(screenshots, `library-personal-isolation-${scene.theme}-${scene.width}.png`) })
    const retryGate = Promise.withResolvers<undefined>()
    onTestFinished(() => { retryGate.resolve(undefined) })
    refreshGate = retryGate.promise
    const beforeRetry = reads, errorNode = await error.elementHandle(), retryNode = await retry.elementHandle()
    await retry.focus(); await retry.press('Enter'); await retry.press(' ')
    await expect.poll(() => reads).toBe(beforeRetry + 1)
    expect(await error.evaluate((node, previous) => node === previous, errorNode)).toBe(true)
    expect(await retry.evaluate((node, previous) => node === previous && node === document.activeElement, retryNode)).toBe(true)
    fail = false; retryGate.resolve(undefined); refreshGate = undefined
    await error.waitFor({ state: 'detached' })
    await page.getByText('No matching files', { exact: true }).waitFor()
    expect(await sharedFile.count()).toBe(0)
    expect(await search.evaluate((node, previous) => node === previous && node === document.activeElement
      && node instanceof HTMLInputElement
      && node.value === 'Team handbook' && node.selectionStart === 1 && node.selectionEnd === 4, searchNode)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  expect([folderWrites.length, uploadWrites.length, memberWrites.length]).toEqual(writesBeforeScopeCheck)
  includeSharedRecent = false
  await search.fill('')
  await mineTab.click()
  await page.getByRole('button', { name: 'Templates Project files', exact: true }).click()
  await page.getByText('No files yet', { exact: true }).waitFor()
  const folderPath = page.getByRole('navigation', { name: 'Folder path', exact: true })
  await folderPath.getByRole('button', { name: 'Templates', exact: true }).waitFor()
  await folderTrigger.click()
  await page.getByRole('menuitem', { name: 'New folder', exact: true }).click()
  const nestedFolderForm = page.getByRole('dialog', { name: 'New folder', exact: true })
  await nestedFolderForm.getByRole('textbox', { name: 'Name', exact: true }).waitFor()
  expect(await nestedFolderForm.getByRole('button', { name: 'Change', exact: true }).count()).toBe(0)
  await nestedFolderForm.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await folderTrigger.evaluate(node => node === document.activeElement)).toBe(true)
  await upload.click()
  const nestedUpload = page.getByRole('dialog', { name: 'Upload files', exact: true })
  await nestedUpload.getByRole('button', { name: 'Choose files', exact: true }).waitFor()
  expect(await page.getByRole('dialog', { name: 'Choose upload destination', exact: true }).count()).toBe(0)
  selectionCount = 0; failUpload = true
  await nestedUpload.getByRole('button', { name: 'Choose files', exact: true }).click()
  await nestedUpload.getByText('中文参考资料.md · 1 KB', { exact: true }).waitFor()
  const nestedSubmit = nestedUpload.getByRole('button', { name: 'Upload files', exact: true })
  await nestedSubmit.click()
  await nestedUpload.getByRole('alert').waitFor()
  expect(await nestedSubmit.evaluate(node => node === document.activeElement)).toBe(true)
  failUpload = false
  await nestedSubmit.click()
  await nestedUpload.waitFor({ state: 'detached' })
  expect(uploadWrites.at(-1)).toMatchObject({ libraryId: library.id, parentId: folder.id })
  expect(await upload.evaluate(node => node === document.activeElement)).toBe(true)
  await page.getByText('No files yet', { exact: true }).waitFor()
  await folderPath.getByRole('button', { name: 'My files', exact: true }).click()
  await page.getByRole('button', { name: 'Templates Project files', exact: true }).waitFor()
  const nativeFolder = page.getByRole('navigation', { name: 'Library navigation', exact: true }).getByRole('button', { name: 'Templates', exact: true })
  const nativeFolderNode = await nativeFolder.elementHandle()
  expect(await nativeFolder.getAttribute('aria-expanded')).toBe('true')
  await nativeFolder.click()
  await page.getByText('No files yet', { exact: true }).waitFor()
  expect(await nativeFolder.getAttribute('aria-expanded')).toBe('true')
  expect(await nativeFolder.getAttribute('aria-current')).toBe('page')
  const emptyDirectory = page.getByText('No files yet', { exact: true }), emptyDirectoryNode = await emptyDirectory.elementHandle()
  const directoryReads = reads
  await nativeFolder.click()
  expect(await nativeFolder.getAttribute('aria-expanded')).toBe('false')
  await nativeFolder.click()
  expect(await nativeFolder.getAttribute('aria-expanded')).toBe('true')
  expect(await emptyDirectory.evaluate((node, previous) => node === previous, emptyDirectoryNode)).toBe(true)
  expect(reads).toBe(directoryReads)
  expect(await nativeFolder.evaluate((node, previous) => node === previous, nativeFolderNode)).toBe(true)
  const teamRoot = page.getByRole('button', { name: 'Team references', exact: true })
  await teamRoot.click()
  await page.getByRole('heading', { name: 'Team references', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Team handbook.md Team references', exact: true }).waitFor()
  expect(await page.getByRole('button', { name: 'Upload files', exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'More actions · Team handbook.md', exact: true }).count()).toBe(0)
  const teamRootNode = await teamRoot.elementHandle()
  const sharedRow = page.getByRole('button', { name: 'Team handbook.md Team references', exact: true })
  const sharedRowNode = await sharedRow.elementHandle()
  for (const scene of [{ theme: 'light', width: 1440 }, { theme: 'dark', width: 600 }] as const) {
    await page.emulateMedia({ colorScheme: scene.theme })
    await page.setViewportSize({ width: scene.width, height: 900 })
    const versionStep = scene.theme === 'light' ? 1 : 0
    teamLibrary = { ...teamLibrary, role: 'EDITOR', canManage: true, version: teamLibrary.version + versionStep }
    await search.fill('Team')
    await page.getByRole('button', { name: 'Upload files', exact: true }).waitFor()
    const add = page.getByRole('button', { name: 'New: Team references', exact: true })
    const rootRow = teamRoot.locator('..')
    await teamRoot.hover()
    const rowFill = await rootRow.evaluate(node => getComputedStyle(node).backgroundColor)
    expect(rowFill).not.toBe('rgba(0, 0, 0, 0)')
    expect(await teamRoot.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    await add.hover()
    expect(await rootRow.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(rowFill)
    expect(await add.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    await page.screenshot({ path: join(screenshots, `library-shared-row-hover-${scene.theme}-${scene.width}.png`) })
    await add.focus()
    await add.click()
    expect(await page.getByRole('menuitem').allTextContents()).toEqual(['Upload files', 'New folder'])
    await page.keyboard.press('Escape')
    const permissionGate = Promise.withResolvers<undefined>()
    onTestFinished(() => { permissionGate.resolve(undefined) })
    teamEntriesGate = permissionGate.promise
    teamLibrary = { ...teamLibrary, role: 'VIEWER', canManage: false, version: teamLibrary.version + versionStep }
    const before = teamEntryReads
    await search.fill('handbook')
    await expect.poll(() => teamEntryReads).toBe(before + 1)
    await add.waitFor({ state: 'detached' })
    expect(await page.getByRole('alert').count()).toBe(0)
    failTeamEntries = true
    permissionGate.resolve(undefined); teamEntriesGate = undefined
    await page.getByRole('alert').waitFor()
    expect(await page.getByRole('button', { name: 'Upload files', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'More actions · Team handbook.md', exact: true }).count()).toBe(0)
    expect(await teamRoot.evaluate((node, previous) => node === previous, teamRootNode)).toBe(true)
    expect(await sharedRow.evaluate((node, previous) => node === previous, sharedRowNode)).toBe(true)
    expect(await search.evaluate((node, previous) => node === previous && node === document.activeElement
      && node instanceof HTMLInputElement && node.value === 'handbook', searchNode)).toBe(true)
    await settleDialog(page.locator('body'))
    await page.screenshot({ path: join(screenshots, `library-permission-sync-${scene.theme}-${scene.width}.png`) })
    const retry = page.getByRole('button', { name: 'Retry', exact: true })
    const retryNode = await retry.elementHandle()
    const retryGate = Promise.withResolvers<undefined>()
    onTestFinished(() => { retryGate.resolve(undefined) })
    teamEntriesGate = retryGate.promise
    failTeamEntries = false
    const retriesBefore = teamDirectoryReads
    await retry.click(); await retry.dispatchEvent('click')
    await expect.poll(() => teamDirectoryReads).toBe(retriesBefore + 1)
    expect(await page.getByRole('alert').count()).toBe(1)
    expect(await retry.evaluate((node, previous) => node === previous && node === document.activeElement, retryNode)).toBe(true)
    retryGate.resolve(undefined); teamEntriesGate = undefined
    await page.getByRole('alert').waitFor({ state: 'detached' })
    expect(await sharedRow.evaluate((node, previous) => node === previous, sharedRowNode)).toBe(true)
    expect(await search.evaluate(node => node === document.activeElement)).toBe(true)
  }
  for (const scene of [{ theme: 'light', width: 1440 }, { theme: 'dark', width: 600 }] as const) {
    await page.emulateMedia({ colorScheme: scene.theme })
    await page.setViewportSize({ width: scene.width, height: 900 })
    teamLibrary = { ...teamLibrary, role: 'OWNER', canManage: true }
    const memberQuery = scene.theme === 'light' ? 'Team' : 'handbook'
    await search.fill(memberQuery)
    await page.getByRole('button', { name: 'Upload files', exact: true }).waitFor()
    const members = page.getByRole('button', { name: 'Members', exact: true })
    const membersNode = await members.elementHandle()
    teamLibrary = { ...teamLibrary, role: 'VIEWER', canManage: false }
    failTeamMembers = true
    await members.click()
    const dialog = page.getByRole('dialog', { name: 'Manage members', exact: true })
    await dialog.getByRole('alert').waitFor()
    const beforeClose = teamMetadataReads
    if (scene.theme === 'light') await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
    else await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    expect(await page.getByRole('button', { name: 'Upload files', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'More actions · Team handbook.md', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'New: Team references', exact: true }).count()).toBe(0)
    expect(await sharedRow.evaluate((node, previous) =>
      node === previous && node instanceof HTMLButtonElement && !node.draggable, sharedRowNode)).toBe(true)
    expect(await members.evaluate((node, previous) => node === previous && node === document.activeElement, membersNode)).toBe(true)
    expect(await search.evaluate((node, previous) => node === previous && node instanceof HTMLInputElement, searchNode)).toBe(true)
    expect(await search.inputValue()).toBe(memberQuery)
    expect(teamMetadataReads).toBe(beforeClose)
    expect(await page.getByRole('alert').count()).toBe(0)
    failTeamMetadata = true
    await search.fill(`${memberQuery} `)
    await page.getByRole('alert').waitFor()
    expect(teamMetadataReads).toBe(beforeClose + 1)
    await settleDialog(page.locator('body'))
    await page.screenshot({ path: join(screenshots, `library-member-return-${scene.theme}-${scene.width}.png`) })
    expect(await sharedRow.evaluate((node, previous) => node === previous, sharedRowNode)).toBe(true)
    failTeamMembers = false; failTeamMetadata = false
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.getByRole('alert').waitFor({ state: 'detached' })
    expect(await page.getByRole('button', { name: 'Upload files', exact: true }).count()).toBe(0)
  }
  await page.getByRole('button', { name: 'Recent', exact: true }).click()
  expect(await page.getByRole('button', { name: 'New: Team references', exact: true }).count()).toBe(0)
  await search.fill('')
  await teamRoot.click()
  await page.getByRole('button', { name: 'Team handbook.md Team references', exact: true }).waitFor()
  await mineTab.click()
  await page.getByRole('button', { name: 'Templates Project files', exact: true }).waitFor()
  await page.setViewportSize({ width:1440,height:900 })
  await page.getByRole('button',{ name:'New shared space',exact:true }).click()
  const createTeam=page.getByRole('dialog',{ name:'New shared space',exact:true })
  await createTeam.getByRole('textbox',{ name:'Name',exact:true }).fill('Shared design library')
  await createTeam.getByRole('button',{ name:'Save',exact:true }).click()
  await createTeam.waitFor({ state:'detached' })
  const ownedRoot=page.getByRole('navigation', { name: 'Library navigation', exact: true })
    .getByRole('button',{ name:'Shared design library',exact:true })
  await ownedRoot.waitFor()
  const ownedRootNode=await ownedRoot.elementHandle()
  for (const scene of [{ theme: 'light', width: 1440 }, { theme: 'dark', width: 600 }] as const) {
    await page.emulateMedia({ colorScheme: scene.theme })
    await page.setViewportSize({ width: scene.width, height: 900 })
    const parentId = sharedFolders.at(-1)?.id ?? null
    const heading = page.getByRole('heading', { name: parentId ? sharedFolders.at(-1)!.name : 'Shared design library', exact: true })
    await heading.waitFor()
    const headingNode = await heading.elementHandle()
    await folderTrigger.click()
    await page.getByRole('menuitem', { name: 'New folder', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'New folder', exact: true })
    const input = form.getByRole('textbox', { name: 'Name', exact: true })
    const inputNode = await input.elementHandle()
    await input.fill(`Shared folder ${scene.width}`)
    await input.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 5) })
    failFolder = true
    const start = folderWrites.length
    const save = form.getByRole('button', { name: 'Save', exact: true })
    await save.click()
    await form.getByRole('alert').waitFor()
    expect(folderWrites.at(-1)).toMatchObject({ libraryId: ownedTeam!.id, parentId })
    expect(await input.evaluate((node, previous) => node === previous && node instanceof HTMLInputElement
      && node.selectionStart === 1 && node.selectionEnd === 5, inputNode)).toBe(true)
    failFolder = false
    await save.click()
    await form.waitFor({ state: 'detached' })
    expect(folderWrites.slice(start)).toHaveLength(2)
    expect(folderWrites.at(-1)).toEqual(folderWrites.at(-2))
    expect(await heading.evaluate((node, previous) => node === previous, headingNode)).toBe(true)
    expect(await folderTrigger.evaluate(node => node === document.activeElement)).toBe(true)
    const child = page.getByRole('button', { name: `Shared folder ${scene.width} Shared design library`, exact: true })
    await child.waitFor()
    const childRow = child.locator('xpath=..')
    expect(await childRow.locator('[data-empty]').isVisible()).toBe(scene.width === 1440)
    expect(await childRow.evaluate(node => getComputedStyle(node).gridTemplateRows.split(' ').length)).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(screenshots, `library-shared-create-${scene.theme}-${scene.width}.png`) })
    await child.click()
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  const teamActions=page.getByRole('button',{ name:'Library actions: Shared design library',exact:true })
  await teamActions.click()
  await page.getByRole('menuitem',{ name:'Manage members',exact:true }).click()
  const membersDialog=page.getByRole('dialog').filter({ has: page.getByText('Shared design library', { exact: true }) })
  await page.getByRole('dialog', { name: 'Manage members', exact: true }).waitFor()
  const picker=membersDialog.getByRole('button',{ name:'Bob',exact:true })
  await picker.click()
  const addMember=membersDialog.getByRole('button',{ name:'Add members',exact:true })
  await expect.poll(()=>addMember.getAttribute('aria-disabled')).toBe('false')
  await addMember.click()
  await membersDialog.getByRole('alert').waitFor()
  const pickerNode=await picker.elementHandle()
  await membersDialog.getByRole('button',{ name:'Retry',exact:true }).click()
  await expect.poll(()=>addMember.getAttribute('aria-disabled')).toBe('false')
  expect(await picker.evaluate((node,previous)=>node===previous,pickerNode)).toBe(true)
  expect(await picker.getAttribute('aria-pressed')).toBe('true')
  failMember=false
  await addMember.click()
  await membersDialog.getByRole('button', { name: 'Access: Bob', exact: true }).waitFor()
  expect(memberWrites).toHaveLength(2)
  expect(await ownedRoot.evaluate((node,previous)=>node===previous,ownedRootNode)).toBe(true)
  const access=membersDialog.getByRole('button',{ name:'Access: Bob',exact:true })
  await expect.poll(()=>access.getAttribute('aria-disabled')).toBe('false')
  await access.click()
  await page.getByRole('menuitem', { name: 'Can edit', exact: true }).click()
  await expect.poll(()=>access.textContent()).toBe('Can edit')
  for (const scene of [{ theme:'light',width:1440 },{ theme:'dark',width:600 }]) {
    await page.emulateMedia({ colorScheme:scene.theme as 'light'|'dark' })
    await page.setViewportSize({ width:scene.width,height:900 })
    await settleDialog(membersDialog)
    const box=await membersDialog.boundingBox()
    expect(box && box.x>=0 && box.x+box.width<=scene.width && box.width<=560).toBe(true)
    await mkdir(join(REPO_ROOT,'.artifacts/library-review-nov16'),{ recursive:true })
    await page.screenshot({ path:join(REPO_ROOT,`.artifacts/library-review-nov16/team-members-${scene.theme}.png`) })
  }
  await page.setViewportSize({ width:1440,height:900 })
  await page.emulateMedia({ colorScheme:'light' })
  await membersDialog.getByRole('button', { name: 'Library actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Transfer ownership', exact: true }).click()
  const transferDialog=page.getByRole('dialog',{ name:'Transfer ownership',exact:true })
  await transferDialog.getByRole('button', { name: 'Bob', exact: true }).click()
  await expect.poll(()=>transferDialog.getByRole('button',{ name:'Transfer ownership',exact:true }).getAttribute('aria-disabled')).toBe('false')
  await transferDialog.getByRole('button',{ name:'Transfer ownership',exact:true }).click()
  await membersDialog.waitFor()
  await expect.poll(()=>membersDialog.getByRole('button',{ name:'Add members',exact:true }).count()).toBe(0)
  await membersDialog.getByRole('button',{ name:'Close',exact:true }).last().click()
  await membersDialog.waitFor({ state:'detached' })
  expect(await teamActions.evaluate(node=>node===document.activeElement)).toBe(true)
  await teamActions.click()
  expect(await page.getByRole('menuitem').allTextContents()).toEqual(['Manage members'])
  await page.keyboard.press('Escape')
  for (const scene of [{ theme: 'light', width: 1440 }, { theme: 'dark', width: 600 }] as const) {
    await page.emulateMedia({ colorScheme: scene.theme })
    await page.setViewportSize({ width: scene.width, height: 900 })
    await ownedRoot.click()
    const directoryFolder = page.getByRole('button', { name: 'Shared folder 1440 Shared design library', exact: true })
    await directoryFolder.waitFor()
    const recentGate = Promise.withResolvers<undefined>()
    onTestFinished(() => { recentGate.resolve(undefined) })
    refreshGate = recentGate.promise
    const before = reads
    await recent.click()
    await expect.poll(() => reads).toBe(before + 1)
    expect(await directoryFolder.count()).toBe(0)
    expect(await search.evaluate((node, previous) => node === previous, searchNode)).toBe(true)
    expect(await page.getByText('No files yet', { exact: true }).count()).toBe(0)
    fail = true; recentGate.resolve(undefined); refreshGate = undefined
    const readError = page.getByRole('region', { name: 'Could not load the library. Retry.', exact: true })
    await readError.waitFor()
    expect(await directoryFolder.count()).toBe(0)
    await page.screenshot({ path: join(screenshots, `library-recent-isolation-${scene.theme}-${scene.width}.png`) })
    const retryGate = Promise.withResolvers<undefined>()
    onTestFinished(() => { retryGate.resolve(undefined) })
    refreshGate = retryGate.promise
    const attempts = reads, retryNode = await retry.elementHandle(), alertNode = await readError.elementHandle()
    await retry.focus(); await retry.press('Enter'); await retry.press(' ')
    await expect.poll(() => reads).toBe(attempts + 1)
    expect(await retry.evaluate((node, previous) => node === previous && node === document.activeElement, retryNode)).toBe(true)
    expect(await readError.evaluate((node, previous) => node === previous, alertNode)).toBe(true)
    fail = false; retryGate.resolve(undefined); refreshGate = undefined
    await readError.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: `${files[0]!.entry.name} Project files`, exact: true }).waitFor()
    expect(await directoryFolder.count()).toBe(0)
    expect(await search.evaluate((node, previous) => node === previous && node === document.activeElement, searchNode)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await mineTab.click()
  let expectedDraft = 'Keep this draft'
  const readDraft = async () => (await composer.locator('p').allTextContents()).join('\n')
  await page.getByRole('button', { name: 'Create in conversation', exact: true }).click()
  expectedDraft += '\nHelp me create a file to save to my library. First ask me about its purpose, main content and file format. Once the requirements are clear, create an actual file for me to preview.'
  await expect.poll(readDraft).toBe(expectedDraft)
  expect(await page.locator('[data-conversation-session]').first().getAttribute('data-conversation-session')).toBe(draftSession)
  expect(await composer.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await page.getByRole('menu').count()).toBe(0)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('[data-sidebar-drawer]').waitFor({ state: 'detached' })
  for (const creation of [
    { page: 'Skills', button: 'Create skill', prompt: 'Help me create a skill that […]. Clarify my needs in chat, '
      + 'generate the complete skill, choose a short reusable category and save it to my skills after confirmation.' },
    { page: 'Expert kits', button: 'Create expert', prompt: 'Help me create an expert in […]. My background and experience: […]. '
      + 'Clarify my needs in chat, generate the instructions and reference files, then save to Mine after confirmation.' },
    { page: 'Expert kits', tab: 'teams', button: 'Create team in chat', prompt: 'Help me create an expert team for […]. '
      + 'Clarify the goal in chat, select existing experts and design duties, deliverables and coordinator rules, '
      + 'then save to Mine after confirmation.' },
  ]) {
    await page.getByRole('button', { name: creation.page, exact: true }).click()
    if (creation.tab) await page.locator('#aag-library-tab-teams').click()
    await page.getByRole('button', { name: creation.button, exact: true }).click()
    expectedDraft += `\n${creation.prompt}`
    await expect.poll(readDraft).toBe(expectedDraft)
    expect(await page.locator('[data-conversation-session]').first().getAttribute('data-conversation-session')).toBe(draftSession)
    expect(await composer.evaluate(node => node === document.activeElement)).toBe(true)
  }
  const originalWorkspace = scaffold.ctx.workspaceRegistry.list().find(workspace => workspace.sessionIds.some(id => id === draftSession))
  if (!originalWorkspace) throw new Error('Missing original workspace')
  await page.locator(`[data-row-key="workspace:${originalWorkspace.id}"]`).hover()
  await page.getByRole('button', { name: 'New session in workspace', exact: true }).click()
  await expect.poll(readDraft).toBe(expectedDraft)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
