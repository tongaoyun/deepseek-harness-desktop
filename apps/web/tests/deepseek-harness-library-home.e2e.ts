/** File-first product views exercised in the real native Web composition. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Locator } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, writeComposerDraft } from './support.ts'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'

async function settleDialog(dialog: Locator): Promise<void> {
  await dialog.evaluate(async (node) => {
    const animations = node.getAnimations({ subtree: true })
    for (let parent = node.parentElement; parent; parent = parent.parentElement) animations.push(...parent.getAnimations())
    await Promise.all(animations.filter(animation => animation.effect?.getTiming().iterations !== Infinity)
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
  const now = '2026-11-14T01:00:00Z'
  const files = ['Project proposal.docx', 'Review presentation.pptx', '网页示例.html', '参考图片.png',
    '资料归档与项目交付说明-Long project delivery documents and reference templates.zip'].map((name, i) => ({
    entry: { id: `22222222-2222-4222-8222-${String(i + 1).padStart(12, '0')}`, libraryId: '11111111-1111-4111-8111-111111111111',
      parentId: null, name, kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'application/octet-stream', sizeBytes: (i + 1) * 5120,
      version: 1, createdAt: now, updatedAt: now },
    libraryName: 'Project files', canManage: true, lastAccessedAt: now, sourceKind: i === 0 ? 'CONVERSATION' : 'UPLOAD', sourceSessionId: i === 0 ? 'native-source' : null,
  }))
  const library = { id: files[0]!.entry.libraryId, name: 'Project files', description: '', scope: 'PERSONAL',
    ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: now, updatedAt: now }
  const teamLibrary = { ...library, id: '66666666-6666-4666-8666-666666666666', scope: 'TEAM', name: 'Team references', role: 'VIEWER', canManage: false }
  const teamFile = { ...files[0]!.entry, id: '77777777-7777-4777-8777-777777777777', libraryId: teamLibrary.id, name: 'Team handbook.md' }
  const folder = { ...files[0]!.entry, id: '55555555-5555-4555-8555-555555555555', name: 'Templates', kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0 }
  let ownedTeam: typeof library | undefined
  let teamCreated = false, failMember = true
  let grants = [{ subjectType:'EMPLOYEE',subjectId:'employee',name:'Test employee',role:'OWNER' }]
  const memberWrites: unknown[] = []
  let folderCreated = false
  const folderWrites: unknown[] = []
  const uploadWrites: unknown[] = []
  const selections = [
    { selectionId: '33333333-3333-4333-8333-333333333333', name: '中文参考资料.md', sizeBytes: 12 },
    { selectionId: '44444444-4444-4444-8444-444444444444', name: 'Another reference.md', sizeBytes: 24 },
  ]
  let selectionCount = 0, failUpload = true, failMove = false
  let failFolder = true
  let fail = false, reads = 0
  let refreshGate: Promise<undefined> | undefined
  await page.exposeFunction('__libraryHomeInvoke', async (method: string, input: { query?: string; sort?: string; direction?: string; view?: string; entryId?: string; parentId?: string | null; size?: number; libraryId?: string; subjectType?: string; subjectId?: string; employeeId?: string; role?: string; version?: number; name?: string; description?: string }) => {
    if (method === 'library.create') {
      ownedTeam = { ...library, id:'88888888-8888-4888-8888-888888888888', scope:'TEAM',name:input.name ?? '',description:input.description ?? '' }
      teamCreated = true
      return ownedTeam
    }
    if (method === 'library.members.list') {
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
    if (method === 'library.entries.list' && input.libraryId === ownedTeam?.id) return { data:[],pageIndex:1,pageSize:input.size??20,totalCount:0,totalPages:0 }
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee', displayName: 'Test employee' }
    if (method === 'library.entries.list' && input.libraryId === teamLibrary.id) return { data: [teamFile], pageIndex: 1, pageSize: input.size ?? 20, totalCount: 1, totalPages: 1 }
    if (method === 'library.entries.list' && input.size === 50) {
      const data = [...files.map(file => file.entry), ...(folderCreated ? [folder] : [])]
        .filter(entry => entry.parentId === (input.parentId ?? null))
      return { data, pageIndex: 1, pageSize: 50, totalCount: data.length, totalPages: data.length ? 1 : 0 }
    }
    if (method === 'library.files.list' || method === 'library.entries.list' && input.view === 'folder') {
      reads++
      if (refreshGate) await refreshGate
      if (fail) return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Read unavailable', true)) }
      const matches = files.filter(file => file.entry.name.toLowerCase().includes((input.query ?? '').toLowerCase()))
      const data = method === 'library.files.list' ? matches : [...matches.map(file => file.entry), ...(folderCreated ? [folder] : [])]
        .filter(entry => entry.parentId === (input.parentId ?? null) && entry.name.toLowerCase().includes((input.query ?? '').toLowerCase()))
      return { data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: data.length ? 1 : 0 }
    }
    if (method === 'library.get' && failMove) {
      failMove = false
      return { fixtureFailure: productFailure(new ProductError('EXTERNAL_SERVICE_ERROR', 'Move unavailable', true)) }
    }
    if (method === 'library.entries.delete') {
      const index = files.findIndex(value => value.entry.id === input.entryId)
      if (index >= 0) files.splice(index, 1)
      return true
    }
    if (method === 'library.personal.ensure' || method === 'library.get') return ownedTeam && input.libraryId === ownedTeam.id ? ownedTeam : input.libraryId === teamLibrary.id ? teamLibrary : library
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
  const node = await row.elementHandle()
  const upload = page.getByRole('button', { name: 'Upload files', exact: true }), uploadNode = await upload.elementHandle()
  const search = page.getByRole('searchbox', { name: 'Search names' }), searchNode = await search.elementHandle()
  await page.getByRole('button', { name: 'Grid', exact: true }).click()
  expect(await row.evaluate((current, previous) => current === previous, node)).toBe(true)
  await page.getByRole('button', { name: 'List', exact: true }).click()
  expect(await page.getByRole('button', { name: 'Refresh', exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Sort', exact: true }).count()).toBe(0)
  const mineTab = page.getByRole('navigation', { name: 'Library navigation', exact: true }).getByRole('button', { name: 'My files', exact: true })
  const bounds = await upload.boundingBox()
  const gate = Promise.withResolvers<undefined>()
  onTestFinished(() => { gate.resolve(undefined) })
  refreshGate = gate.promise
  await mineTab.focus(); await mineTab.press('Enter'); await mineTab.press(' ')
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
  const folderTrigger = page.getByRole('button', { name: 'New folder', exact: true })
  const folderTriggerNode = await folderTrigger.elementHandle()
  await folderTrigger.click()
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
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-catalog')
  await mkdir(screenshots, { recursive: true })
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
      for (const layout of ['List', 'Grid']) {
        await page.getByRole('button', { name: layout, exact: true }).click()
        expect(await page.locator('body').evaluate(current => current.scrollWidth <= current.clientWidth + 1)).toBe(true)
        const heading = page.getByRole('heading', { name: 'Libraries', exact: true })
        const header = heading.locator('xpath=ancestor::nav')
        expect(await header.evaluate(current => current.scrollWidth <= current.clientWidth + 1)).toBe(true)
        expect(await upload.evaluate((current, previous) => current === previous, uploadNode)).toBe(true)
        expect(await search.evaluate((current, previous) => current === previous, searchNode)).toBe(true)
        const searchBounds = (await search.locator('..').boundingBox())!
        if (width >= 700) expect(searchBounds.width).toBeLessThanOrEqual(240)
        if (width === 1440) {
          expect(Math.abs((await heading.boundingBox())!.y - (await upload.boundingBox())!.y)).toBeLessThanOrEqual(4)
        }
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
        await page.screenshot({ path: join(screenshots, `library-home-${theme}-${width}-${layout.toLowerCase()}.png`) })
      }
      const rowBounds = await row.boundingBox()
      fail = true
      const nextView = await mineTab.getAttribute('aria-current') === 'page' ? recent : mineTab
      await nextView.click()
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
      const form = page.getByRole('dialog', { name: 'New folder', exact: true })
      const name = form.getByRole('textbox', { name: 'Name', exact: true }), nameNode = await name.elementHandle()
      expect(await name.evaluate(node => node === document.activeElement)).toBe(true)
      await name.fill('A long folder name 中文文件夹')
      await name.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(2, 8) })
      await settleDialog(form)
      expect(await form.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-folder-form-${theme}-${width}.png`) })
      const change = form.getByRole('button', { name: 'Change', exact: true })
      await expect.poll(() => change.getAttribute('aria-disabled')).toBe('false')
      await change.click()
      const picker = page.getByRole('dialog', { name: 'Choose folder location', exact: true })
      await picker.getByRole('button', { name: /Project files/ }).waitFor()
      expect(await picker.getByRole('button', { name: 'New folder', exact: true }).count()).toBe(0)
      expect(await picker.getByRole('button', { name: 'Refresh', exact: true }).count()).toBe(0)
      expect(await picker.getByRole('searchbox').evaluate(node => node === document.activeElement)).toBe(true)
      await settleDialog(picker)
      expect(await picker.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      await page.screenshot({ path: join(screenshots, `library-folder-picker-${theme}-${width}.png`) })
      await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(await name.evaluate((node, previous) => node === previous && node instanceof HTMLInputElement
        && node.value === 'A long folder name 中文文件夹' && node.selectionStart === 2 && node.selectionEnd === 8, nameNode)).toBe(true)
      expect(await change.evaluate(node => node === document.activeElement)).toBe(true)
      await name.press('Escape')
      await page.getByRole('button', { name: 'Discard', exact: true }).click()
      expect(await folderTrigger.evaluate(node => node === document.activeElement)).toBe(true)
      await upload.click()
      if (await mineTab.getAttribute('aria-current') !== 'page') {
        const uploadPicker = page.getByRole('dialog', { name: 'Choose upload destination', exact: true })
        await uploadPicker.getByRole('button', { name: 'New folder', exact: true }).waitFor()
        await settleDialog(uploadPicker)
        expect(await uploadPicker.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
        expect(await uploadPicker.getByRole('searchbox').evaluate(node => node.getBoundingClientRect().height <= 36)).toBe(true)
        await page.screenshot({ path: join(screenshots, `library-upload-picker-${theme}-${width}.png`) })
        await uploadPicker.getByRole('button', { name: /Project files/ }).click()
        await uploadPicker.getByRole('button', { name: 'Choose', exact: true }).click()
      }
      const uploadDialog = page.getByRole('dialog', { name: 'Upload files', exact: true })
      const chooseFiles = uploadDialog.getByRole('button', { name: 'Choose local files', exact: true })
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
  await mineTab.click()
  await page.getByRole('button', { name: 'Templates Project files', exact: true }).click()
  await page.getByText('No files yet', { exact: true }).waitFor()
  const folderPath = page.getByRole('navigation', { name: 'Folder path', exact: true })
  await folderPath.getByRole('button', { name: 'Templates', exact: true }).waitFor()
  await folderTrigger.click()
  const nestedFolderForm = page.getByRole('dialog', { name: 'New folder', exact: true })
  await nestedFolderForm.getByText('Project files / Templates', { exact: true }).waitFor()
  await nestedFolderForm.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await folderTrigger.evaluate(node => node === document.activeElement)).toBe(true)
  await upload.click()
  const nestedUpload = page.getByRole('dialog', { name: 'Upload files', exact: true })
  await nestedUpload.getByText('Project files / Templates', { exact: true }).waitFor()
  expect(await page.getByRole('dialog', { name: 'Choose upload destination', exact: true }).count()).toBe(0)
  selectionCount = 0; failUpload = true
  await nestedUpload.getByRole('button', { name: 'Choose local files', exact: true }).click()
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
  await page.getByRole('button', { name: 'Recent', exact: true }).click()
  await teamRoot.click()
  expect(await teamRoot.getAttribute('aria-expanded')).toBe('true')
  await page.getByRole('button', { name: 'Team handbook.md Team references', exact: true }).waitFor()
  await mineTab.click()
  await page.getByRole('button', { name: 'Templates Project files', exact: true }).waitFor()
  await page.setViewportSize({ width:1440,height:900 })
  await page.getByRole('button',{ name:'New team library',exact:true }).click()
  const createTeam=page.getByRole('dialog',{ name:'New team library',exact:true })
  await createTeam.getByRole('textbox',{ name:'Name',exact:true }).fill('Shared design library')
  await createTeam.getByRole('button',{ name:'Save',exact:true }).click()
  await createTeam.waitFor({ state:'detached' })
  const ownedRoot=page.getByRole('button',{ name:'Shared design library',exact:true })
  await ownedRoot.waitFor()
  const ownedRootNode=await ownedRoot.elementHandle()
  const teamActions=page.getByRole('button',{ name:'Library actions: Shared design library',exact:true })
  await teamActions.click()
  await page.getByRole('menuitem',{ name:'Invite and manage members',exact:true }).click()
  const membersDialog=page.getByRole('dialog',{ name:'Invite and manage members',exact:true })
  await membersDialog.getByText('Test employee',{ exact:true }).waitFor()
  await membersDialog.getByRole('button',{ name:'Add members',exact:true }).click()
  const picker=membersDialog.getByRole('combobox',{ name:'Choose a member',exact:true })
  await picker.selectOption('bob')
  const addMember=membersDialog.getByRole('button',{ name:'Add members',exact:true })
  await expect.poll(()=>addMember.getAttribute('aria-disabled')).toBe('false')
  await addMember.click()
  await membersDialog.getByRole('alert').waitFor()
  const pickerNode=await picker.elementHandle()
  await membersDialog.getByRole('button',{ name:'Retry',exact:true }).click()
  await expect.poll(()=>addMember.getAttribute('aria-disabled')).toBe('false')
  expect(await picker.evaluate((node,previous)=>node===previous,pickerNode)).toBe(true)
  expect(await picker.inputValue()).toBe('bob')
  failMember=false
  await addMember.click()
  await membersDialog.getByText('Bob',{ exact:true }).waitFor()
  expect(memberWrites).toHaveLength(2)
  expect(await ownedRoot.evaluate((node,previous)=>node===previous,ownedRootNode)).toBe(true)
  const access=membersDialog.getByRole('combobox',{ name:'Access: Bob',exact:true })
  await expect.poll(()=>access.getAttribute('aria-disabled')).toBe('false')
  await access.selectOption('EDITOR')
  await expect.poll(()=>access.inputValue()).toBe('EDITOR')
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
  await expect.poll(()=>membersDialog.getByRole('button',{ name:'Transfer ownership',exact:true }).getAttribute('aria-disabled')).toBe('false')
  await membersDialog.getByRole('button',{ name:'Transfer ownership',exact:true }).click()
  const transferDialog=page.getByRole('dialog',{ name:'Transfer ownership',exact:true })
  await transferDialog.getByRole('combobox',{ name:'Choose a member',exact:true }).selectOption('bob')
  await expect.poll(()=>transferDialog.getByRole('button',{ name:'Transfer ownership',exact:true }).getAttribute('aria-disabled')).toBe('false')
  await transferDialog.getByRole('button',{ name:'Transfer ownership',exact:true }).click()
  await membersDialog.waitFor()
  await expect.poll(()=>membersDialog.getByRole('button',{ name:'Add members',exact:true }).count()).toBe(0)
  await membersDialog.getByRole('button',{ name:'Close',exact:true }).last().click()
  await membersDialog.waitFor({ state:'detached' })
  expect(await teamActions.evaluate(node=>node===document.activeElement)).toBe(true)
  await teamActions.click()
  expect(await page.getByRole('menuitem').allTextContents()).toEqual(['Invite and manage members'])
  await page.keyboard.press('Escape')
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
