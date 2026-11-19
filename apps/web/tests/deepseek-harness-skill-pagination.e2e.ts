/** Built skill discovery through the real Loader and Remote with isolated external catalog reads. */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { SkillsManager } from '../../../packages/deepseek-harness-product/skills/lib/index.js'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { builtinCapabilityPatches } from '../../../packages/deepseek-harness-product/desktop/src/builtin-capabilities.ts'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { controlIsUnclipped, REPO_ROOT } from './support.ts'
import { newEmployeePage } from './product-support.ts'

async function bootSkillFocus() {
  const root = await mkdtemp(join(tmpdir(), 'skill-read-focus-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const overlay = join(root, 'skills.patch.yml')
  await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const skills = scaffold.ctx.get('skillsManager') as SkillsManager
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEmployeePage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  onTestFinished(() => { expect(tripwire.pageErrors).toEqual([]) })
  onTestFinished(async ({ task }) => {
    if (task.result?.state !== 'fail') return
    const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-skill-pagination')
    await mkdir(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, `failure-${task.name.replace(/[^a-z0-9]+/gi, '-')}.png`) })
  })
  return { root, scaffold, skills, page }
}

async function captureSkillFocus(page: Page, name: string, area: Locator, target: Locator) {
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-skill-pagination')
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
      if (await page.locator('[role="dialog"][aria-modal="true"]').count() === 0) {
        await page.waitForFunction(drawer => Boolean(document.querySelector('[data-sidebar-drawer]')) === drawer, width < 768)
        if (await page.locator('[data-sidebar-drawer]:not([data-sidebar-collapsed])').count()) {
          await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
          await target.focus()
        }
        for (const tab of await page.locator('.dssm-scope-tabs [role="tab"]').all()) {
          const fits = await tab.evaluate(node => node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth)
          expect(fits).toBe(true)
        }
      }
      await target.scrollIntoViewIfNeeded()
      expect(await target.evaluate(node => node === document.activeElement)).toBe(true)
      expect(await area.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `${name}-${theme}-${width}.png`), animations: 'disabled' })
    }
  }
}

it.each([false, true].flatMap(retained => (['button', 'escape', 'mask'] as const).map(close => ({ retained, close }))))(
  'returns skill detail focus after background removal (retained=$retained, close=$close)', async ({ retained, close }) => {
    const { root, scaffold, skills, page } = await bootSkillFocus()
    const response = Promise.withResolvers<undefined>()
    let reads = 0
    const item = { name: 'focus-skill', declaredName: 'focus-skill', description: 'Read-only skill fixture', kind: 'directory' as const,
      path: join(root, 'focus-skill'), modelInvocable: true, userInvocable: true, invocationPolicyValid: true, hasFrontmatter: true,
      loadable: true, diagnostics: [], managerEnabled: true, managerOverride: null,
      effectiveModelInvocable: true, effectiveUserInvocable: true }
    const source = { key: 'company', path: root, label: 'Company', rank: 0, mutable: false, native: true, toggleable: true,
      exists: true, truncated: false, enabled: true, skills: [item], categories: [] }
    const directory = vi.spyOn(skills, 'readState').mockImplementation(async () => {
      if (++reads === 2) {
        await response.promise
        if (!retained) source.skills = []
      }
      return { roots: [source], writeDestinations: [], projects: [],
        summary: { total: source.skills.length, enabled: source.skills.length, disabled: 0, issues: 0 }, trash: [], warnings: [] }
    })
    const detail = vi.spyOn(skills, 'readDetail').mockResolvedValue({ root: source.key, name: item.name, declaredName: item.name,
      description: '', path: item.path, kind: item.kind, diagnostics: [], body: 'Read-only instructions', document: 'Read-only instructions',
      frontmatter: null, loadable: true, sourceReadOnly: true })
    onTestFinished(() => { response.resolve(undefined); directory.mockRestore(); detail.mockRestore() })
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    await expect.poll(() => reads).toBe(2)
    const area = page.locator('.dssm-section')
    const search = area.getByRole('textbox', { name: 'Search', exact: true })
    await search.fill('focus')
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
    const originalSearch = await search.elementHandle()
    const trigger = area.getByRole('button', { name: 'More', exact: true })
    await trigger.click()
    await page.getByRole('menuitem', { name: 'View details', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: 'Body', exact: true }).waitFor()
    response.resolve(undefined)
    await expect.poll(() => area.getByRole('switch', { name: 'Toggle skill focus-skill', exact: true }).count()).toBe(retained ? 1 : 0)
    if (close === 'escape') await page.keyboard.press('Escape')
    else if (close === 'mask') await page.locator('[role="presentation"] > [aria-hidden="true"]').last().click({ position: { x: 4, y: 4 } })
    else await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const target = retained ? trigger : search
    await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await search.evaluate((node, previous) => node === previous, originalSearch)).toBe(true)
    expect(await search.inputValue()).toBe('focus')
    expect(await search.evaluate(node => node instanceof HTMLInputElement ? [node.selectionStart, node.selectionEnd] : [])).toEqual([1, 3])
    if (!retained && close === 'button') await captureSkillFocus(page, 'detail-close-removed', area, target)
  })

it.each((['clawhub', 'skillsh'] as const).flatMap(source =>
  (['install', 'uninstall'] as const).flatMap(action => [false, true].map(filtered => ({ source, action, filtered }))),
))('returns $source $action focus after closing (filtered=$filtered)', async ({ source, action, filtered }) => {
  const { root, scaffold, skills, page } = await bootSkillFocus()
  const response = Promise.withResolvers<undefined>()
  let installed = action === 'uninstall'
  let writes = 0
  const id = source === 'clawhub' ? 'clawhub:fixture/orders' : 'skillsh:fixture/skills/orders'
  const repositories = vi.spyOn(skills, 'listRepositories').mockImplementation(async () => ({ repositories: [],
    installRoots: [{ key: 'dsh', path: join(root, 'skills'), label: 'DSH', available: true }],
    catalogInstalls: installed ? [id] : [], catalogCopies: installed ? [{ id, name: 'orders', installedRoot: 'dsh', canUninstall: true }] : [],
    catalogWarnings: [] }))
  const ranking = vi.spyOn(skills, 'listClawHub').mockResolvedValue({
    items: [{ ownerHandle: 'fixture', slug: 'orders', displayName: 'Order review', summary: '' }], nextCursor: null,
  })
  const searchSkills = vi.spyOn(skills, 'searchSkillsSh').mockResolvedValue({
    skills: [{ id: 'fixture/skills/orders', source: 'fixture/skills', skillId: 'orders', name: 'Order review' }],
  })
  const commit = async () => { writes++; await response.promise; installed = !installed }
  const install = vi.spyOn(skills, 'installCatalog').mockImplementation(async () => {
    await commit()
    return { name: 'orders', root: 'dsh' }
  })
  const uninstall = vi.spyOn(skills, 'trashSkill').mockImplementation(async () => {
    await commit()
    return { id: 'trash', name: 'orders', deletedAt: '2026-11-12T00:00:00.000Z', root: { key: 'dsh', scope: 'user', label: 'DSH' } }
  })
  onTestFinished(() => {
    response.resolve(undefined)
    repositories.mockRestore(); ranking.mockRestore(); searchSkills.mockRestore(); install.mockRestore(); uninstall.mockRestore()
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  await page.getByRole('tab', { name: 'Discover Skills', exact: true }).click()
  await page.getByRole('button', { name: source === 'clawhub' ? 'ClawHub' : 'skills.sh', exact: true }).click()
  const area = page.locator('.dssm-section')
  const search = area.getByRole('textbox', { name: source === 'clawhub' ? 'Search ClawHub skills' : 'Search skills.sh', exact: true })
  if (source === 'skillsh') await search.fill('orders')
  const originalSearch = await search.elementHandle()
  const status = action === 'uninstall' ? 'Installed' : source === 'skillsh' ? 'Not installed' : 'Available'
  if (filtered) {
    await area.getByRole('button', { name: 'All statuses', exact: true }).click()
    await page.getByRole('menuitem', { name: status, exact: true }).click()
  }
  await area.getByRole('button', { name: action === 'install' ? 'Install' : 'Uninstall', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const submit = dialog.getByRole('button', { name: action === 'install' ? 'Install' : 'Move to Trash', exact: true })
  await submit.press('Enter')
  await expect.poll(() => writes).toBe(1)
  await page.keyboard.press('Enter')
  expect(writes).toBe(1)
  response.resolve(undefined)
  await dialog.waitFor({ state: 'hidden' })
  await expect.poll(() => area.locator('#dssm-scope-panel').getAttribute('aria-busy')).toBe('false')
  const target = !filtered && action === 'install' ? area.getByRole('button', { name: 'Install elsewhere', exact: true }) : search
  await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await area.getByText('Order review', { exact: true }).count()).toBe(filtered ? 0 : 1)
  expect(await search.evaluate((node, previous) => node === previous, originalSearch)).toBe(true)
  expect(await search.inputValue()).toBe(source === 'skillsh' ? 'orders' : '')
  expect(await area.getByRole('button', { name: 'All statuses', exact: true }).textContent()).toBe(filtered ? status : 'All statuses')
  if (filtered) await captureSkillFocus(page, `catalog-close-${source}-${action}`, area, target)
})

it.each([ ...(['github', 'clawhub'] as const).flatMap(source =>
  (['install', 'uninstall'] as const).map(action => ({ source, action })),
), ...(['update', 'rollback'] as const).map(action => ({ source: 'github' as const, action })),
])('retains $source $action controls through failure and retry without moving adjacent buttons', async ({ source, action }) => {
  const { root, scaffold, skills, page } = await bootSkillFocus()
  const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
  let installed = action !== 'install'
  let writes = 0
  const catalogId = 'clawhub:fixture/orders'
  const repo = { id: 'stable-repository', owner: 'fixture', name: 'skills', ref: '', subdirectory: '', commit: 'revision',
    refreshedAt: null, error: null }
  const copy = { installedRoot: 'dsh' as const, tracked: true as const, status: 'installed',
    updateAvailable: action === 'update', canRollback: action === 'rollback', canUninstall: true }
  const repositories = vi.spyOn(skills, 'listRepositories').mockImplementation(async () => ({
    repositories: [{ ...repo, skills: [{ path: 'orders', name: 'orders', description: 'Order review', valid: true,
      documentHash: 'hash', body: 'Read-only instructions', status: installed ? 'installed' : 'available',
      installations: installed ? [copy] : [] }] }],
    installRoots: [{ key: 'dsh', path: join(root, 'skills'), label: 'DSH', available: true }],
    catalogInstalls: installed ? [catalogId] : [],
    catalogCopies: installed ? [{ id: catalogId, name: 'orders', installedRoot: 'dsh', canUninstall: true }] : [],
    catalogWarnings: [],
  }))
  const ranking = vi.spyOn(skills, 'listClawHub').mockResolvedValue({
    items: [{ ownerHandle: 'fixture', slug: 'orders', displayName: 'Order review', summary: '' }], nextCursor: null,
  })
  const commit = async () => {
    const gate = gates[writes++]
    if (!gate) throw new Error('Unexpected duplicate skill write')
    await gate.promise
    if (writes === 1) throw new RemoteError('skills/operation', 'Skill write temporarily unavailable', {
      code: 'error.repo.conflict', error: 'Skill write temporarily unavailable',
      ...(source === 'github' && action === 'uninstall' ? { params: { path: '/fixture/' + 'unavailable-segment/'.repeat(40) } } : {}),
    })
    if (action === 'install' || action === 'uninstall') installed = !installed
  }
  const installRepo = vi.spyOn(skills, 'installRepository').mockImplementation(async () => {
    await commit(); return { name: 'orders', root: 'dsh', commit: 'revision' }
  })
  const installCatalog = vi.spyOn(skills, 'installCatalog').mockImplementation(async () => {
    await commit(); return { name: 'orders', root: 'dsh' }
  })
  const trashReceipt = { id: 'trashed', name: 'orders', deletedAt: '2026-11-12T00:00:00Z', root: { key: 'dsh', scope: 'user', label: 'DSH' } }
  const uninstallRepo = vi.spyOn(skills, 'uninstallRepository').mockImplementation(async () => {
    await commit(); return trashReceipt
  })
  const uninstallCatalog = vi.spyOn(skills, 'trashSkill').mockImplementation(async () => {
    await commit(); return trashReceipt
  })
  const preview = vi.spyOn(skills, 'previewUpdate').mockResolvedValue({ token: 'current', commit: 'new', localModified: false,
    changes: [{ path: 'SKILL.md', kind: 'modified' }], rollback: action === 'rollback' })
  const update = vi.spyOn(skills, 'updateRepository').mockImplementation(async () => {
    await commit(); return { name: 'orders', commit: 'new' }
  })
  const rollback = vi.spyOn(skills, 'rollbackRepository').mockImplementation(async () => {
    await commit(); return { name: 'orders', commit: 'old' }
  })
  onTestFinished(() => {
    gates.forEach((gate) => { gate.resolve(undefined) })
    repositories.mockRestore(); ranking.mockRestore(); installRepo.mockRestore(); installCatalog.mockRestore()
    uninstallRepo.mockRestore(); uninstallCatalog.mockRestore()
    preview.mockRestore(); update.mockRestore(); rollback.mockRestore()
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  await page.getByRole('tab', { name: 'Discover Skills', exact: true }).click()
  const area = page.locator('.dssm-section')
  if (source === 'clawhub') await area.getByRole('button', { name: 'ClawHub', exact: true }).click()
  else await area.getByRole('button', { name: /fixture\/skills/, expanded: false }).click()
  const search = area.getByRole('textbox', { name: source === 'github' ? 'Search repository skills' : 'Search ClawHub skills', exact: true })
  const originalSearch = await search.elementHandle()
  const title = { install: 'Install', uninstall: 'Uninstall', update: 'Review update', rollback: 'Restore previous version' }[action]
  const trigger = area.getByRole('button', { name: title, exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: title, exact: true })
  const submit = dialog.getByRole('button', { name: /^(Install|Installing…|Move to Trash|Uninstalling…|Back up and update|Back up and restore|Updating…)$/ })
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
  const originalSubmit = await submit.elementHandle(), originalCancel = await cancel.elementHandle()
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-skill-pagination')
  await mkdir(screenshots, { recursive: true })
  const geometry = (control: Locator) => control.evaluate((node) => {
    const { x, y, width, height } = node.getBoundingClientRect()
    return { x, y, width, height }
  })
  const before = [await geometry(submit), await geometry(cancel)]
  await submit.press('Enter')
  await expect.poll(() => writes).toBe(1)
  await expect.poll(() => submit.getAttribute('aria-busy')).toBe('true')
  expect(await geometry(submit)).toEqual(before[0])
  expect(await geometry(cancel)).toEqual(before[1])
  expect(await submit.evaluate((node, previous) => node === previous && node === document.activeElement, originalSubmit)).toBe(true)
  await page.screenshot({ path: join(screenshots, `${source}-${action}-pending-light-1440.png`), animations: 'disabled' })
  await page.keyboard.press('Enter')
  await page.keyboard.press(' ')
  await cancel.dispatchEvent('click')
  await page.keyboard.press('Escape')
  expect(writes).toBe(1)
  expect(await dialog.count()).toBe(1)
  gates[0]!.resolve(undefined)
  const alert = dialog.getByRole('alert')
  await alert.waitFor()
  const originalError = await alert.elementHandle()
  expect(await geometry(submit)).toEqual(before[0])
  expect(await geometry(cancel)).toEqual(before[1])
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 390, height: 560 })
  await submit.scrollIntoViewIfNeeded()
  const beforeRetry = [await geometry(submit), await geometry(cancel)]
  const content = dialog.locator('.dssm-modal-content > div:last-child')
  await content.evaluate((node) => { node.scrollTop = Math.min(40, node.scrollHeight - node.clientHeight) })
  const scrollTop = await content.evaluate(node => node.scrollTop)
  if (action === 'install') expect(scrollTop).toBeGreaterThan(0)
  const failure = dialog.locator('.dssm-write-feedback')
  if (source === 'github' && action === 'uninstall') {
    expect(await alert.textContent()).toContain('/fixture/' + 'unavailable-segment/'.repeat(40))
    expect(await failure.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
    await failure.focus()
    await page.keyboard.press('End')
    await expect.poll(() => failure.evaluate(node => node.scrollTop === node.scrollHeight - node.clientHeight)).toBe(true)
    expect(await failure.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await geometry(submit)).toEqual(beforeRetry[0])
    expect(await geometry(cancel)).toEqual(beforeRetry[1])
  }
  const failureScrollTop = await failure.evaluate(node => node.scrollTop)
  await submit.press('Enter')
  await expect.poll(() => writes).toBe(2)
  await expect.poll(() => submit.getAttribute('aria-busy')).toBe('true')
  expect(await geometry(submit)).toEqual(beforeRetry[0])
  expect(await geometry(cancel)).toEqual(beforeRetry[1])
  expect(await submit.evaluate((node, previous) => node === previous && node === document.activeElement, originalSubmit)).toBe(true)
  expect(await cancel.evaluate((node, previous) => node === previous, originalCancel)).toBe(true)
  expect(await alert.evaluate((node, previous) => node === previous, originalError)).toBe(true)
  expect(await content.evaluate(node => node.scrollTop)).toBe(scrollTop)
  expect(await failure.evaluate(node => node.scrollTop)).toBe(failureScrollTop)
  expect(await controlIsUnclipped(submit)).toBe(true)
  expect(await controlIsUnclipped(cancel)).toBe(true)
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  await page.screenshot({ path: join(screenshots, `${source}-${action}-retry-dark-390.png`), animations: 'disabled' })
  gates[1]!.resolve(undefined)
  await dialog.waitFor({ state: 'hidden' })
  await expect.poll(() => area.locator('#dssm-scope-panel').getAttribute('aria-busy')).toBe('false')
  expect(writes).toBe(2)
  expect(await search.evaluate((node, previous) => node === previous, originalSearch)).toBe(true)
  const target = action === 'update' || action === 'rollback' ? trigger
    : action === 'install' ? area.getByRole('button', { name: 'Install elsewhere', exact: true }) : search
  await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
})

it.each(['success', 'failure'] as const)('returns add repository focus during a pending scan and its %s result', async (result) => {
  const { scaffold, skills, page } = await bootSkillFocus()
  const response = Promise.withResolvers<undefined>()
  const repo = { id: 'focus-repository', owner: 'fixture', name: 'orders', ref: '', subdirectory: '', commit: 'revision',
    refreshedAt: null, error: null, skills: [] }
  let added = false
  let scans = 0
  const repositories = vi.spyOn(skills, 'listRepositories').mockImplementation(async () => ({ repositories: added ? [repo] : [],
    installRoots: [], catalogInstalls: [], catalogCopies: [], catalogWarnings: [] }))
  const add = vi.spyOn(skills, 'addRepository').mockImplementation(async () => { added = true; return repo })
  const scan = vi.spyOn(skills, 'refreshRepository').mockImplementation(async () => {
    scans++
    await response.promise
    if (result === 'failure') throw new Error('Repository scan temporarily unavailable')
    return repo
  })
  onTestFinished(() => { response.resolve(undefined); repositories.mockRestore(); add.mockRestore(); scan.mockRestore() })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  await page.getByRole('tab', { name: 'Discover Skills', exact: true }).click()
  const area = page.locator('.dssm-section')
  const search = area.getByRole('textbox', { name: 'Search repository skills', exact: true })
  const originalSearch = await search.elementHandle()
  const trigger = area.getByRole('button', { name: 'Add repository', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: 'Repository URL', exact: true }).fill('fixture/orders')
  await dialog.getByRole('button', { name: 'Add and scan', exact: true }).press('Enter')
  await expect.poll(() => scans).toBe(1)
  await dialog.waitFor({ state: 'hidden' })
  await expect.poll(() => search.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await trigger.isDisabled()).toBe(true)
  await search.fill('orders')
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
  const other = area.getByRole('button', { name: /^GitHub/ })
  await other.focus()
  response.resolve(undefined)
  await expect.poll(() => trigger.isEnabled()).toBe(true)
  expect(await other.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await search.evaluate((node, previous) => node === previous, originalSearch)).toBe(true)
  expect(await search.inputValue()).toBe('orders')
  expect(await search.evaluate(node => node instanceof HTMLInputElement ? [node.selectionStart, node.selectionEnd] : [])).toEqual([1, 3])
  expect(add).toHaveBeenCalledTimes(1)
  expect(scan).toHaveBeenCalledTimes(1)
})

it.each(['cancel', 'remove'] as const)('keeps repository management focus across %s confirmation', async (action) => {
  const { scaffold, skills, page } = await bootSkillFocus()
  const repo = { id: 'focus-repository', owner: 'fixture', name: 'orders', ref: '', subdirectory: '', commit: 'revision',
    refreshedAt: null, error: null, skills: [] }
  let removed = false
  const pending = Promise.withResolvers<undefined>()
  const repositories = vi.spyOn(skills, 'listRepositories').mockImplementation(async () => ({ repositories: removed ? [] : [repo],
    installRoots: [], catalogInstalls: [], catalogCopies: [], catalogWarnings: [] }))
  const remove = vi.spyOn(skills, 'removeRepository').mockImplementation(async () => {
    if (remove.mock.calls.length === 1) throw new RemoteError('skills/operation', 'Repository removal rejected', {
      code: 'error.state.invalid', error: 'Repository removal rejected', params: { path: '资料/模板/'.repeat(80) + 'ERROR-END' },
    })
    await pending.promise
    removed = true; return { id: repo.id }
  })
  onTestFinished(() => { pending.resolve(undefined); repositories.mockRestore(); remove.mockRestore() })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  await page.getByRole('tab', { name: 'Discover Skills', exact: true }).click()
  const area = page.locator('.dssm-section')
  const trigger = area.getByRole('button', { name: 'Manage repositories', exact: true })
  await trigger.click()
  const dialog = page.locator('[role="dialog"][aria-modal="true"]')
  const close = dialog.getByRole('button', { name: 'Close', exact: true })
  const originalClose = await close.elementHandle()
  await dialog.getByRole('button', { name: 'Remove repository', exact: true }).click()
  await expect.poll(() => close.evaluate(node => node === document.activeElement)).toBe(true)
  const submit = dialog.getByRole('button', { name: action === 'cancel' ? 'Cancel' : 'Confirm removal', exact: true })
  const bounds = await dialog.boundingBox()
  const submitBounds = await submit.boundingBox()
  await submit.press('Enter')
  if (action === 'remove') {
    const alert = await dialog.getByRole('alert').elementHandle()
    expect(await dialog.boundingBox()).toEqual(bounds)
    expect(await submit.boundingBox()).toEqual(submitBounds)
    expect(await submit.evaluate(node => node === document.activeElement)).toBe(true)
    await captureSkillFocus(page, 'repository-remove-failure', dialog, submit)
    const feedback = dialog.locator('.dssm-write-feedback')
    await feedback.focus()
    await page.keyboard.press('End')
    await expect.poll(() => feedback.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
    await submit.press('Enter')
    await expect.poll(() => remove.mock.calls.length).toBe(2)
    expect(await dialog.getByRole('alert').evaluate((node, previous) => node === previous, alert)).toBe(true)
    await page.keyboard.press('Enter')
    expect(remove).toHaveBeenCalledTimes(2)
    pending.resolve(undefined)
  }
  await page.getByRole('dialog', { name: 'Manage repositories', exact: true }).waitFor()
  await expect.poll(() => close.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await close.evaluate((node, previous) => node === previous, originalClose)).toBe(true)
  expect(remove).toHaveBeenCalledTimes(action === 'remove' ? 2 : 0)
  await expect.poll(() => trigger.isEnabled()).toBe(true)
  await close.click()
  await dialog.waitFor({ state: 'hidden' })
  expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true)
})

it.each((['catalog', 'toolbar', 'manage'] as const).flatMap(surface =>
  [false, true].flatMap(retained => [false, true].map(elsewhere => ({ surface, retained, elsewhere }))),
))('keeps repository $surface refresh focus (retained=$retained, elsewhere=$elsewhere)', async ({ surface, retained, elsewhere }) => {
  const { scaffold, skills, page } = await bootSkillFocus()
  const response = Promise.withResolvers<undefined>()
  let changed = false
  let scans = 0
  const skill = { path: 'skills/orders', name: 'orders', description: 'Read-only repository fixture', valid: true,
    documentHash: 'hash', body: 'Read-only instructions', status: 'available', installations: [] }
  const repo = { id: 'focus-repository', owner: 'fixture', name: 'skills', ref: '', subdirectory: '', commit: 'revision',
    refreshedAt: null, error: null, skills: [skill] }
  const repositories = vi.spyOn(skills, 'listRepositories').mockImplementation(async () => ({
    repositories: changed && !retained && surface !== 'catalog' ? [] : [{ ...repo, skills: changed && !retained ? [] : [skill] }],
    installRoots: [], catalogInstalls: [], catalogCopies: [], catalogWarnings: [],
  }))
  const refresh = vi.spyOn(skills, 'refreshRepository').mockImplementation(async () => {
    scans++
    await response.promise
    return repo
  })
  onTestFinished(() => { response.resolve(undefined); repositories.mockRestore(); refresh.mockRestore() })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  await page.getByRole('tab', { name: 'Discover Skills', exact: true }).click()
  const area = page.locator('.dssm-section')
  const search = area.getByRole('textbox', { name: 'Search repository skills', exact: true })
  await search.fill('orders')
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
  const originalSearch = await search.elementHandle()
  const detail = area.getByRole('button', { name: 'Details', exact: true })
  await detail.waitFor()
  if (surface === 'manage') await area.getByRole('button', { name: 'Manage repositories', exact: true }).click()
  const container = surface === 'manage' ? page.getByRole('dialog') : area
  const trigger = container.getByRole('button', { name: 'Refresh & check updates', exact: true })
  const originalTrigger = await trigger.elementHandle()
  await trigger.press('Enter')
  await expect.poll(() => scans).toBe(1)
  const focused = surface === 'catalog' ? detail : trigger
  await focused.focus()
  const other = surface === 'manage' ? container.getByRole('button', { name: 'Close', exact: true }) : search
  if (elsewhere) await other.focus()
  changed = true
  response.resolve(undefined)
  await expect.poll(() => area.locator('#dssm-scope-panel').getAttribute('aria-busy')).toBe('false')
  const fallback = surface === 'manage' ? container.getByRole('button', { name: 'Close', exact: true }) : search
  const target = elsewhere ? other : retained ? focused : fallback
  await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await search.evaluate((node, previous) => node === previous, originalSearch)).toBe(true)
  expect(await search.inputValue()).toBe('orders')
  expect(await search.evaluate(node => node instanceof HTMLInputElement ? [node.selectionStart, node.selectionEnd] : [])).toEqual([1, 3])
  if (surface === 'toolbar') expect(await trigger.evaluate((node, previous) => node === previous, originalTrigger)).toBe(true)
  if (!elsewhere && !retained) await captureSkillFocus(page, `repository-refresh-${surface}`, area, target)
})

it.each((['available', 'missing', 'failed'] as const).flatMap(result => [false, true].map(elsewhere => ({ result, elsewhere }))))(
  'keeps repository workspace read focus with $result results (elsewhere=$elsewhere)', async ({ result, elsewhere }) => {
    const { root, scaffold, skills, page } = await bootSkillFocus()
    const response = Promise.withResolvers<undefined>()
    let reads = 0
    const skill = { path: 'skills/orders', name: 'orders', description: 'Read-only workspace fixture', valid: true,
      documentHash: 'hash', body: 'Read-only instructions', status: 'installed', installations: [{ installedRoot: 'dsh' as const, installedWorkspace: root,
        tracked: true as const, status: 'installed', updateAvailable: false, canRollback: false, canUninstall: true }] }
    const repo = { id: 'focus-repository', owner: 'fixture', name: 'skills', ref: '', subdirectory: '', commit: 'revision',
      refreshedAt: null, error: null, skills: [skill] }
    const repositories = vi.spyOn(skills, 'listRepositories').mockResolvedValue({ repositories: [repo],
      installRoots: [], catalogInstalls: [], catalogCopies: [], catalogWarnings: [] })
    const refresh = vi.spyOn(skills, 'refreshRepository').mockResolvedValue(repo)
    const workspaces = vi.spyOn(skills, 'listWorkspaces').mockImplementation(async () => {
      if (++reads > 1) {
        await response.promise
        if (result === 'failed') throw new Error('Workspace registry temporarily unavailable')
      }
      return { items: reads > 1 && result === 'missing' ? [] : [{ name: reads > 1 ? 'Refreshed workspace' : 'Focus workspace', path: root, projectRoot: root,
        registeredPaths: [root], available: true, skillCount: 1 }] }
    })
    const uninstall = vi.spyOn(skills, 'uninstallRepository')
    onTestFinished(() => {
      response.resolve(undefined); repositories.mockRestore(); refresh.mockRestore(); workspaces.mockRestore(); uninstall.mockRestore()
    })
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    await page.getByRole('tab', { name: 'Discover Skills', exact: true }).click()
    const area = page.locator('.dssm-section')
    const search = area.getByRole('textbox', { name: 'Search repository skills', exact: true })
    await search.fill('orders')
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
    const originalSearch = await search.elementHandle()
    const trigger = area.getByRole('button', { name: 'Uninstall', exact: true })
    await expect.poll(() => trigger.isEnabled()).toBe(true)
    const originalTrigger = await trigger.elementHandle()
    await area.getByRole('button', { name: 'Refresh & check updates', exact: true }).click()
    await expect.poll(() => reads).toBe(2)
    await trigger.focus()
    if (elsewhere) await search.focus()
    response.resolve(undefined)
    const target = elsewhere || result !== 'available' ? search : trigger
    if (result === 'available') await area.getByText(/Refreshed workspace/).waitFor()
    await expect.poll(() => trigger.isEnabled()).toBe(result === 'available')
    await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
    const notice = area.locator('.dssm-repo-copy [role="status"]')
    expect(await notice.count()).toBe(result === 'available' ? 0 : 1)
    const missing = area.getByText('The original project is unregistered or unavailable. Re-register it in the sidebar and refresh to manage this copy.', { exact: true })
    expect(await missing.count()).toBe(result === 'missing' ? 1 : 0)
    if (result === 'failed') {
      expect(await notice.textContent()).toMatchInlineSnapshot('"The skill service is temporarily unavailable. Try again."')
    }
    expect(await search.evaluate((node, previous) => node === previous, originalSearch)).toBe(true)
    expect(await search.inputValue()).toBe('orders')
    const selection = await search.evaluate(node => node instanceof HTMLInputElement ? [node.selectionStart, node.selectionEnd] : [])
    expect(selection).toEqual([1, 3])
    expect(await trigger.evaluate((node, previous) => node === previous, originalTrigger)).toBe(true)
    expect(uninstall).not.toHaveBeenCalled()
    if (!elsewhere && result !== 'available') await captureSkillFocus(page, `repository-workspace-${result}`, area, target)
  },
)

it.each((['market', 'mine', 'project', 'trash'] as const).flatMap(surface =>
  (surface === 'market' || surface === 'mine' ? [false, true] : [false]).flatMap(background =>
    (surface === 'project' ? [false, true] : [false]).flatMap(workspaceList =>
      (['removed', 'failed'] as const).flatMap(result => [false, true].map(elsewhere =>
        ({ surface, background, workspaceList, result, elsewhere }))))),
))('recovers skill $surface read focus with $result results (background=$background, workspaceList=$workspaceList, elsewhere=$elsewhere)', async ({ surface, background, workspaceList, result, elsewhere }) => {
  const { root, scaffold, skills, page } = await bootSkillFocus()
  const response = Promise.withResolvers<undefined>()
  let refreshing = false
  let reads = 0
  let refreshReads = 0
  const item = { name: 'focus-skill', declaredName: 'focus-skill', description: 'Read-only skill fixture', kind: 'directory' as const,
    path: join(root, 'focus-skill'), modelInvocable: true, userInvocable: true, invocationPolicyValid: true, hasFrontmatter: true,
    loadable: true, diagnostics: [], managerEnabled: true, managerOverride: null,
    effectiveModelInvocable: true, effectiveUserInvocable: true }
  const source = { key: surface === 'market' ? 'company' : 'dsh', path: root, label: surface === 'market' ? 'Company' : 'DSH',
    rank: 0, mutable: surface !== 'market', native: true, toggleable: true, exists: true, truncated: false, enabled: true,
    skills: [item], categories: [] }
  const trash = { id: '1794105400000-00000000-0000-0000-0000-000000000005', name: item.name,
    deletedAt: '2026-11-08T02:00:00.000Z', root: { key: 'dsh', scope: 'user' as const, label: 'DSH' }, entries: [item.name] }
  const state = { roots: [source], writeDestinations: [], projects: [],
    summary: { total: 1, enabled: 1, disabled: 0, issues: 0 }, trash: [trash], warnings: [] }
  const read = async () => {
    refreshReads++
    await response.promise
    if (result === 'failed') throw new Error('Skill refresh temporarily unavailable')
    source.skills = []
    state.trash = []
  }
  const directory = vi.spyOn(skills, 'readState').mockImplementation(async () => {
    reads++
    if ((refreshing || background && reads === 2) && surface !== 'project') await read()
    return state
  })
  const workspaces = vi.spyOn(skills, 'listWorkspaces').mockImplementation(async () => {
    if (refreshing && workspaceList) await read()
    return { items: refreshing && workspaceList ? [] : [{ name: 'Focus workspace', path: root,
      registeredPaths: [root], available: true, skillCount: 1 }] }
  })
  const workspace = vi.spyOn(skills, 'readWorkspace').mockImplementation(async () => {
    if (refreshing && surface === 'project' && !workspaceList) await read()
    return { project: { root, name: 'Focus workspace', workspaceCwds: [root] }, roots: [source], warnings: [] }
  })
  onTestFinished(() => { response.resolve(undefined); directory.mockRestore(); workspaces.mockRestore(); workspace.mockRestore() })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await expect.poll(() => reads).toBe(2)
  if (surface !== 'market') await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  if (surface === 'project') await page.getByRole('tab', { name: 'Project skills', exact: true }).click()
  const area = page.locator('.dssm-section')
  const search = area.getByRole('textbox', { name: 'Search', exact: true })
  if (surface !== 'trash') await search.fill('focus')
  const originalSearch = surface === 'trash' ? null : await search.elementHandle()
  const create = area.getByRole('button', { name: 'Create skill', exact: true })
  const originalCreate = surface === 'trash' ? null : await create.elementHandle()
  if (surface !== 'trash') await area.getByRole('switch', { name: 'Toggle skill focus-skill', exact: true }).waitFor()
  refreshing = true
  if (surface === 'trash') await area.getByRole('tab', { name: /^Trash/ }).click()
  else if (!background) await area.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect.poll(() => refreshReads).toBe(1)
  const trigger = surface === 'trash' ? area.getByRole('button', { name: 'Restore', exact: true })
    : area.getByRole('switch', { name: 'Toggle skill focus-skill', exact: true })
  await trigger.focus()
  const other = surface === 'trash' ? area.getByRole('tab', { name: 'Mine', exact: true }) : search
  if (elsewhere) {
    await other.focus()
    if (surface !== 'trash') await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
  }
  response.resolve(undefined)
  const retained = surface === 'project' && result === 'failed'
  if (retained) await area.getByRole('alert').waitFor()
  else await trigger.waitFor({ state: 'hidden' })
  const target = elsewhere ? other : retained ? trigger : surface === 'trash' ? page.locator('#dssm-library-panel') : search
  await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
  if (result === 'failed') {
    const notice = area.getByRole('alert')
    await notice.waitFor()
    if (surface !== 'project') {
      expect(await notice.locator('p').textContent()).toMatchInlineSnapshot(
        '"The skill list could not be read: The skill service is temporarily unavailable. Try again."',
      )
    }
  }
  if (originalSearch) {
    expect(await search.evaluate((node, original) => node === original, originalSearch)).toBe(true)
    expect(await search.inputValue()).toBe('focus')
    if (elsewhere) {
      const selection = await search.evaluate(node => node instanceof HTMLInputElement ? [node.selectionStart, node.selectionEnd] : [])
      expect(selection).toEqual([1, 3])
    }
  }
  if (originalCreate) expect(await create.evaluate((node, original) => node === original, originalCreate)).toBe(true)
  if (!elsewhere && !background) await captureSkillFocus(page, `read-${surface}${workspaceList ? '-list' : ''}-${result}`, area, target)
})

it.each((['trash', 'delete', 'restore'] as const).flatMap(operation => [false, true].map(elsewhere => ({ operation, elsewhere }))))(
  'recovers skill $operation focus after its row is removed (elsewhere=$elsewhere)', async ({ operation, elsewhere }) => {
    const { root, scaffold, skills, page } = await bootSkillFocus()
    const pending = Promise.withResolvers<undefined>()
    const rejected = Promise.withResolvers<undefined>()
    let writes = 0
    const item = { name: 'focus-skill', declaredName: 'focus-skill', description: 'Read-only skill fixture', kind: 'directory' as const,
      path: join(root, 'focus-skill'), modelInvocable: true, userInvocable: true, invocationPolicyValid: true, hasFrontmatter: true,
      loadable: true, diagnostics: [], managerEnabled: true, managerOverride: null,
      effectiveModelInvocable: true, effectiveUserInvocable: true }
    const trash = { id: '1794105400000-00000000-0000-0000-0000-000000000005', name: item.name,
      deletedAt: '2026-11-08T02:00:00.000Z', root: { key: 'dsh', scope: 'user' as const, label: 'DSH' }, entries: [item.name] }
    const state = { roots: [{ key: 'dsh', path: root, label: 'DSH', rank: 0, mutable: true, native: true, toggleable: true,
      exists: true, truncated: false, enabled: true, skills: operation === 'trash' ? [item] : [], categories: [] }],
    writeDestinations: [], projects: [], summary: { total: 1, enabled: 1, disabled: 0, issues: 0 },
    trash: operation === 'trash' ? [] : [trash], warnings: [] }
    const directory = vi.spyOn(skills, 'readState').mockResolvedValue(state)
    const complete = async () => {
      writes++
      if (operation !== 'restore' && writes === 1) {
        await rejected.promise
        throw new RemoteError('skills/operation', 'Skill removal rejected', {
          code: 'error.state.invalid', error: 'Skill removal rejected', params: { path: '资料/模板/'.repeat(80) + 'ERROR-END' },
        })
      }
      await pending.promise
      state.roots[0]!.skills = operation === 'restore' ? [item] : []
      state.trash = operation === 'trash' ? [trash] : []
    }
    const moved = vi.spyOn(skills, 'trashSkill').mockImplementation(async () => { await complete(); return trash })
    const removed = vi.spyOn(skills, 'deleteTrash').mockImplementation(async () => { await complete(); return { id: trash.id, name: item.name } })
    const restored = vi.spyOn(skills, 'restoreTrash').mockImplementation(async () => { await complete(); return trash })
    onTestFinished(() => {
      rejected.resolve(undefined); pending.resolve(undefined)
      directory.mockRestore(); moved.mockRestore(); removed.mockRestore(); restored.mockRestore()
    })
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    const area = page.locator('.dssm-section')
    const search = area.getByRole('textbox', { name: 'Search', exact: true })
    let original
    if (operation === 'trash') {
      await area.getByRole('button', { name: /DSH skills/, expanded: false }).click()
      await search.fill('focus')
      await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
      original = await search.elementHandle()
      await area.getByRole('button', { name: 'More', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Move to trash', exact: true }).click()
    } else {
      await area.getByRole('tab', { name: /^Trash/ }).click()
      const trigger = area.getByRole('button', { name: operation === 'delete' ? 'Delete forever' : 'Restore', exact: true })
      await trigger.click()
    }
    if (operation !== 'restore') {
      const dialog = page.locator('[role="dialog"][aria-modal="true"]')
      await page.setViewportSize({ width: elsewhere ? 390 : 1440, height: elsewhere ? 560 : 900 })
      const submit = dialog.getByRole('button', { name: operation === 'trash' ? 'Move to trash' : 'Delete forever', exact: true })
      const bounds = await dialog.boundingBox()
      const submitBounds = await submit.boundingBox()
      const control = await submit.elementHandle()
      await submit.press('Enter')
      await expect.poll(() => writes).toBe(1)
      await page.keyboard.press('Enter')
      expect(writes).toBe(1)
      rejected.resolve(undefined)
      await dialog.getByRole('alert').waitFor()
      expect(await dialog.boundingBox()).toEqual(bounds)
      expect(await submit.boundingBox()).toEqual(submitBounds)
      expect(await submit.evaluate((node, previous) => node === previous && node === document.activeElement, control)).toBe(true)
      if (!elsewhere) await captureSkillFocus(page, `skill-${operation}-failure`, dialog, submit)
      const feedback = dialog.locator('.dssm-write-feedback')
      await feedback.focus()
      await page.keyboard.press('End')
      await expect.poll(() => feedback.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
      await submit.press('Enter')
    }
    const expectedWrites = operation === 'restore' ? 1 : 2
    await expect.poll(() => writes).toBe(expectedWrites)
    await page.keyboard.press('Enter')
    expect(writes).toBe(expectedWrites)
    const other = area.locator('.dssm-scope-tabs [role="tab"]').first()
    if (elsewhere) await other.focus()
    pending.resolve(undefined)
    await page.locator('[role="dialog"][aria-modal="true"]').waitFor({ state: 'hidden' })
    const target = elsewhere ? other : operation === 'trash' ? search : page.locator('#dssm-library-panel')
    await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
    if (original) {
      expect(await search.evaluate((node, previous) => node === previous, original)).toBe(true)
      expect(await search.inputValue()).toBe('focus')
      const selection = await search.evaluate(node => node instanceof HTMLInputElement ? [node.selectionStart, node.selectionEnd] : [])
      expect(selection).toEqual([1, 3])
    }
    if (!elsewhere) await captureSkillFocus(page, `removed-${operation}`, area, target)
  },
)

it.each((['market', 'mine'] as const).flatMap(scope => [false, true].map(elsewhere => ({ scope, elsewhere }))))(
  'recovers skill $scope toggle focus through failure and filtered removal (elsewhere=$elsewhere)', async ({ scope, elsewhere }) => {
    const { root, scaffold, skills, page } = await bootSkillFocus()
    const rejected = Promise.withResolvers<undefined>()
    const confirmed = Promise.withResolvers<undefined>()
    let writes = 0
    const item = { name: 'focus-skill', declaredName: 'focus-skill', description: 'Read-only skill fixture', kind: 'directory' as const,
      path: join(root, 'focus-skill'), modelInvocable: true, userInvocable: true, invocationPolicyValid: true, hasFrontmatter: true,
      loadable: true, diagnostics: [], managerEnabled: true, managerOverride: null,
      effectiveModelInvocable: true, effectiveUserInvocable: true }
    const state = { roots: [{ key: scope === 'market' ? 'company' : 'dsh', path: root, label: scope === 'market' ? 'Company' : 'DSH',
      rank: 0, mutable: scope === 'mine', native: true, toggleable: true,
      exists: true, truncated: false, enabled: true, skills: [item], categories: [] }], writeDestinations: [], projects: [],
    summary: { total: 1, enabled: 1, disabled: 0, issues: 0 }, trash: [], warnings: [] }
    const directory = vi.spyOn(skills, 'readState').mockResolvedValue(state)
    const write = vi.spyOn(skills, 'setSkillEnabled').mockImplementation(async () => {
      if (++writes === 1) {
        await rejected.promise
        throw new Error('Skill toggle temporarily unavailable')
      }
      if (writes !== 2) throw new Error('Duplicate skill toggle')
      await confirmed.promise
      item.managerEnabled = false
      return { root: state.roots[0]!.key, name: item.name, enabled: false }
    })
    onTestFinished(() => { rejected.resolve(undefined); confirmed.resolve(undefined); directory.mockRestore(); write.mockRestore() })
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    if (scope === 'mine') await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    const area = page.locator('.dssm-section')
    await area.getByRole('button', { name: 'Enablement', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Enabled', exact: true }).click()
    const search = area.getByRole('textbox', { name: 'Search', exact: true })
    await search.fill('focus')
    const originalSearch = await search.elementHandle()
    const toggle = area.getByRole('switch', { name: 'Toggle skill focus-skill', exact: true })
    const originalToggle = await toggle.elementHandle()
    const create = area.getByRole('button', { name: 'Create skill', exact: true })
    const originalCreate = await create.elementHandle()
    await toggle.press('Enter')
    await expect.poll(() => writes).toBe(1)
    expect(await toggle.isDisabled()).toBe(true)
    expect(await create.isEnabled()).toBe(true)
    if (elsewhere) await search.focus()
    rejected.resolve(undefined)
    await area.locator('.dssm-feedback').waitFor()
    await expect.poll(() => toggle.isEnabled()).toBe(true)
    expect(await toggle.evaluate((node, prior) => node === prior && node.getAttribute('aria-checked') === 'true', originalToggle)).toBe(true)
    await expect.poll(() => (elsewhere ? search : toggle).evaluate(node => node === document.activeElement)).toBe(true)
    await toggle.press('Enter')
    await expect.poll(() => writes).toBe(2)
    await page.keyboard.press('Enter')
    expect(writes).toBe(2)
    if (elsewhere) {
      await search.focus()
      await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
    }
    confirmed.resolve(undefined)
    await toggle.waitFor({ state: 'hidden' })
    await expect.poll(() => search.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await search.evaluate((node, prior) => node === prior, originalSearch)).toBe(true)
    expect(await search.inputValue()).toBe('focus')
    if (elsewhere) {
      const selection = await search.evaluate(node => node instanceof HTMLInputElement ? [node.selectionStart, node.selectionEnd] : [])
      expect(selection).toEqual([1, 3])
    }
    expect(await area.getByRole('button', { name: 'Enablement', exact: true }).textContent()).toContain('Enabled')
    expect(await create.evaluate((node, prior) => node === prior, originalCreate)).toBe(true)
    expect(await create.isEnabled()).toBe(true)
    await area.getByText('No matching skills.', { exact: true }).waitFor()
    if (!elsewhere) await captureSkillFocus(page, `toggle-result-${scope}`, area, search)
  },
)

it.each((['file', 'folder'] as const).flatMap(kind => [false, true].map(elsewhere => ({ kind, elsewhere }))))(
  'keeps skill import usable after removing a $kind selection (elsewhere=$elsewhere)', async ({ kind, elsewhere }) => {
    const { root, scaffold, skills, page } = await bootSkillFocus()
    const upload = vi.spyOn(skills, 'uploadSkill')
    onTestFinished(() => { upload.mockRestore() })
    const folder = join(root, 'focus-skill')
    await mkdir(folder)
    const skillDocument = '---\nname: focus-skill\ndescription: Read-only import fixture.\n---\nKeep {{literal}}.'
    await writeFile(join(folder, 'SKILL.md'), skillDocument)
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    await page.getByRole('button', { name: 'Import skill', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Import skill', exact: true })
    const input = dialog.locator('input[type="file"]').nth(kind === 'file' ? 0 : 1)
    const selection = kind === 'folder' ? folder : { name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from(skillDocument) }
    await input.setInputFiles(selection)
    const remove = dialog.getByRole('button', { name: 'Remove selection', exact: true })
    const choose = dialog.getByRole('button', { name: kind === 'folder' ? 'Choose folder' : 'Choose file', exact: true })
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
    const install = dialog.getByRole('button', { name: 'Install', exact: true })
    let pickers = 0
    page.on('filechooser', () => { pickers++ })
    await remove.focus()
    if (elsewhere) {
      await cancel.focus()
      await remove.dispatchEvent('click')
    } else await remove.press('Enter')
    await remove.waitFor({ state: 'hidden' })
    const target = elsewhere ? cancel : choose
    await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await install.isDisabled()).toBe(true)
    expect(pickers).toBe(0)
    expect(upload).not.toHaveBeenCalled()
    if (!elsewhere) await captureSkillFocus(page, `import-remove-${kind}`, dialog, target)
    await input.setInputFiles(selection)
    await remove.waitFor()
    expect(await install.isEnabled()).toBe(true)
    expect(upload).not.toHaveBeenCalled()
    await cancel.click()
    await dialog.waitFor({ state: 'hidden' })
  },
)

it.each((['clawhub', 'skillsh'] as const).flatMap(source =>
  (['retained', 'removed', 'failure'] as const).map(outcome => ({ source, outcome }))))(
  'retains confirmed skill $source search through a background $outcome refresh', async ({ source, outcome }) => {
    const { scaffold, skills, page } = await bootSkillFocus()
    const response = Promise.withResolvers<undefined>()
    const retryResponse = Promise.withResolvers<undefined>()
    const directoryReady = Promise.withResolvers<undefined>()
    const repositories = vi.spyOn(skills, 'listRepositories').mockImplementation(async () => {
      await directoryReady.promise
      return { repositories: [], installRoots: [], catalogInstalls: [], catalogCopies: [], catalogWarnings: [] }
    })
    let reads = 0
    const read = async () => {
      const current = ++reads
      if (current === 2) {
        await response.promise
        if (outcome === 'failure') throw new Error('Background search unavailable')
      }
      if (current === 3) await retryResponse.promise
      return current === 2 && outcome === 'removed' ? 'Replacement review' : 'Order review'
    }
    const ranking = vi.spyOn(skills, 'listClawHub').mockResolvedValue({ items: [], nextCursor: null })
    const search = source === 'clawhub' ? vi.spyOn(skills, 'searchClawHub').mockImplementation(async () => {
      const name = await read()
      return { results: [{ source: 'clawhub', ownerHandle: 'fixture', slug: name === 'Order review' ? 'orders' : 'replacement', displayName: name, summary: '' }] }
    }) : vi.spyOn(skills, 'searchSkillsSh').mockImplementation(async () => {
      const name = await read(), id = name === 'Order review' ? 'orders' : 'replacement'
      return { skills: [{ id: `fixture/skills/${id}`, source: 'fixture/skills', skillId: id, name }] }
    })
    onTestFinished(() => {
      response.resolve(undefined); retryResponse.resolve(undefined); directoryReady.resolve(undefined)
      repositories.mockRestore(); ranking.mockRestore(); search.mockRestore()
    })
    await page.goto(scaffold.authenticatedUrl)
    await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    await page.getByRole('tab', { name: 'Discover Skills', exact: true }).click()
    const sourceButton = page.getByRole('button', { name: source === 'clawhub' ? 'ClawHub' : 'skills.sh', exact: true })
    await sourceButton.click()
    const input = page.getByRole('textbox', { name: source === 'clawhub' ? 'Search ClawHub skills' : 'Search skills.sh', exact: true })
    await input.fill('orders')
    directoryReady.resolve(undefined)
    await page.getByText('Order review', { exact: true }).waitFor()
    await page.getByRole('button', { name: /^GitHub/ }).click()
    await sourceButton.click()
    await expect.poll(() => reads).toBe(2)
    const panel = page.locator('.dssm-repo-panel').first()
    const row = panel.locator('.dssm-repo-row').filter({ hasText: 'Order review' })
    expect(await row.count()).toBe(1)
    const node = await row.elementHandle()
    const action = row.getByRole('button', { name: 'Details', exact: true })
    await input.evaluate((element) => { (element as HTMLInputElement).setSelectionRange(1, 4) })
    await action.focus()
    expect(await panel.getByRole('status').count()).toBe(0)
    const geometry = await action.boundingBox()
    response.resolve(undefined)
    if (outcome === 'failure') {
      const retry = panel.getByRole('button', { name: 'Retry', exact: true })
      await retry.waitFor()
      expect(await node?.evaluate(element => element.isConnected)).toBe(true)
      expect(await action.evaluate(element => element === document.activeElement)).toBe(true)
      await retry.press('Enter')
      await expect.poll(() => reads).toBe(3)
      await retry.press('Enter')
      expect(reads).toBe(3)
      expect(await node?.evaluate(element => element.isConnected)).toBe(true)
      retryResponse.resolve(undefined)
      await retry.waitFor({ state: 'hidden' })
      await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
    } else if (outcome === 'retained') {
      await expect.poll(() => row.locator('..').getAttribute('aria-busy')).toBe('false')
      expect(await node?.evaluate(element => element.isConnected)).toBe(true)
      expect(await action.boundingBox()).toEqual(geometry)
      expect(await action.evaluate(element => element === document.activeElement)).toBe(true)
    } else {
      await panel.getByText('Replacement review', { exact: true }).waitFor()
      expect(await node?.evaluate(element => element.isConnected)).toBe(false)
      await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
    }
    expect(await input.evaluate((element) => {
      const field = element as HTMLInputElement
      return [field.value, field.selectionStart, field.selectionEnd]
    })).toEqual(['orders', 1, 4])
    if (outcome !== 'retained') await captureSkillFocus(page, `search-refresh-${source}-${outcome}`, panel, input)
  },
)

it.each((['clawhub', 'skillsh'] as const).flatMap(source => [false, true].map(elsewhere => ({ source, elsewhere }))))(
  'recovers skill $source search retry result focus (elsewhere=$elsewhere)', async ({ source, elsewhere }) => {
    const { scaffold, skills, page } = await bootSkillFocus()
    const response = Promise.withResolvers<undefined>()
    let reads = 0
    const read = async () => {
      if (++reads === 1) throw new Error('Search temporarily unavailable')
      if (reads !== 2) throw new Error('Duplicate search retry')
      await response.promise
    }
    const ranking = vi.spyOn(skills, 'listClawHub').mockResolvedValue({ items: [], nextCursor: null })
    const search = source === 'clawhub' ? vi.spyOn(skills, 'searchClawHub').mockImplementation(async () => {
      await read()
      return { results: [{ source: 'clawhub', ownerHandle: 'fixture', slug: 'orders', displayName: 'Order review', summary: '' }] }
    }) : vi.spyOn(skills, 'searchSkillsSh').mockImplementation(async () => {
      await read()
      return { skills: [{ id: 'fixture/skills/orders', source: 'fixture/skills', skillId: 'orders', name: 'Order review' }] }
    })
    onTestFinished(() => { response.resolve(undefined); ranking.mockRestore(); search.mockRestore() })
    await page.goto(scaffold.authenticatedUrl)
    await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    await page.getByRole('tab', { name: 'Discover Skills', exact: true }).click()
    await page.getByRole('button', { name: source === 'clawhub' ? 'ClawHub' : 'skills.sh', exact: true }).click()
    const input = page.getByRole('textbox', { name: source === 'clawhub' ? 'Search ClawHub skills' : 'Search skills.sh', exact: true })
    await input.fill('orders')
    const panel = page.locator('.dssm-repo-panel').first()
    const retry = panel.getByRole('button', { name: 'Retry', exact: true })
    await retry.press('Enter')
    await expect.poll(() => reads).toBe(2)
    expect(await retry.evaluate(node => node === document.activeElement)).toBe(true)
    await page.keyboard.press('Enter')
    expect(reads).toBe(2)
    const other = page.getByRole('button', { name: /^GitHub/ })
    if (elsewhere) await other.focus()
    response.resolve(undefined)
    await panel.getByText('Order review', { exact: true }).waitFor()
    const target = elsewhere ? other : input
    await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await retry.count()).toBe(0)
    expect(await input.inputValue()).toBe('orders')
    if (!elsewhere) await captureSkillFocus(page, `search-result-${source}`, panel, target)
  },
)

it.each((['repository', 'catalog', 'review', 'rollback'] as const).flatMap(surface => [false, true].map(elsewhere => ({ surface, elsewhere }))))(
  'recovers skill $surface read retry result focus (elsewhere=$elsewhere)', async ({ surface, elsewhere }) => {
    const { root, scaffold, skills, page } = await bootSkillFocus()
    const response = Promise.withResolvers<undefined>()
    let reads = 0
    const read = async () => {
      if (++reads === 1) throw new Error('Skill read temporarily unavailable')
      if (reads !== 2) throw new Error('Duplicate skill read retry')
      await response.promise
    }
    const preview = surface === 'review' || surface === 'rollback'
    const repositories = vi.spyOn(skills, 'listRepositories').mockResolvedValue({ repositories: [{ id: 'focus-repository', owner: 'fixture',
      name: 'skills', ref: '', subdirectory: '', commit: 'revision', refreshedAt: null, error: null,
      skills: [{ path: 'orders', name: 'orders', description: 'Order review', valid: true, documentHash: 'hash', status: 'available',
        installations: preview ? [{ installedRoot: 'dsh', tracked: true, status: 'installed', updateAvailable: true,
          canRollback: true, canUninstall: true }] : [] }] }],
    installRoots: [{ key: 'dsh', path: join(root, 'skills'), label: 'DSH', available: true }],
    catalogInstalls: [], catalogCopies: [], catalogWarnings: [] })
    const ranking = vi.spyOn(skills, 'listClawHub').mockResolvedValue({
      items: [{ ownerHandle: 'fixture', slug: 'orders', displayName: 'Order review', summary: '' }], nextCursor: null,
    })
    const result = preview ? vi.spyOn(skills, 'previewUpdate').mockImplementation(async () => {
      await read()
      return { token: 'current', commit: 'revision', localModified: false, rollback: surface === 'rollback',
        changes: [{ path: 'SKILL.md', kind: 'modified' }] }
    }) : surface === 'catalog' ? vi.spyOn(skills, 'readCatalog').mockImplementation(async () => {
      await read()
      return { name: 'orders', description: 'Order review', body: 'Recovered instructions', origin: 'catalog' }
    }) : vi.spyOn(skills, 'readRepository').mockImplementation(async () => {
      await read()
      return { path: 'orders', name: 'orders', description: 'Order review', valid: true, documentHash: 'hash', status: 'available',
        installations: [], commit: 'revision', body: 'Recovered instructions' }
    })
    onTestFinished(() => { response.resolve(undefined); repositories.mockRestore(); ranking.mockRestore(); result.mockRestore() })
    await page.goto(scaffold.authenticatedUrl)
    await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    await page.getByRole('tab', { name: 'Discover Skills', exact: true }).click()
    if (surface === 'catalog') await page.getByRole('button', { name: 'ClawHub', exact: true }).click()
    else await page.getByRole('button', { name: /fixture\/skills/, expanded: false }).click()
    await page.getByRole('button', { name: preview ? surface === 'review' ? 'Review update' : 'Restore previous version' : 'Details', exact: true }).click()
    const dialog = page.locator('[role="dialog"][aria-modal="true"]')
    const retry = dialog.getByRole('button', { name: 'Retry', exact: true })
    await retry.press('Enter')
    await expect.poll(() => reads).toBe(2)
    expect(await retry.evaluate(node => node === document.activeElement)).toBe(true)
    await page.keyboard.press('Enter')
    expect(reads).toBe(2)
    const close = dialog.getByRole('button', { name: 'Close', exact: true })
    if (elsewhere) await close.focus()
    response.resolve(undefined)
    await retry.waitFor({ state: 'hidden' })
    const target = elsewhere ? close : preview ? dialog.getByRole('region') : dialog.getByRole('textbox', { name: 'Body', exact: true })
    await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
    if (preview) expect(await dialog.getByRole('button', { name: surface === 'review' ? 'Back up and update' : 'Back up and restore', exact: true }).isEnabled()).toBe(true)
    if (!elsewhere) await captureSkillFocus(page, `read-result-${surface}`, dialog, target)
  },
)

it.each((['directory', 'detail', 'trash', 'repositories'] as const)
  .flatMap(surface => [false, true].map(elsewhere => ({ surface, elsewhere }))))(
  'recovers skill $surface page retry result focus (elsewhere=$elsewhere)', async ({ surface, elsewhere }) => {
    const { root, scaffold, skills, page } = await bootSkillFocus()
    const response = Promise.withResolvers<undefined>()
    let reads = 0
    let recovering = false
    const item = { name: 'focus-skill', declaredName: 'focus-skill', description: 'Read-only skill fixture', kind: 'directory' as const,
      path: join(root, 'focus-skill'), modelInvocable: true, userInvocable: true, invocationPolicyValid: true, hasFrontmatter: true,
      loadable: true, diagnostics: [], managerEnabled: true, managerOverride: null,
      effectiveModelInvocable: true, effectiveUserInvocable: true }
    const state = { roots: [{ key: 'company', path: root, label: 'Company', rank: 0, mutable: false, native: true, toggleable: true,
      exists: true, truncated: false, enabled: true, skills: [item], categories: [] }], writeDestinations: [], projects: [],
    summary: { total: 1, enabled: 1, disabled: 0, issues: 0 }, trash: [], warnings: [] }
    const read = async () => {
      if (!recovering) throw new Error('Skills page read temporarily unavailable')
      if (++reads !== 1) throw new Error('Duplicate skills page retry')
      await response.promise
    }
    const directory = vi.spyOn(skills, 'readState').mockImplementation(async () => {
      if (surface !== 'detail') await read()
      return state
    })
    const detail = vi.spyOn(skills, 'readDetail').mockImplementation(async () => {
      await read()
      return { root: 'company', name: item.name, declaredName: item.name, description: '', path: item.path, kind: item.kind,
        diagnostics: [], body: 'Recovered instructions', document: 'Recovered instructions', frontmatter: null, loadable: true, sourceReadOnly: true }
    })
    const repositories = vi.spyOn(skills, 'listRepositories').mockResolvedValue({ repositories: [], installRoots: [],
      catalogInstalls: [], catalogCopies: [], catalogWarnings: [] })
    onTestFinished(() => { response.resolve(undefined); directory.mockRestore(); detail.mockRestore(); repositories.mockRestore() })
    await page.goto(scaffold.authenticatedUrl)
    await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    if (surface === 'detail') {
      await page.locator('.dssm-section').getByRole('button', { name: 'More', exact: true }).click()
      await page.getByRole('menuitem', { name: 'View details', exact: true }).click()
    } else if (surface === 'trash' || surface === 'repositories') {
      await page.getByRole('tab', { name: 'Mine', exact: true }).click()
      await page.getByRole('tab', { name: surface === 'trash' ? 'Trash' : 'Discover Skills', exact: true }).click()
    }
    const area = surface === 'detail' ? page.locator('[role="dialog"][aria-modal="true"]') : page.locator('.dssm-section')
    const retry = area.getByRole('button', { name: 'Retry', exact: true })
    await expect.poll(() => retry.getAttribute('aria-disabled')).toBe('false')
    recovering = true
    await retry.press('Enter')
    await expect.poll(() => reads).toBe(1)
    expect(await retry.evaluate(node => node === document.activeElement)).toBe(true)
    await page.keyboard.press('Enter')
    expect(reads).toBe(1)
    const hiddenSearch = surface === 'trash' || surface === 'repositories'
    const other = hiddenSearch ? area.getByRole('tab', { name: 'Mine', exact: true })
      : area.getByRole('button', { name: surface === 'detail' ? 'Close' : 'Create skill', exact: true })
    if (elsewhere) await other.focus()
    response.resolve(undefined)
    await retry.waitFor({ state: 'hidden' })
    const target = elsewhere ? other : hiddenSearch ? area.getByRole('tabpanel', { name: 'Mine', exact: true })
      : area.getByRole('textbox', { name: surface === 'detail' ? 'Body' : 'Search', exact: true })
    await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
    if (!elsewhere) await captureSkillFocus(page, `page-result-${surface}`, area, target)
  },
)

it.each([
  { surface: 'import', result: 'available', elsewhere: false },
  { surface: 'import', result: 'empty', elsewhere: false },
  { surface: 'import', result: 'available', elsewhere: true },
  { surface: 'repository', result: 'available', elsewhere: false },
  { surface: 'repository', result: 'available', elsewhere: true },
] as const)('recovers $surface workspace retry focus with $result results (elsewhere=$elsewhere)', async ({ surface, result, elsewhere }) => {
  const root = await mkdtemp(join(tmpdir(), 'skill-workspace-focus-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const overlay = join(root, 'skills.patch.yml')
  await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const skills = scaffold.ctx.get('skillsManager') as SkillsManager
  const response = Promise.withResolvers<undefined>()
  let reads = 0
  const workspaces = vi.spyOn(skills, 'listWorkspaces').mockImplementation(async () => {
    if (++reads === 1) throw new Error('Workspace list temporarily unavailable')
    if (reads !== 2) throw new Error('Duplicate workspace retry')
    await response.promise
    return { items: result === 'empty' ? [] : [{ name: 'Focus workspace', path: root, registeredPaths: [root], available: true, skillCount: 0 }] }
  })
  const repositories = vi.spyOn(skills, 'listRepositories').mockResolvedValue({ repositories: [{ id: 'focus-repository', owner: 'fixture',
    name: 'skills', ref: '', subdirectory: '', commit: 'revision', refreshedAt: null, error: null,
    skills: [{ path: 'orders', name: 'orders', description: 'Order review', valid: true, documentHash: 'hash', status: 'available', installations: [] }] }],
  installRoots: [{ key: 'dsh', path: join(root, 'skills'), label: 'DSH', available: true }], catalogInstalls: [], catalogCopies: [], catalogWarnings: [] })
  onTestFinished(() => { response.resolve(undefined); workspaces.mockRestore(); repositories.mockRestore() })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEmployeePage(browser)
  const tripwire = watchConsole(page)
  page.setDefaultTimeout(10_000)
  await page.goto(scaffold.authenticatedUrl)
  await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  if (surface === 'import') await page.getByRole('button', { name: 'Import skill', exact: true }).click()
  else {
    await page.getByRole('tab', { name: 'Discover Skills', exact: true }).click()
    await page.getByRole('button', { name: /fixture\/skills/, expanded: false }).click()
    await page.getByRole('button', { name: 'Install', exact: true }).click()
  }
  const dialog = page.locator('[role="dialog"][aria-modal="true"]')
  await dialog.getByRole('button', { name: 'Scope', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Specific workspace', exact: true }).click()
  await dialog.getByRole('alert').waitFor()
  const retry = dialog.getByRole('button', { name: 'Retry', exact: true })
  const original = await retry.elementHandle()
  await retry.press('Enter')
  await expect.poll(() => reads).toBe(2)
  expect(await retry.evaluate((node, prior) => node === prior && node === document.activeElement, original)).toBe(true)
  await page.keyboard.press('Enter')
  expect(reads).toBe(2)
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
  if (elsewhere) await cancel.focus()
  response.resolve(undefined)
  await dialog.getByRole('alert').waitFor({ state: 'hidden' })
  const target = elsewhere ? cancel : dialog.getByRole('button', { name: result === 'empty' ? 'Scope' : 'Workspace', exact: true })
  await expect.poll(() => target.evaluate(node => node === document.activeElement)).toBe(true)
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-skill-pagination')
  await mkdir(screenshots, { recursive: true })
  if (!elsewhere) for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
      await target.scrollIntoViewIfNeeded()
      expect(await target.evaluate(node => node === document.activeElement)).toBe(true)
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `workspace-${surface}-${result}-${theme}-${width}.png`), animations: 'disabled' })
    }
  }
  expect(tripwire.pageErrors).toEqual([])
})

it.each((['import', 'repository'] as const).flatMap(action => [1440, 390].map(width => ({ action, width }))))('retains $action submission focus, form and errors while retrying ($width)', async ({ action, width }) => {
  const root = await mkdtemp(join(tmpdir(), 'skill-write-focus-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const overlay = join(root, 'skills.patch.yml')
  await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const skills = scaffold.ctx.get('skillsManager') as SkillsManager
  const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
  let writes = 0
  const failWrite = async (): Promise<never> => {
    const gate = gates[writes++]
    if (!gate) throw new Error('Unexpected duplicate skill write')
    await gate.promise
    throw new RemoteError('skills/operation', 'Skill write rejected', {
      code: action === 'import' ? 'error.upload.pathConflict' : 'error.state.invalid',
      error: 'Skill write rejected', params: { path: '资料/模板/'.repeat(80) + 'ERROR-END' },
    })
  }
  const delay = action === 'import' ? vi.spyOn(skills, 'uploadSkill').mockImplementation(failWrite)
    : vi.spyOn(skills, 'addRepository').mockImplementation(failWrite)
  onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }); delay.mockRestore() })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEmployeePage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-skill-pagination')
  await mkdir(screenshots, { recursive: true })
  onTestFinished(async ({ task }) => {
    if (task.result?.state !== 'fail') return
    await page.screenshot({ path: join(screenshots, `${action}-focus-failure.png`) })
    await writeFile(join(screenshots, `${action}-focus-failure.txt`), await page.evaluate(() => document.activeElement?.outerHTML ?? 'No active element'))
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  if (action === 'import') {
    await page.getByRole('button', { name: 'Import skill', exact: true }).click()
    await page.getByRole('dialog').locator('input[type="file"]').first().setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown',
      buffer: Buffer.from('---\nname: focus-review\ndescription: Retain the imported skill.\n---\nKeep {{literal}}.') })
  } else {
    await page.getByRole('tab', { name: 'Discover Skills', exact: true }).click()
    await page.getByRole('button', { name: 'Add repository', exact: true }).click()
    await page.getByRole('textbox', { name: 'Repository URL', exact: true }).fill('fixture/focus-skills')
  }
  const dialog = page.getByRole('dialog', { name: action === 'import' ? 'Import skill' : 'Add repository', exact: true })
  const entry = page.getByRole('button', { name: action === 'import' ? 'Import skill' : 'Add repository', exact: true })
  const originalEntry = await entry.elementHandle()
  const submit = dialog.getByRole('button', { name: action === 'import' ? 'Install' : 'Add and scan', exact: true })
  const control = await submit.elementHandle()
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
  const originalCancel = await cancel.elementHandle()
  await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
  await expect.poll(() => submit.getAttribute('aria-disabled')).toBe('false')
  await submit.scrollIntoViewIfNeeded()
  expect(await controlIsUnclipped(submit)).toBe(true)
  const submitBounds = await submit.boundingBox()
  const cancelBounds = await cancel.boundingBox()
  const dialogBounds = await dialog.boundingBox()
  const feedback = dialog.locator('.dssm-write-feedback')
  const originalFeedback = await feedback.elementHandle()
  const feedbackBounds = await feedback.boundingBox()
  const content = dialog.locator('.dssm-modal-content > div:last-child')
  const contentBounds = await content.boundingBox()
  const contentScroll = await content.evaluate(node => node.scrollTop)
  const draft = action === 'import' ? dialog.getByText('SKILL.md', { exact: true })
    : dialog.getByRole('textbox', { name: 'Repository URL', exact: true })
  const originalDraft = await draft.elementHandle()
  if (action === 'repository') await draft.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(2, 8) })
  await submit.press('Enter')
  await expect.poll(() => writes).toBe(1)
  expect(await submit.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await submit.getAttribute('aria-disabled')).toBe('true')
  if (action === 'import') {
    expect(await entry.evaluate(node => node instanceof HTMLButtonElement && node.disabled)).toBe(false)
    expect(await entry.getAttribute('aria-disabled')).toBe('true')
    await entry.dispatchEvent('click')
    expect(await dialog.getByText('SKILL.md', { exact: true }).count()).toBe(1)
  }
  await page.keyboard.press('Enter')
  await page.keyboard.press(' ')
  expect(writes).toBe(1)
  gates[0]!.resolve(undefined)
  await dialog.getByRole('alert').waitFor()
  expect.soft(await submit.boundingBox()).toEqual(submitBounds)
  expect.soft(await cancel.boundingBox()).toEqual(cancelBounds)
  expect.soft(await dialog.boundingBox()).toEqual(dialogBounds)
  expect.soft(await feedback.boundingBox()).toEqual(feedbackBounds)
  expect.soft(await content.boundingBox()).toEqual(contentBounds)
  expect(await content.evaluate(node => node.scrollTop)).toBe(contentScroll)
  expect(await feedback.evaluate((node, original) => node === original, originalFeedback)).toBe(true)
  expect(await draft.evaluate((node, original) => node === original, originalDraft)).toBe(true)
  if (action === 'repository') expect(await draft.evaluate(node => node instanceof HTMLInputElement && [node.selectionStart, node.selectionEnd])).toEqual([2, 8])
  expect(await feedback.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
  const alert = await dialog.getByRole('alert').elementHandle()
  expect(await submit.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await controlIsUnclipped(submit)).toBe(true)
  expect(await controlIsUnclipped(cancel)).toBe(true)
  expect(await cancel.evaluate((node, original) => node === original, originalCancel)).toBe(true)
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
      await page.screenshot({ path: join(screenshots, `${action}-focus-${theme}-${size.width}.png`), animations: 'disabled' })
    }
  }
  await feedback.focus()
  await page.keyboard.press('End')
  await expect.poll(() => feedback.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
  expect(await feedback.evaluate(node => node === document.activeElement)).toBe(true)
  await submit.focus()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).dispatchEvent('click')
  await page.keyboard.press('Escape')
  expect(await dialog.count()).toBe(1)
  expect(writes).toBe(2)
  gates[1]!.resolve(undefined)
  await expect.poll(() => submit.getAttribute('aria-busy')).toBe('false')
  expect(await submit.evaluate(node => node === document.activeElement)).toBe(true)
  if (action === 'import') expect(await dialog.getByText('SKILL.md', { exact: true }).count()).toBe(1)
  else expect(await dialog.getByRole('textbox', { name: 'Repository URL', exact: true }).inputValue()).toBe('fixture/focus-skills')
  if (action === 'import') {
    vi.spyOn(skills, 'uploadSkill').mockImplementation(async () => {
      writes++
      return { imported: [{ name: 'focus-review', overwritten: false, warnings: [] }], skipped: [], failed: [] }
    })
    await submit.press('Enter')
  } else await cancel.click()
  await dialog.waitFor({ state: 'hidden' })
  expect(writes).toBe(action === 'import' ? 3 : 2)
  expect(await entry.evaluate((node, original) => node === original, originalEntry)).toBe(true)
  await expect.poll(() => entry.evaluate(node => node === document.activeElement)).toBe(true)
  if (action === 'import') {
    await entry.press('Enter')
    await dialog.waitFor()
    expect(await dialog.getByText('SKILL.md', { exact: true }).count()).toBe(0)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter')
    await dialog.waitFor({ state: 'hidden' })
    expect(await entry.evaluate(node => node === document.activeElement)).toBe(true)
    expect(writes).toBe(3)
  }
  expect(tripwire.pageErrors).toEqual([])
})

it.each(['clawhub', 'skillsh'] as const)('keeps %s search controls stable through debounce and equivalent queries', async (source) => {
  const fixture = await mkdtemp(join(tmpdir(), 'product-skill-search-'))
  onTestFinished(() => rm(fixture, { recursive: true, force: true }))
  const overlay = join(fixture, 'catalog.patch.yml')
  await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const skills = scaffold.ctx.get('skillsManager') as SkillsManager
  const pending = Promise.withResolvers<undefined>()
  const reads: { query: string; signal: AbortSignal }[] = []
  const ranking = vi.spyOn(skills, 'listClawHub').mockResolvedValue({ items: [], nextCursor: null })
  const read = source === 'clawhub'
    ? vi.spyOn(skills, 'searchClawHub').mockImplementation(async (query, _options, signal) => {
      reads.push({ query, signal })
      if (query !== 'orders') return { results: [] }
      await pending.promise
      return { results: [{ source: 'clawhub', ownerHandle: 'fixture', slug: 'orders', displayName: 'Order review', summary: 'Read-only search fixture' }] }
    })
    : vi.spyOn(skills, 'searchSkillsSh').mockImplementation(async (query, signal) => {
      reads.push({ query, signal })
      if (query !== 'orders') return { skills: [] }
      await pending.promise
      return { skills: [{ id: 'fixture/skills/orders', source: 'fixture/skills', skillId: 'orders', name: 'Order review' }] }
    })
  onTestFinished(() => { pending.resolve(undefined); read.mockRestore(); ranking.mockRestore() })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEmployeePage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-skill-pagination')
  await mkdir(screenshots, { recursive: true })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  await page.getByRole('tab', { name: 'Discover Skills', exact: true }).click()
  await page.getByRole('button', { name: source === 'clawhub' ? 'ClawHub' : 'skills.sh', exact: true }).click()
  const search = page.getByRole('textbox', { name: source === 'clawhub' ? 'Search ClawHub skills' : 'Search skills.sh', exact: true })
  const input = await search.elementHandle()
  const panel = page.locator('.dssm-repo-panel')
  const loading = panel.getByRole('status', { name: source === 'clawhub' ? 'Searching ClawHub…' : 'Searching skills.sh…', exact: true })
  const empty = panel.getByText(source === 'clawhub' ? 'No matching ClawHub skills were found.' : 'No matching skills.sh skills were found.', { exact: true })
  const start = new Date('2026-11-11T00:00:00Z')
  await page.clock.install({ time: start })
  await page.clock.pauseAt(start)
  await search.fill('order')
  expect(await loading.count()).toBe(1)
  expect(await empty.count()).toBe(0)
  await page.clock.runFor(299)
  expect(reads).toHaveLength(0)
  await search.fill('orders')
  await page.clock.runFor(300)
  await expect.poll(() => reads.length).toBe(1)
  await search.fill(' orders ')
  await page.clock.runFor(300)
  expect(reads).toHaveLength(1)
  expect(reads[0]!.signal.aborted).toBe(false)
  expect(await empty.count()).toBe(0)
  expect(await loading.count()).toBe(1)
  await page.clock.resume()
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.clock.runFor(100)
      await page.waitForFunction(drawer => Boolean(document.querySelector('[data-sidebar-drawer]')) === drawer, width < 768)
      if (await page.locator('[data-sidebar-drawer]:not([data-sidebar-collapsed])').count()) {
        await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      }
      await search.focus()
      expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `search-${source}-${theme}-${width}.png`), animations: 'disabled' })
    }
  }
  pending.resolve(undefined)
  const result = panel.getByText('Order review', { exact: true })
  await result.waitFor()
  const row = await result.elementHandle()
  await search.fill('orders ')
  await page.clock.runFor(300)
  expect(reads).toHaveLength(1)
  expect(await result.evaluate((node, original) => node === original, row)).toBe(true)
  expect(await loading.count()).toBe(0)
  expect(await search.evaluate((node, original) => node === original, input)).toBe(true)
  expect(await search.evaluate(node => node === document.activeElement)).toBe(true)
  await search.fill('invoices')
  expect(await empty.count()).toBe(0)
  expect(await loading.count()).toBe(1)
  await page.clock.runFor(300)
  await empty.waitFor()
  expect(reads.map(item => item.query)).toEqual(['orders', 'invoices'])
  expect(await loading.count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('retains ClawHub pagination and detail focus across loading, overlap, retry and the final page', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'product-skill-pagination-'))
  onTestFinished(() => rm(fixture, { recursive: true, force: true }))
  const failedRead = Promise.withResolvers<undefined>()
  const nextRead = Promise.withResolvers<undefined>()
  const finalRead = Promise.withResolvers<undefined>()
  const detailRead = Promise.withResolvers<undefined>()
  let nextRequests = 0
  let finalRequests = 0
  let detailRequests = 0
  const item = (number: number) => ({ ownerHandle: 'fixture', slug: `skill-${number}`,
    displayName: `Catalog skill ${number}`, summary: `Read-only catalog fixture ${number}` })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname.endsWith('/file')) {
      if (++detailRequests === 1) { response.writeHead(503); response.end() }
      else void detailRead.promise.then(() => {
        response.writeHead(200, { 'content-type': 'text/markdown' })
        response.end('---\nname: catalog-detail\ndescription: Read-only acceptance fixture\n---\n\nKeep the retry focus stable.')
      })
      return
    }
    const cursor = url.searchParams.get('cursor')
    const reply = (items: ReturnType<typeof item>[], nextCursor: string | null) => {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ items, nextCursor }))
    }
    if (cursor === null) reply(Array.from({ length: 10 }, (_, index) => item(index)), 'next')
    else if (cursor === 'next' && ++nextRequests === 1) void failedRead.promise.then(() => { response.writeHead(503); response.end() })
    else if (cursor === 'next') void nextRead.promise.then(() => { reply([item(0), ...Array.from({ length: 9 }, (_, index) => item(index + 10))], 'last') })
    else { finalRequests++; void finalRead.promise.then(() => { reply([item(19)], null) }) }
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => {
    failedRead.resolve(undefined); nextRead.resolve(undefined); finalRead.resolve(undefined); detailRead.resolve(undefined)
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing catalog fixture port')
  const overlay = join(fixture, 'catalog.patch.yml')
  await writeFile(overlay, JSON.stringify([...builtinCapabilityPatches(), { insert: [{ id: 'clawhub-catalog-fixture',
    name: new URL('./fixtures/clawhub-catalog.mjs', import.meta.url).href, config: { endpoint: `http://127.0.0.1:${address.port}` } }] }]))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEmployeePage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-skill-pagination')
  await mkdir(screenshots, { recursive: true })
  onTestFinished(async ({ task }) => {
    if (task.result?.state === 'fail') await page.screenshot({ path: join(screenshots, 'failure.png') })
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  await page.getByRole('tab', { name: 'Discover Skills', exact: true }).click()
  await page.getByRole('button', { name: 'ClawHub', exact: true }).click()
  const list = page.locator('.dssm-catalog-list')
  const first = list.locator('[data-catalog-skill="fixture/skill-0"]')
  await first.waitFor()
  const firstNode = await first.elementHandle()
  const action = list.getByRole('button', { name: 'Load 10 more', exact: true })
  const actionNode = await action.elementHandle()
  await action.focus(); await action.press('Enter')
  await expect.poll(() => nextRequests).toBe(1)
  expect(await action.evaluate((node, previous) => node === previous, actionNode)).toBe(true)
  expect(await action.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await action.getAttribute('aria-busy')).toBe('true')
  await page.keyboard.press('Enter')
  expect(nextRequests).toBe(1)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await action.scrollIntoViewIfNeeded()
      expect(await list.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false)
      await page.screenshot({ path: join(screenshots, `pending-${theme}-${width}.png`), animations: 'disabled' })
    }
  }
  failedRead.resolve(undefined)
  const retry = list.getByRole('button', { name: 'Retry', exact: true })
  await retry.waitFor()
  expect(await retry.evaluate((node, previous) => node === previous, actionNode)).toBe(true)
  expect(await retry.evaluate(node => node === document.activeElement)).toBe(true)
  const notice = await list.getByRole('alert').elementHandle()
  await retry.press('Enter')
  await expect.poll(() => nextRequests).toBe(2)
  expect(await list.getByRole('alert').evaluate((node, previous) => node === previous, notice)).toBe(true)
  nextRead.resolve(undefined)
  await list.locator('[data-catalog-skill="fixture/skill-18"]').waitFor()
  expect(await first.evaluate((node, previous) => node === previous, firstNode)).toBe(true)
  expect(await list.locator('[data-catalog-skill]').count()).toBe(19)
  expect(await action.evaluate((node, previous) => node === previous, actionNode)).toBe(true)
  expect(await action.evaluate(node => node === document.activeElement)).toBe(true)
  await action.press('Enter')
  await expect.poll(() => finalRequests).toBe(1)
  finalRead.resolve(undefined)
  const finalDetail = list.locator('[data-catalog-skill="fixture/skill-19"]').getByRole('button', { name: 'Details', exact: true })
  await finalDetail.waitFor()
  expect(await finalDetail.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await action.count()).toBe(0)
  expect(await list.locator('[data-catalog-skill]').count()).toBe(20)
  await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/deepseek-harness-skill-pagination.expected.md'),
    await captureStableAria(page, '.dssm-catalog-list', scaffold.workspaceCwd), webSnapshotMode())
  await finalDetail.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Details', exact: true })
  const retryDetail = dialog.getByRole('button', { name: 'Retry', exact: true })
  await retryDetail.waitFor()
  const retryNode = await retryDetail.elementHandle()
  const errorNode = await dialog.getByRole('alert').elementHandle()
  await retryDetail.focus()
  const retryBox = await retryDetail.boundingBox()
  await retryDetail.press('Enter')
  await expect.poll(() => detailRequests).toBe(2)
  await expect.poll(() => retryDetail.getAttribute('aria-busy')).toBe('true')
  expect(await retryDetail.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await retryDetail.getAttribute('aria-disabled')).toBe('true')
  expect(await retryDetail.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
  expect(await retryDetail.boundingBox()).toEqual(retryBox)
  await page.keyboard.press('Enter')
  await page.keyboard.press(' ')
  expect(detailRequests).toBe(2)
  expect(await retryDetail.evaluate((node, previous) => node === previous, retryNode)).toBe(true)
  expect(await dialog.getByRole('alert').evaluate((node, previous) => node === previous, errorNode)).toBe(true)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await retryDetail.focus()
      await retryDetail.scrollIntoViewIfNeeded()
      expect(await dialog.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false)
      await page.screenshot({ path: join(screenshots, `detail-retry-${theme}-${width}.png`), animations: 'disabled' })
    }
  }
  detailRead.resolve(undefined)
  await expect.poll(() => dialog.getByRole('textbox', { name: 'Body', exact: true }).inputValue()).toContain('Keep the retry focus stable.')
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  expect(await finalDetail.evaluate(node => node === document.activeElement)).toBe(true)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it.each(['listWorkspaces', 'readWorkspace'] as const)('retains project rows, viewport and focus through a failed %s refresh and retry', async (method) => {
  const { root, scaffold, skills, page } = await bootSkillFocus()
  const failed = Promise.withResolvers<undefined>(), retried = Promise.withResolvers<undefined>()
  let phase: 'initial' | 'failure' | 'retry' = 'initial', reads = 0
  const read = async () => {
    reads++
    if (phase === 'failure') { await failed.promise; throw new Error('Workspace refresh unavailable') }
    if (phase === 'retry') await retried.promise
  }
  const items = Array.from({ length: 35 }, (_, index) => ({ name: `retained-skill-${index}`, declaredName: `retained-skill-${index}`,
    description: 'Confirmed project instructions', kind: 'directory' as const, path: join(root, `retained-skill-${index}`),
    modelInvocable: true, userInvocable: true, invocationPolicyValid: true, hasFrontmatter: true, loadable: true,
    diagnostics: [], managerEnabled: true, managerOverride: null, effectiveModelInvocable: true, effectiveUserInvocable: true }))
  const source = { key: 'dsh', path: root, label: 'DSH', rank: 0, mutable: true, native: true, toggleable: true,
    exists: true, truncated: false, enabled: true, skills: items, categories: [] }
  const state = { roots: [source], writeDestinations: [], projects: [],
    summary: { total: items.length, enabled: items.length, disabled: 0, issues: 0 }, trash: [], warnings: [] }
  const directory = vi.spyOn(skills, 'readState').mockResolvedValue(state)
  const workspaces = vi.spyOn(skills, 'listWorkspaces').mockImplementation(async () => {
    if (method === 'listWorkspaces') await read()
    return { items: [{ name: 'Retained workspace', path: root, registeredPaths: [root], available: true, skillCount: items.length }] }
  })
  const workspace = vi.spyOn(skills, 'readWorkspace').mockImplementation(async () => {
    if (method === 'readWorkspace') await read()
    return { project: { root, name: 'Retained workspace', workspaceCwds: [root] }, roots: [source], warnings: [] }
  })
  onTestFinished(() => {
    failed.resolve(undefined); retried.resolve(undefined)
    directory.mockRestore(); workspaces.mockRestore(); workspace.mockRestore()
  })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await expect.poll(() => directory.mock.calls.length).toBe(2)
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  await page.getByRole('tab', { name: 'Project skills', exact: true }).click()
  const area = page.locator('.dssm-section')
  const search = area.getByRole('textbox', { name: 'Search', exact: true })
  await search.fill('retained')
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
  const refresh = area.getByRole('button', { name: 'Refresh', exact: true })
  const toggle = area.getByRole('switch', { name: 'Toggle skill retained-skill-20', exact: true })
  await toggle.waitFor()
  const toggleNode = await toggle.elementHandle(), searchNode = await search.elementHandle(), refreshNode = await refresh.elementHandle()
  phase = 'failure'
  await refresh.click()
  await expect.poll(() => reads).toBe(2)
  await toggle.scrollIntoViewIfNeeded()
  await toggle.focus()
  const scrollOwner = await toggle.evaluateHandle((node) => {
    for (let owner = node.parentElement; owner; owner = owner.parentElement) {
      if (['auto', 'scroll'].includes(getComputedStyle(owner).overflowY) && owner.scrollHeight > owner.clientHeight) return owner
    }
    throw new Error('Missing skill page scroll owner')
  })
  const scroll = await scrollOwner.evaluate(node => node.scrollTop), bounds = await toggle.boundingBox()
  expect(scroll).toBeGreaterThan(0)
  failed.resolve(undefined)
  const notice = area.getByRole('alert')
  await notice.waitFor()
  expect(await toggle.evaluate((node, original) => node === original && node === document.activeElement, toggleNode)).toBe(true)
  expect(await toggle.boundingBox()).toEqual(bounds)
  expect(await scrollOwner.evaluate(node => node.scrollTop)).toBe(scroll)
  phase = 'retry'
  const noticeNode = await notice.elementHandle()
  await refresh.evaluate((node) => {
    if (!(node instanceof HTMLButtonElement)) throw new Error('Missing refresh button')
    node.click(); node.click()
  })
  await expect.poll(() => reads).toBe(3)
  expect(await notice.evaluate((node, original) => node === original, noticeNode)).toBe(true)
  expect(await toggle.evaluate((node, original) => node === original && node === document.activeElement, toggleNode)).toBe(true)
  retried.resolve(undefined)
  await notice.waitFor({ state: 'detached' })
  expect(await toggle.evaluate((node, original) => node === original && node === document.activeElement, toggleNode)).toBe(true)
  expect(await search.evaluate((node, original) => node === original && node instanceof HTMLInputElement
    && node.value === 'retained' && node.selectionStart === 1 && node.selectionEnd === 3, searchNode)).toBe(true)
  expect(await refresh.evaluate((node, original) => node === original, refreshNode)).toBe(true)
  expect(await toggle.boundingBox()).toEqual(bounds)
  expect(await scrollOwner.evaluate(node => node.scrollTop)).toBe(scroll)
  await refresh.focus()
  await captureSkillFocus(page, `project-refresh-${method}`, area, refresh)
})

it.each((['market', 'source', 'skill'] as const).flatMap(target => [1440, 390].map(width => ({ target, width }))))(
  'retains the $target skill switch focus and local progress at $width', async ({ target, width }) => {
    const { root, scaffold, skills, page } = await bootSkillFocus()
    const item = { name: 'focus-alpha', declaredName: 'focus-alpha', description: 'Read-only skill fixture', kind: 'directory' as const,
      path: join(root, 'focus-alpha'), modelInvocable: true, userInvocable: true, invocationPolicyValid: true, hasFrontmatter: true,
      loadable: true, diagnostics: [], managerEnabled: true, managerOverride: null,
      effectiveModelInvocable: true, effectiveUserInvocable: true }
    const neighborItem = { ...item, name: 'focus-beta', declaredName: 'focus-beta', path: join(root, 'focus-beta') }
    const source = { key: target === 'market' ? 'company' : 'dsh', path: root, label: 'DSH', rank: 0,
      mutable: target !== 'market', native: true, toggleable: true, exists: true, truncated: false, enabled: true,
      skills: [item, neighborItem], categories: [] }
    const state = { roots: [source], writeDestinations: [], projects: [],
      summary: { total: 2, enabled: 2, disabled: 0, issues: 0 }, trash: [], warnings: [] }
    const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    let writes = 0
    const directory = vi.spyOn(skills, 'readState').mockImplementation(async () => {
      if (writes === 2) await gates[2]!.promise
      return state
    })
    const wait = async () => {
      const attempt = writes++
      await gates[attempt]!.promise
      if (!attempt) throw new Error('Settings temporarily unavailable')
    }
    const write = target === 'skill' ? vi.spyOn(skills, 'setSkillEnabled').mockImplementation(async () => {
      await wait(); item.managerEnabled = false
      return { root: source.key, name: item.name, enabled: false }
    }) : vi.spyOn(skills, 'setSourceEnabled').mockImplementation(async () => {
      await wait(); source.enabled = false
      return { root: source.key, enabled: false }
    })
    onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }); directory.mockRestore(); write.mockRestore() })
    await page.goto(scaffold.authenticatedUrl)
    await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
    await page.locator('[data-composer-input][contenteditable="true"]').waitFor()
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    if (target !== 'market') {
      await page.getByRole('tab', { name: 'Mine', exact: true }).click()
      await page.getByRole('button', { name: /DSH/, expanded: false }).click()
    }
    const area = page.locator('.dssm-section')
    const search = area.getByRole('textbox', { name: 'Search', exact: true })
    await search.fill('focus')
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
    await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' })
    await page.evaluate(async () => { await Promise.allSettled(document.getAnimations().map(animation => animation.finished)) })
    const toggle = area.getByRole('switch', { name: target === 'market' ? 'Use marketplace skills'
      : target === 'source' ? 'Toggle source DSH skills' : 'Toggle skill focus-alpha', exact: true })
    const neighbor = area.getByRole('switch', { name: 'Toggle skill focus-beta', exact: true })
    await toggle.scrollIntoViewIfNeeded()
    const node = await toggle.elementHandle(), neighborNode = await neighbor.elementHandle(), searchNode = await search.elementHandle()
    const geometry = () => Promise.all([toggle.boundingBox(), neighbor.boundingBox()])
    const feedback = area.locator('.dssm-directory-feedback')
    const feedbackNode = await feedback.elementHandle(), feedbackBounds = await feedback.boundingBox()
    const bounds = await geometry()
    const scrollport = page.locator('.product-capability-page').filter({ has: area })
    const scroll = await scrollport.evaluate(node => node.scrollTop)
    const neighborStyle = () => neighbor.evaluate(node => [getComputedStyle(node).opacity, getComputedStyle(node).backgroundColor])
    const appearance = await neighborStyle()
    for (const attempt of [0, 1]) {
      await toggle.press('Enter')
      await expect.poll(() => writes).toBe(attempt + 1)
      expect(await toggle.evaluate((element, previous) => element === previous && element === document.activeElement, node)).toBe(true)
      expect(await toggle.evaluate(node => node instanceof HTMLButtonElement && node.disabled)).toBe(false)
      expect(await toggle.locator('..').getAttribute('aria-busy')).toBe('true')
      expect(await neighbor.locator('..').getAttribute('aria-busy')).toBe('false')
      expect(await neighborStyle()).toEqual(appearance)
      expect(await geometry()).toEqual(bounds)
      await page.keyboard.press('Enter'); await page.keyboard.press(' '); await neighbor.dispatchEvent('click')
      expect(writes).toBe(attempt + 1)
      if (attempt) {
        await area.locator('.dssm-feedback').waitFor()
        await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.focus({ preventScroll: true }) })
      }
      const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-skill-pagination')
      await mkdir(screenshots, { recursive: true })
      await page.screenshot({ path: join(screenshots, `switch-${target}-${width}-pending-${attempt}.png`), animations: 'disabled' })
      gates[attempt]!.resolve(undefined)
      if (attempt) {
        await expect.poll(() => directory.mock.calls.length).toBeGreaterThan(2)
        expect(await toggle.locator('..').getAttribute('aria-busy')).toBe('true')
        gates[2]!.resolve(undefined)
      }
      await expect.poll(() => toggle.locator('..').getAttribute('aria-busy')).toBe('false')
      expect(await (attempt ? search : toggle).evaluate(node => node === document.activeElement)).toBe(true)
      expect(await toggle.evaluate((element, previous) => element === previous, node)).toBe(true)
      expect(await neighbor.evaluate((element, previous) => element === previous, neighborNode)).toBe(true)
      expect(await search.evaluate((element, previous) => element === previous && element instanceof HTMLInputElement
        && [element.value, element.selectionStart, element.selectionEnd], searchNode)).toEqual(['focus', 1, 3])
      expect(await scrollport.evaluate(node => node.scrollTop)).toBe(scroll)
      expect(await geometry()).toEqual(bounds)
      expect(await feedback.evaluate((element, previous) => element === previous, feedbackNode)).toBe(true)
      expect(await feedback.boundingBox()).toEqual(feedbackBounds)
    }
    expect(writes).toBe(2)
  },
)
