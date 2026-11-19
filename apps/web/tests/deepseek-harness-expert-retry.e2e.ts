/** Built expert UI over native Remote, with real Settings conflicts and delayed read failures. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Locator } from 'playwright'
import { zipSync } from 'fflate'
import { expect, it, onTestFinished, vi } from 'vitest'
import { builtinCapabilityPatches } from '../../../packages/deepseek-harness-product/desktop/src/builtin-capabilities.ts'
import type AgencyAgentsRemote from '../../../packages/deepseek-harness-product/experts/lib/remote.js'
import type { AgencyPersonaSource } from '../../../packages/deepseek-harness-product/experts/lib/index.js'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { controlIsUnclipped, REPO_ROOT } from './support.ts'
import { newEmployeePage } from './product-support.ts'

type ExpertLibrary = {
  catalog: (signal?: AbortSignal) => ReturnType<AgencyAgentsRemote['getCatalog']>
  saveCustom: AgencyAgentsRemote['saveCustomExpert']
  setEnabled: AgencyAgentsRemote['setEnabled']
  deleteCustom: AgencyAgentsRemote['deleteCustomExpert']
  getCustom: (slug: string) => ReturnType<AgencyAgentsRemote['getCustomExpert']>
}
type TeamLibrary = {
  snapshot: (sessionId?: string, signal?: AbortSignal) => ReturnType<AgencyAgentsRemote['getTeams']>
  save: AgencyAgentsRemote['saveTeam']
  remove: AgencyAgentsRemote['deleteTeam']
  setEnabled: AgencyAgentsRemote['setTeamEnabled']
}

it.each(['expert', 'team'] as const)('keeps the %s directory still when an operation fails and its read is retried', async (surface) => {
  const root = await mkdtemp(join(tmpdir(), 'directory-feedback-layout-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const companyRoot = join(root, 'employee', 'company', 'experts')
  await mkdir(companyRoot, { recursive: true })
  vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const overlay = join(root, 'experts.patch.yml')
  await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
  const teams = scaffold.ctx.get('agencyAgentsTeams') as TeamLibrary
  let catalog = await library.catalog()
  for (const name of ['Stable reviewer', 'Second reviewer']) catalog = await library.saveCustom({ name,
    description: 'Read-only browser fixture', division: 'specialized', prompt: 'Keep {{literal}}.' }, true, catalog.revision)
  await teams.save({ name: 'Stable team', description: 'Read-only browser fixture', tags: [], goal: 'Review the task',
    constraints: 'Do not write', deliveryRequirements: 'Return findings', examples: ['Review the task'], coordinatorMode: 'template',
    coordinatorTemplateId: 'general', coordinatorTemplateVersion: 1, coordinatorPrompt: '',
    members: catalog.experts.map(item => ({ expertSlug: item.slug, duty: 'Review', instructions: 'Read the references.' })),
  }, true, catalog.revision)
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEmployeePage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  if (surface === 'team') await page.getByRole('tab', { name: 'Expert teams', exact: true }).click()
  const area = page.locator(surface === 'team' ? '#aag-team-source-panel' : '#aag-expert-source-panel')
  const search = area.getByRole('textbox', { name: surface === 'team' ? 'Search teams' : 'Search', exact: true })
  await search.fill('Stable')
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
  const card = area.locator('.aag-expert-card').first()
  await card.waitFor()
  const cardNode = await card.elementHandle(), searchNode = await search.elementHandle()
  const before = await card.boundingBox(), searchBefore = await search.boundingBox()
  const failure = new Error('Directory temporarily unavailable. ' + 'Check the connection and retry. '.repeat(20))
  const writes = surface === 'team' ? vi.spyOn(teams, 'setEnabled').mockRejectedValue(failure)
    : vi.spyOn(library, 'setEnabled').mockRejectedValue(failure)
  onTestFinished(() => { writes.mockRestore() })
  await card.getByRole('switch').click()
  const alert = area.getByRole('alert')
  await alert.waitFor()
  expect(await card.evaluate((node, previous) => node === previous, cardNode)).toBe(true)
  expect(await card.boundingBox()).toEqual(before)
  expect(await search.boundingBox()).toEqual(searchBefore)
  expect(await search.evaluate((node, previous) => node === previous && node instanceof HTMLInputElement
    && [node.value, node.selectionStart, node.selectionEnd], searchNode)).toEqual(['Stable', 1, 4])
  const originalAlert = await alert.elementHandle()
  const retry = area.getByRole('button', { name: surface === 'team' ? 'Refresh and retry' : 'Retry loading', exact: true })
  const retryNode = await retry.elementHandle()
  const failedRead = Promise.withResolvers<undefined>(), recoveredRead = Promise.withResolvers<undefined>()
  onTestFinished(() => { failedRead.resolve(undefined); recoveredRead.resolve(undefined) })
  let reads = 0
  const catalogRead = library.catalog.bind(library), teamRead = teams.snapshot.bind(teams)
  const read = surface === 'team' ? vi.spyOn(teams, 'snapshot').mockImplementation(async (...args) => {
    if (++reads === 1) { await failedRead.promise; throw failure }
    await recoveredRead.promise
    return teamRead(...args)
  }) : vi.spyOn(library, 'catalog').mockImplementation(async (...args) => {
    if (++reads === 1) { await failedRead.promise; throw failure }
    await recoveredRead.promise
    return catalogRead(...args)
  })
  onTestFinished(() => { read.mockRestore() })
  await retry.click(); await retry.press('Enter')
  await expect.poll(() => reads).toBe(1)
  expect(await alert.evaluate((node, previous) => node === previous, originalAlert)).toBe(true)
  expect(await retry.evaluate((node, previous) => node === previous && node === document.activeElement, retryNode)).toBe(true)
  expect(await card.boundingBox()).toEqual(before)
  failedRead.resolve(undefined)
  await expect.poll(() => retry.getAttribute('aria-busy')).toBe('false')
  expect(await retry.evaluate((node, previous) => node === previous && node === document.activeElement, retryNode)).toBe(true)
  expect(await alert.evaluate((node, previous) => node === previous, originalAlert)).toBe(true)
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
  await mkdir(screenshots, { recursive: true })
  const region = alert.locator('..')
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
      await region.scrollIntoViewIfNeeded()
      await region.focus()
      await page.screenshot({ path: join(screenshots, `directory-feedback-${surface}-${theme}-${width}.png`) })
      expect(await controlIsUnclipped(region)).toBe(true)
      expect(await controlIsUnclipped(retry)).toBe(true)
      expect(await area.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      expect(await region.evaluate((node) => { node.scrollTop = 20; return node.scrollTop })).toBeGreaterThan(0)
    }
  }
  await retry.click(); await retry.press('Enter')
  await expect.poll(() => reads).toBe(2)
  await region.focus()
  const cardPending = await card.boundingBox(), searchPending = await search.boundingBox()
  recoveredRead.resolve(undefined)
  await alert.waitFor({ state: 'hidden' })
  await expect.poll(() => search.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await card.evaluate((node, previous) => node === previous, cardNode)).toBe(true)
  expect(await card.boundingBox()).toEqual(cardPending)
  expect(await search.boundingBox()).toEqual(searchPending)
  expect(await search.evaluate((node, previous) => node === previous && node instanceof HTMLInputElement
    && [node.value, node.selectionStart, node.selectionEnd], searchNode)).toEqual(['Stable', 1, 4])
  expect(writes).toHaveBeenCalledOnce()
  expect(tripwire.pageErrors).toEqual([])
})

it.each((['menu', 'panel'] as const).flatMap(surface => (['success', 'failure'] as const).map(outcome => ({ surface, outcome }))))(
  'preserves newer team feedback after an older directory read ($surface, $outcome)', async ({ surface, outcome }) => {
    const root = await mkdtemp(join(tmpdir(), 'team-read-feedback-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const companyRoot = join(root, 'employee', 'company', 'experts')
    await mkdir(companyRoot, { recursive: true })
    vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
    onTestFinished(() => { vi.unstubAllEnvs() })
    const overlay = join(root, 'experts.patch.yml')
    await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
    const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
      extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
      extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
        join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
    })
    onTestFinished(() => scaffold.close())
    const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
    const teams = scaffold.ctx.get('agencyAgentsTeams') as TeamLibrary
    let catalog = await library.catalog()
    for (const name of ['Feedback reviewer', 'Second reviewer']) catalog = await library.saveCustom({ name,
      description: 'Read-only browser fixture', division: 'specialized', prompt: 'Keep {{literal}}.' }, true, catalog.revision)
    let revision = catalog.revision
    for (let index = 1; index <= 8; index++) revision = (await teams.save({ name: `Feedback team ${index}`,
      description: 'Read-only browser fixture', tags: [], goal: 'Review the task', constraints: 'Do not write',
      deliveryRequirements: 'Return findings', examples: ['Review the task'], coordinatorMode: 'template',
      coordinatorTemplateId: 'general', coordinatorTemplateVersion: 1, coordinatorPrompt: '',
      members: catalog.experts.map(item => ({ expertSlug: item.slug, duty: 'Review', instructions: 'Read the references.' })),
    }, true, revision)).revision
    const snapshot = teams.snapshot.bind(teams)
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await newEmployeePage(browser)
    page.setDefaultTimeout(10_000)
    const tripwire = watchConsole(page)
    onTestFinished(() => { expect(tripwire.pageErrors).toEqual([]) })
    await page.goto(scaffold.authenticatedUrl)
    await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
    const trigger = page.getByRole('button', { name: 'Experts', exact: true })
    await trigger.click()
    const picker = page.getByRole('dialog', { name: 'Experts', exact: true })
    await picker.getByRole('tab', { name: 'Expert teams', exact: true }).click()
    await picker.getByRole('button', { name: /^Feedback team 1/ }).click()
    await picker.waitFor({ state: 'hidden' })
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await expect.poll(() => composer.textContent()).toContain('Feedback team 1')
    const draft = await composer.textContent()
    const pending = Promise.withResolvers<undefined>()
    let reads = 0
    const delayed = vi.spyOn(teams, 'snapshot').mockImplementation(async (...args) => {
      if (++reads === 1) {
        await pending.promise
        if (outcome === 'failure') throw new Error('Older directory read failed')
      }
      return snapshot(...args)
    })
    const writes = vi.spyOn(teams, 'setEnabled')
    onTestFinished(() => { pending.resolve(undefined); delayed.mockRestore(); writes.mockRestore() })
    if (surface === 'menu') await trigger.click()
    else {
      await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
      await page.getByRole('tab', { name: 'Mine', exact: true }).click()
      await page.getByRole('tab', { name: 'Expert teams', exact: true }).click()
    }
    await expect.poll(() => reads).toBe(1)
    const area = surface === 'menu' ? picker : page.locator('#aag-team-source-panel')
    const search = area.getByRole('textbox', { name: 'Search teams', exact: true })
    await search.fill('Feedback')
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
    const list = area.locator(surface === 'menu' ? '.agt-compact-list' : '.aag-team-grid')
    if (surface === 'menu') await area.getByRole('button', { name: /^Feedback team 1/ }).click()
    else {
      await area.getByRole('button', { name: 'View details', exact: true }).first().click()
      await page.getByRole('dialog', { name: 'Feedback team 1 details', exact: true })
        .getByRole('button', { name: 'Use team', exact: true }).click()
    }
    const confirmation = page.getByRole('dialog', { name: 'Confirm team selection', exact: true })
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await confirmation.waitFor({ state: 'hidden' })
    const feedback = surface === 'menu' ? area : page.getByRole('dialog', { name: 'Feedback team 1 details', exact: true })
    const notice = feedback.getByRole('alert'), retry = feedback.getByRole('button', { name: surface === 'menu' ? 'Refresh' : 'Refresh and retry', exact: true })
    await retry.waitFor()
    const text = await notice.textContent(), originalNotice = await notice.elementHandle(), originalRetry = await retry.elementHandle()
    const originalSearch = await search.elementHandle(), originalList = await list.elementHandle()
    const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
    await mkdir(screenshots, { recursive: true })
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
        await retry.focus()
        for (const control of [retry, notice]) expect(await controlIsUnclipped(control)).toBe(true)
        if (surface === 'menu') {
          expect(await notice.getAttribute('tabindex')).toBe('0')
          expect(await notice.evaluate(node => node.scrollHeight <= node.clientHeight)).toBe(true)
        }
        expect(await retry.evaluate((node) => {
          const range = document.createRange()
          range.selectNodeContents(node)
          const text = range.getBoundingClientRect(), button = node.getBoundingClientRect()
          return text.top >= button.top && text.bottom <= button.bottom && text.left >= button.left && text.right <= button.right
        })).toBe(true)
        await page.screenshot({ path: join(screenshots, `team-feedback-${surface}-${outcome}-${theme}-${width}.png`), animations: 'disabled' })
      }
    }
    if (surface === 'menu') await list.evaluate((node) => { node.scrollTop = 30 })
    const scroll = await list.evaluate(node => node.scrollTop)
    if (surface === 'menu') expect(scroll).toBeGreaterThan(0)
    const geometry = () => Promise.all([feedback.boundingBox(), search.boundingBox(), list.boundingBox(), retry.boundingBox()])
    const bounds = await geometry()
    pending.resolve(undefined)
    await expect.poll(() => retry.getAttribute('aria-busy')).toBe('false')
    expect(await notice.textContent()).toBe(text)
    expect(await notice.evaluate((node, previous) => node === previous, originalNotice)).toBe(true)
    expect(await retry.evaluate((node, previous) => node === previous && node === document.activeElement, originalRetry)).toBe(true)
    expect(await geometry()).toEqual(bounds)
    expect(await list.evaluate((node, previous) => node === previous && node.scrollTop, originalList)).toBe(scroll)
    expect(await search.evaluate((node, previous) => node === previous && node instanceof HTMLInputElement
      && [node.value, node.selectionStart, node.selectionEnd], originalSearch)).toEqual(['Feedback', 1, 4])
    await retry.press('Enter')
    await notice.waitFor({ state: 'hidden' })
    await expect.poll(() => reads).toBe(2)
    await expect.poll(() => (surface === 'menu' ? search : feedback.getByRole('heading', { name: 'Feedback team 1', exact: true }))
      .evaluate(node => node === document.activeElement)).toBe(true)
    expect(await search.evaluate((node, previous) => node === previous && node instanceof HTMLInputElement
      && [node.value, node.selectionStart, node.selectionEnd], originalSearch)).toEqual(['Feedback', 1, 4])
    expect(writes).not.toHaveBeenCalled()
    expect((await snapshot()).revision).toBe(revision)
    if (surface === 'panel') {
      await feedback.getByRole('button', { name: 'Close', exact: true }).click()
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click()
    }
    else await page.keyboard.press('Escape')
    expect(await composer.textContent()).toBe(draft)
  },
)

it.each(['retained', 'filtered', 'reconciled', 'elsewhere'] as const)('preserves expert directory filters and focus after an edited expert is %s', async (change) => {
  const root = await mkdtemp(join(tmpdir(), 'expert-save-filters-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const companyRoot = join(root, 'employee', 'company', 'experts')
  await mkdir(companyRoot, { recursive: true })
  vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const overlay = join(root, 'experts.patch.yml')
  await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
  await library.saveCustom({ name: 'Needle reviewer', description: 'Needle details', division: 'specialized',
    prompt: 'Keep {{literal}}.' }, true, (await library.catalog()).revision)
  const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
  const save = library.saveCustom.bind(library)
  let writes = 0
  const delayed = vi.spyOn(library, 'saveCustom').mockImplementation(async (...args) => {
    const attempt = writes++
    const gate = gates[attempt]
    if (!gate) throw new Error('Unexpected duplicate write')
    await gate.promise
    if (attempt === 0) throw new Error('Write temporarily unavailable')
    return save(...args)
  })
  onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }); delayed.mockRestore() })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEmployeePage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  onTestFinished(() => { expect(tripwire.pageErrors).toEqual([]) })
  await page.goto(scaffold.authenticatedUrl)
  const reconcile = change === 'reconciled' || change === 'elsewhere'
  const background = Promise.withResolvers<undefined>(), reread = Promise.withResolvers<undefined>()
  let reads = 0
  if (reconcile) {
    const catalog = library.catalog.bind(library)
    const initial = await catalog()
    const delayedRead = vi.spyOn(library, 'catalog').mockImplementation(async (...args) => {
      const index = ++reads
      if (index === 2) {
        await background.promise
        return { ...initial, experts: [...initial.experts.map(expert => ({ ...expert, conflict: true })),
          { ...initial.experts[0]!, slug: 'company-reviewer', custom: false, company: true }] }
      }
      if (index >= 3) await reread.promise
      return catalog(...args)
    })
    onTestFinished(() => { background.resolve(undefined); reread.resolve(undefined); delayedRead.mockRestore() })
  }
  await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  if (reconcile) await expect.poll(() => reads).toBe(2)
  const area = page.locator('#aag-expert-source-panel')
  const search = area.getByRole('textbox', { name: 'Search', exact: true })
  await search.fill('Needle')
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
  const status = area.getByRole('button', { name: 'Status', exact: true })
  await status.click()
  await page.getByRole('menuitem', { name: 'Enabled', exact: true }).click()
  const category = area.getByRole('navigation', { name: 'Category', exact: true }).getByRole('button', { name: 'Other', exact: true })
  await category.click()
  const edit = area.getByRole('button', { name: 'Edit expert', exact: true })
  const original = { search: await search.elementHandle(), status: await status.elementHandle(),
    category: await category.elementHandle(), edit: await edit.elementHandle() }
  await edit.click()
  const dialog = page.getByRole('dialog', { name: 'Edit expert', exact: true })
  const name = dialog.getByRole('textbox', { name: 'Expert name', exact: true })
  await name.fill(change === 'retained' ? 'Needle updated' : 'Updated reviewer')
  await dialog.getByRole('textbox', { name: 'Short description', exact: true }).fill('Updated details')
  await name.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(2, 5) })
  const originalName = await name.elementHandle()
  const submit = dialog.getByRole('button', { name: /^(?:Save changes|Saving…)$/u })
  await submit.click()
  await page.keyboard.press('Enter')
  await expect.poll(() => writes).toBe(1)
  gates[0]!.resolve(undefined)
  await dialog.getByRole('alert').waitFor()
  expect(await name.evaluate((node, previous) => node === previous, originalName)).toBe(true)
  expect(await name.evaluate(node => node instanceof HTMLInputElement && [node.selectionStart, node.selectionEnd])).toEqual([2, 5])
  expect(await search.inputValue()).toBe('Needle')
  expect(await category.getAttribute('aria-pressed')).toBe('true')
  expect(await status.textContent()).toBe('Enabled')
  await submit.click()
  await expect.poll(() => writes).toBe(2)
  if (reconcile) {
    background.resolve(undefined)
    await area.getByText('Name conflict', { exact: true }).waitFor()
  }
  gates[1]!.resolve(undefined)
  await dialog.waitFor({ state: 'hidden' })
  if (reconcile) {
    await expect.poll(() => reads).toBeGreaterThanOrEqual(3)
    expect(await edit.evaluate(node => node === document.activeElement)).toBe(true)
    if (change === 'elsewhere') await status.focus()
    reread.resolve(undefined)
  }
  expect(delayed.mock.calls[1]!.slice(0, 3)).toEqual(delayed.mock.calls[0]!.slice(0, 3))
  expect(await search.inputValue()).toBe('Needle')
  expect(await search.evaluate(node => node instanceof HTMLInputElement && [node.selectionStart, node.selectionEnd])).toEqual([1, 4])
  expect(await search.evaluate((node, previous) => node === previous, original.search)).toBe(true)
  expect(await status.evaluate((node, previous) => node === previous, original.status)).toBe(true)
  expect(await category.evaluate((node, previous) => node === previous, original.category)).toBe(true)
  expect(await category.getAttribute('aria-pressed')).toBe('true')
  expect(await status.textContent()).toBe('Enabled')
  if (change !== 'retained') await edit.waitFor({ state: 'hidden' })
  else expect(await edit.evaluate((node, previous) => node === previous, original.edit)).toBe(true)
  const target = change === 'retained' ? edit : change === 'elsewhere' ? status : search
  await expect.poll(() => target.evaluate(node => node === document.activeElement ? 'target'
    : document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName)).toBe('target')
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
      await target.scrollIntoViewIfNeeded()
      expect(await target.evaluate(node => node === document.activeElement)).toBe(true)
      expect(await controlIsUnclipped(target)).toBe(true)
      expect(await area.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `expert-save-${change}-${theme}-${width}.png`), animations: 'disabled' })
    }
  }
})

it('keeps long expert prompt previews inside the viewport without rebuilding the selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-prompt-layout-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const companyRoot = join(root, 'employee', 'company', 'experts')
  await mkdir(companyRoot, { recursive: true })
  vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const overlay = join(root, 'experts.patch.yml')
  await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
  const name = '订单核对与供应链分析专家'.repeat(3)
  const prompt = 'Keep {{literal}} and read references.\n'.repeat(150)
  await library.saveCustom({ name, description: 'Long prompt preview fixture', division: 'specialized', prompt }, false, (await library.catalog()).revision)
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEmployeePage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  onTestFinished(() => { expect(tripwire.pageErrors).toEqual([]) })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  const trigger = page.getByRole('button', { name: 'View prompt', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: `Prompt for ${name}`, exact: true })
  const text = dialog.getByRole('textbox')
  const close = dialog.getByRole('button', { name: 'Close', exact: true })
  await expect.poll(() => text.inputValue()).toContain(prompt.trimEnd())
  const originalText = await text.elementHandle(), originalClose = await close.elementHandle()
  await text.focus()
  await text.evaluate((node) => { if (node instanceof HTMLTextAreaElement) { node.setSelectionRange(2, 17); node.scrollTop = 80 } })
  const scroll = await text.evaluate(node => node.scrollTop)
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const size of [{ width: 1440, height: 900 }, { width: 740, height: 400 }, { width: 390, height: 560 }]) {
      await page.setViewportSize(size)
      await page.screenshot({ path: join(screenshots, `prompt-layout-${theme}-${size.width}.png`), animations: 'disabled' })
      expect(await controlIsUnclipped(dialog.getByRole('heading'))).toBe(true)
      expect(await controlIsUnclipped(close)).toBe(true)
      expect(await controlIsUnclipped(text)).toBe(true)
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().top >= 24
        && node.getBoundingClientRect().bottom <= innerHeight - 24)).toBe(true)
      expect(await text.evaluate((node, previous) => node === previous && node === document.activeElement, originalText)).toBe(true)
      expect(await text.evaluate(node => node instanceof HTMLTextAreaElement
        && [node.selectionStart, node.selectionEnd, node.scrollTop])).toEqual([2, 17, scroll])
      expect(await close.evaluate((node, previous) => node === previous, originalClose)).toBe(true)
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true)
})

it.each((['prompt', 'editor'] as const).flatMap(surface => (['removed', 'moved', 'retained'] as const).flatMap(change =>
  (['button', 'escape', 'mask'] as const).map(close => ({ surface, change, close })),
)))('returns expert $surface focus to current content (change=$change, close=$close)', async ({ surface, change, close }) => {
  const root = await mkdtemp(join(tmpdir(), 'expert-prompt-return-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const companyRoot = join(root, 'employee', 'company', 'experts')
  await mkdir(companyRoot, { recursive: true })
  vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const overlay = join(root, 'experts.patch.yml')
  await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
  const initial = await library.catalog()
  const saved = await library.saveCustom({ name: 'Return reviewer', description: 'Read-only fixture', division: 'specialized',
    prompt: 'Keep {{literal}}.' }, false, initial.revision)
  const expert = saved.experts.find(item => item.name === 'Return reviewer')!
  const persona = scaffold.ctx.get('agencyAgentsPersona') as AgencyPersonaSource
  const response = Promise.withResolvers<undefined>()
  let reads = 0
  const promptRead = persona.getPrompt.bind(persona), customRead = library.getCustom.bind(library)
  const waitForRead = async () => { reads++; await response.promise }
  const read = surface === 'prompt'
    ? vi.spyOn(persona, 'getPrompt').mockImplementation(async (...args) => { await waitForRead(); return promptRead(...args) })
    : vi.spyOn(library, 'getCustom').mockImplementation(async (...args) => { await waitForRead(); return customRead(...args) })
  onTestFinished(() => { response.resolve(undefined); read.mockRestore() })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEmployeePage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  onTestFinished(() => { expect(tripwire.pageErrors).toEqual([]) })
  await page.goto(scaffold.authenticatedUrl)
  const directoryResponse = Promise.withResolvers<undefined>()
  const originalCatalog = library.catalog.bind(library)
  let catalogReads = 0
  const catalogRead = change === 'removed' ? vi.spyOn(library, 'catalog').mockImplementation(async (...args) => {
    if (++catalogReads > 1) await directoryResponse.promise
    return originalCatalog(...args)
  }) : undefined
  onTestFinished(() => { directoryResponse.resolve(undefined); catalogRead?.mockRestore() })
  await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  if (change === 'removed') await expect.poll(() => catalogReads).toBe(2)
  const area = page.locator('#aag-expert-source-panel')
  const search = area.getByRole('textbox', { name: 'Search', exact: true })
  await search.fill('Return')
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
  const originalSearch = await search.elementHandle()
  const trigger = area.getByRole('button', { name: surface === 'prompt' ? 'View prompt' : 'Edit expert', exact: true })
  const originalTrigger = await trigger.elementHandle()
  await trigger.click()
  await expect.poll(() => reads).toBe(1)
  if (change === 'moved') await search.focus()
  response.resolve(undefined)
  const dialog = page.getByRole('dialog', { name: surface === 'prompt' ? 'Prompt for Return reviewer' : 'Edit expert', exact: true })
  const instructions = surface === 'prompt' ? dialog.getByRole('textbox') : dialog.getByRole('textbox', { name: 'Expert instructions', exact: true })
  await expect.poll(() => instructions.inputValue()).toContain('Keep {{literal}}.')
  if (change === 'removed') {
    const current = await originalCatalog()
    await library.deleteCustom(expert.slug, current.revision)
    directoryResponse.resolve(undefined)
    await trigger.waitFor({ state: 'hidden' })
  }
  if (close === 'escape') await page.keyboard.press('Escape')
  else if (close === 'mask') await page.locator('[role="presentation"] > [aria-hidden="true"]').last().click({ position: { x: 4, y: 4 } })
  else await dialog.getByRole('button', { name: surface === 'prompt' ? 'Close' : 'Cancel', exact: true }).last().click()
  await dialog.waitFor({ state: 'hidden' })
  const target = change === 'retained' ? trigger : search
  await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
  if (change === 'retained') expect(await target.evaluate((node, previous) => node === previous, originalTrigger)).toBe(true)
  expect(await search.evaluate((node, previous) => node === previous, originalSearch)).toBe(true)
  expect(await search.inputValue()).toBe('Return')
  expect(await search.evaluate(node => node instanceof HTMLInputElement ? [node.selectionStart, node.selectionEnd] : [])).toEqual([1, 4])
  expect(reads).toBe(1)
  if (change === 'removed' && close === 'escape') {
    const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
    await mkdir(screenshots, { recursive: true })
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
        await target.scrollIntoViewIfNeeded()
        expect(await area.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
        expect(await target.evaluate(node => node === document.activeElement)).toBe(true)
        await page.screenshot({ path: join(screenshots, `${surface}-return-${theme}-${width}.png`), animations: 'disabled' })
      }
    }
  }
})

it.each([
  ...(['menu', 'panel'] as const).flatMap(surface => (['team', 'example'] as const)
    .flatMap(change => [false, true].map(elsewhere => ({ surface, change, elsewhere })))),
  ...(['editor-close', 'editor-discard', 'editor-save'] as const)
    .flatMap(change => [false, true].map(elsewhere => ({ surface: 'panel' as const, change, elsewhere }))),
  { surface: 'panel' as const, change: 'editor-retained' as const, elsewhere: false },
])(
  'recovers team details, task examples and editors without losing current input ($surface, $change, elsewhere=$elsewhere)', async ({ surface, change, elsewhere }) => {
    const root = await mkdtemp(join(tmpdir(), 'team-example-removal-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const companyRoot = join(root, 'employee', 'company', 'experts')
    await mkdir(companyRoot, { recursive: true })
    vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
    onTestFinished(() => { vi.unstubAllEnvs() })
    const overlay = join(root, 'experts.patch.yml')
    await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
    const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
      extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
      extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
        join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
    })
    onTestFinished(() => scaffold.close())
    const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
    const teams = scaffold.ctx.get('agencyAgentsTeams') as TeamLibrary
    let catalog = await library.catalog()
    for (const name of ['First reviewer', 'Second reviewer']) catalog = await library.saveCustom({ name,
      description: 'Team example fixture', division: 'specialized', prompt: 'Read the references.' }, true, catalog.revision)
    const saved = await teams.save({ name: 'Example team', description: 'Team example fixture', tags: [], goal: 'Review the task',
      constraints: 'Do not write', deliveryRequirements: 'Return findings', examples: ['Removed example', 'Retained example'],
      coordinatorMode: 'template', coordinatorTemplateId: 'general', coordinatorTemplateVersion: 1, coordinatorPrompt: '',
      members: catalog.experts.map(item => ({ expertSlug: item.slug, duty: 'Review', instructions: 'Read the references.' })),
    }, true, catalog.revision)
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await newEmployeePage(browser)
    page.setDefaultTimeout(10_000)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    if (surface === 'panel') {
      await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
      await page.getByRole('tab', { name: 'Mine', exact: true }).click()
      await page.getByRole('tab', { name: /^Expert teams/ }).click()
      await page.getByRole('button', { name: 'View details', exact: true }).waitFor()
      await page.getByRole('tab', { name: /^Experts/ }).click()
    } else {
      await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
      await page.getByRole('button', { name: 'Experts', exact: true }).click()
      await page.getByRole('dialog', { name: 'Experts', exact: true }).getByRole('tab', { name: 'Expert teams', exact: true }).click()
      await page.getByRole('button', { name: 'View Example team details', exact: true }).waitFor()
      await page.keyboard.press('Escape')
    }
    const pending = Promise.withResolvers<undefined>()
    const snapshot = teams.snapshot.bind(teams)
    const reads = vi.spyOn(teams, 'snapshot').mockImplementation(async (...args) => { await pending.promise; return snapshot(...args) })
    onTestFinished(() => { pending.resolve(undefined); reads.mockRestore() })
    if (surface === 'panel') await page.getByRole('tab', { name: /^Expert teams/ }).click()
    else await page.getByRole('button', { name: 'Experts', exact: true }).click()
    await expect.poll(() => reads.mock.calls.length).toBe(1)
    const area = surface === 'panel' ? page.locator('#aag-team-source-panel') : page.getByRole('dialog', { name: 'Experts', exact: true })
    const search = area.getByRole('textbox', { name: 'Search teams', exact: true })
    const query = change === 'editor-save' ? 'Example team' : 'Example'
    await search.fill(query)
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
    const originalSearch = await search.elementHandle()
    await area.getByRole('button', { name: surface === 'panel' ? 'View details' : 'View Example team details', exact: true }).click()
    const details = page.getByRole('dialog', { name: 'Example team details', exact: true })
    if (change === 'editor-close' || change === 'editor-discard' || change === 'editor-save' || change === 'editor-retained') {
      await details.getByRole('button', { name: 'Edit team', exact: true }).click()
      const editor = page.getByRole('dialog', { name: 'Edit team', exact: true })
      const name = editor.getByRole('textbox', { name: 'Team name', exact: true })
      const originalEditor = await editor.elementHandle(), originalName = await name.elementHandle()
      if (change === 'editor-discard' || change === 'editor-save') await name.fill('Updated review team')
      await name.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(2, 5) })
      if (change === 'editor-close' || change === 'editor-discard') await teams.remove(saved.teams[0]!.id, (await library.catalog()).revision)
      pending.resolve(undefined)
      if (change === 'editor-close' || change === 'editor-discard') await area.getByRole('button', { name: 'View details', exact: true }).waitFor({ state: 'hidden' })
      if (change === 'editor-discard') {
        await name.focus()
        await page.keyboard.press('Escape')
        const discard = page.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true })
        await discard.waitFor()
        await page.keyboard.press('Escape')
        await discard.waitFor({ state: 'hidden' })
        expect(await editor.evaluate((node, previous) => node === previous, originalEditor)).toBe(true)
        expect(await name.evaluate((node, previous) => node === previous, originalName)).toBe(true)
        expect(await name.evaluate(node => node instanceof HTMLInputElement
          && [node.selectionStart, node.selectionEnd, node === document.activeElement])).toEqual([2, 5, true])
        await page.keyboard.press('Escape')
        await discard.waitFor()
      }
      const other = page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' })
      if (elsewhere) await other.focus()
      if (change === 'editor-close' || change === 'editor-retained') await page.keyboard.press('Escape')
      else {
        const action = change === 'editor-save' ? editor.getByRole('button', { name: 'Save changes', exact: true })
          : page.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true }).getByRole('button', { name: 'Discard changes', exact: true })
        if (elsewhere) await action.dispatchEvent('click')
        else await action.click()
      }
      await editor.waitFor({ state: 'hidden' })
      if (change === 'editor-save') await area.getByRole('button', { name: 'View details', exact: true }).waitFor({ state: 'hidden' })
      const target = elsewhere ? other : change === 'editor-retained' ? area.getByRole('button', { name: 'View details', exact: true }) : search
      await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
      expect(await search.evaluate((node, previous) => node === previous, originalSearch)).toBe(true)
      expect(await search.inputValue()).toBe(query)
      expect(await search.evaluate(node => node instanceof HTMLInputElement
        && [node.selectionStart, node.selectionEnd])).toEqual([1, 3])
      expect(reads).toHaveBeenCalledTimes(1)
      expect(tripwire.pageErrors).toEqual([])
      if (!elsewhere) {
        const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
        await mkdir(screenshots, { recursive: true })
        for (const theme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: theme })
          for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
            await target.scrollIntoViewIfNeeded()
            expect(await area.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
            expect(await target.evaluate(node => node === document.activeElement)).toBe(true)
            await page.screenshot({ path: join(screenshots, `team-${change}-${theme}-${width}.png`), animations: 'disabled' })
          }
        }
      }
      return
    }
    await details.getByRole('button', { name: 'View coordinator prompt', exact: true }).click()
    const prompt = details.getByRole('textbox', { name: 'Coordinator prompt text', exact: true })
    await prompt.evaluate((node) => { if (node instanceof HTMLTextAreaElement) { node.setSelectionRange(1, 3); node.scrollTop = 24 } })
    const originalPrompt = await prompt.elementHandle(), originalDetails = await details.elementHandle()
    const promptScroll = await prompt.evaluate(node => node.scrollTop)
    const example = details.getByRole('button', { name: '“Removed example”', exact: true })
    await example.focus()
    const other = change === 'team' ? page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' })
      : details.getByRole('button', { name: 'Close', exact: true })
    if (elsewhere) await other.focus()
    if (change === 'team') await teams.remove(saved.teams[0]!.id, (await library.catalog()).revision)
    else await teams.save({ ...saved.teams[0]!, examples: ['Retained example'] }, true, (await library.catalog()).revision)
    pending.resolve(undefined)
    if (change === 'team') {
      await details.waitFor({ state: 'hidden' })
      const target = elsewhere ? other : search
      await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
      expect(await search.evaluate((node, previous) => node === previous, originalSearch)).toBe(true)
      expect(await search.inputValue()).toBe('Example')
      expect(await search.evaluate(node => node instanceof HTMLInputElement && [node.selectionStart, node.selectionEnd])).toEqual([1, 3])
      expect(await originalPrompt?.evaluate(node => node.isConnected)).toBe(false)
      expect(await originalDetails?.evaluate(node => node.isConnected)).toBe(false)
      if (!elsewhere) {
        const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
        await mkdir(screenshots, { recursive: true })
        await page.screenshot({ path: join(screenshots, `removed-team-${surface}.png`), animations: 'disabled' })
      }
      expect(reads).toHaveBeenCalledTimes(1)
      expect(tripwire.pageErrors).toEqual([])
      return
    }
    await example.waitFor({ state: 'hidden' })
    const target = elsewhere ? other : details.getByRole('heading', { name: 'Example team', exact: true })
    await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await details.evaluate((node, previous) => node === previous, originalDetails)).toBe(true)
    expect(await search.evaluate((node, previous) => node === previous, originalSearch)).toBe(true)
    expect(await search.inputValue()).toBe('Example')
    expect(await search.evaluate(node => node instanceof HTMLInputElement && [node.selectionStart, node.selectionEnd])).toEqual([1, 3])
    expect(await prompt.evaluate((node, previous) => node === previous, originalPrompt)).toBe(true)
    expect(await prompt.evaluate(node => node instanceof HTMLTextAreaElement
      && [node.selectionStart, node.selectionEnd, node.scrollTop])).toEqual([1, 3, promptScroll])
    expect(await details.getByRole('button', { name: '“Retained example”', exact: true }).count()).toBe(1)
    if (!elsewhere) {
      const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
      await mkdir(screenshots, { recursive: true })
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
          expect(await details.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
          expect(await details.evaluate((node) => {
            const bounds = node.getBoundingClientRect()
            return node.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.bottom - 16))
          })).toBe(true)
          expect(await target.evaluate(node => node === document.activeElement)).toBe(true)
          await page.screenshot({ path: join(screenshots, `removed-example-${surface}-${theme}-${width}.png`), animations: 'disabled' })
        }
      }
    }
    await page.keyboard.press('Escape')
    await details.waitFor({ state: 'hidden' })
    await expect.poll(() => area.getByRole('button', {
      name: surface === 'panel' ? 'View details' : 'View Example team details', exact: true,
    }).evaluate(node => node === document.activeElement)).toBe(true)
    expect(reads).toHaveBeenCalledTimes(1)
    expect(tripwire.pageErrors).toEqual([])
  },
)

it.each((['expert-removed', 'expert-disabled', 'expert-category', 'team-removed', 'team-details-removed', 'team-disabled'] as const)
  .flatMap(surface => [false, true].map(elsewhere => ({ surface, elsewhere }))))(
  'keeps composer directory controls through a background update ($surface, elsewhere=$elsewhere)', async ({ surface, elsewhere }) => {
    const root = await mkdtemp(join(tmpdir(), 'composer-directory-focus-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const companyRoot = join(root, 'employee', 'company', 'experts')
    await mkdir(companyRoot, { recursive: true })
    vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
    onTestFinished(() => { vi.unstubAllEnvs() })
    const overlay = join(root, 'experts.patch.yml')
    await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
    const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
      extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
      extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
        join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
    })
    onTestFinished(() => scaffold.close())
    const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
    const teams = scaffold.ctx.get('agencyAgentsTeams') as TeamLibrary
    const catalog = library.catalog.bind(library), snapshot = teams.snapshot.bind(teams)
    let initial = await catalog()
    for (const name of ['Refresh reviewer', 'Second reviewer']) initial = await library.saveCustom({ name,
      description: 'Composer focus fixture', division: 'specialized', prompt: 'Read the references.' }, true, initial.revision)
    const expert = initial.experts.find(item => item.name === 'Refresh reviewer')!
    const saved = await teams.save({ name: 'Refresh team', description: 'Composer focus fixture', tags: [], goal: 'Review the task',
      constraints: 'Do not write', deliveryRequirements: 'Return findings', examples: ['Review a change'],
      coordinatorMode: 'template', coordinatorTemplateId: 'general', coordinatorTemplateVersion: 1, coordinatorPrompt: '',
      members: initial.experts.map(item => ({ expertSlug: item.slug, duty: 'Review', instructions: 'Read the references.' })),
    }, true, initial.revision)
    const team = saved.teams[0]!
    const isTeam = surface.startsWith('team-')
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await newEmployeePage(browser)
    page.setDefaultTimeout(10_000)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
    await page.getByRole('button', { name: 'Experts', exact: true }).click()
    const region = page.getByRole('dialog', { name: 'Experts', exact: true })
    if (isTeam) await region.getByRole('tab', { name: 'Expert teams', exact: true }).click()
    const name = surface === 'team-details-removed' ? 'View Refresh team details' : isTeam ? /^Refresh team/ : 'Refresh reviewer'
    const choice = region.getByRole('button', { name, exact: true })
    await choice.waitFor()
    await page.keyboard.press('Escape')
    await region.waitFor({ state: 'hidden' })
    const pending = Promise.withResolvers<undefined>()
    const reads = isTeam ? vi.spyOn(teams, 'snapshot').mockImplementation(async (...args) => { await pending.promise; return snapshot(...args) })
      : vi.spyOn(library, 'catalog').mockImplementation(async (...args) => { await pending.promise; return catalog(...args) })
    onTestFinished(() => { pending.resolve(undefined); reads.mockRestore() })
    await page.getByRole('button', { name: 'Experts', exact: true }).click()
    await expect.poll(() => reads.mock.calls.length).toBe(1)
    const search = region.getByRole(isTeam ? 'textbox' : 'searchbox')
    const query = surface.endsWith('disabled') ? '' : 'Refresh'
    await search.fill(query)
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
    const selection = await search.evaluate(node => node instanceof HTMLInputElement && [node.selectionStart, node.selectionEnd])
    const originalSearch = await search.elementHandle(), originalChoice = await choice.elementHandle()
    await choice.focus()
    const other = region.getByRole('tab', { name: isTeam ? 'Experts' : 'Expert teams', exact: true })
    if (elsewhere) await other.focus()
    const latest = await catalog()
    if (surface === 'expert-removed') await library.deleteCustom(expert.slug, latest.revision)
    else if (surface === 'expert-disabled') await library.setEnabled(latest.enabled.filter(slug => slug !== expert.slug), latest.revision)
    else if (surface === 'expert-category') await library.saveCustom({ ...await library.getCustom(expert.slug), division: 'engineering' }, true, latest.revision)
    else if (surface === 'team-disabled') await teams.setEnabled(team.id, false, latest.revision)
    else await teams.remove(team.id, latest.revision)
    pending.resolve(undefined)
    if (surface === 'expert-category') {
      await region.getByText('Engineering & Integration', { exact: true }).waitFor()
      expect(await choice.evaluate((node, previous) => node === previous, originalChoice)).toBe(true)
    } else await choice.waitFor({ state: 'hidden' })
    const target = elsewhere ? other : surface === 'expert-category' ? choice : search
    await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await search.evaluate((node, previous) => node === previous, originalSearch)).toBe(true)
    expect(await search.inputValue()).toBe(query)
    expect(await search.evaluate(node => node instanceof HTMLInputElement && [node.selectionStart, node.selectionEnd])).toEqual(selection)
    if (!elsewhere && ['expert-category', 'team-disabled'].includes(surface)) {
      const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
      await mkdir(screenshots, { recursive: true })
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
          expect(await region.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
          await expect.poll(() => region.evaluate((node) => {
            const bounds = node.getBoundingClientRect()
            return bounds.left >= 12 && bounds.top >= 12
              && bounds.right <= window.innerWidth - 12 && bounds.bottom <= window.innerHeight - 12
          })).toBe(true)
          expect(await target.evaluate(node => node === document.activeElement)).toBe(true)
          await page.screenshot({ path: join(screenshots, `composer-${surface}-${theme}-${width}.png`), animations: 'disabled' })
        }
      }
    }
    await page.keyboard.press('Escape')
    await region.waitFor({ state: 'hidden' })
    expect(reads).toHaveBeenCalledTimes(1)
    expect(tripwire.pageErrors).toEqual([])
  },
)

it.each((['removed', 'disabled'] as const).flatMap(change => [false, true].map(elsewhere => ({ change, elsewhere }))))(
  'recovers the member candidate removed by an in-flight directory read ($change, elsewhere=$elsewhere)', async ({ change, elsewhere }) => {
    const root = await mkdtemp(join(tmpdir(), 'member-picker-removal-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const companyRoot = join(root, 'employee', 'company', 'experts')
    await mkdir(companyRoot, { recursive: true })
    vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
    onTestFinished(() => { vi.unstubAllEnvs() })
    const overlay = join(root, 'experts.patch.yml')
    await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
    const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
      extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
      extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
        join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
    })
    onTestFinished(() => scaffold.close())
    const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
    const teams = scaffold.ctx.get('agencyAgentsTeams') as TeamLibrary
    let catalog = await library.catalog()
    for (let index = 0; index < 4; index++) catalog = await library.saveCustom({ name: `Candidate ${index}`,
      description: 'Member picker fixture', division: 'specialized', prompt: 'Read the references.' }, true, catalog.revision)
    const members = catalog.experts.filter(item => ['Candidate 0', 'Candidate 1'].includes(item.name))
    await teams.save({ name: 'Picker team', description: 'Member picker fixture', tags: [], goal: 'Review the task',
      constraints: 'Do not write', deliveryRequirements: 'Return findings', examples: ['Review a change'],
      coordinatorMode: 'template', coordinatorTemplateId: 'general', coordinatorTemplateVersion: 1, coordinatorPrompt: '',
      members: members.map(item => ({ expertSlug: item.slug, duty: 'Review', instructions: 'Read the references.' })),
    }, false, catalog.revision)
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await newEmployeePage(browser)
    page.setDefaultTimeout(10_000)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    await page.getByRole('button', { name: 'Edit expert', exact: true }).first().waitFor()
    const pending = Promise.withResolvers<undefined>()
    const snapshot = teams.snapshot.bind(teams)
    const reads = vi.spyOn(teams, 'snapshot').mockImplementation(async (...args) => {
      await pending.promise
      return snapshot(...args)
    })
    onTestFinished(() => { pending.resolve(undefined); reads.mockRestore() })
    await page.getByRole('tab', { name: /^Expert teams/ }).click()
    await expect.poll(() => reads.mock.calls.length).toBe(1)
    await page.getByRole('button', { name: 'Edit team', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Edit team', exact: true })
    const name = editor.getByRole('textbox', { name: 'Team name', exact: true })
    await name.fill('Unsubmitted team draft')
    const originalName = await name.elementHandle()
    await editor.getByRole('button', { name: 'Add member', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Choose team members', exact: true })
    const search = picker.getByRole('textbox', { name: 'Search team members', exact: true })
    await search.fill('Candidate')
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
    const original = await search.elementHandle()
    const choice = picker.getByRole('button', { name: /^Candidate 2\D/ })
    await choice.focus()
    const other = picker.getByRole('button', { name: 'Source', exact: true })
    if (elsewhere) await other.focus()
    const latest = await library.catalog()
    const candidate = latest.experts.find(item => item.name === 'Candidate 2')!
    if (change === 'removed') await library.deleteCustom(candidate.slug, latest.revision)
    else await library.setEnabled(latest.enabled.filter(slug => slug !== candidate.slug), latest.revision)
    pending.resolve(undefined)
    await choice.waitFor({ state: 'hidden' })
    const target = elsewhere ? other : search
    await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await search.evaluate((node, previous) => node === previous, original)).toBe(true)
    expect(await search.inputValue()).toBe('Candidate')
    expect(await search.evaluate(node => node instanceof HTMLInputElement && [node.selectionStart, node.selectionEnd])).toEqual([1, 3])
    if (!elsewhere) {
      const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
      await mkdir(screenshots, { recursive: true })
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
          await search.scrollIntoViewIfNeeded()
          expect(await picker.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
          expect(await search.evaluate(node => node === document.activeElement)).toBe(true)
          await page.screenshot({ path: join(screenshots, `member-candidate-${change}-${theme}-${width}.png`), animations: 'disabled' })
        }
      }
    }
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'hidden' })
    expect(await name.evaluate((node, previous) => node === previous, originalName)).toBe(true)
    expect(await name.inputValue()).toBe('Unsubmitted team draft')
    expect(await editor.getByRole('textbox', { name: 'Responsibility', exact: true }).count()).toBe(2)
    expect((await snapshot()).teams[0]?.name).toBe('Picker team')
    expect(reads).toHaveBeenCalledTimes(1)
    expect(tripwire.pageErrors).toEqual([])
  },
)

it.each((['expert', 'team-card', 'team-details'] as const).flatMap(surface => [false, true].map(elsewhere => ({ surface, elsewhere }))))(
  'recovers deleted $surface focus without replacing search controls (elsewhere=$elsewhere)', async ({ surface, elsewhere }) => {
    const root = await mkdtemp(join(tmpdir(), 'expert-delete-focus-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const companyRoot = join(root, 'employee', 'company', 'experts')
    await mkdir(companyRoot, { recursive: true })
    vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
    onTestFinished(() => { vi.unstubAllEnvs() })
    const overlay = join(root, 'experts.patch.yml')
    await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
    const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
      extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
      extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
        join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
    })
    onTestFinished(() => scaffold.close())
    const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
    const teams = scaffold.ctx.get('agencyAgentsTeams') as TeamLibrary
    let catalog = await library.catalog()
    for (const name of ['Focus reviewer', 'Second reviewer']) catalog = await library.saveCustom({ name,
      description: 'Read-only focus fixture', division: 'specialized', prompt: 'Read the references.' }, true, catalog.revision)
    if (surface !== 'expert') await teams.save({ name: 'Focus team', description: 'Read-only focus fixture', tags: [], goal: 'Review the task',
      constraints: 'Do not write', deliveryRequirements: 'Return findings', examples: ['Review a change'],
      coordinatorMode: 'template', coordinatorTemplateId: 'general', coordinatorTemplateVersion: 1, coordinatorPrompt: '',
      members: catalog.experts.map(item => ({ expertSlug: item.slug, duty: 'Review', instructions: 'Read the references.' })),
    }, true, catalog.revision)
    const pending = Promise.withResolvers<undefined>()
    let writes = 0
    const writeExpert = library.deleteCustom.bind(library), writeTeam = teams.remove.bind(teams)
    const expertWrite = vi.spyOn(library, 'deleteCustom').mockImplementation(async (...args) => {
      writes++; await pending.promise; return writeExpert(...args)
    })
    const teamWrite = vi.spyOn(teams, 'remove').mockImplementation(async (...args) => {
      writes++; await pending.promise; return writeTeam(...args)
    })
    onTestFinished(() => { pending.resolve(undefined); expertWrite.mockRestore(); teamWrite.mockRestore() })
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await newEmployeePage(browser)
    page.setDefaultTimeout(10_000)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    if (surface !== 'expert') await page.getByRole('tab', { name: /^Expert teams/ }).click()
    const area = page.locator(surface === 'expert' ? '#aag-expert-source-panel' : '#aag-team-source-panel')
    const search = area.getByRole('textbox', { name: surface === 'expert' ? 'Search' : 'Search teams', exact: true })
    const query = surface === 'expert' ? 'Focus reviewer' : 'Focus team'
    await search.fill(query)
    const card = area.getByRole('article').filter({ has: page.getByText(query, { exact: true }) })
    await card.waitFor()
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
    const original = await search.elementHandle()
    if (surface === 'team-details') await area.getByRole('button', { name: 'View details', exact: true }).click()
    const region = surface === 'team-details' ? page.getByRole('dialog') : card
    await region.getByRole('button', { name: surface === 'expert' ? 'Delete expert' : 'Delete team', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: surface === 'expert' ? 'Delete custom expert' : 'Delete this team?', exact: true })
    const confirm = dialog.getByRole('button', { name: surface === 'expert' ? 'Delete expert' : 'Delete', exact: true })
    await confirm.press('Enter')
    await expect.poll(() => writes).toBe(1)
    await page.keyboard.press('Enter')
    expect(writes).toBe(1)
    const other = page.locator('.aag-library-tabs [role="tab"]').first()
    if (elsewhere) await other.focus()
    pending.resolve(undefined)
    await dialog.waitFor({ state: 'hidden' })
    await card.waitFor({ state: 'hidden' })
    const target = elsewhere ? other : search
    await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await search.evaluate((node, previous) => node === previous, original)).toBe(true)
    expect(await search.inputValue()).toBe(query)
    const selection = await search.evaluate(node => node instanceof HTMLInputElement ? [node.selectionStart, node.selectionEnd] : [])
    expect(selection).toEqual([1, 3])
    if (!elsewhere) {
      const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
      await mkdir(screenshots, { recursive: true })
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 })
          await page.waitForFunction(drawer => Boolean(document.querySelector('[data-sidebar-drawer]')) === drawer, width < 768)
          if (await page.locator('[data-sidebar-drawer]:not([data-sidebar-collapsed])').count()) {
            await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
            await search.focus()
          }
          await search.scrollIntoViewIfNeeded()
          expect(await area.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
          await page.screenshot({ path: join(screenshots, `delete-${surface}-${theme}-${width}.png`), animations: 'disabled' })
        }
      }
    }
    expect(tripwire.pageErrors).toEqual([])
  },
)

it.each((['expert', 'team'] as const).flatMap(kind => [false, true].map(elsewhere => ({ kind, elsewhere }))))(
  'recovers $kind switch focus after filtered removal (elsewhere=$elsewhere)', async ({ kind, elsewhere }) => {
    const root = await mkdtemp(join(tmpdir(), 'expert-toggle-focus-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const companyRoot = join(root, 'employee', 'company', 'experts')
    await mkdir(companyRoot, { recursive: true })
    vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
    onTestFinished(() => { vi.unstubAllEnvs() })
    const overlay = join(root, 'experts.patch.yml')
    await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
    const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
      extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
      extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
        join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
    })
    onTestFinished(() => scaffold.close())
    const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
    const teams = scaffold.ctx.get('agencyAgentsTeams') as TeamLibrary
    let catalog = await library.catalog()
    for (const name of ['Focus reviewer', 'Second reviewer']) catalog = await library.saveCustom({ name,
      description: 'Read-only focus fixture', division: 'specialized', prompt: 'Read the references.' }, true, catalog.revision)
    await teams.save({ name: 'Focus team', description: 'Read-only focus fixture', tags: [], goal: 'Review the task',
      constraints: 'Do not write', deliveryRequirements: 'Return findings', examples: ['Review a change'],
      coordinatorMode: 'template', coordinatorTemplateId: 'general', coordinatorTemplateVersion: 1, coordinatorPrompt: '',
      members: catalog.experts.map(item => ({ expertSlug: item.slug, duty: 'Review', instructions: 'Read the references.' })),
    }, true, catalog.revision)
    const pending = Promise.withResolvers<undefined>()
    let writes = 0
    const writeExpert = library.setEnabled.bind(library), writeTeam = teams.setEnabled.bind(teams)
    const expertWrite = vi.spyOn(library, 'setEnabled').mockImplementation(async (...args) => {
      writes++; await pending.promise; return writeExpert(...args)
    })
    const teamWrite = vi.spyOn(teams, 'setEnabled').mockImplementation(async (...args) => {
      writes++; await pending.promise; return writeTeam(...args)
    })
    onTestFinished(() => { pending.resolve(undefined); expertWrite.mockRestore(); teamWrite.mockRestore() })
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await newEmployeePage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    if (kind === 'team') await page.getByRole('tab', { name: /^Expert teams/ }).click()
    const area = page.locator(kind === 'expert' ? '#aag-expert-source-panel' : '#aag-team-source-panel')
    const search = area.getByRole('textbox', { name: kind === 'expert' ? 'Search' : 'Search teams', exact: true })
    const query = kind === 'expert' ? 'Focus reviewer' : 'Focus team'
    await search.fill(query)
    await area.getByRole('button', { name: 'Status', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Enabled', exact: true }).click()
    const original = await search.elementHandle()
    const toggle = area.getByRole('switch', { name: new RegExp(`^${query}：`) })
    await toggle.press('Enter')
    await expect.poll(() => writes).toBe(1)
    if (elsewhere) {
      await search.focus()
      await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
    }
    pending.resolve(undefined)
    await toggle.waitFor({ state: 'hidden' })
    await expect.poll(() => search.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await search.evaluate((node, previous) => node === previous, original)).toBe(true)
    expect(await search.inputValue()).toBe(query)
    if (elsewhere) {
      const selection = await search.evaluate(node => node instanceof HTMLInputElement ? [node.selectionStart, node.selectionEnd] : [])
      expect(selection).toEqual([1, 3])
    }
    if (!elsewhere) {
      const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
      await mkdir(screenshots, { recursive: true })
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
          await page.waitForFunction(drawer => Boolean(document.querySelector('[data-sidebar-drawer]')) === drawer, width < 768)
          if (await page.locator('[data-sidebar-drawer]:not([data-sidebar-collapsed])').count()) {
            await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
            await search.focus()
          }
          await search.scrollIntoViewIfNeeded()
          const tabs = page.locator('.aag-library-tabs')
          for (const tab of await tabs.getByRole('tab').all()) {
            expect(await tab.evaluate(node => node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth),
              `${kind} tab label fits at ${width}px`).toBe(true)
          }
          expect(await area.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
          expect(await search.evaluate(node => node === document.activeElement)).toBe(true)
          await page.screenshot({ path: join(screenshots, `toggle-${kind}-${theme}-${width}.png`), animations: 'disabled' })
        }
      }
    }
    expect(tripwire.pageErrors).toEqual([])
  },
)

it.each((['expert-directory', 'team-directory', 'team-detail'] as const)
  .flatMap(surface => [false, true].map(elsewhere => ({ surface, elsewhere }))))(
  'returns recovered $surface focus to its current content (elsewhere=$elsewhere)', async ({ surface, elsewhere }) => {
    const root = await mkdtemp(join(tmpdir(), 'expert-directory-focus-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const companyRoot = join(root, 'employee', 'company', 'experts')
    await mkdir(companyRoot, { recursive: true })
    vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
    onTestFinished(() => { vi.unstubAllEnvs() })
    const overlay = join(root, 'experts.patch.yml')
    await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
    const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
      extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
      extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
        join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
    })
    onTestFinished(() => scaffold.close())
    const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
    const teams = scaffold.ctx.get('agencyAgentsTeams') as TeamLibrary
    let catalog = await library.catalog()
    for (const name of ['Focus reviewer', 'Second reviewer']) catalog = await library.saveCustom({ name,
      description: 'Read-only focus fixture', division: 'specialized', prompt: 'Read the references.' }, false, catalog.revision)
    await teams.save({ name: 'Focus team', description: 'Read-only focus fixture', tags: [], goal: 'Review the task',
      constraints: 'Do not write', deliveryRequirements: 'Return findings', examples: ['Review a change'],
      coordinatorMode: 'template', coordinatorTemplateId: 'general', coordinatorTemplateVersion: 1, coordinatorPrompt: '',
      members: catalog.experts.map(item => ({ expertSlug: item.slug, duty: 'Review', instructions: 'Read the references.' })),
    }, true, catalog.revision)
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await newEmployeePage(browser)
    page.setDefaultTimeout(10_000)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    if (surface !== 'expert-directory') await page.getByRole('tab', { name: /^Expert teams/ }).click()
    const directory = page.locator(surface === 'expert-directory' ? '#aag-expert-source-panel' : '#aag-team-source-panel')
    const write = surface === 'expert-directory' ? vi.spyOn(library, 'setEnabled') : vi.spyOn(teams, 'setEnabled')
    write.mockRejectedValue(new Error('Directory confirmation unavailable'))
    onTestFinished(() => { write.mockRestore() })
    await directory.getByRole('switch').first().click()
    await directory.getByRole('alert').waitFor()
    if (surface === 'team-detail') await directory.getByRole('button', { name: 'View details', exact: true }).click()
    const region = surface === 'team-detail' ? page.getByRole('dialog', { name: 'Focus team details', exact: true }) : directory
    const search = directory.getByRole('textbox', { name: surface === 'expert-directory' ? 'Search' : 'Search teams', exact: true })
    if (surface !== 'team-detail') {
      await search.fill('Focus')
      await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
    }
    const pending = Promise.withResolvers<undefined>()
    onTestFinished(() => { pending.resolve(undefined) })
    let reads = 0
    const readCatalog = library.catalog.bind(library), readTeams = teams.snapshot.bind(teams)
    const waitForRead = async () => { reads++; await pending.promise }
    const delay = surface === 'expert-directory'
      ? vi.spyOn(library, 'catalog').mockImplementation(async (signal) => { await waitForRead(); return readCatalog(signal) })
      : vi.spyOn(teams, 'snapshot').mockImplementation(async (sessionId, signal) => { await waitForRead(); return readTeams(sessionId, signal) })
    onTestFinished(() => { delay.mockRestore() })
    const retry = region.getByRole('button', { name: surface === 'expert-directory' ? 'Retry loading' : 'Refresh and retry', exact: true })
    const original = await retry.elementHandle()
    const notice = await region.getByRole('alert').elementHandle()
    await retry.focus()
    const bounds = await retry.boundingBox()
    await retry.press('Enter')
    await expect.poll(() => reads).toBe(1)
    expect(await retry.getAttribute('aria-busy')).toBe('true')
    expect(await retry.evaluate((node, previous) => node === previous && node === document.activeElement, original)).toBe(true)
    expect(await retry.boundingBox()).toEqual(bounds)
    expect(await region.getByRole('alert').evaluate((node, previous) => node === previous, notice)).toBe(true)
    await page.keyboard.press('Enter')
    expect(reads).toBe(1)
    const other = surface === 'team-detail' ? region.getByRole('button', { name: 'Close', exact: true }) : search
    if (elsewhere) await other.focus()
    pending.resolve(undefined)
    await retry.waitFor({ state: 'hidden' })
    const target = elsewhere ? other : surface === 'team-detail' ? region.getByRole('heading', { name: 'Focus team', exact: true }) : search
    await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
    if (surface !== 'team-detail') expect(await search.evaluate(node => node instanceof HTMLInputElement
      ? [node.value, node.selectionStart, node.selectionEnd] : [])).toEqual(['Focus', 1, 3])
    expect(write).toHaveBeenCalledOnce()
    if (!elsewhere) {
      const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
      await mkdir(screenshots, { recursive: true })
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 })
          await target.scrollIntoViewIfNeeded()
          expect(await region.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
          expect(await target.evaluate(node => node === document.activeElement)).toBe(true)
          await page.screenshot({ path: join(screenshots, `directory-${surface}-${theme}-${width}.png`), animations: 'disabled' })
        }
      }
    }
    expect(tripwire.pageErrors).toEqual([])
  },
)

it.each((['zip', 'directory', 'attachments', 'import-zip', 'import-directory'] as const)
  .flatMap(action => [1440, 390].map(width => ({ action, width }))))('keeps expert $action file actions focused through a read failure and retry ($width)', async ({ action, width }) => {
  const importOnly = action.startsWith('import-')
  const fileAction = action.replace('import-', '')
  const root = await mkdtemp(join(tmpdir(), 'expert-file-focus-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const companyRoot = join(root, 'employee', 'company', 'experts')
  await mkdir(companyRoot, { recursive: true })
  vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const overlay = join(root, 'experts.patch.yml')
  await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
  const initial = await library.catalog()
  const saved = await library.saveCustom({ name: 'File reviewer', description: 'Retain the file draft.',
    division: 'specialized', prompt: 'Keep {{literal}}.' }, false, initial.revision)
  const content = await library.getCustom(saved.experts[0]!.slug)
  const files = { 'manifest.json': Buffer.from(content.manifest!), 'config/SOUL.md': Buffer.from('Imported {{literal}}.') }
  const directory = join(root, 'file-reviewer')
  await mkdir(join(directory, 'config'), { recursive: true })
  for (const [path, data] of Object.entries(files)) await writeFile(join(directory, path), data)
  const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
  onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }) })
  let reads = 0
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEmployeePage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  await page.exposeFunction('__readExpertFile', async () => {
    const index = reads++
    const gate = gates[index]
    if (!gate) throw new Error('Unexpected duplicate file read')
    await gate.promise
    if (index === 0) throw new Error('File read temporarily unavailable. '.repeat(24) + 'ERROR-END')
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.evaluate((filename) => {
    const bridge = globalThis as typeof globalThis & { __readExpertFile(): Promise<void> }
    File.prototype.arrayBuffer = async function () {
      if (this.name === filename) await bridge.__readExpertFile()
      return Blob.prototype.arrayBuffer.call(this)
    }
  }, fileAction === 'zip' ? 'focus.zip' : fileAction === 'directory' ? 'manifest.json' : '中文资料.md')
  await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  await page.getByRole('button', { name: importOnly ? 'Import expert package' : 'Edit expert', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: importOnly ? 'Import expert package' : 'Edit expert', exact: true })
  await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
  const label = fileAction === 'zip' ? 'Import ZIP' : fileAction === 'directory' ? 'Import directory' : 'Add references or templates'
  const trigger = dialog.getByRole('button', { name: label, exact: true })
  const input = dialog.getByLabel(label, { exact: true }).filter({ visible: false })
  const select = async () => {
    await trigger.focus()
    if (fileAction === 'directory') await input.setInputFiles(directory)
    else await input.setInputFiles(fileAction === 'zip'
      ? { name: 'focus.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync(files)) }
      : { name: '中文资料.md', mimeType: 'text/markdown', buffer: Buffer.from('Reference {{literal}}.') })
  }
  await trigger.scrollIntoViewIfNeeded()
  const originalTrigger = await trigger.elementHandle()
  const body = dialog.locator('form')
  const originalBody = await body.elementHandle()
  const controls = dialog.locator('.aag-package-toolbar')
  const geometry = () => Promise.all([dialog.boundingBox(), controls.boundingBox(), trigger.boundingBox()])
  const initialBounds = await geometry()
  await select()
  await expect.poll(() => reads).toBe(1)
  expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await trigger.getAttribute('aria-disabled')).toBe('true')
  await trigger.dispatchEvent('click')
  expect(reads).toBe(1)
  gates[0]!.resolve(undefined)
  await dialog.getByRole('alert').waitFor()
  expect(await geometry()).toEqual(initialBounds)
  expect(await trigger.evaluate((node, original) => node === original, originalTrigger)).toBe(true)
  expect(await body.evaluate((node, original) => node === original, originalBody)).toBe(true)
  expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true)
  const error = await dialog.getByRole('alert').elementHandle()
  await dialog.getByRole('alert').focus()
  await page.keyboard.press('End')
  await expect.poll(() => dialog.getByRole('alert').evaluate(node =>
    node.scrollTop > 0 && Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 1)).toBe(true)
  const errorScroll = await dialog.getByRole('alert').evaluate(node => node.scrollTop)
  await select()
  await expect.poll(() => reads).toBe(2)
  expect(await dialog.getByRole('alert').evaluate((node, prior) => node === prior, error)).toBe(true)
  expect(await dialog.getByRole('alert').evaluate(node => node.scrollTop)).toBe(errorScroll)
  expect(await geometry()).toEqual(initialBounds)
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 560 }]) {
      await page.setViewportSize(size)
      await trigger.scrollIntoViewIfNeeded()
      expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true)
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `file-${action}-${width}-${theme}-${size.width}.png`), animations: 'disabled' })
    }
  }
  const nextFocus = width === 1440 ? dialog.getByRole('textbox', { name: 'Expert name', exact: true })
    : dialog.getByRole('button', { name: fileAction === 'zip' ? 'Import directory' : 'Import ZIP', exact: true })
  if (width === 1440) await dialog.getByRole('alert').focus()
  else await nextFocus.focus()
  gates[1]!.resolve(undefined)
  await expect.poll(() => trigger.getAttribute('aria-busy')).toBe('false')
  expect(await trigger.evaluate((node, original) => node === original, originalTrigger)).toBe(true)
  expect(await body.evaluate((node, original) => node === original, originalBody)).toBe(true)
  await expect.poll(() => nextFocus.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await dialog.getByRole('textbox', { name: 'Expert instructions', exact: true }).inputValue()).toBe(action === 'attachments' ? 'Keep {{literal}}.' : 'Imported {{literal}}.')
  if (fileAction === 'attachments') expect(await dialog.getByRole('button', { name: 'Remove attachment: assets/中文资料.md', exact: true }).count()).toBe(1)
  expect(tripwire.pageErrors).toEqual([])
})

it.each(['expert-delete', 'team-delete', 'team-enable', 'team-enable-filtered', 'team-menu'] as const)('keeps long %s confirmation content and controls stable through retry', async (action) => {
  const enabling = action.startsWith('team-enable') || action === 'team-menu'
  const root = await mkdtemp(join(tmpdir(), 'expert-long-confirmation-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const companyRoot = join(root, 'employee', 'company', 'experts')
  await mkdir(companyRoot, { recursive: true })
  vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const overlay = join(root, 'experts.patch.yml')
  await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
  const teams = scaffold.ctx.get('agencyAgentsTeams') as TeamLibrary
  let catalog = await library.catalog()
  for (let index = 0; index < (enabling ? 8 : action === 'expert-delete' ? 1 : 2); index++) catalog = await library.saveCustom({
    name: `${index}${(enabling ? '订单处理与企业运营资料审查专家' : 'OperationalReferenceReviewer').repeat(3)}`.slice(0, 40),
    description: 'Review operational references.', division: 'specialized', prompt: 'Keep {{literal}}.',
  }, false, catalog.revision)
  if (action !== 'expert-delete') await teams.save({ name: 'OperationalTeamReferenceReviewer'.repeat(2).slice(0, 40),
    description: 'Review operational references.', tags: [], goal: 'Review the task', constraints: 'Do not write',
    deliveryRequirements: 'Return findings', examples: ['Review the references'], coordinatorMode: 'template',
    coordinatorTemplateId: 'general', coordinatorTemplateVersion: 1, coordinatorPrompt: '',
    members: catalog.experts.map(item => ({ expertSlug: item.slug, duty: 'Review', instructions: 'Read the references.' })),
  }, false, catalog.revision)
  const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
  let writes = 0
  const waitForWrite = async () => {
    const index = writes++
    const gate = gates[index]
    if (!gate) throw new Error('Unexpected duplicate long confirmation write')
    await gate.promise
    if (index === 0) throw new Error('Write temporarily unavailable')
  }
  const original = { expert: library.deleteCustom.bind(library), team: teams.remove.bind(teams), enable: teams.setEnabled.bind(teams) }
  const write = action === 'expert-delete' ? vi.spyOn(library, 'deleteCustom').mockImplementation(async (...args) => {
    await waitForWrite(); return original.expert(...args)
  }) : action === 'team-delete' ? vi.spyOn(teams, 'remove').mockImplementation(async (...args) => {
    await waitForWrite(); return original.team(...args)
  }) : vi.spyOn(teams, 'setEnabled').mockImplementation(async (...args) => {
    await waitForWrite(); return original.enable(...args)
  })
  onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }); write.mockRestore() })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEmployeePage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  onTestFinished(() => { expect(tripwire.pageErrors).toEqual([]) })
  await page.goto(scaffold.authenticatedUrl)
  if (action === 'team-menu') {
    await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
    await page.getByRole('button', { name: 'Experts', exact: true }).click()
    await page.getByRole('dialog', { name: 'Experts', exact: true }).getByRole('tab', { name: 'Expert teams', exact: true }).click()
  } else {
    await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    if (action !== 'expert-delete') await page.getByRole('tab', { name: 'Expert teams', exact: true }).click()
  }
  const area = action === 'team-menu' ? page.getByRole('dialog', { name: 'Experts', exact: true })
    : page.locator(action === 'expert-delete' ? '#aag-expert-source-panel' : '#aag-team-source-panel')
  const search = area.getByRole('textbox')
  await search.fill('Operational')
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
  const input = await search.elementHandle()
  if (action === 'team-enable-filtered') {
    await area.getByRole('button', { name: 'Status', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Disabled', exact: true }).click()
  }
  const trigger = action === 'team-menu' ? area.getByRole('button', { name: /^OperationalTeam/u }).first()
    : enabling ? area.getByRole('switch').first()
      : area.getByRole('button', { name: action === 'expert-delete' ? 'Delete expert' : 'Delete team', exact: true }).first()
  await trigger.click()
  const dialog = page.getByRole('dialog').last()
  const submit = dialog.locator('button[aria-busy]').last()
  const title = dialog.getByRole('heading')
  const close = dialog.getByRole('button', { name: 'Close dialog', exact: true })
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
  const withinFrame = () => dialog.evaluate((node) => {
    const layer = node.parentElement!, style = getComputedStyle(layer), bounds = node.getBoundingClientRect()
    return bounds.top >= parseFloat(style.paddingTop) && bounds.bottom <= innerHeight - parseFloat(style.paddingBottom)
  })
  await page.setViewportSize({ width: 390, height: 560 })
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ path: join(screenshots, `long-${action}-initial.png`), animations: 'disabled' })
  for (const control of [title, close, cancel, submit]) expect(await controlIsUnclipped(control)).toBe(true)
  expect(await withinFrame()).toBe(true)
  expect(await submit.evaluate((node) => {
    const range = document.createRange()
    range.selectNodeContents(node)
    return range.getBoundingClientRect().height <= node.getBoundingClientRect().height
  })).toBe(true)
  expect(await dialog.locator('p').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth))).toBe(true)
  const button = await submit.elementHandle()
  const submitBounds = await submit.boundingBox(), cancelBounds = await cancel.boundingBox()
  await submit.press('Enter')
  await expect.poll(() => writes).toBe(1)
  expect(await submit.boundingBox()).toEqual(submitBounds)
  expect(await cancel.boundingBox()).toEqual(cancelBounds)
  gates[0]!.resolve(undefined)
  const notice = await dialog.getByRole('alert').elementHandle()
  expect(await controlIsUnclipped(dialog.getByRole('alert'))).toBe(true)
  for (const control of [title, close, cancel, submit]) expect(await controlIsUnclipped(control)).toBe(true)
  expect(await withinFrame()).toBe(true)
  if (enabling) {
    const description = dialog.locator('p').first()
    expect(await description.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
    const titleBounds = await title.boundingBox(), actionBounds = await submit.boundingBox()
    await description.evaluate((node) => { node.scrollTop = node.scrollHeight - node.clientHeight })
    expect(await title.boundingBox()).toEqual(titleBounds)
    expect(await submit.boundingBox()).toEqual(actionBounds)
  }
  const failedBounds = await submit.boundingBox(), failedCancelBounds = await cancel.boundingBox()
  await submit.press('Enter')
  await expect.poll(() => writes).toBe(2)
  expect(await submit.boundingBox()).toEqual(failedBounds)
  expect(await cancel.boundingBox()).toEqual(failedCancelBounds)
  expect(await dialog.getByRole('alert').evaluate((node, previous) => node === previous, notice)).toBe(true)
  await page.keyboard.press('Enter')
  await page.keyboard.press(' ')
  await page.keyboard.press('Escape')
  expect(writes).toBe(2)
  expect(await dialog.isVisible()).toBe(true)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 560 }]) {
      await page.setViewportSize(size)
      for (const control of [title, close, cancel, submit]) expect(await controlIsUnclipped(control)).toBe(true)
      expect(await controlIsUnclipped(dialog.getByRole('alert'))).toBe(true)
      expect(await withinFrame()).toBe(true)
      expect(await submit.evaluate((node, previous) => node === previous && node === document.activeElement, button)).toBe(true)
      expect(await dialog.locator('p').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth))).toBe(true)
      await page.screenshot({ path: join(screenshots, `long-${action}-retry-${theme}-${size.width}.png`), animations: 'disabled' })
    }
  }
  if (action === 'team-menu') {
    gates[1]!.resolve(undefined)
    await dialog.waitFor({ state: 'hidden' })
    await area.waitFor({ state: 'hidden' })
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await expect.poll(() => composer.textContent()).toContain('OperationalTeamReferenceReviewer')
    await expect.poll(() => composer.evaluate(node => node === document.activeElement)).toBe(true)
    expect(writes).toBe(2)
    return
  }
  gates[1]!.resolve(undefined)
  await dialog.waitFor({ state: 'hidden' })
  if (action !== 'team-enable') await trigger.waitFor({ state: 'hidden' })
  await expect.poll(() => (action === 'team-enable' ? trigger : search).evaluate(node => node === document.activeElement)).toBe(true)
  expect(await search.evaluate((node, previous) => node === previous, input)).toBe(true)
  expect(await search.evaluate(node => node instanceof HTMLInputElement && [node.value, node.selectionStart, node.selectionEnd])).toEqual(['Operational', 1, 4])
})

it.each(['expert-save', 'team-save', 'expert-delete', 'team-delete'] as const)(
  'keeps %s confirmation focus and draft through delayed failure and retry', async (action) => {
    const root = await mkdtemp(join(tmpdir(), 'expert-write-focus-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const companyRoot = join(root, 'employee', 'company', 'experts')
    await mkdir(companyRoot, { recursive: true })
    vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
    onTestFinished(() => { vi.unstubAllEnvs() })
    const overlay = join(root, 'experts.patch.yml')
    await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
    const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
      extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
      extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
        join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
    })
    onTestFinished(() => scaffold.close())
    const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
    const teams = scaffold.ctx.get('agencyAgentsTeams') as TeamLibrary
    let catalog = await library.catalog()
    for (const name of ['Focus reviewer', 'Second reviewer']) catalog = await library.saveCustom({
      name, description: 'Retain the review draft.', division: 'specialized', prompt: 'Keep {{literal}}.',
      resources: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`references/资料-${index}.txt`, 'dGVzdA=='])),
    }, false, catalog.revision)
    await teams.save({ name: 'Focus team', description: 'Retain the team draft.', tags: [], goal: 'Review the task',
      constraints: 'Do not write', deliveryRequirements: 'Return findings', examples: ['Review the references'],
      coordinatorMode: 'template', coordinatorTemplateId: 'general', coordinatorTemplateVersion: 1, coordinatorPrompt: '',
      members: catalog.experts.map(item => ({ expertSlug: item.slug, duty: 'Review', instructions: 'Read the references.' })),
    }, false, catalog.revision)
    const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    let writes = 0
    const waitForWrite = async () => {
      const index = writes++
      const gate = gates[index]
      if (!gate) throw new Error('Unexpected duplicate write')
      await gate.promise
      if (index === 0) throw new Error(action.endsWith('save') ? 'Write temporarily unavailable. '.repeat(24) + 'ERROR-END' : 'Write temporarily unavailable')
    }
    const original = { expertSave: library.saveCustom.bind(library), teamSave: teams.save.bind(teams),
      expertDelete: library.deleteCustom.bind(library), teamDelete: teams.remove.bind(teams) }
    const delay = action === 'expert-save' ? vi.spyOn(library, 'saveCustom').mockImplementation(async (...args) => {
      await waitForWrite(); return original.expertSave(...args)
    }) : action === 'team-save' ? vi.spyOn(teams, 'save').mockImplementation(async (...args) => {
      await waitForWrite(); return original.teamSave(...args)
    }) : action === 'expert-delete' ? vi.spyOn(library, 'deleteCustom').mockImplementation(async (...args) => {
      await waitForWrite(); return original.expertDelete(...args)
    }) : vi.spyOn(teams, 'remove').mockImplementation(async (...args) => {
      await waitForWrite(); return original.teamDelete(...args)
    })
    onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }); delay.mockRestore() })
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await newEmployeePage(browser)
    page.setDefaultTimeout(10_000)
    const tripwire = watchConsole(page)
    const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
    await mkdir(screenshots, { recursive: true })
    onTestFinished(async ({ task }) => {
      if (task.result?.state === 'fail') await page.screenshot({ path: join(screenshots, `${action}-failure.png`) })
    })
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    const team = action.startsWith('team')
    const deleting = action.endsWith('delete')
    if (team) await page.getByRole('tab', { name: 'Expert teams', exact: true }).click()
    await page.getByRole('button', { name: deleting ? team ? 'Delete team' : 'Delete expert' : team ? 'Edit team' : 'Edit expert', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: deleting ? team ? 'Delete this team?' : 'Delete custom expert' : team ? 'Edit team' : 'Edit expert', exact: true })
    const submit = dialog.getByRole('button', { name: deleting ? team ? /^(?:Delete|Working…)$/u : 'Delete expert' : /^(?:Save changes|Saving…)$/u })
    const control = await submit.elementHandle()
    const submitBounds = await submit.boundingBox()
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
    const cancelBounds = await cancel.boundingBox()
    const footerBounds = deleting ? null : await dialog.locator('footer').boundingBox()
    const body = dialog.locator('.aag-custom-body')
    const draft = dialog.getByRole('textbox', { name: team ? 'Team name' : 'Expert name', exact: true })
    if (!deleting) {
      await draft.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
      await body.evaluate((node) => { node.scrollTop = 80 })
    }
    const originalDraft = deleting ? null : await draft.elementHandle()
    const bodyBounds = deleting ? null : await body.boundingBox()
    const bodyScroll = deleting ? 0 : await body.evaluate(node => node.scrollTop)
    if (!deleting) expect(bodyScroll).toBeGreaterThan(0)
    await submit.press('Enter')
    await expect.poll(() => writes).toBe(1)
    if (!deleting) {
      expect(await submit.boundingBox()).toEqual(submitBounds)
      expect(await cancel.boundingBox()).toEqual(cancelBounds)
    }
    expect(await submit.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await submit.evaluate(node => node instanceof HTMLButtonElement && !node.disabled)).toBe(true)
    expect(await submit.getAttribute('aria-disabled')).toBe('true')
    await page.keyboard.press('Enter')
    await page.keyboard.press(' ')
    expect(writes).toBe(1)
    gates[0]!.resolve(undefined)
    await dialog.getByRole('alert').waitFor()
    if (!deleting) {
      expect(await dialog.locator('footer').boundingBox()).toEqual(footerBounds)
      expect(await body.boundingBox()).toEqual(bodyBounds)
      expect(await body.evaluate(node => node.scrollTop)).toBe(bodyScroll)
      expect(await draft.evaluate((node, previous) => node === previous, originalDraft)).toBe(true)
      expect(await draft.evaluate(node => node instanceof HTMLInputElement && [node.selectionStart, node.selectionEnd])).toEqual([1, 4])
    }
    const alert = await dialog.getByRole('alert').elementHandle()
    expect(await submit.evaluate(node => node === document.activeElement)).toBe(true)
    await submit.press('Enter')
    await expect.poll(() => writes).toBe(2)
    expect(await dialog.getByRole('alert').evaluate((node, prior) => node === prior, alert)).toBe(true)
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 560 }]) {
        await page.setViewportSize(size)
        await submit.scrollIntoViewIfNeeded()
        expect(await submit.evaluate((node, prior) => node === prior && node === document.activeElement, control)).toBe(true)
        expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
        expect(await submit.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
        await page.screenshot({ path: join(screenshots, `${action}-${theme}-${size.width}.png`), animations: 'disabled' })
      }
    }
    if (!deleting) {
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Shift+Tab')
      expect(await dialog.getByRole('alert').evaluate(node => node === document.activeElement)).toBe(true)
      await page.keyboard.press('End')
      await expect.poll(() => dialog.getByRole('alert').evaluate(node => node.scrollTop)).toBeGreaterThan(0)
      await submit.focus()
    }
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).dispatchEvent('click')
    await page.keyboard.press('Escape')
    expect(await dialog.count()).toBe(1)
    expect(writes).toBe(2)
    if (!deleting) expect(await dialog.getByRole('textbox', { name: team ? 'Team name' : 'Expert name', exact: true }).inputValue()).toBe(team ? 'Focus team' : 'Focus reviewer')
    gates[1]!.resolve(undefined)
    await dialog.waitFor({ state: 'hidden' })
    expect(tripwire.pageErrors).toEqual([])
  })

it('keeps editor focus at the current avatar, attachment, member and example action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-editor-actions-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const companyRoot = join(root, 'employee', 'company', 'experts')
  await mkdir(companyRoot, { recursive: true })
  vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const overlay = join(root, 'experts.patch.yml')
  await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
  const teams = scaffold.ctx.get('agencyAgentsTeams') as TeamLibrary
  let catalog = await library.catalog()
  const names = ['First reviewer', 'Second reviewer', 'Third reviewer', 'Fourth reviewer', 'Fifth reviewer',
    'Sixth reviewer', 'Seventh reviewer', 'Eighth reviewer', 'Ninth reviewer']
  for (const name of names) {
    catalog = await library.saveCustom({ name, description: 'Editor keyboard fixture',
      division: 'specialized', prompt: 'Keep {{literal}}.',
      resources: { 'assets/一.bin': 'AAE=', 'references/二.md': 'dGVzdA==', 'references/三.md': 'dGVzdA==' },
    }, true, catalog.revision)
  }
  await teams.save({ name: 'Editor team', description: 'Editor keyboard fixture', tags: [], goal: 'Review the task',
    constraints: 'Do not write', deliveryRequirements: 'Return findings', examples: ['First task', 'Second task', 'Third task'],
    coordinatorMode: 'template', coordinatorTemplateId: 'general', coordinatorTemplateVersion: 1, coordinatorPrompt: '',
    members: catalog.experts.filter(item => names.slice(0, 3).includes(item.name))
      .map(item => ({ expertSlug: item.slug, duty: 'Review', instructions: 'Read the references.' })),
  }, false, catalog.revision)
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEmployeePage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
  await mkdir(screenshots, { recursive: true })
  const capture = async (name: string, dialog: Locator, focused: Locator) => {
    const control = await focused.elementHandle()
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 560 }]) {
        await page.setViewportSize(size)
        await focused.scrollIntoViewIfNeeded()
        expect(await focused.evaluate((node, previous) => node === previous && node === document.activeElement, control)).toBe(true)
        expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
        await page.screenshot({ path: join(screenshots, `${name}-${theme}-${size.width}.png`), animations: 'disabled' })
      }
    }
  }
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  await page.getByRole('button', { name: 'Edit expert', exact: true }).first().click()
  const expert = page.getByRole('dialog', { name: 'Edit expert', exact: true })
  const prompt = expert.getByRole('textbox', { name: 'Expert instructions', exact: true })
  await prompt.fill('')
  await expert.getByRole('button', { name: 'Use a template', exact: true }).press('Enter')
  await expect.poll(() => prompt.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await prompt.inputValue()).not.toBe('')
  await capture('editor-template', expert, prompt)
  const avatar = expert.getByRole('button', { name: 'Change avatar', exact: true })
  await avatar.press('Enter')
  await expert.getByRole('button', { name: 'Avatar 2', exact: true }).press('Enter')
  expect(await avatar.evaluate(node => node === document.activeElement)).toBe(true)
  const attachments = expert.getByRole('button', { name: /^Remove attachment:/ })
  for (const index of [1, 1, 0]) {
    await attachments.nth(index).press('Enter')
    const remaining = await attachments.count()
    const target = remaining ? attachments.nth(index === 0 ? 0 : remaining - 1)
      : expert.getByRole('button', { name: 'Add references or templates', exact: true })
    expect(await target.evaluate(node => node === document.activeElement)).toBe(true)
  }
  await capture('editor-attachments', expert, expert.getByRole('button', { name: 'Add references or templates', exact: true }))
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expert.waitFor({ state: 'hidden' })
  await page.getByRole('tab', { name: /^Expert teams/ }).click()
  await page.getByRole('button', { name: 'Edit team', exact: true }).click()
  const team = page.getByRole('dialog', { name: 'Edit team', exact: true })
  await team.getByRole('button', { name: /^Replace member / }).first().press('Enter')
  const picker = page.getByRole('dialog', { name: 'Choose team members', exact: true })
  await picker.getByRole('button', { name: /^Ninth reviewer/ }).press('Enter')
  const duty = team.getByRole('textbox', { name: 'Responsibility', exact: true }).first()
  expect(await duty.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await duty.inputValue()).toBe('Review')
  const replace = team.getByRole('button', { name: 'Replace member Ninth reviewer', exact: true })
  await replace.press('Enter')
  await page.keyboard.press('Escape')
  await picker.waitFor({ state: 'hidden' })
  expect(await replace.evaluate(node => node === document.activeElement)).toBe(true)
  const addMember = team.getByRole('button', { name: 'Add member', exact: true })
  for (const name of names.slice(3, 8)) {
    await addMember.press('Enter')
    await picker.getByRole('button', { name: new RegExp(`^${name}`) }).press('Enter')
    expect(await team.getByRole('textbox', { name: 'Responsibility', exact: true }).last()
      .evaluate(node => node === document.activeElement)).toBe(true)
  }
  expect(await addMember.isDisabled()).toBe(true)
  await capture('editor-eighth-member', team, team.getByRole('textbox', { name: 'Responsibility', exact: true }).last())
  for (const name of names.slice(3, 8)) await team.getByRole('button', { name: `Remove member ${name}`, exact: true }).press('Enter')
  const reviewer = team.locator('.agt-edit-member').filter({ has: page.getByRole('button', { name: 'Replace member Ninth reviewer', exact: true }) })
  await reviewer.getByText('Expand assignment', { exact: true }).press('Enter')
  const assignment = reviewer.getByRole('textbox', { name: 'Detailed assignment', exact: true })
  await assignment.fill('保留详细分工 {{literal}}')
  const reviewerDuty = reviewer.getByRole('textbox', { name: 'Responsibility', exact: true })
  await reviewerDuty.fill('Retained responsibility')
  for (const label of ['Move down', 'Move up']) {
    const move = reviewer.getByRole('button', { name: label, exact: true })
    const original = await move.elementHandle()
    for (let step = 0; step < 2; step++) {
      await move.press('Enter')
      expect(await move.evaluate((node, previous) => node === previous && node === document.activeElement, original)).toBe(true)
      expect(await reviewer.locator('details').getAttribute('open')).not.toBeNull()
      expect(await assignment.inputValue()).toBe('保留详细分工 {{literal}}')
    }
    expect(await move.getAttribute('aria-disabled')).toBe('true')
    expect(await move.evaluate(node => getComputedStyle(node).opacity)).toBe('0.4')
    const order = await team.locator('.agt-edit-member strong').allTextContents()
    expect(order[label === 'Move down' ? 2 : 0]).toBe('Ninth reviewer')
    await page.keyboard.press('Enter')
    expect(await team.locator('.agt-edit-member strong').allTextContents()).toEqual(order)
    expect(await move.evaluate(node => node === document.activeElement)).toBe(true)
    await capture(`editor-member-${label === 'Move down' ? 'last' : 'first'}`, team, move)
  }
  expect(await reviewerDuty.inputValue()).toBe('Retained responsibility')
  const members = team.getByRole('button', { name: /^Remove member / })
  for (const index of [1, 1, 0]) {
    await members.nth(index).press('Enter')
    const target = await members.count() ? members.last() : team.getByRole('button', { name: 'Add member', exact: true })
    expect(await target.evaluate(node => node === document.activeElement)).toBe(true)
  }
  await team.getByRole('button', { name: 'Remove example', exact: true }).nth(1).press('Enter')
  expect(await team.getByRole('textbox', { name: 'Task examples2', exact: true }).evaluate(node => node === document.activeElement)).toBe(true)
  await team.getByRole('button', { name: 'Remove example', exact: true }).last().press('Enter')
  expect(await team.getByRole('textbox', { name: 'Task examples1', exact: true }).evaluate(node => node === document.activeElement)).toBe(true)
  const add = team.getByRole('button', { name: 'Add example', exact: true })
  for (const index of [2, 3]) {
    await add.press('Enter')
    expect(await team.getByRole('textbox', { name: `Task examples${index}`, exact: true }).evaluate(node => node === document.activeElement)).toBe(true)
  }
  await capture('editor-examples', team, team.getByRole('textbox', { name: 'Task examples3', exact: true }))
  expect(tripwire.pageErrors).toEqual([])
})

it('keeps expert selection focus and feedback stable through a real Settings conflict and retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-selection-focus-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const companyRoot = join(root, 'employee', 'company', 'experts')
  await mkdir(companyRoot, { recursive: true })
  vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const overlay = join(root, 'experts.patch.yml')
  await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
  const initial = await library.catalog()
  const first = await library.saveCustom({ name: 'Focus reviewer', description: 'Keyboard selection fixture',
    division: 'specialized', prompt: 'Review the references.' }, false, initial.revision)
  const saved = await library.saveCustom({ name: 'Other reviewer', description: 'Concurrent Settings fixture',
    division: 'specialized', prompt: 'Review the references.' }, false, first.revision)
  const target = saved.experts.find(item => item.name === 'Focus reviewer')!
  const other = saved.experts.find(item => item.name === 'Other reviewer')!
  const original = library.setEnabled.bind(library)
  const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
  let writes = 0
  const delay = vi.spyOn(library, 'setEnabled').mockImplementation(async (...args) => {
    const gate = gates[writes++]
    if (!gate) throw new Error('Unexpected duplicate selection')
    await gate.promise
    return original(...args)
  })
  onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }); delay.mockRestore() })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEmployeePage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
  await mkdir(screenshots, { recursive: true })
  onTestFinished(async ({ task }) => {
    if (task.result?.state === 'fail') await page.screenshot({ path: join(screenshots, 'selection-focus-failure.png') })
  })
  await page.goto(scaffold.authenticatedUrl)
  await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
  await page.getByRole('button', { name: 'Experts', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Experts', exact: true })
  await dialog.getByRole('searchbox').fill('Focus reviewer')
  const choice = dialog.getByRole('button', { name: /^Focus reviewer/ })
  const button = await choice.elementHandle()
  await choice.press('Enter')
  await expect.poll(() => writes).toBe(1)
  expect(await choice.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await choice.evaluate(node => node instanceof HTMLButtonElement && !node.disabled)).toBe(true)
  expect(await choice.getAttribute('aria-disabled')).toBe('true')
  expect(await choice.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
  await page.keyboard.press('Enter')
  await page.keyboard.press(' ')
  expect(writes).toBe(1)
  await original([other.slug], saved.revision)
  gates[0]!.resolve(undefined)
  await dialog.getByRole('alert').waitFor()
  const notice = await dialog.getByRole('alert').elementHandle()
  expect(await choice.evaluate(node => node === document.activeElement)).toBe(true)
  await choice.press('Enter')
  await expect.poll(() => writes).toBe(2)
  expect(await dialog.getByRole('alert').evaluate((node, previous) => node === previous, notice)).toBe(true)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await choice.evaluate((node, previous) => node === previous, button)).toBe(true)
      expect(await choice.evaluate(node => node === document.activeElement)).toBe(true)
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      expect(await choice.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
      const feedback = dialog.getByRole('alert')
      expect(await controlIsUnclipped(feedback)).toBe(true)
      expect(await feedback.evaluate(node => node.scrollHeight <= node.clientHeight)).toBe(true)
      await page.screenshot({ path: join(screenshots, `selection-focus-${theme}-${width}.png`), animations: 'disabled' })
    }
  }
  await page.keyboard.press('Enter')
  expect(writes).toBe(2)
  gates[1]!.resolve(undefined)
  await dialog.waitFor({ state: 'hidden' })
  expect((await library.catalog()).enabled).toEqual(expect.arrayContaining([target.slug, other.slug]))

  const longMessage = 'The expert directory could not be read. '.repeat(40)
  const reread = Promise.withResolvers<undefined>()
  const catalog = library.catalog.bind(library)
  const failedRead = vi.spyOn(library, 'catalog').mockRejectedValueOnce(new Error(longMessage))
    .mockImplementation(async (...args) => { await reread.promise; return catalog(...args) })
  onTestFinished(() => { reread.resolve(undefined); failedRead.mockRestore() })
  await page.getByRole('button', { name: 'Experts', exact: true }).click()
  const longFeedback = dialog.getByRole('alert')
  await expect.poll(() => longFeedback.textContent()).toBe(longMessage)
  const longNotice = await longFeedback.elementHandle()
  const search = dialog.getByRole('searchbox'), originalSearch = await search.elementHandle()
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 390, height: 560 })
    expect(await controlIsUnclipped(longFeedback)).toBe(true)
    expect(await longFeedback.evaluate(node => node.clientHeight <= 120 && node.scrollHeight > node.clientHeight)).toBe(true)
    await longFeedback.focus()
    await longFeedback.press('End')
    await expect.poll(() => longFeedback.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
    expect(await longFeedback.evaluate(node => node === document.activeElement)).toBe(true)
    await page.screenshot({ path: join(screenshots, `selection-long-feedback-${theme}-390.png`), animations: 'disabled' })
  }
  const refresh = dialog.getByRole('button', { name: 'Refresh', exact: true })
  await refresh.click()
  await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('true')
  expect(await longFeedback.evaluate((node, previous) => node === previous, longNotice)).toBe(true)
  expect(await refresh.evaluate(node => node === document.activeElement)).toBe(true)
  reread.resolve(undefined)
  await longFeedback.waitFor({ state: 'hidden' })
  expect(await search.evaluate((node, previous) => node === previous && node === document.activeElement, originalSearch)).toBe(true)
  expect(tripwire.pageErrors).toEqual([])
})

it('returns focus to the same expert and team searches after clearing market and personal filters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-clear-filter-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const companyRoot = join(root, 'employee', 'company', 'experts')
  await mkdir(companyRoot, { recursive: true })
  vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const overlay = join(root, 'experts.patch.yml')
  await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
  const initial = await library.catalog()
  await library.saveCustom({ name: 'Filter reviewer', description: 'Read-only browser fixture',
    division: 'specialized', prompt: 'Review the references.' }, false, initial.revision)
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEmployeePage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
  await mkdir(screenshots, { recursive: true })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
  for (const kind of ['expert', 'team']) {
    if (kind === 'team') await page.getByRole('tab', { name: /^Expert teams/ }).click()
    for (const source of ['Marketplace', 'Mine']) {
      await page.getByRole('tab', { name: source, exact: true }).click()
      const search = page.getByRole('textbox', { name: kind === 'expert' ? 'Search' : 'Search teams', exact: true })
      const input = await search.elementHandle()
      await search.fill('no-matching-fixture')
      const clear = page.getByRole('button', { name: 'Clear filters', exact: true })
      await clear.focus()
      await clear.press('Enter')
      await expect.poll(() => search.evaluate(node => node === document.activeElement)).toBe(true)
      expect(await search.evaluate((node, original) => node === original, input)).toBe(true)
      expect(await search.inputValue()).toBe('')
      expect(await page.getByRole('tab', { name: source, exact: true }).getAttribute('aria-selected')).toBe('true')
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 })
          await page.waitForFunction(drawer => Boolean(document.querySelector('[data-sidebar-drawer]')) === drawer, width < 768)
          if (await page.locator('[data-sidebar-drawer]:not([data-sidebar-collapsed])').count()) {
            await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
          }
          await search.focus()
          await search.scrollIntoViewIfNeeded()
          expect(await page.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
          if (width === 390) {
            const fields = page.locator('.aag-card-filters:visible .aag-field')
            expect(await fields.evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height <= 40))).toBe(true)
          }
          await page.screenshot({ path: join(screenshots, `clear-${kind}-${source.toLowerCase()}-${theme}-${width}.png`), animations: 'disabled' })
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 })
    }
  }
  expect(tripwire.pageErrors).toEqual([])
})

it.each(['expert', 'team'] as const)('keeps the first %s picker failure distinct from empty results without moving controls', async (surface) => {
  const root = await mkdtemp(join(tmpdir(), 'expert-picker-unread-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const companyRoot = join(root, 'employee', 'company', 'experts')
  await mkdir(companyRoot, { recursive: true })
  vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const overlay = join(root, 'experts.patch.yml')
  await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
  const teams = scaffold.ctx.get('agencyAgentsTeams') as TeamLibrary
  const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
  let reads = 0
  let phase = 0
  const waitForRead = async () => {
    reads++
    const index = phase
    await gates[index]!.promise
    if (index === 0) throw new Error('First directory read unavailable')
  }
  const originalCatalog = library.catalog.bind(library), originalTeams = teams.snapshot.bind(teams)
  const delay = surface === 'expert' ? vi.spyOn(library, 'catalog').mockImplementation(async (...args) => {
    await waitForRead(); return originalCatalog(...args)
  }) : vi.spyOn(teams, 'snapshot').mockImplementation(async (...args) => {
    await waitForRead(); return originalTeams(...args)
  })
  onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }); delay.mockRestore() })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEmployeePage(browser)
  page.setDefaultTimeout(10_000)
  await page.setViewportSize({ width: 390, height: 560 })
  const tripwire = watchConsole(page)
  onTestFinished(() => { expect(tripwire.pageErrors).toEqual([]) })
  await page.goto(scaffold.authenticatedUrl)
  await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
  await page.getByRole('button', { name: 'Experts', exact: true }).click()
  const region = page.getByRole('dialog', { name: 'Experts', exact: true })
  const tab = region.getByRole('tab', { name: surface === 'team' ? 'Expert teams' : 'Experts', exact: true })
  if (surface === 'team') await tab.click()
  await expect.poll(() => reads).toBeGreaterThan(0)
  const search = region.getByRole(surface === 'team' ? 'textbox' : 'searchbox')
  const list = region.locator(surface === 'team' ? '.agt-compact-list' : '.aag-discovery-results')
  await search.fill('No match')
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
  const originalSearch = await search.elementHandle(), originalList = await list.elementHandle()
  const geometry = () => Promise.all([region.boundingBox(), tab.boundingBox(), search.boundingBox(), list.boundingBox()])
  const bounds = await geometry()
  gates[0]!.resolve(undefined)
  const notice = region.getByRole('alert')
  await notice.waitFor()
  expect(await geometry()).toEqual(bounds)
  expect(await region.getByRole('status').count()).toBe(0)
  expect(await region.getByText(surface === 'team' ? 'Loading…' : 'Working…', { exact: true }).count()).toBe(0)
  expect(await region.getByText(surface === 'team' ? 'Search for a team to enable.' : /^No (enabled|matching) experts/).count()).toBe(0)
  expect(await search.evaluate((node, previous) => node === previous && node === document.activeElement, originalSearch)).toBe(true)
  const retry = region.getByRole('button', { name: 'Refresh', exact: true })
  const originalNotice = await notice.elementHandle()
  const initialReads = reads
  phase = 1
  await retry.press('Enter')
  await expect.poll(() => reads).toBe(initialReads + 1)
  expect(await notice.evaluate((node, previous) => node === previous, originalNotice)).toBe(true)
  expect(await geometry()).toEqual(bounds)
  expect(await region.getByRole('status').count()).toBe(0)
  expect(await region.getByText(surface === 'team' ? 'Loading…' : 'Working…', { exact: true }).count()).toBe(0)
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ path: join(screenshots, `picker-${surface}-unread-retry.png`), animations: 'disabled' })
  gates[1]!.resolve(undefined)
  await notice.waitFor({ state: 'hidden' })
  expect(await geometry()).toEqual(bounds)
  expect(await list.evaluate((node, previous) => node === previous, originalList)).toBe(true)
  expect(await search.evaluate((node, previous) => node === previous && node === document.activeElement
    && node instanceof HTMLInputElement && [node.value, node.selectionStart, node.selectionEnd], originalSearch)).toEqual(['No match', 1, 4])
  const emptyText = surface === 'team' ? 'Search for a team to enable.' : 'No matching experts. Try a different keyword.'
  await region.getByText(emptyText, { exact: true }).waitFor()
})

it.each((['expert', 'team'] as const).flatMap(surface => [1440, 390].map(width => ({ surface, width }))))(
  'keeps cached $surface picker controls stable through the first read failure and recovery ($width)', async ({ surface, width }) => {
    const root = await mkdtemp(join(tmpdir(), 'expert-picker-first-failure-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const companyRoot = join(root, 'employee', 'company', 'experts')
    await mkdir(companyRoot, { recursive: true })
    vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
    onTestFinished(() => { vi.unstubAllEnvs() })
    const overlay = join(root, 'experts.patch.yml')
    await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
    const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
      extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
      extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
        join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
    })
    onTestFinished(() => scaffold.close())
    const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
    const teams = scaffold.ctx.get('agencyAgentsTeams') as TeamLibrary
    let catalog = await library.catalog()
    for (let index = 1; index <= 8; index++) catalog = await library.saveCustom({ name: `Retry reviewer ${index}`,
      description: 'Read-only picker fixture', division: 'specialized', prompt: 'Keep {{literal}}.' }, true, catalog.revision)
    if (surface === 'team') {
      let revision = catalog.revision
      for (let index = 1; index <= 8; index++) {
        const next = await teams.save({ name: `Retry team ${index}`, description: 'Read-only picker fixture', tags: [], goal: 'Review the task',
          constraints: 'Do not write', deliveryRequirements: 'Return findings', examples: ['Review a change'],
          coordinatorMode: 'template', coordinatorTemplateId: 'general', coordinatorTemplateVersion: 1, coordinatorPrompt: '',
          members: catalog.experts.slice(0, 2).map(item => ({ expertSlug: item.slug, duty: 'Review', instructions: 'Read the references.' })),
        }, true, revision)
        revision = next.revision
      }
    }
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await newEmployeePage(browser)
    page.setDefaultTimeout(10_000)
    await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
    const tripwire = watchConsole(page)
    onTestFinished(() => { expect(tripwire.pageErrors).toEqual([]) })
    await page.goto(scaffold.authenticatedUrl)
    await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
    const trigger = page.getByRole('button', { name: 'Experts', exact: true })
    await trigger.click()
    const region = page.getByRole('dialog', { name: 'Experts', exact: true })
    const tab = region.getByRole('tab', { name: surface === 'team' ? 'Expert teams' : 'Experts', exact: true })
    if (surface === 'team') await tab.click()
    const first = region.getByRole('button', { name: surface === 'team' ? /^Retry team 1/ : 'Retry reviewer 1', exact: surface === 'expert' })
    await first.waitFor()
    await page.keyboard.press('Escape')
    await region.waitFor({ state: 'hidden' })
    const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    let reads = 0
    const waitForRead = async () => {
      const index = reads++
      if (!gates[index]) throw new Error('Unexpected duplicate picker read')
      await gates[index].promise
      if (index === 0) throw new Error('Directory unavailable. Check https://content.example.test/resources/directory and retry. '.repeat(3))
    }
    const originalCatalog = library.catalog.bind(library), originalTeams = teams.snapshot.bind(teams)
    const delay = surface === 'expert' ? vi.spyOn(library, 'catalog').mockImplementation(async (...args) => {
      await waitForRead(); return originalCatalog(...args)
    }) : vi.spyOn(teams, 'snapshot').mockImplementation(async (...args) => {
      await waitForRead(); return originalTeams(...args)
    })
    onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }); delay.mockRestore() })
    await trigger.click()
    await expect.poll(() => reads).toBe(1)
    const search = region.getByRole(surface === 'team' ? 'textbox' : 'searchbox')
    await search.fill('Retry')
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
    const list = region.locator(surface === 'team' ? '.agt-compact-list' : '.aag-discovery-results')
    await list.evaluate((node) => { node.scrollTop = 30 })
    const scroll = await list.evaluate(node => node.scrollTop)
    expect(scroll).toBeGreaterThan(0)
    const originalSearch = await search.elementHandle(), originalFirst = await first.elementHandle()
    const originalList = await list.elementHandle()
    const geometry = () => Promise.all([region.boundingBox(), tab.boundingBox(), search.boundingBox(),
      list.boundingBox(), first.boundingBox()])
    const bounds = await geometry()
    const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
    await mkdir(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, `picker-${surface}-${width}-before-error.png`), animations: 'disabled' })
    gates[0]!.resolve(undefined)
    const notice = region.getByRole('alert')
    await notice.waitFor()
    await page.screenshot({ path: join(screenshots, `picker-${surface}-${width}-first-error.png`), animations: 'disabled' })
    expect(await geometry()).toEqual(bounds)
    expect(await search.evaluate((node, previous) => node === previous && node === document.activeElement, originalSearch)).toBe(true)
    expect(await first.evaluate((node, previous) => node === previous, originalFirst)).toBe(true)
    expect(await list.evaluate((node, previous) => node === previous && node.scrollTop, originalList)).toBe(scroll)
    const originalNotice = await notice.elementHandle()
    const retry = region.getByRole('button', { name: 'Refresh', exact: true })
    const originalRetry = await retry.elementHandle()
    await retry.press('Enter')
    await expect.poll(() => reads).toBe(2)
    expect(await retry.evaluate((node, previous) => node === previous && node === document.activeElement, originalRetry)).toBe(true)
    expect(await notice.evaluate((node, previous) => node === previous, originalNotice)).toBe(true)
    expect(await geometry()).toEqual(bounds)
    await page.keyboard.press('Enter')
    await page.keyboard.press(' ')
    expect(reads).toBe(2)
    await page.keyboard.press('Shift+Tab')
    expect(await notice.evaluate(node => node === document.activeElement)).toBe(true)
    await page.keyboard.press('End')
    await expect.poll(() => notice.evaluate(node => node.scrollTop > 0
      && Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 1)).toBe(true)
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      expect(await controlIsUnclipped(search)).toBe(true)
      expect(await controlIsUnclipped(tab)).toBe(true)
      expect(await controlIsUnclipped(retry)).toBe(true)
      await page.screenshot({ path: join(screenshots, `picker-${surface}-${width}-retry-${theme}.png`), animations: 'disabled' })
    }
    if (width === 390) await tab.focus()
    gates[1]!.resolve(undefined)
    await notice.waitFor({ state: 'hidden' })
    expect(await retry.count()).toBe(0)
    await expect.poll(() => (width === 390 ? tab : search).evaluate(node => node === document.activeElement)).toBe(true)
    expect(await geometry()).toEqual(bounds)
    expect(await list.evaluate((node, previous) => node === previous && node.scrollTop, originalList)).toBe(scroll)
    expect(await search.evaluate((node, previous) => node === previous && node instanceof HTMLInputElement
      && [node.value, node.selectionStart, node.selectionEnd], originalSearch)).toEqual(['Retry', 1, 4])
  },
)

it.each(['expert', 'team', 'picker', 'team-picker'] as const)('keeps %s read retry focus, geometry and draft stable', async (surface) => {
  const picker = surface === 'picker' || surface === 'team-picker'
  const root = await mkdtemp(join(tmpdir(), 'expert-read-retry-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const companyRoot = join(root, 'employee', 'company', 'experts')
  await mkdir(companyRoot, { recursive: true })
  vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const overlay = join(root, 'experts.patch.yml')
  await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
  const teams = scaffold.ctx.get('agencyAgentsTeams') as TeamLibrary
  const initial = await library.catalog()
  const saved = await library.saveCustom({ name: 'Retry reviewer', description: 'Read-only browser fixture',
    division: 'specialized', prompt: 'Keep {{literal}}.' }, false, initial.revision)
  const expert = saved.experts.find(item => item.custom)!
  if (surface === 'team' || surface === 'team-picker') {
    const members = await library.saveCustom({ name: 'Second reviewer', description: 'Second team member',
      division: 'specialized', prompt: 'Review the references.' }, false, saved.revision)
    let revision = members.revision
    for (let index = 0; index < (surface === 'team-picker' ? 8 : 1); index++) {
      const savedTeam = await teams.save({ name: index === 0 ? 'Retry team' : `Retry team ${index + 1}`, description: 'Read-only browser fixture', tags: [], goal: 'Review the task',
        constraints: 'Do not write', deliveryRequirements: 'Return findings', examples: ['Review a change'],
        coordinatorMode: 'template', coordinatorTemplateId: 'general', coordinatorTemplateVersion: 1, coordinatorPrompt: '',
        members: members.experts.map(item => ({ expertSlug: item.slug, duty: 'Review', instructions: 'Read the references.' })),
      }, surface === 'team-picker', revision)
      revision = savedTeam.revision
    }
  }
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEmployeePage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
  await mkdir(screenshots, { recursive: true })
  onTestFinished(async ({ task }) => {
    if (task.result?.state === 'fail') await page.screenshot({ path: join(screenshots, `${surface}-failure.png`) })
  })
  await page.goto(scaffold.authenticatedUrl)
  const pending = Promise.withResolvers<undefined>()
  onTestFinished(() => { pending.resolve(undefined) })
  let region: Locator
  let retry: Locator
  let reads = 0
  const catalog = library.catalog.bind(library)
  const delay = surface === 'team' || surface === 'team-picker' ? vi.spyOn(teams, 'snapshot') : vi.spyOn(library, 'catalog')
  onTestFinished(() => { delay.mockRestore() })
  if (picker) {
    await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent())
      .toBe('Default workspace')
    if (surface === 'team-picker') {
      await page.getByRole('button', { name: 'Experts', exact: true }).click()
      const initialPicker = page.getByRole('dialog', { name: 'Experts', exact: true })
      await initialPicker.getByRole('tab', { name: 'Expert teams', exact: true }).click()
      await initialPicker.getByRole('button', { name: /^Retry team 8/ }).waitFor()
      await page.keyboard.press('Escape')
      await initialPicker.waitFor({ state: 'hidden' })
    }
    delay.mockRejectedValue(new Error(surface === 'team-picker'
      ? 'Team directory unavailable. Check the connection to https://content.example.test/teams/directory and retry.' : 'Catalog unavailable'))
    await page.getByRole('button', { name: 'Experts', exact: true }).click()
    region = page.getByRole('dialog', { name: 'Experts', exact: true })
    if (surface === 'team-picker') await region.getByRole('textbox', { name: 'Search teams', exact: true }).waitFor()
    retry = region.getByRole('button', { name: 'Refresh', exact: true })
  } else {
    await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    if (surface === 'team') await page.getByRole('tab', { name: /^Expert teams/ }).click()
    await page.getByRole('button', { name: surface === 'expert' ? 'Edit expert' : 'Edit team', exact: true }).click()
    region = page.getByRole('dialog', { name: surface === 'expert' ? 'Edit expert' : 'Edit team', exact: true })
    await region.getByRole('textbox', { name: surface === 'expert' ? 'Expert name' : 'Team name', exact: true }).fill('Retained local draft')
    const current = await catalog()
    await library.setEnabled([expert.slug], current.revision)
    await region.getByRole('button', { name: 'Save changes', exact: true }).click()
    retry = region.getByRole('button', { name: surface === 'expert' ? 'Read latest content' : 'Load latest settings', exact: true })
  }
  await retry.waitFor()
  const comparison = picker ? undefined : region.getByRole('textbox', {
    name: surface === 'expert' ? 'Currently saved content' : 'Latest coordinator prompt', exact: true,
  })
  const keep = region.getByRole('button', { name: 'Keep my draft', exact: true })
  const adopt = region.getByRole('button', { name: surface === 'expert' ? 'Load latest content' : 'Use latest content', exact: true })
  if (comparison) {
    await retry.click()
    await comparison.waitFor()
  }
  const originalComparison = comparison ? await comparison.elementHandle() : null
  const originalKeep = comparison ? await keep.elementHandle() : null
  const originalAdopt = comparison ? await adopt.elementHandle() : null
  if (picker) expect(await region.getByRole(surface === 'team-picker' ? 'textbox' : 'searchbox').evaluate(node => node === document.activeElement)).toBe(true)
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(28)
  const button = await retry.elementHandle()
  const notice = await region.getByRole('alert').elementHandle()
  delay.mockImplementation(async () => {
    reads++
    await pending.promise
    throw new Error('Review unavailable')
  })
  await retry.focus()
  const box = await retry.boundingBox()
  await retry.press('Enter')
  await expect.poll(() => reads).toBe(1)
  expect(await retry.getAttribute('aria-busy')).toBe('true')
  expect(await retry.getAttribute('aria-disabled')).toBe('true')
  expect(await retry.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await retry.boundingBox()).toEqual(box)
  expect(await region.getByRole('alert').evaluate((node, previous) => node === previous, notice)).toBe(true)
  if (comparison) {
    expect(await comparison.evaluate((node, previous) => node === previous, originalComparison)).toBe(true)
    expect(await keep.evaluate((node, previous) => node === previous, originalKeep)).toBe(true)
    expect(await adopt.evaluate((node, previous) => node === previous, originalAdopt)).toBe(true)
    for (const action of [keep, adopt]) {
      expect(await action.getAttribute('aria-disabled')).toBe('true')
      expect(await action.evaluate(node => node instanceof HTMLButtonElement && node.disabled)).toBe(false)
      await action.dispatchEvent('click')
    }
    expect(await region.getByRole('button', { name: 'Save changes', exact: true }).isDisabled()).toBe(true)
    expect(await comparison.isVisible()).toBe(true)
  }
  await page.keyboard.press('Enter')
  await page.keyboard.press(' ')
  expect(reads).toBe(1)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    const viewports = [{ width: 1440, height: 900 }, { width: 390, height: 900 },
      ...(surface === 'team-picker' ? [{ width: 390, height: 560 }] : [])]
    for (const { width, height } of viewports) {
      await page.setViewportSize({ width, height })
      await retry.focus()
      await retry.scrollIntoViewIfNeeded()
      await expect.poll(async () => {
        const bounds = await region.boundingBox()
        return bounds !== null && bounds.x >= 12 && bounds.y >= 12
          && bounds.x + bounds.width <= width - 12 && bounds.y + bounds.height <= height - 12
      }).toBe(true)
      expect(await region.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      expect(await retry.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
      expect(await retry.evaluate((node) => {
        const bounds = node.getBoundingClientRect()
        return node.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
      })).toBe(true)
      if (surface === 'team-picker') {
        const last = region.getByRole('button', { name: /^Retry team 8/ })
        await last.scrollIntoViewIfNeeded()
        expect(await last.evaluate((node) => {
          const box = node.getBoundingClientRect()
          return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
        })).toBe(true)
        expect(await region.evaluate(node => node.scrollTop)).toBe(0)
        const tabBounds = await region.getByRole('tab', { name: 'Expert teams', exact: true }).boundingBox()
        const regionBounds = (await region.boundingBox())!
        expect(tabBounds!.y).toBeGreaterThanOrEqual(regionBounds.y)
        expect(tabBounds!.y + tabBounds!.height).toBeLessThanOrEqual(regionBounds.y + regionBounds.height)
      }
      await page.screenshot({ path: join(screenshots, `${surface}-${theme}-${width}${height === 900 ? '' : `x${height}`}.png`), animations: 'disabled' })
    }
  }
  if (comparison) await comparison.focus()
  pending.resolve(undefined)
  await expect.poll(() => retry.getAttribute('aria-busy')).toBe('false')
  expect(await retry.getAttribute('aria-disabled')).toBe('false')
  expect(await retry.evaluate((node, previous) => node === previous, button)).toBe(true)
  expect(await retry.evaluate(node => node === document.activeElement)).toBe(true)
  if (picker) {
    delay.mockRestore()
    await retry.press('Enter')
    await retry.waitFor({ state: 'hidden' })
    const search = region.getByRole(surface === 'team-picker' ? 'textbox' : 'searchbox')
    await expect.poll(() => search.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await region.getByRole('alert').count()).toBe(0)
    expect(await region.evaluate(node => node.scrollTop)).toBe(0)
    await page.screenshot({ path: join(screenshots, `${surface}-recovered.png`), animations: 'disabled' })
    await page.keyboard.press('Tab')
    expect(await region.evaluate(node => node.contains(document.activeElement))).toBe(true)
  }
  if (!picker) expect(await region.getByRole('textbox', {
    name: surface === 'expert' ? 'Expert name' : 'Team name', exact: true,
  }).inputValue()).toBe('Retained local draft')
  if (comparison) {
    expect(await comparison.count()).toBe(0)
    expect(await keep.count()).toBe(0)
    expect(await adopt.count()).toBe(0)
    expect(await region.getByRole('button', { name: 'Save changes', exact: true }).isDisabled()).toBe(true)
    delay.mockRestore()
    await retry.press('Enter')
    await comparison.waitFor()
    await keep.click()
    expect(await region.getByRole('textbox', {
      name: surface === 'expert' ? 'Expert name' : 'Team name', exact: true,
    }).evaluate(node => node === document.activeElement)).toBe(true)
    expect(await region.getByRole('textbox', {
      name: surface === 'expert' ? 'Expert name' : 'Team name', exact: true,
    }).inputValue()).toBe('Retained local draft')
    await region.getByRole('button', { name: 'Save changes', exact: true }).click()
    await region.waitFor({ state: 'hidden' })
  }
  expect(tripwire.pageErrors).toEqual([])
})

it.each((['expert', 'team'] as const).flatMap(surface => [1440, 390].map(width => ({ surface, width }))))(
  'keeps $surface card progress local and focus stable at $width', async ({ surface, width }) => {
    const root = await mkdtemp(join(tmpdir(), 'card-progress-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const companyRoot = join(root, 'employee', 'company', 'experts')
    await mkdir(companyRoot, { recursive: true })
    vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
    onTestFinished(() => { vi.unstubAllEnvs() })
    const overlay = join(root, 'experts.patch.yml')
    await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
    const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
      extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
      extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
        join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
    })
    onTestFinished(() => scaffold.close())
    const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
    const teams = scaffold.ctx.get('agencyAgentsTeams') as TeamLibrary
    let catalog = await library.catalog()
    for (const name of ['Stable reviewer', 'Second reviewer']) catalog = await library.saveCustom({ name,
      description: 'Read-only browser fixture', division: 'specialized', prompt: 'Keep {{literal}}.' }, true, catalog.revision)
    let snapshot = await teams.snapshot()
    for (const name of ['Stable team', 'Second team']) snapshot = await teams.save({ name,
      description: 'Read-only browser fixture', tags: [], goal: 'Review the task', constraints: 'Do not write',
      deliveryRequirements: 'Return findings', examples: ['Review the task'], coordinatorMode: 'template',
      coordinatorTemplateId: 'general', coordinatorTemplateVersion: 1, coordinatorPrompt: '',
      members: catalog.experts.map(item => ({ expertSlug: item.slug, duty: 'Review', instructions: 'Read references.' })),
    }, true, snapshot.revision)
    const browser = await chromium.launch()
    onTestFinished(async ({ task }) => {
      try {
        if (task.result?.state === 'fail') {
          const path = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
          await mkdir(path, { recursive: true })
          await page.screenshot({ path: join(path, `card-${surface}-${width}-failure.png`) })
          await writeFile(join(path, `card-${surface}-${width}-failure.txt`), await page.locator('body').ariaSnapshot())
        }
      } finally { await browser.close() }
    })
    const page = await newEmployeePage(browser)
    page.setDefaultTimeout(10_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' })
    const tripwire = watchConsole(page)
    onTestFinished(() => { expect(tripwire.pageErrors).toEqual([]) })
    await page.goto(scaffold.authenticatedUrl)
    await expect.poll(() => page.locator('[data-composer-input][contenteditable="true"]').evaluateAll(nodes =>
      nodes.some(node => node === document.activeElement))).toBe(true)
    await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    if (surface === 'team') await page.getByRole('tab', { name: 'Expert teams', exact: true }).click()
    await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
    await page.evaluate(async () => { await Promise.allSettled(document.getAnimations().map(animation => animation.finished)) })
    const area = page.locator(surface === 'team' ? '#aag-team-source-panel' : '#aag-expert-source-panel')
    const search = area.getByRole('textbox', { name: surface === 'team' ? 'Search teams' : 'Search', exact: true })
    await search.fill(surface === 'team' ? 'team' : 'reviewer')
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
    const cards = area.locator('.aag-expert-card')
    await expect.poll(() => cards.count()).toBe(2)
    const toggle = cards.first().getByRole('switch'), neighbor = cards.nth(1).getByRole('switch')
    const edit = cards.nth(1).getByRole('button', { name: surface === 'team' ? 'Edit team' : 'Edit expert', exact: true })
    await toggle.scrollIntoViewIfNeeded()
    const scrollport = page.locator('.product-capability-page').filter({ has: area })
    const scroll = await scrollport.evaluate(node => node.scrollTop)
    if (width === 390) expect(scroll).toBeGreaterThan(0)
    const original = await toggle.elementHandle(), originalNeighbor = await neighbor.elementHandle()
    const originalSearch = await search.elementHandle()
    const geometry = () => Promise.all([cards.first().boundingBox(), cards.nth(1).boundingBox(),
      edit.boundingBox(), neighbor.boundingBox(), toggle.boundingBox()])
    const bounds = await geometry()
    const style = () => edit.evaluate(node => [getComputedStyle(node).opacity,
      getComputedStyle(node).color, getComputedStyle(node).backgroundColor])
    const appearance = await style()
    const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }) })
    const expertWrite = library.setEnabled.bind(library), teamWrite = teams.setEnabled.bind(teams)
    let writes = 0
    const write = surface === 'team' ? vi.spyOn(teams, 'setEnabled').mockImplementation(async (...args) => {
      const attempt = writes++; await gates[attempt]!.promise
      if (!attempt) throw new Error('Settings temporarily unavailable')
      return teamWrite(...args)
    }) : vi.spyOn(library, 'setEnabled').mockImplementation(async (...args) => {
      const attempt = writes++; await gates[attempt]!.promise
      if (!attempt) throw new Error('Settings temporarily unavailable')
      return expertWrite(...args)
    })
    onTestFinished(() => { write.mockRestore() })
    for (const attempt of [0, 1]) {
      await toggle.press('Enter')
      await expect.poll(() => writes).toBe(attempt + 1)
      expect(await toggle.evaluate((node, previous) => node === previous && node === document.activeElement, original)).toBe(true)
      expect(await toggle.evaluate(node => node instanceof HTMLButtonElement && node.disabled)).toBe(false)
      expect(await toggle.locator('..').getAttribute('aria-busy')).toBe('true')
      expect(await neighbor.locator('..').getAttribute('aria-busy')).toBe('false')
      expect(await edit.getAttribute('aria-busy')).not.toBe('true')
      expect(await edit.evaluate(node => node instanceof HTMLButtonElement && node.disabled)).toBe(false)
      expect(await geometry()).toEqual(bounds)
      expect(await style()).toEqual(appearance)
      await page.keyboard.press('Enter'); await page.keyboard.press(' ')
      await neighbor.dispatchEvent('click'); await edit.dispatchEvent('click')
      expect(writes).toBe(attempt + 1)
      expect(await page.locator('.aag-host-modal').count()).toBe(0)
      if (attempt) {
        expect(await area.getByRole('alert').count()).toBe(1)
        await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.focus({ preventScroll: true }) })
      }
      const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
      await mkdir(screenshots, { recursive: true })
      await page.screenshot({ path: join(screenshots, `card-${surface}-${width}-pending-${attempt}.png`), animations: 'disabled' })
      gates[attempt]!.resolve(undefined)
      await expect.poll(() => toggle.locator('..').getAttribute('aria-busy')).toBe('false')
      if (!attempt) await area.getByRole('alert').waitFor()
      else await area.getByRole('alert').waitFor({ state: 'hidden' })
      expect(await (attempt ? search : toggle).evaluate(node => node === document.activeElement)).toBe(true)
      expect(await toggle.evaluate((node, previous) => node === previous, original)).toBe(true)
      expect(await neighbor.evaluate((node, previous) => node === previous, originalNeighbor)).toBe(true)
      expect(await search.evaluate((node, previous) => node === previous && node instanceof HTMLInputElement
        && [node.value, node.selectionStart, node.selectionEnd], originalSearch)).toEqual([surface === 'team' ? 'team' : 'reviewer', 1, 3])
      expect(await geometry()).toEqual(bounds)
      expect(await scrollport.evaluate(node => node.scrollTop)).toBe(scroll)
      expect(await controlIsUnclipped(toggle)).toBe(true)
    }
    expect(writes).toBe(2)
  },
)


it.each([{ theme: 'light', width: 1440, height: 900 }, { theme: 'dark', width: 390, height: 560 }] as const)(
  'keeps team detail feedback fixed and keyboard-readable through failure and recovery ($theme, $width)', async ({ theme, width, height }) => {
    const root = await mkdtemp(join(tmpdir(), 'team-detail-feedback-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const companyRoot = join(root, 'employee', 'company', 'experts')
    await mkdir(companyRoot, { recursive: true })
    vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', companyRoot)
    onTestFinished(() => { vi.unstubAllEnvs() })
    const overlay = join(root, 'experts.patch.yml')
    await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
    const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
      extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
      extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
        join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
    })
    onTestFinished(() => scaffold.close())
    const library = scaffold.ctx.get('agencyAgentsLibrary') as ExpertLibrary
    const teams = scaffold.ctx.get('agencyAgentsTeams') as TeamLibrary
    let catalog = await library.catalog()
    for (const name of ['Detail reviewer', 'Reference reviewer']) catalog = await library.saveCustom({ name,
      description: 'Feedback browser fixture', division: 'specialized', prompt: 'Review references.' }, true, catalog.revision)
    await teams.save({ name: 'Stable detail team', description: 'Retain the detail reading position.',
      tags: [], goal: 'Review the task', constraints: 'Do not write', deliveryRequirements: 'Return findings',
      examples: ['Review the task'], coordinatorMode: 'template', coordinatorTemplateId: 'general',
      coordinatorTemplateVersion: 1, coordinatorPrompt: '',
      members: catalog.experts.map(item => ({ expertSlug: item.slug, duty: 'Review', instructions: 'Read references.' })),
    }, false, catalog.revision)
    const longMessage = 'The selected team could not be enabled. Read the current configuration and retry. '.repeat(12)
    const mutation = Promise.withResolvers<undefined>(), recovery = Promise.withResolvers<undefined>()
    const enable = vi.spyOn(teams, 'setEnabled').mockImplementation(async () => { await mutation.promise; throw new Error(longMessage) })
    onTestFinished(() => { mutation.resolve(undefined); recovery.resolve(undefined); enable.mockRestore() })
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await newEmployeePage(browser)
    page.setDefaultTimeout(10_000)
    const tripwire = watchConsole(page)
    onTestFinished(() => { expect(tripwire.pageErrors).toEqual([]) })
    await page.goto(scaffold.authenticatedUrl)
    await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
    await page.getByRole('button', { name: 'Expert kits', exact: true }).click()
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    await page.getByRole('tab', { name: 'Expert teams', exact: true }).click()
    const area = page.locator('#aag-team-source-panel')
    const search = area.getByRole('textbox', { name: 'Search teams', exact: true })
    await search.fill('Stable detail')
    await area.getByRole('button', { name: 'View details', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Stable detail team details', exact: true })
    const action = dialog.getByRole('button', { name: 'Use team', exact: true })
    const body = dialog.locator('.agt-dialog.agt-detail')
    const title = dialog.getByRole('heading', { name: 'Stable detail team', exact: true })
    await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height })
    await dialog.evaluate(async (node) => {
      await Promise.allSettled(node.getAnimations({ subtree: true }).map(animation => animation.finished))
    })
    await action.press('Enter')
    await expect.poll(() => enable.mock.calls.length).toBe(1)
    const actionNode = await action.elementHandle(), bodyNode = await body.elementHandle()
    const bounds = await Promise.all([dialog.boundingBox(), body.boundingBox()])
    await body.evaluate((node) => { node.scrollTop = 80 })
    const scroll = await body.evaluate(node => node.scrollTop)
    mutation.resolve(undefined)
    const alert = dialog.getByRole('alert')
    await expect.poll(() => alert.textContent()).toBe(longMessage)
    const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-expert-retry')
    await mkdir(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, `team-detail-long-error-${theme}-${width}.png`) })
    expect(await Promise.all([dialog.boundingBox(), body.boundingBox()])).toEqual(bounds)
    expect(await body.evaluate((node, previous) => node === previous && node.scrollTop, bodyNode)).toBe(scroll)
    expect(await action.evaluate((node, previous) => node === previous && node === document.activeElement, actionNode)).toBe(true)
    const retry = dialog.getByRole('button', { name: 'Refresh and retry', exact: true })
    await retry.focus(); await page.keyboard.press('Shift+Tab')
    const errorRegion = dialog.getByRole('region', { name: longMessage, exact: true })
    expect(await errorRegion.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await errorRegion.evaluate(node => node.scrollHeight > node.clientHeight && node.scrollWidth <= node.clientWidth)).toBe(true)
    await errorRegion.press('End')
    await expect.poll(() => errorRegion.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
    const snapshot = teams.snapshot.bind(teams)
    const reread = vi.spyOn(teams, 'snapshot').mockImplementation(async (...args) => { await recovery.promise; return snapshot(...args) })
    onTestFinished(() => { reread.mockRestore() })
    await retry.press('Enter')
    await expect.poll(() => retry.getAttribute('aria-busy')).toBe('true')
    const retryNode = await retry.elementHandle(), alertNode = await alert.elementHandle()
    await retry.press('Enter')
    expect(reread.mock.calls).toHaveLength(1)
    expect(enable.mock.calls).toHaveLength(1)
    expect(await alert.evaluate((node, previous) => node === previous, alertNode)).toBe(true)
    expect(await retry.evaluate((node, previous) => node === previous && node === document.activeElement, retryNode)).toBe(true)
    await errorRegion.focus()
    const readingBounds = await Promise.all([dialog.boundingBox(), body.boundingBox()])
    recovery.resolve(undefined)
    await alert.waitFor({ state: 'detached' })
    expect(await title.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await Promise.all([dialog.boundingBox(), body.boundingBox()])).toEqual(readingBounds)
    expect(await body.evaluate((node, previous) => node === previous && node.scrollTop, bodyNode)).toBe(scroll)
    expect(await action.evaluate((node, previous) => node === previous, actionNode)).toBe(true)
    expect(enable.mock.calls).toHaveLength(1)
    expect(await controlIsUnclipped(dialog.getByRole('button', { name: 'Close', exact: true }))).toBe(true)
    await page.screenshot({ path: join(screenshots, `team-detail-recovered-${theme}-${width}.png`) })
  },
)
