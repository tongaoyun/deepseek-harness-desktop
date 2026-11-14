/** Product controls over the native Harness UI; only the enterprise transport is replaced. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { builtinCapabilityPatches } from '../../../packages/deepseek-harness-product/desktop/src/builtin-capabilities.ts'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { controlIsUnclipped, newEnglishPage, REPO_ROOT } from './support.ts'

async function boot(invoke: (method: string, payload?: unknown) => Promise<unknown>,
  getSession = async (): Promise<unknown> => ({ authenticated: true, employeeId: 'employee-fixture', displayName: 'Control reviewer' }),
  initialize?: (home: string, scaffold: WebScaffold) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'product-control-focus-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const overlay = join(root, 'product.patch.yml')
  await writeFile(overlay, JSON.stringify(builtinCapabilityPatches()))
  const scaffold = await launchWebScaffold({ firstUse: true, profile: { packages: [] },
    extraInstallAnchors: [join(REPO_ROOT, 'packages/deepseek-harness-product/desktop/package.json')],
    extraOverlayPath: [overlay, join(REPO_ROOT, 'packages/extensions/ui-deepseek-harness-product/cordis.patch.yml'),
      join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml')],
  })
  onTestFinished(() => scaffold.close())
  await initialize?.(scaffold.harnessHome, scaffold)
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  page.setDefaultTimeout(10_000)
  const tripwire = watchConsole(page)
  await page.exposeFunction('__controlInvoke', async (method: string, payload?: unknown) => method === 'auth.getSession'
    ? getSession() : invoke(method, payload))
  await page.addInitScript(() => {
    const api = globalThis as typeof globalThis & { __controlInvoke(method: string, payload?: unknown): Promise<unknown> }
    Object.defineProperty(globalThis, 'dshDesktop', { value: { extensions: {
      invoke: async (_namespace: string, method: string, payload?: unknown) => {
        let result = await api.__controlInvoke(method, payload)
        if (typeof result === 'object' && result !== null && 'fixtureFailure' in result) return { ok: false, failure: result.fixtureFailure }
        if (method === 'library.files.preview.read' && typeof result === 'object' && result !== null
          && 'data' in result && Array.isArray(result.data)) result = { ...result, data: Uint8Array.from(result.data) }
        return { ok: true, result }
      }, cancel: () => {}, subscribe: (_namespace: string, listener: (event: { type: string; payload?: unknown }) => void) => {
        const receive = (event: Event) => {
          if (!(event instanceof CustomEvent)) return
          const detail: unknown = event.detail
          if (typeof detail === 'object' && detail !== null && 'type' in detail && typeof detail.type === 'string') {
            listener({ type: detail.type, ...'payload' in detail ? { payload: detail.payload } : {} })
          }
        }
        globalThis.addEventListener('control-product-event', receive)
        return () => { globalThis.removeEventListener('control-product-event', receive) }
      },
    } } })
  })
  await page.goto(scaffold.authenticatedUrl)
  onTestFinished(() => { expect(tripwire.pageErrors).toEqual([]) })
  return page
}

/** Finish native first-session autofocus before exercising a product dialog over the resident composer. */
async function waitForInitialComposer(page: Page): Promise<void> {
  await expect.poll(() => page.locator('[data-composer-input][contenteditable="true"]').evaluateAll(nodes =>
    nodes.some(node => node === document.activeElement))).toBe(true)
}

it.each(['REQUIRED', 'EXPIRED', 'AUTHORIZED'] as const)(
  'retains connector authorization controls and browsing through a confirmed %s transition', async (status) => {
    const gate = Promise.withResolvers<undefined>()
    onTestFinished(() => { gate.resolve(undefined) })
    const revoking = status === 'AUTHORIZED'
    const entry = { id: 'authorization-layout', version: '1.0.0', name: 'Authorization layout connector', visibility: 'COMPANY',
      reviewStatus: 'PUBLISHED', canConfigure: true, authMode: 'oauth', tools: Array.from({ length: 21 }, (_, index) => ({
        name: `order.get_${index}`, displayName: `Read order ${index}`, description: `Order capability ${index}`, access: 'READ',
      })) }
    let writes = 0, reads = 0, completed = false
    const page = await boot(async (method) => {
      if (method === `connectors.authorization.${revoking ? 'revoke' : 'begin'}`) {
        writes++
        await gate.promise
        if (revoking) { completed = true; return { connectorId: entry.id, status: 'REQUIRED' } }
        return { connectorId: entry.id, status: 'PENDING', authorizationUrl: 'https://auth.example.test/' }
      }
      switch (method) {
        case 'connectors.authorization.status': completed = true; return { connectorId: entry.id, status: 'AUTHORIZED' }
        case 'connectors.list': reads++; return [{ ...entry, authorizationStatus: completed ? revoking ? 'REQUIRED' : 'AUTHORIZED' : status }]
        default: throw new Error(`Unexpected authorization geometry method: ${method}`)
      }
    })
    await page.getByRole('button', { name: 'Connectors', exact: true }).click()
    await page.getByRole('button', { name: entry.name, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Connector details', exact: true })
    await dialog.locator('summary').filter({ hasText: 'View capabilities (21)' }).click()
    const search = dialog.getByRole('searchbox', { name: 'Search capabilities', exact: true })
    await search.fill('order')
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
    const originalSearch = await search.elementHandle()
    const action = dialog.getByRole('button', { name: revoking ? 'Disconnect account' : status === 'EXPIRED' ? 'Reconnect account' : 'Connect account', exact: true })
    const originalAction = await action.elementHandle()
    const configure = dialog.getByRole('button', { name: 'Configure this device', exact: true })
    const originalConfigure = await configure.elementHandle()
    const actionBounds = await action.boundingBox(), configureBounds = await configure.boundingBox()
    await action.press('Enter')
    await expect.poll(() => writes).toBe(1)
    const progress = dialog.getByRole('button', { name: revoking ? 'Working…' : 'Waiting for browser authorization…', exact: true })
    expect(await progress.evaluate((node, previous) => node === previous && node === document.activeElement, originalAction)).toBe(true)
    expect(await progress.boundingBox()).toEqual(actionBounds)
    expect(await configure.boundingBox()).toEqual(configureBounds)
    await page.keyboard.press('Enter'); await page.keyboard.press(' ')
    expect(writes).toBe(1)
    await capture(page, `authorization-${status}-pending`, dialog, progress)
    const pendingBounds = await progress.boundingBox(), neighborBounds = await configure.boundingBox()
    gate.resolve(undefined)
    const confirmed = dialog.getByRole('button', { name: revoking ? 'Connect account' : 'Disconnect account', exact: true })
    await expect.poll(() => confirmed.getAttribute('aria-busy')).toBe('false')
    expect(await confirmed.evaluate((node, previous) => node === previous && node === document.activeElement, originalAction)).toBe(true)
    expect(await confirmed.boundingBox()).toEqual(pendingBounds)
    expect(await configure.boundingBox()).toEqual(neighborBounds)
    expect(await configure.evaluate((node, previous) => node === previous, originalConfigure)).toBe(true)
    expect(await search.evaluate((node, previous) => node === previous, originalSearch)).toBe(true)
    expect(await search.evaluate(node => node instanceof HTMLInputElement && [node.value, node.selectionStart, node.selectionEnd])).toEqual(['order', 1, 3])
    expect(reads).toBe(2)
    expect(writes).toBe(1)
    await capture(page, `authorization-${status}-confirmed`, dialog, confirmed)
  },
)

it.each((['success', 'failure'] as const).flatMap(outcome => [false, true].map(elsewhere => ({ outcome, elsewhere }))))(
  'retains device entry focus during authorization refresh ($outcome, elsewhere=$elsewhere)', async ({ outcome, elsewhere }) => {
    const revoked = Promise.withResolvers<undefined>()
    const refreshed = Promise.withResolvers<undefined>(), retried = Promise.withResolvers<undefined>()
    onTestFinished(() => { revoked.resolve(undefined); refreshed.resolve(undefined); retried.resolve(undefined) })
    const connector = { id: 'device-refresh-entry', version: '1.0.0', name: 'Device refresh entry', visibility: 'COMPANY',
      reviewStatus: 'PUBLISHED', canConfigure: true, authMode: 'oauth', authorizationStatus: 'AUTHORIZED', tools: [] }
    let reads = 0, writes = 0, configurations = 0
    const page = await boot(async (method) => {
      switch (method) {
        case 'connectors.list':
          if (++reads === 2) {
            await refreshed.promise
            if (outcome === 'failure') return { fixtureFailure: {
              code: 'SERVER_ERROR', message: 'Fixture refresh failure', retryable: true, resources: [],
            } }
          }
          if (reads === 3) await retried.promise
          if (reads > 3) throw new Error('Duplicate entry refresh')
          return [{ ...connector, authorizationStatus: writes > 0 ? 'REQUIRED' : 'AUTHORIZED' }]
        case 'connectors.authorization.revoke':
          writes++
          await revoked.promise
          return { connectorId: connector.id, status: 'REQUIRED' }
        case 'extensions.connector.configuration.read':
          configurations++
          return { id: connector.id, version: connector.version, transport: 'streamable-http', url: 'https://example.test/mcp',
            arguments: [], headers: ['Authorization'], environment: [], configured: false, timeoutSeconds: 60 }
        default: throw new Error(`Unexpected device entry method: ${method}`)
      }
    })
    await page.getByRole('button', { name: 'Connectors', exact: true }).click()
    await page.getByRole('button', { name: connector.name, exact: true }).click()
    const detail = page.getByRole('dialog', { name: 'Connector details', exact: true })
    const configure = detail.getByRole('button', { name: 'Configure this device', exact: true })
    const close = detail.getByRole('button', { name: 'Close', exact: true })
    const original = await configure.elementHandle()
    const bounds = await configure.boundingBox()
    const style = await configure.evaluate(node => [getComputedStyle(node).opacity,
      getComputedStyle(node).color, getComputedStyle(node).backgroundColor])
    await detail.getByRole('button', { name: 'Disconnect account', exact: true }).press('Enter')
    await expect.poll(() => writes).toBe(1)
    const target = elsewhere ? close : configure
    await target.focus()
    revoked.resolve(undefined)
    await expect.poll(() => reads).toBe(2)
    expect(await target.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await configure.evaluate((node, previous) => node === previous, original)).toBe(true)
    expect(await configure.evaluate(node => node instanceof HTMLButtonElement && node.disabled)).toBe(false)
    expect(await configure.getAttribute('aria-disabled')).toBe('true')
    expect(await configure.boundingBox()).toEqual(bounds)
    expect(await configure.evaluate(node => [getComputedStyle(node).opacity,
      getComputedStyle(node).color, getComputedStyle(node).backgroundColor])).toEqual(style)
    await configure.dispatchEvent('click')
    await configure.dispatchEvent('click')
    expect(configurations).toBe(0)
    expect(await page.getByRole('dialog').count()).toBe(1)
    if (!elsewhere) await capture(page, `device-entry-refresh-${outcome}`, detail, configure)
    refreshed.resolve(undefined)
    if (outcome === 'failure') {
      const retry = detail.getByRole('button', { name: 'Refresh', exact: true })
      await retry.waitFor()
      await expect.poll(() => (elsewhere ? close : retry).evaluate(node => node === document.activeElement)).toBe(true)
      await retry.press('Enter')
      await expect.poll(() => reads).toBe(3)
      if (elsewhere) await close.focus()
      await retry.dispatchEvent('click')
      expect(reads).toBe(3)
      retried.resolve(undefined)
      await retry.waitFor({ state: 'hidden' })
      await expect.poll(() => (elsewhere ? close : detail.getByRole('button', { name: 'Connect account', exact: true }))
        .evaluate(node => node === document.activeElement)).toBe(true)
    } else {
      await expect.poll(() => configure.getAttribute('aria-disabled')).toBe('false')
      expect(await target.evaluate(node => node === document.activeElement)).toBe(true)
      expect(await configure.evaluate((node, previous) => node === previous, original)).toBe(true)
    }
    await configure.click()
    const configuration = page.getByRole('dialog', { name: 'Configure this device', exact: true })
    await configuration.getByLabel('Authorization', { exact: true }).waitFor()
    await configuration.getByRole('button', { name: 'Close', exact: true }).click()
    await expect.poll(() => configure.evaluate(node => node === document.activeElement)).toBe(true)
    expect(configurations).toBe(1)
    expect(writes).toBe(1)
  },
)

it.each((['none', 'oauth'] as const).flatMap(mode => (['success', 'failure'] as const).map(outcome => ({ mode, outcome }))))(
  'returns $mode device configuration focus after a confirmed save and refresh $outcome', async ({ mode, outcome }) => {
    const saved = Promise.withResolvers<undefined>()
    const refreshed = Promise.withResolvers<undefined>()
    const retried = Promise.withResolvers<undefined>()
    onTestFinished(() => { saved.resolve(undefined); refreshed.resolve(undefined); retried.resolve(undefined) })
    const tools = Array.from({ length: 21 }, (_, index) => ({ name: `order.get_${index}`, displayName: `Read order ${index}`,
      description: `Read order capability ${index}`, access: 'READ' }))
    const entry = { id: 'device-return', version: '1.0.0', name: 'Device return connector', visibility: 'COMPANY',
      reviewStatus: 'PUBLISHED', canConfigure: true, authMode: mode, authorizationStatus: 'AUTHORIZED', tools }
    let reads = 0, writes = 0, configurations = 0
    const page = await boot(async (method) => {
      switch (method) {
        case 'connectors.list':
          if (++reads === 2) {
            await refreshed.promise
            if (outcome === 'failure') return { fixtureFailure: {
              code: 'SERVER_ERROR', message: 'Fixture catalog refresh failure', retryable: true, resources: [],
            } }
          }
          if (reads === 3) await retried.promise
          if (reads > 3) throw new Error('Duplicate device catalog refresh')
          return [entry]
        case 'extensions.connector.configuration.read':
          configurations++
          return { id: entry.id, version: entry.version, transport: 'streamable-http', url: 'https://example.test/mcp',
            arguments: [], headers: ['Authorization'], environment: [], configured: writes > 0, timeoutSeconds: 60 }
        case 'extensions.connector.configuration.save':
          writes++
          await saved.promise
          return { id: entry.id, version: entry.version, configured: true }
        default: throw new Error(`Unexpected device return method: ${method}`)
      }
    })
    await page.getByRole('button', { name: 'Connectors', exact: true }).click()
    await page.getByRole('button', { name: entry.name, exact: true }).click()
    const detail = page.getByRole('dialog', { name: 'Connector details', exact: true })
    await detail.locator('summary').filter({ hasText: 'View capabilities (21)' }).click()
    const search = detail.getByRole('searchbox', { name: 'Search capabilities', exact: true })
    await search.fill('order')
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
    const originalSearch = await search.elementHandle()
    const configure = detail.getByRole('button', { name: 'Configure this device', exact: true })
    const originalConfigure = await configure.elementHandle()
    if (outcome === 'failure') {
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.setViewportSize({ width: 390, height: 560 })
    }
    const scroller = await configure.evaluateHandle((node) => {
      for (let element = node.parentElement; element; element = element.parentElement) {
        if (['auto', 'scroll'].includes(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight) return element
      }
      throw new Error('Missing scrollable connector detail')
    })
    const title = detail.getByRole('heading', { name: 'Connector details', exact: true })
    const close = detail.getByRole('button', { name: 'Close', exact: true })
    const titleBounds = await title.boundingBox(), closeBounds = await close.boundingBox()
    await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight - node.clientHeight })
    expect(await title.boundingBox()).toEqual(titleBounds)
    expect(await close.boundingBox()).toEqual(closeBounds)
    await scroller.evaluate((node) => { node.scrollTop = 32 })
    expect(await title.boundingBox()).toEqual(titleBounds)
    expect(await close.boundingBox()).toEqual(closeBounds)
    await configure.click()
    const scrollBefore = await scroller.evaluate(node => node.scrollTop)
    expect(scrollBefore).toBeGreaterThan(0)
    const dialog = page.getByRole('dialog', { name: 'Configure this device', exact: true })
    await dialog.getByLabel('Authorization', { exact: true }).fill('synthetic-fixture')
    const save = dialog.getByRole('button', { name: 'Save connector', exact: true })
    const originalSave = await save.elementHandle()
    await save.press('Enter')
    await expect.poll(() => writes).toBe(1)
    await page.keyboard.press('Enter')
    await page.keyboard.press(' ')
    expect(writes).toBe(1)
    saved.resolve(undefined)
    await expect.poll(() => reads).toBe(2)
    expect(await dialog.getByRole('button', { name: 'Connecting and discovering tools…', exact: true })
      .evaluate((node, original) => node === original && node === document.activeElement, originalSave)).toBe(true)
    refreshed.resolve(undefined)
    await dialog.waitFor({ state: 'hidden' })
    const target = outcome === 'success' ? configure : detail.getByRole('button', { name: 'Refresh', exact: true })
    await expect.poll(() => target.evaluate(node => node === document.activeElement), {
      message: JSON.stringify(await page.evaluate(() => ({ tag: document.activeElement?.tagName,
        role: document.activeElement?.getAttribute('role'), label: document.activeElement?.getAttribute('aria-label') }))),
    }).toBe(true)
    if (outcome === 'success') expect(await scroller.evaluate(node => node.scrollTop)).toBe(scrollBefore)
    if (mode === 'none') await capture(page, `device-save-return-${outcome}`, detail, target)
    if (outcome === 'failure') {
      const notice = await detail.getByRole('alert').elementHandle()
      const originalRetry = await target.elementHandle()
      await target.press('Enter')
      await expect.poll(() => reads).toBe(3)
      await page.keyboard.press('Enter')
      await page.keyboard.press(' ')
      expect(reads).toBe(3)
      expect(await target.evaluate((node, original) => node === original && node === document.activeElement, originalRetry)).toBe(true)
      expect(await detail.getByRole('alert').evaluate((node, original) => node === original, notice)).toBe(true)
      expect(writes).toBe(1)
      retried.resolve(undefined)
      const restored = mode === 'oauth' ? detail.getByRole('button', { name: 'Disconnect account', exact: true }) : configure
      await expect.poll(() => restored.evaluate(node => node === document.activeElement)).toBe(true)
    } else expect(await configure.evaluate((node, original) => node === original, originalConfigure)).toBe(true)
    expect(await search.evaluate((node, original) => node === original, originalSearch)).toBe(true)
    expect(await search.inputValue()).toBe('order')
    expect(await search.evaluate(node => node instanceof HTMLInputElement && [node.selectionStart, node.selectionEnd])).toEqual([1, 3])
    expect(writes).toBe(1)
    expect(configurations).toBe(1)
  },
)

it.each(['light', 'dark'] as const)('keeps company submission controls and failure layout stable through inspection and submission retries (%s)', async (theme) => {
  const gates = Array.from({ length: 4 }, () => Promise.withResolvers<undefined>())
  onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }) })
  let reads = 0, writes = 0
  const page = await boot(async (method) => {
    if (method === 'content.submissions.inspect') {
      const attempt = reads++
      await gates[attempt]?.promise
      return attempt === 0 ? { fixtureFailure: { code: 'SERVER_ERROR', message: 'Private inspection diagnostic', retryable: true, resources: [] } }
        : { status: null }
    }
    if (method === 'content.submissions.submit') {
      const attempt = writes++
      await gates[attempt + 2]?.promise
      return attempt === 0 ? { fixtureFailure: { code: 'SERVER_ERROR', message: 'Private submission diagnostic', retryable: true, resources: [] } }
        : { status: 'SUBMITTED', reviewNote: '' }
    }
    throw new Error(`Unexpected content submission method: ${method}`)
  })
  await waitForInitialComposer(page)
  await page.emulateMedia({ colorScheme: theme })
  await page.setViewportSize({ width: theme === 'dark' ? 390 : 1440, height: theme === 'dark' ? 560 : 900 })
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('dsh:company-content-submit', { cancelable: true, detail: {
      name: 'Company submission stability',
      prepare: async () => ({ resourceKey: 'skills/stability', files: { 'skills/stability/SKILL.md': 'ZmlsZQ==' } }),
    } }))
  })
  const dialog = page.getByRole('dialog', { name: 'Submit for publication', exact: true })
  const action = dialog.locator('button[aria-busy]')
  const close = dialog.getByRole('button', { name: 'Close', exact: true }).last()
  await expect.poll(() => reads).toBe(1)
  const originalAction = await action.elementHandle(), originalClose = await close.elementHandle()
  const geometry = async () => Promise.all([dialog, action, close].map(control => control.boundingBox()))
  const initial = await geometry()
  gates[0]!.resolve(undefined)
  const notice = dialog.getByRole('alert')
  await notice.waitFor()
  await expect.poll(() => action.getAttribute('aria-busy')).toBe('false')
  expect(await geometry()).toEqual(initial)
  const failedNotice = await notice.elementHandle()
  await action.press('Enter')
  await expect.poll(() => reads).toBe(2)
  expect(await geometry()).toEqual(initial)
  expect(await notice.evaluate((node, previous) => node === previous, failedNotice)).toBe(true)
  await page.keyboard.press('Enter'); await page.keyboard.press(' ')
  expect(reads).toBe(2)
  gates[1]!.resolve(undefined)
  await expect.poll(() => action.getAttribute('aria-busy')).toBe('false')
  expect(await notice.count()).toBe(0)
  expect(await action.evaluate((node, previous) => node === previous && node === document.activeElement, originalAction)).toBe(true)
  expect((await action.boundingBox())?.width).toBe(initial[1]?.width)
  expect(await close.evaluate((node, previous) => node === previous, originalClose)).toBe(true)
  const prepared = await geometry()
  await action.press('Enter')
  await expect.poll(() => writes).toBe(1)
  expect(await geometry()).toEqual(prepared)
  gates[2]!.resolve(undefined)
  await notice.waitFor()
  await expect.poll(() => action.getAttribute('aria-busy')).toBe('false')
  expect(await geometry()).toEqual(prepared)
  const writeNotice = await notice.elementHandle()
  await action.press('Enter')
  await expect.poll(() => writes).toBe(2)
  expect(await geometry()).toEqual(prepared)
  expect(await notice.evaluate((node, previous) => node === previous, writeNotice)).toBe(true)
  await page.keyboard.press('Enter'); await page.keyboard.press(' ')
  expect(writes).toBe(2)
  await capture(page, `company-submission-retry-${theme}`, dialog, action)
  gates[3]!.resolve(undefined)
  await dialog.getByRole('status').waitFor()
  expect(await close.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await action.evaluate((node, previous) => node === previous
    && node instanceof HTMLButtonElement && node.disabled, originalAction)).toBe(true)
  expect(await notice.count()).toBe(0)
  expect(await dialog.textContent()).not.toContain('Private')
})

it.each(['light', 'dark'] as const)('keeps feedback form geometry, draft and focus through submission results (%s)', async (theme) => {
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers<undefined>())
  onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }) })
  let writes = 0
  const page = await boot(async (method) => {
    if (method !== 'support.feedback.submit') throw new Error(`Unexpected feedback geometry method: ${method}`)
    const attempt = writes++
    await gates[attempt]?.promise
    return attempt === 2 ? { id: 'geometry-receipt' }
      : { fixtureFailure: { code: 'SERVER_ERROR', message: 'Private feedback diagnostic', retryable: true, resources: [] } }
  })
  await waitForInitialComposer(page)
  await page.getByRole('button', { name: 'Control reviewer', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Feedback', exact: true }).click()
  await page.emulateMedia({ colorScheme: theme })
  await page.setViewportSize({ width: theme === 'dark' ? 390 : 1440, height: theme === 'dark' ? 560 : 900 })
  const dialog = page.getByRole('dialog', { name: 'Feedback', exact: true })
  const input = dialog.getByRole('textbox', { name: 'Message', exact: true })
  const category = dialog.getByRole('combobox', { name: 'Category', exact: true })
  await dialog.getByRole('button', { name: 'Submit feedback', exact: true }).waitFor()
  const action = dialog.locator('button[aria-busy]').last()
  const close = dialog.getByRole('button', { name: 'Close', exact: true }).last()
  const draft = 'Keep the feedback draft and its reading position.\n'.repeat(30)
  await input.fill(draft)
  await input.evaluate((node) => { if (node instanceof HTMLTextAreaElement) { node.setSelectionRange(3, 9); node.scrollTop = 48 } })
  const originalInput = await input.elementHandle(), originalAction = await action.elementHandle()
  const originalCategory = await category.elementHandle(), originalClose = await close.elementHandle()
  const geometry = async () => Promise.all([dialog, action, close, category, input].map(control => control.boundingBox()))
  const before = await geometry()
  const scroll = await input.evaluate(node => node.scrollTop)
  await action.press('Enter')
  await expect.poll(() => writes).toBe(1)
  expect(await geometry()).toEqual(before)
  await page.keyboard.press('Enter'); await page.keyboard.press(' ')
  expect(writes).toBe(1)
  gates[0]!.resolve(undefined)
  const notice = dialog.getByRole('alert')
  await notice.waitFor()
  expect(await geometry()).toEqual(before)
  const originalNotice = await notice.elementHandle()
  await action.press('Enter')
  await expect.poll(() => writes).toBe(2)
  expect(await geometry()).toEqual(before)
  expect(await notice.evaluate((node, previous) => node === previous, originalNotice)).toBe(true)
  gates[1]!.resolve(undefined)
  await expect.poll(() => action.getAttribute('aria-busy')).toBe('false')
  expect(await geometry()).toEqual(before)
  expect(await action.evaluate((node, previous) => node === previous && node === document.activeElement, originalAction)).toBe(true)
  expect(await input.evaluate((node, previous) => node === previous, originalInput)).toBe(true)
  expect(await category.evaluate((node, previous) => node === previous, originalCategory)).toBe(true)
  expect(await close.evaluate((node, previous) => node === previous, originalClose)).toBe(true)
  expect(await input.inputValue()).toBe(draft)
  expect(await input.evaluate(node => node instanceof HTMLTextAreaElement
    ? [node.selectionStart, node.selectionEnd, node.scrollTop] : [])).toEqual([3, 9, scroll])
  await capture(page, `feedback-submit-stability-${theme}`, dialog, action)
  await page.emulateMedia({ colorScheme: theme })
  await page.setViewportSize({ width: theme === 'dark' ? 390 : 1440, height: theme === 'dark' ? 560 : 900 })
  const retry = await geometry()
  await action.press('Enter')
  await expect.poll(() => writes).toBe(3)
  gates[2]!.resolve(undefined)
  await dialog.getByRole('status').waitFor()
  expect(await geometry()).toEqual(retry)
  expect(await input.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await input.inputValue()).toBe('')
  expect(await dialog.getByRole('alert').count()).toBe(0)
  expect(await dialog.textContent()).not.toContain('Private feedback diagnostic')
})

it('retains native paste insertion and the feedback caret when text includes screenshots', async () => {
  const page = await boot(async () => [])
  await waitForInitialComposer(page)
  await page.getByRole('button', { name: 'Control reviewer', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Feedback', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Feedback', exact: true })
  const input = dialog.getByRole('textbox', { name: 'Message', exact: true })
  await input.fill('BeforeAfter')
  const original = await input.elementHandle()
  const bytes = [...await page.screenshot()]
  await input.evaluate((node, data) => {
    if (!(node instanceof HTMLTextAreaElement)) throw new Error('Expected feedback textarea')
    node.setSelectionRange(6, 6)
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', ' middle ')
    clipboardData.items.add(new File([new Uint8Array(data)], 'paste.png', { type: 'image/png' }))
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, bytes)
  await dialog.getByRole('img', { name: 'paste.png', exact: true }).waitFor()
  expect(await input.inputValue()).toBe('Before middle After')
  expect(await input.evaluate((node, previous) => node === previous && node === document.activeElement, original)).toBe(true)
  expect(await input.evaluate(node => node instanceof HTMLTextAreaElement
    ? [node.selectionStart, node.selectionEnd] : [])).toEqual([14, 14])
  await page.keyboard.type('caret ')
  expect(await input.inputValue()).toBe('Before middle caret After')
  await capture(page, 'feedback-mixed-paste', dialog, input)
})

it.each((['light', 'dark'] as const).flatMap(theme => (['connectors', 'library'] as const).map(catalog => ({ theme, catalog }))))(
  'retains shared employee sign-in focus and layout across $catalog authorization retries ($theme)', async ({ theme, catalog }) => {
    const initial = Promise.withResolvers<undefined>(), retried = Promise.withResolvers<undefined>()
    const accepted = Promise.withResolvers<undefined>()
    onTestFinished(() => { initial.resolve(undefined); retried.resolve(undefined); accepted.resolve(undefined) })
    let writes = 0, authenticated = false
    const page = await boot(async (method) => {
      if (method === 'connectors.list') return []
      if (method === 'library.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
      if (method === 'auth.ensureDingTalk') {
        const attempt = ++writes
        if (attempt === 1) await initial.promise
        if (attempt === 2) await retried.promise
        if (attempt === 3) {
          await accepted.promise
          authenticated = true
          await page.evaluate(() => { dispatchEvent(new CustomEvent('control-product-event', { detail: {
            type: 'session.changed', payload: { authenticated: true, employeeId: 'reviewer', displayName: 'Signed-in reviewer' },
          } })) })
          return { authenticated: true }
        }
        return { fixtureFailure: { code: 'SERVER_ERROR', message: 'Private sign-in diagnostic', retryable: true, resources: [] } }
      }
      throw new Error(`Unexpected employee retry method: ${method}`)
    }, async () => ({ authenticated, ...authenticated ? { employeeId: 'reviewer', displayName: 'Signed-in reviewer' } : {} }))
    await page.emulateMedia({ colorScheme: theme })
    const initialPrompt = page.getByRole('dialog', { name: 'Sign in to use organization resources', exact: true })
    await initialPrompt.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(writes).toBe(0)
    await page.getByRole('button', { name: catalog === 'connectors' ? 'Connectors' : 'Libraries', exact: true }).click()
    const opener = page.getByRole('button', { name: 'Sign in with DingTalk', exact: true })
    const originalOpener = await opener.elementHandle()
    await opener.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Sign in to use organization resources', exact: true })
    const notice = dialog.getByRole('alert')
    const waiting = dialog.getByRole('button', { name: 'Waiting for DingTalk…', exact: true })
    await waiting.waitFor()
    await page.setViewportSize({ width: theme === 'dark' ? 390 : 1440, height: theme === 'dark' ? 560 : 900 })
    const initialBounds = await waiting.boundingBox(), initialDialogBounds = await dialog.boundingBox()
    initial.resolve(undefined)
    await notice.waitFor()
    const action = dialog.getByRole('button', { name: 'Sign in with DingTalk', exact: true })
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
    const original = await action.elementHandle(), originalNotice = await notice.elementHandle()
    const originalCancel = await cancel.elementHandle()
    const bounds = await action.boundingBox(), cancelBounds = await cancel.boundingBox(), dialogBounds = await dialog.boundingBox()
    expect(bounds).toEqual(initialBounds)
    expect(dialogBounds).toEqual(initialDialogBounds)
    const style = await action.evaluate(node => [getComputedStyle(node).opacity,
      getComputedStyle(node).backgroundColor, getComputedStyle(node).color])
    await action.press('Enter')
    await expect.poll(() => writes).toBe(2)
    expect(await notice.evaluate((node, previous) => node === previous, originalNotice)).toBe(true)
    expect(await waiting.evaluate((node, previous) => node === previous && node === document.activeElement, original)).toBe(true)
    expect(await waiting.evaluate(node => [getComputedStyle(node).opacity,
      getComputedStyle(node).backgroundColor, getComputedStyle(node).color])).toEqual(style)
    expect(await waiting.boundingBox()).toEqual(bounds)
    expect(await cancel.boundingBox()).toEqual(cancelBounds)
    expect(await dialog.boundingBox()).toEqual(dialogBounds)
    expect(await cancel.evaluate((node, previous) => node === previous, originalCancel)).toBe(true)
    await page.keyboard.press('Enter'); await page.keyboard.press(' ')
    expect(writes).toBe(2)
    await capture(page, `employee-sign-in-retry-${catalog}-${theme}`, dialog, waiting)
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: theme === 'dark' ? 390 : 1440, height: theme === 'dark' ? 560 : 900 })
    retried.resolve(undefined)
    await action.waitFor()
    expect(await notice.evaluate((node, previous) => node === previous, originalNotice)).toBe(true)
    expect(await action.evaluate((node, previous) => node === previous && node === document.activeElement, original)).toBe(true)
    await action.press('Enter')
    await expect.poll(() => writes).toBe(3)
    await cancel.focus()
    accepted.resolve(undefined)
    await dialog.waitFor({ state: 'hidden' })
    const employee = page.getByRole('button', { name: 'Signed-in reviewer', exact: true })
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts/deepseek-harness-control-focus',
      `employee-sign-in-return-${catalog}-${theme}.png`) })
    const destination = theme === 'light' ? employee : page.getByRole('region', {
      name: catalog === 'connectors' ? 'Connectors' : 'Libraries', exact: true,
    }).filter({ has: page.getByRole('heading', { level: 1 }) })
    await destination.waitFor()
    await expect.poll(() => destination.evaluate(node =>
      node === document.activeElement || node.contains(document.activeElement),
    )).toBe(true)
    expect(await page.getByRole('alert').count()).toBe(0)
    expect(await opener.count()).toBe(0)
    expect(await page.evaluate(previous => previous?.isConnected, originalOpener)).toBe(false)
    expect(await page.locator('body').textContent()).not.toContain('Private sign-in diagnostic')
  },
)

it.each(['light', 'dark'] as const)('retains skill reader focus through the native clipboard fallback (%s)', async (theme) => {
  const text = 'Keep the exact fallback instructions.\n'.repeat(40)
  const page = await boot(async (method) => {
    throw new Error(`Unexpected fallback method: ${method}`)
  }, undefined, async (home) => {
    const directory = join(home, 'skills', 'fallback-reviewer')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), `---\nname: fallback-reviewer\ndescription: Clipboard fallback fixture.\n---\n\n${text}`)
  })
  const copied: string[] = []
  await page.exposeFunction('__copySkillFallback', (text: string) => { copied.push(text) })
  await page.evaluate(() => {
    const api = globalThis as typeof globalThis & { __copySkillFallback(text: string): Promise<void> }
    let writes = 0
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => {
      const selected = document.body.querySelector('textarea[readonly][style]')
      if (!(selected instanceof HTMLTextAreaElement)) throw new Error('Missing native clipboard text')
      void api.__copySkillFallback(selected.value)
      return ++writes === 2
    } })
  })
  await page.emulateMedia({ colorScheme: theme })
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  await page.locator('.dssm-section').getByRole('textbox', { name: 'Search', exact: true }).fill('fallback-reviewer')
  await page.locator('.dssm-skill-row').getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name: 'View details', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Skill details', exact: true })
  const body = dialog.getByRole('textbox', { name: 'Body', exact: true })
  const copy = dialog.getByRole('button', { name: 'Copy body', exact: true })
  await body.waitFor()
  const expectedBody = await body.inputValue()
  await page.setViewportSize({ width: theme === 'dark' ? 390 : 1440, height: theme === 'dark' ? 560 : 900 })
  const originalCopy = await copy.elementHandle(), originalBody = await body.elementHandle()
  const copyBounds = await copy.boundingBox(), bodyBounds = await body.boundingBox()
  await copy.press('Enter')
  await dialog.getByRole('alert').waitFor()
  await expect.poll(() => copied.length).toBe(1)
  expect(await copy.evaluate((node, original) => node === original && node === document.activeElement, originalCopy)).toBe(true)
  expect(await copy.boundingBox()).toEqual(copyBounds)
  expect(await body.boundingBox()).toEqual(bodyBounds)
  await copy.press('Enter')
  await dialog.getByText('Copied', { exact: true }).waitFor()
  await expect.poll(() => copied.length).toBe(2)
  expect(await copy.evaluate(node => node === document.activeElement)).toBe(true)
  await body.focus()
  await body.evaluate((node) => { if (node instanceof HTMLTextAreaElement) { node.setSelectionRange(2, 9); node.scrollTop = 32 } })
  await copy.dispatchEvent('click')
  await dialog.getByRole('alert').waitFor()
  await expect.poll(() => copied.length).toBe(3)
  expect(await body.evaluate((node, original) => node === original && node === document.activeElement, originalBody)).toBe(true)
  expect(await body.evaluate(node => node instanceof HTMLTextAreaElement
    ? [node.selectionStart, node.selectionEnd, node.scrollTop] : [])).toEqual([2, 9, 32])
  expect(new Set(copied)).toEqual(new Set([expectedBody]))
  expect(await page.locator('body > textarea[readonly][style]').count()).toBe(0)
  await capture(page, `skill-copy-fallback-${theme}`, dialog, body)
})

it.each(['light', 'dark'] as const)('keeps skill body copy focus, selection and geometry through retry (%s)', async (theme) => {
  const page = await boot(async (method) => {
    throw new Error(`Unexpected skill copy method: ${method}`)
  }, undefined, async (home) => {
    const directory = join(home, 'skills', 'copy-reviewer')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), '---\nname: copy-reviewer\ndescription: Clipboard review fixture.\n---\n\n' + 'Keep the exact review instructions.\n'.repeat(40))
  })
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers<undefined>())
  const copied: string[] = []
  onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }) })
  await page.exposeFunction('__copySkillBody', async (text: string) => {
    const index = copied.length
    copied.push(text)
    const gate = gates[index]
    if (!gate) throw new Error('Duplicate skill clipboard write')
    await gate.promise
    if (index === 0) throw new Error('Clipboard temporarily unavailable')
  })
  await page.evaluate(() => {
    const api = globalThis as typeof globalThis & { __copySkillBody(text: string): Promise<void> }
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: (text: string) => api.__copySkillBody(text) } })
  })
  await page.emulateMedia({ colorScheme: theme })
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('tab', { name: 'Mine', exact: true }).click()
  await page.locator('.dssm-section').getByRole('textbox', { name: 'Search', exact: true }).fill('copy-reviewer')
  const row = page.locator('.dssm-skill-row').filter({ has: page.getByText('copy-reviewer', { exact: true }) })
  await row.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name: 'View details', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Skill details', exact: true })
  const body = dialog.getByRole('textbox', { name: 'Body', exact: true })
  const copy = dialog.getByRole('button', { name: 'Copy body', exact: true })
  await body.waitFor()
  await page.setViewportSize({ width: theme === 'dark' ? 390 : 1440, height: 900 })
  const originalCopy = await copy.elementHandle()
  const originalBody = await body.elementHandle()
  const copyBounds = await copy.boundingBox()
  const bodyBounds = await body.boundingBox()
  await copy.press('Enter')
  await expect.poll(() => copied.length).toBe(1)
  expect(await copy.evaluate(node => node === document.activeElement)).toBe(true)
  await page.keyboard.press('Enter')
  await page.keyboard.press(' ')
  expect(copied).toHaveLength(1)
  gates[0]!.resolve(undefined)
  const notice = dialog.getByRole('alert')
  await notice.waitFor()
  const originalNotice = await notice.elementHandle()
  expect(await copy.boundingBox()).toEqual(copyBounds)
  expect(await body.boundingBox()).toEqual(bodyBounds)
  await copy.press('Enter')
  await expect.poll(() => copied.length).toBe(2)
  expect(await copy.evaluate((node, previous) => node === previous && node === document.activeElement, originalCopy)).toBe(true)
  expect(await notice.evaluate((node, previous) => node === previous, originalNotice)).toBe(true)
  gates[1]!.resolve(undefined)
  await dialog.getByText('Copied', { exact: true }).waitFor()
  expect(await copy.boundingBox()).toEqual(copyBounds)
  expect(await body.boundingBox()).toEqual(bodyBounds)
  await copy.press('Enter')
  await expect.poll(() => copied.length).toBe(3)
  await body.focus()
  await body.evaluate((node) => { if (node instanceof HTMLTextAreaElement) { node.setSelectionRange(2, 9); node.scrollTop = 32 } })
  gates[2]!.resolve(undefined)
  await expect.poll(() => copy.getAttribute('aria-busy')).toBe('false')
  expect(await body.evaluate((node, previous) => node === previous && node === document.activeElement, originalBody)).toBe(true)
  expect(await body.evaluate(node => node instanceof HTMLTextAreaElement
    ? [node.selectionStart, node.selectionEnd, node.scrollTop] : [])).toEqual([2, 9, 32])
  expect(new Set(copied).size).toBe(1)
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-control-focus')
  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ path: join(screenshots, `skill-copy-${theme}.png`), animations: 'disabled' })
})

it.each([
  ...(['detail', 'editor'] as const).flatMap(surface => (['removed', 'regrouped', 'retained'] as const)
    .map(change => ({ surface, change, close: 'escape' as const }))),
  ...(['detail', 'editor'] as const).flatMap(surface => (['button', 'mask'] as const)
    .map(close => ({ surface, change: 'removed' as const, close }))),
])('returns connector $surface focus after a $change catalog change (close=$close)', async ({ surface, change, close }) => {
  const response = Promise.withResolvers<undefined>()
  onTestFinished(() => { response.resolve(undefined) })
  const entry = { id: 'return-connector', version: '1.0.0', name: 'Return connector', visibility: 'PERSONAL',
    canEdit: true, reviewStatus: 'DRAFT', category: 'business-systems', authMode: 'none', tools: [] }
  let refreshing = false
  let reads = 0
  const page = await boot(async (method) => {
    switch (method) {
      case 'connectors.list':
        if (!refreshing) return [entry]
        if (++reads !== 1) throw new Error('Duplicate return catalog read')
        await response.promise
        return change === 'removed' ? [] : [{ ...entry, name: 'Return connector refreshed',
          category: change === 'regrouped' ? 'data-analysis' : entry.category }]
      case 'extensions.connector.read': return { draft: { kind: 'connector', id: entry.id, version: '1.0.1', name: entry.name,
        summary: 'Read-only fixture', category: entry.category, transport: 'stdio', command: 'node', arguments: [] },
      configured: true, savePending: false }
      default: throw new Error(`Unexpected return focus method: ${method}`)
    }
  })
  await page.getByRole('button', { name: 'Connectors', exact: true }).click()
  const catalog = page.getByRole('region', { name: 'Connectors', exact: true })
  await catalog.getByRole('tab', { name: 'Mine', exact: true }).click()
  const search = catalog.getByRole('searchbox', { name: 'Search', exact: true })
  await search.fill('Return')
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
  const originalSearch = await search.elementHandle()
  const trigger = catalog.getByRole('button', { name: surface === 'detail' ? entry.name : 'More actions', exact: true })
  const originalTrigger = await trigger.elementHandle()
  await trigger.click()
  if (surface === 'editor') await page.getByRole('menuitem', { name: 'Modify', exact: true }).click()
  const dialog = page.getByRole('dialog')
  if (surface === 'editor') await expect.poll(() => dialog.getByRole('textbox', { name: 'Server name', exact: true }).inputValue()).toBe(entry.name)
  await dialog.getByRole('button', { name: 'Close', exact: true }).focus()
  refreshing = true
  await page.evaluate(() => { globalThis.dispatchEvent(new CustomEvent('control-product-event', { detail: { type: 'catalog.changed' } })) })
  await expect.poll(() => reads).toBe(1)
  response.resolve(undefined)
  if (change === 'removed') await catalog.getByRole('button', { name: entry.name, exact: true }).waitFor({ state: 'hidden' })
  else await catalog.getByRole('button', { name: 'Return connector refreshed', exact: true }).waitFor()
  if (close === 'escape') await page.keyboard.press('Escape')
  else if (close === 'mask') await page.locator('[role="presentation"] > [aria-hidden="true"]').last().click({ position: { x: 4, y: 4 } })
  else await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const target = change === 'retained' ? surface === 'detail'
    ? catalog.getByRole('button', { name: 'Return connector refreshed', exact: true }) : trigger : search
  await expect.poll(() => target.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
  expect(await search.evaluate((node, previous) => node === previous, originalSearch)).toBe(true)
  expect(await search.inputValue()).toBe('Return')
  expect(await search.evaluate(node => node instanceof HTMLInputElement ? [node.selectionStart, node.selectionEnd] : [])).toEqual([1, 4])
  if (change === 'retained') expect(await target.evaluate((node, previous) => node === previous, originalTrigger)).toBe(true)
  if (change === 'removed' && close === 'escape') await capture(page, `connector-return-${surface}`, catalog, target)
})

async function capture(page: Page, name: string, region: Locator, focused: Locator) {
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-control-focus')
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 560 }]) {
      await page.setViewportSize(size)
      if (await focused.evaluate(node => node.tagName !== 'FORM')) await focused.scrollIntoViewIfNeeded()
      expect(await region.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      expect(await focused.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
      await page.screenshot({ path: join(screenshots, `${name}-${theme}-${size.width}.png`), animations: 'disabled' })
    }
  }
}

it.each(['success', 'failure'] as const)('settles library favorites across search and pagination without losing the viewport (%s)', async (outcome) => {
  const now = '2026-11-13T01:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: 'Favorite library', description: 'Retained files',
    scope: 'PERSONAL', ownerId: 'employee-fixture', managerEmployeeId: 'employee-fixture', canManage: true,
    version: 1, createdAt: now, updatedAt: now }
  const files = Array.from({ length: 40 }, (_, index) => ({
    id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`, libraryId: library.id, parentId: null,
    name: `Retained ${index}.md`, kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12,
    favorite: false, version: 1, createdAt: now, updatedAt: now,
  }))
  const write = Promise.withResolvers<undefined>(), retry = Promise.withResolvers<undefined>()
  onTestFinished(() => { write.resolve(undefined); retry.resolve(undefined) })
  let writes = 0, reads = 0, saved = false
  const page = await boot(async (method, payload) => {
    switch (method) {
      case 'library.list': return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
      case 'library.get': return library
      case 'library.entries.list': {
        reads++
        const index = typeof payload === 'object' && payload !== null && 'page' in payload ? Number(payload.page) : 1
        return { data: files.slice((index - 1) * 20, index * 20).map(file => ({ ...file, favorite: saved && file.id === files[0]!.id })),
          pageIndex: index, pageSize: 20, totalCount: 40, totalPages: 2 }
      }
      case 'library.entries.favorite':
        if (++writes === 1) {
          await write.promise
          if (outcome === 'failure') return { fixtureFailure: {
            code: 'LIBRARY_ACCESS_DENIED', message: 'Favorite unavailable', retryable: true, resources: [],
          } }
        } else await retry.promise
        saved = typeof payload === 'object' && payload !== null && 'value' in payload && payload.value === true
        return saved
      default: throw new Error(`Unexpected library favorite method: ${method}`)
    }
  })
  await page.getByRole('button', { name: 'Libraries', exact: true }).click()
  await page.getByRole('button', { name: 'Favorite library Retained files', exact: true }).click()
  const browser = page.getByRole('region', { name: 'Libraries', exact: true }).last()
  const first = browser.getByRole('button', { name: 'Retained 0.md 1 KB', exact: true })
  const favorite = first.locator('..').getByRole('button', { name: 'Favorite', exact: true })
  const upload = browser.getByRole('button', { name: 'Upload files', exact: true })
  const uploadNode = await upload.elementHandle(), uploadBounds = await upload.boundingBox()
  await favorite.press('Enter'); await favorite.press(' ')
  await expect.poll(() => writes).toBe(1)
  expect(await favorite.getAttribute('aria-busy')).toBe('true')
  expect(await upload.evaluate((node, original) => node === original && getComputedStyle(node).opacity === '1', uploadNode)).toBe(true)
  expect(await upload.boundingBox()).toEqual(uploadBounds)
  const search = browser.getByRole('searchbox', { name: 'Search names', exact: true })
  const searchNode = await search.elementHandle()
  await search.fill('Retained')
  const refresh = browser.getByRole('button', { name: 'Refresh', exact: true })
  await expect.poll(() => reads).toBe(2)
  await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('false')
  expect(await favorite.getAttribute('aria-busy')).toBe('true')
  await search.focus()
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
  await browser.getByRole('button', { name: 'Next', exact: true }).click()
  const retained = browser.getByRole('button', { name: 'Retained 32.md 1 KB', exact: true })
  await retained.focus()
  await expect.poll(() => reads).toBe(3)
  await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('false')
  const retainedNode = await retained.elementHandle(), retainedBounds = await retained.boundingBox()
  const viewport = await retained.evaluateHandle((node) => {
    for (let owner = node.parentElement; owner; owner = owner.parentElement) {
      if (['auto', 'scroll'].includes(getComputedStyle(owner).overflowY) && owner.scrollHeight > owner.clientHeight) return owner
    }
    throw new Error('Missing library scroll owner')
  })
  const scroll = await viewport.evaluate(node => node.scrollTop)
  expect(scroll).toBeGreaterThan(0)
  write.resolve(undefined)
  if (outcome === 'failure') {
    const notice = browser.getByRole('alert'), action = browser.getByRole('button', { name: 'Retry', exact: true })
    await notice.waitFor()
    expect(await retained.evaluate((node, original) => node === original && node === document.activeElement, retainedNode)).toBe(true)
    expect(await retained.boundingBox()).toEqual(retainedBounds)
    expect(await viewport.evaluate(node => node.scrollTop)).toBe(scroll)
    await action.focus()
    const actionNode = await action.elementHandle(), noticeNode = await notice.elementHandle(), actionBounds = await action.boundingBox()
    await action.press('Enter'); await action.press(' ')
    await expect.poll(() => writes).toBe(2)
    expect(await action.evaluate((node, original) => node === original && node === document.activeElement, actionNode)).toBe(true)
    expect(await action.boundingBox()).toEqual(actionBounds)
    expect(await notice.evaluate((node, original) => node === original, noticeNode)).toBe(true)
    await capture(page, 'library-favorite-retry', browser, action)
    const message = browser.getByRole('region', { name: 'Save failed. Please retry.', exact: true })
    const retryBounds = await action.boundingBox()
    await message.focus()
    expect(await message.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
    await message.press('ArrowDown')
    await expect.poll(() => message.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
    expect(await action.boundingBox()).toEqual(retryBounds)
    await action.focus()
    retry.resolve(undefined)
    await notice.waitFor({ state: 'detached' })
    expect(await search.evaluate(node => node === document.activeElement)).toBe(true)
  } else {
    await expect.poll(() => reads).toBe(4)
    expect(await retained.evaluate((node, original) => node === original && node === document.activeElement, retainedNode)).toBe(true)
    expect(await retained.boundingBox()).toEqual(retainedBounds)
    expect(await viewport.evaluate(node => node.scrollTop)).toBe(scroll)
    await capture(page, 'library-favorite-confirmed', browser, retained)
  }
  await expect.poll(() => reads).toBe(4)
  await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('false')
  expect(await retained.evaluate((node, original) => node === original, retainedNode)).toBe(true)
  expect(await search.evaluate((node, original) => ({ same: node === original,
    selection: node instanceof HTMLInputElement ? [node.value, node.selectionStart, node.selectionEnd] : [],
  }), searchNode)).toEqual({ same: true, selection: ['Retained', 1, 4] })
  expect(await browser.getByText('2 / 2', { exact: true }).count()).toBe(1)
  await browser.getByRole('button', { name: 'Previous', exact: true }).click()
  await first.locator('..').getByRole('button', { name: 'Remove favorite', exact: true }).waitFor()
  expect(writes).toBe(outcome === 'success' ? 1 : 2)
  const remove = first.locator('..').getByRole('button', { name: 'Remove favorite', exact: true })
  await remove.focus()
  const removeNode = await remove.elementHandle(), removeBounds = await remove.boundingBox(), firstBounds = await first.boundingBox()
  retry.resolve(undefined)
  await remove.press('Enter')
  const restored = first.locator('..').getByRole('button', { name: 'Favorite', exact: true })
  await restored.waitFor()
  await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('false')
  expect(await restored.evaluate((node, original) => node === original && node === document.activeElement, removeNode)).toBe(true)
  expect(await restored.boundingBox()).toEqual(removeBounds)
  expect(await first.boundingBox()).toEqual(firstBounds)
  expect(writes).toBe(outcome === 'success' ? 2 : 3)
})

it.each(['count', 'bytes'] as const)('keeps library selection %s limits actionable without moving controls or losing focus', async (limit) => {
  const now = '2026-11-13T01:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: 'Selection library', description: 'Limit fixtures',
    scope: 'PERSONAL', ownerId: 'employee-fixture', managerEmployeeId: 'employee-fixture', canManage: true,
    version: 1, createdAt: now, updatedAt: now }
  const files = Array.from({ length: limit === 'count' ? 21 : 3 }, (_, index) => ({
    id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`, libraryId: library.id, parentId: null,
    name: `Selection ${index}.md`, kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown',
    sizeBytes: limit === 'count' || index === 2 ? 1 : (index === 0 ? 60 : 40) * 1024 * 1024,
    favorite: false, version: 1, createdAt: now, updatedAt: now,
  }))
  let fileReads = 0
  const page = await boot(async (method, payload) => {
    switch (method) {
      case 'library.list': return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
      case 'library.get': return library
      case 'library.entries.list': {
        fileReads++
        const index = typeof payload === 'object' && payload !== null && 'page' in payload ? Number(payload.page) : 1
        return { data: files.slice((index - 1) * 20, index * 20), pageIndex: index, pageSize: 20,
          totalCount: files.length, totalPages: limit === 'count' ? 2 : 1 }
      }
      default: throw new Error(`Unexpected library selection method: ${method}`)
    }
  }, undefined, async (_home, scaffold) => {
    await seedSession(scaffold, await readFile(join(REPO_ROOT, 'snapshots/web/present-after-closing-reply/session.v4.jsonl'), 'utf8'),
      `library-selection-${limit}`)
  })
  await page.locator('[role="treeitem"]').first().click()
  await page.locator('[role="treeitem"]').nth(1).click()
  await page.getByText('REPORT_READY', { exact: true }).waitFor()
  await waitForInitialComposer(page)
  await page.getByRole('button', { name: 'Libraries', exact: true }).waitFor()
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.fill('Keep the selection draft.')
  const composerNode = await composer.elementHandle()
  await page.getByRole('button', { name: 'Add files or run commands', exact: true }).click()
  await page.getByRole('option', { name: /Choose library files/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Choose library files', exact: true })
  await dialog.getByRole('button', { name: /Selection library Limit fixtures/ }).click()
  const row = (index: number) => dialog.getByRole('button', {
    name: `${files[index]!.name} ${Math.ceil(files[index]!.sizeBytes / 1024)} KB`, exact: true,
  }).locator('..')
  const chosen = files.length - 1
  for (let index = 0; index < chosen; index++) await row(index).getByRole('button', { name: 'Choose', exact: true }).click()
  const search = dialog.getByRole('searchbox')
  await search.fill('Selection')
  const refresh = dialog.getByRole('button', { name: 'Refresh', exact: true })
  await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('false')
  if (limit === 'count') await dialog.getByRole('button', { name: 'Next', exact: true }).click()
  const toggle = row(chosen).getByRole('button', { name: 'Choose', exact: true })
  await toggle.waitFor()
  await page.setViewportSize({ width: 390, height: 560 })
  await search.focus()
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
  const scroller = dialog.locator('[class*="detailModalContent"] > div:last-child')
  await scroller.evaluate((node) => { node.scrollTop = 40 })
  await toggle.focus()
  const scroll = await scroller.evaluate(node => node.scrollTop)
  expect(scroll).toBeGreaterThan(0)
  const searchNode = await search.elementHandle(), toggleNode = await toggle.elementHandle()
  const add = dialog.getByRole('button', { name: `Add ${chosen} files`, exact: true })
  const addNode = await add.elementHandle(), dialogBounds = await dialog.boundingBox(), addBounds = await add.boundingBox()
  await toggle.press('Enter')
  const notice = dialog.getByRole('alert')
  await notice.waitFor()
  expect(await notice.textContent()).toBe(limit === 'count' ? 'Select up to 20 files at a time.' : 'Selected files must total 100 MB or less.')
  expect(await toggle.getAttribute('aria-pressed')).toBe('false')
  expect(await toggle.evaluate((node, original) => node === original && node === document.activeElement, toggleNode)).toBe(true)
  expect(await dialog.boundingBox()).toEqual(dialogBounds)
  expect(await add.boundingBox()).toEqual(addBounds)
  expect(await scroller.evaluate(node => node.scrollTop)).toBe(scroll)
  const noticeNode = await notice.elementHandle(), reads = fileReads
  await toggle.press('Enter')
  expect(fileReads).toBe(reads)
  expect(await notice.evaluate((node, original) => node === original, noticeNode)).toBe(true)
  expect(await scroller.evaluate(node => node.scrollTop)).toBe(scroll)
  await refresh.click()
  await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('false')
  expect(await notice.evaluate((node, original) => node === original, noticeNode)).toBe(true)
  expect(await search.evaluate((node, original) => ({ same: node === original,
    value: node instanceof HTMLInputElement ? node.value : null,
    selection: node instanceof HTMLInputElement ? [node.selectionStart, node.selectionEnd] : null,
  }), searchNode)).toEqual({ same: true, value: 'Selection', selection: [1, 4] })
  expect(await add.evaluate((node, original) => node === original, addNode)).toBe(true)
  await toggle.focus()
  await capture(page, `library-selection-${limit}`, dialog, toggle)
  if (limit === 'count') await dialog.getByRole('button', { name: 'Previous', exact: true }).click()
  await row(0).getByRole('button', { name: 'Selected', exact: true }).click()
  await expect.poll(() => notice.count()).toBe(0)
  if (limit === 'count') await dialog.getByRole('button', { name: 'Next', exact: true }).click()
  await row(chosen).getByRole('button', { name: 'Choose', exact: true }).click()
  expect(await row(chosen).getByRole('button', { name: 'Selected', exact: true }).getAttribute('aria-pressed')).toBe('true')
  expect(await add.evaluate((node, original) => node === original, addNode)).toBe(true)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  expect(await composer.evaluate((node, original) => node === original && node.textContent === 'Keep the selection draft.', composerNode)).toBe(true)
})

it.each((['light', 'dark'] as const).flatMap(theme => (['button', 'escape'] as const).map(dismissal => ({ theme, dismissal }))))(
  'retains the connector draft viewport and selection after keeping a long edit ($theme, $dismissal)', async ({ theme, dismissal }) => {
    const page = await boot(async (method) => {
      if (method === 'connectors.list') return []
      throw new Error(`Unexpected draft viewport method: ${method}`)
    })
    await page.emulateMedia({ colorScheme: theme })
    await page.getByRole('button', { name: 'Connectors', exact: true }).click()
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await page.setViewportSize({ width: theme === 'dark' ? 390 : 1440, height: theme === 'dark' ? 560 : 900 })
    for (let index = 1; index < 8; index++) await dialog.getByRole('button', { name: 'Add variable', exact: true }).click()
    const field = dialog.getByRole('textbox', { name: 'Key 8', exact: true })
    await field.fill('RETAIN_SELECTION')
    await field.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(2, 8) })
    const original = await field.elementHandle()
    const viewport = await field.evaluateHandle((node) => {
      for (let element = node.parentElement; element; element = element.parentElement) {
        if (['auto', 'scroll'].includes(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight) return element
      }
      throw new Error('Missing scrollable connector editor')
    })
    const scroll = await viewport.evaluate(node => node.scrollTop)
    const bounds = await field.boundingBox()
    expect(scroll).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    if (dismissal === 'button') await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click()
    else await page.keyboard.press('Escape')
    expect(await field.evaluate((node, previous) => node === previous && node === document.activeElement, original)).toBe(true)
    expect(await field.evaluate(node => node instanceof HTMLInputElement ? [node.selectionStart, node.selectionEnd] : [])).toEqual([2, 8])
    expect(await viewport.evaluate(node => node.scrollTop)).toBe(scroll)
    expect(await field.boundingBox()).toEqual(bounds)
    const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-control-focus')
    await mkdir(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, `connector-draft-${theme}-${dismissal}.png`), animations: 'disabled' })
  },
)

it.each([
  ...(['tool', 'more', 'search', 'close'] as const).map(focus => ({ outcome: 'reduced' as const, focus })),
  ...(['tool', 'search', 'close'] as const).map(focus => ({ outcome: 'empty' as const, focus })),
  { outcome: 'failed' as const, focus: 'tool' as const },
])('keeps connector tool browsing focus after a $outcome refresh (focus=$focus)', async ({ outcome, focus }) => {
  const response = Promise.withResolvers<undefined>()
  onTestFinished(() => { response.resolve(undefined) })
  const tools = Array.from({ length: 21 }, (_, index) => ({ name: `order.get_${index}`, displayName: `Read order ${index}`,
    description: `Read order capability ${index}`, access: 'READ' }))
  const entry = { id: 'tools-focus', version: '1.0.0', name: 'Tools focus connector', visibility: 'COMPANY',
    reviewStatus: 'PUBLISHED', authMode: 'oauth', authorizationStatus: 'AUTHORIZED', tools }
  let reads = 0
  let writes = 0
  const page = await boot(async (method) => {
    switch (method) {
      case 'connectors.list':
        if (++reads === 1) return [entry]
        if (reads === 3 && outcome === 'empty') return [entry]
        if (reads !== 2) throw new Error('Duplicate tool refresh')
        await response.promise
        return outcome === 'failed'
          ? { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture tool refresh failure', retryable: true, resources: [] } }
          : [{ ...entry, authorizationStatus: 'REQUIRED', tools: outcome === 'empty' ? [] : tools.slice(0, 2) }]
      case 'connectors.authorization.revoke': writes++; return { connectorId: entry.id, status: 'REQUIRED' }
      case 'connectors.authorization.begin': writes++; return { connectorId: entry.id, status: 'PENDING', authorizationUrl: 'https://example.test/oauth' }
      case 'connectors.authorization.status': return { connectorId: entry.id, status: 'AUTHORIZED' }
      default: throw new Error(`Unexpected tools focus method: ${method}`)
    }
  })
  await page.getByRole('button', { name: 'Connectors', exact: true }).click()
  await page.getByRole('button', { name: entry.name, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connector details', exact: true })
  const disclosure = dialog.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'View capabilities (21)' }) }).first()
  await dialog.locator('summary').filter({ hasText: 'View capabilities (21)' }).click()
  const input = dialog.getByRole('searchbox', { name: 'Search capabilities', exact: true })
  await input.fill('order')
  await input.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
  const originalInput = await input.elementHandle(), originalDisclosure = await disclosure.elementHandle()
  await dialog.getByRole('combobox', { name: 'Capability type', exact: true }).selectOption('READ')
  const first = dialog.locator('summary').filter({ has: page.getByText('Read order 0', { exact: true }) })
  await first.click()
  const originalFirst = await first.elementHandle()
  if (outcome === 'empty') await dialog.getByRole('button', { name: 'Show more (20 / 21 shown)', exact: true }).click()
  await dialog.getByRole('button', { name: 'Disconnect account', exact: true }).click()
  await expect.poll(() => reads).toBe(2)
  const source = focus === 'tool' ? dialog.locator('summary').filter({ has: page.getByText('Read order 19', { exact: true }) })
    : focus === 'more' ? dialog.getByRole('button', { name: 'Show more (20 / 21 shown)', exact: true })
      : focus === 'search' ? input : dialog.getByRole('button', { name: 'Close', exact: true })
  await source.focus()
  response.resolve(undefined)
  if (outcome === 'failed') await dialog.getByRole('alert').waitFor()
  else await dialog.getByRole('button', { name: 'Connect account', exact: true }).waitFor()
  const target = outcome === 'failed' ? dialog.getByRole('button', { name: 'Refresh', exact: true })
    : focus === 'close' ? source
      : outcome === 'empty' ? dialog.getByRole('heading', { name: 'Business capabilities', exact: true }) : input
  await expect.poll(() => target.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
  if (outcome === 'reduced') {
    expect(await input.inputValue()).toBe('order')
    expect(await dialog.getByRole('combobox', { name: 'Capability type', exact: true }).inputValue()).toBe('READ')
    expect(await first.evaluate((node, original) => node === original
      && node.parentElement instanceof HTMLDetailsElement && node.parentElement.open, originalFirst)).toBe(true)
  }
  expect(reads).toBe(2)
  expect(writes).toBe(1)
  if (focus === 'tool') await capture(page, `connector-tools-${outcome}`, dialog, target)
  if (outcome === 'empty') {
    expect(await originalInput?.evaluate(node => node.isConnected && node.closest('[hidden]') !== null)).toBe(true)
    expect(await originalDisclosure?.evaluate(node => node.isConnected && node instanceof HTMLDetailsElement && node.open)).toBe(true)
    await dialog.getByRole('button', { name: 'Connect account', exact: true }).press('Enter')
    const authorized = dialog.getByRole('button', { name: 'Disconnect account', exact: true })
    await expect.poll(() => reads).toBe(3)
    await expect.poll(() => authorized.getAttribute('aria-disabled')).toBe('false')
    await expect.poll(() => authorized.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    expect(await input.evaluate((node, previous) => node === previous, originalInput)).toBe(true)
    expect(await disclosure.evaluate((node, previous) => node === previous
      && node instanceof HTMLDetailsElement && node.open, originalDisclosure)).toBe(true)
    expect(await input.inputValue()).toBe('order')
    expect(await input.evaluate(node => node instanceof HTMLInputElement && [node.selectionStart, node.selectionEnd])).toEqual([1, 3])
    expect(await dialog.getByRole('combobox', { name: 'Capability type', exact: true }).inputValue()).toBe('READ')
    expect(await dialog.getByRole('listitem').count()).toBe(21)
    expect(writes).toBe(2)
    if (focus === 'tool') await capture(page, 'connector-tools-restored', dialog, authorized)
  }
})

it.each((['oauth', 'device'] as const).flatMap(mode => [false, true].map(elsewhere => ({ mode, elsewhere }))))(
  'recovers connector $mode detail refresh focus after confirmation (elsewhere=$elsewhere)', async ({ mode, elsewhere }) => {
    const response = Promise.withResolvers<undefined>()
    onTestFinished(() => { response.resolve(undefined) })
    const entry = { id: 'refresh-focus', version: '1.0.0', name: 'Refresh focus connector', visibility: 'COMPANY',
      reviewStatus: 'PUBLISHED', canConfigure: true, authMode: mode === 'oauth' ? 'oauth' : 'none',
      authorizationStatus: 'AUTHORIZED', tools: [{ name: 'order.get', displayName: 'Read order', access: 'READ' }] }
    let reads = 0
    let writes = 0
    const page = await boot(async (method) => {
      switch (method) {
        case 'connectors.list':
          if (++reads === 2) return { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture refresh failure', retryable: true, resources: [] } }
          if (reads === 3) await response.promise
          if (reads > 3) throw new Error('Duplicate detail refresh')
          return [{ ...entry, authorizationStatus: writes ? 'REQUIRED' : 'AUTHORIZED' }]
        case 'connectors.authorization.revoke': writes++; return { connectorId: entry.id, status: 'REQUIRED' }
        case 'extensions.connector.configuration.read': return { id: entry.id, version: entry.version, transport: 'streamable-http',
          url: 'https://example.test/mcp', arguments: [], headers: ['Authorization'], environment: [], configured: false, timeoutSeconds: 60 }
        case 'extensions.connector.configuration.save': writes++; return { id: entry.id, version: entry.version, configured: true }
        default: throw new Error(`Unexpected connector refresh method: ${method}`)
      }
    })
    await page.getByRole('button', { name: 'Connectors', exact: true }).click()
    await page.getByRole('button', { name: entry.name, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Connector details', exact: true })
    if (mode === 'oauth') await dialog.getByRole('button', { name: 'Disconnect account', exact: true }).press('Enter')
    else {
      await dialog.getByRole('button', { name: 'Configure this device', exact: true }).click()
      const configuration = page.getByRole('dialog', { name: 'Configure this device', exact: true })
      await configuration.getByLabel('Authorization', { exact: true }).fill('synthetic-fixture')
      await configuration.getByRole('button', { name: 'Save connector', exact: true }).press('Enter')
      await configuration.waitFor({ state: 'hidden' })
    }
    await dialog.getByRole('alert').waitFor()
    const retry = dialog.getByRole('button', { name: 'Refresh', exact: true })
    const original = await retry.elementHandle()
    await retry.press('Enter')
    await expect.poll(() => reads).toBe(3)
    expect(await retry.evaluate((node, prior) => node === prior && node === globalThis.document.activeElement, original)).toBe(true)
    await page.keyboard.press('Enter')
    expect(reads).toBe(3)
    const close = dialog.getByRole('button', { name: 'Close', exact: true })
    if (elsewhere) await close.focus()
    response.resolve(undefined)
    await dialog.getByRole('heading', { name: 'Business capabilities', exact: true }).waitFor()
    const target = elsewhere ? close : dialog.getByRole('button', { name: mode === 'oauth' ? 'Connect account' : 'Configure this device', exact: true })
    await expect.poll(() => target.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    expect(await retry.count()).toBe(0)
    expect(writes).toBe(1)
    if (!elsewhere) await capture(page, `connector-refresh-${mode}`, dialog, target)
  },
)

it.each((['prepare', 'inspect', 'submit'] as const).flatMap(stage => [false, true].map(elsewhere => ({ stage, elsewhere }))))(
  'hands off submission focus after $stage completes (elsewhere=$elsewhere)', async ({ stage, elsewhere }) => {
    const response = Promise.withResolvers<undefined>()
    onTestFinished(() => { response.resolve(undefined) })
    const failure = { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture submission failure', retryable: true, resources: [] } }
    let inspections = 0
    let submissions = 0
    const page = await boot(async (method) => {
      if (method === 'content.submissions.inspect') {
        inspections++
        if (stage === 'submit') return { status: null }
        if (stage === 'inspect' && inspections === 1) return failure
        await response.promise
        return { status: { status: 'PUBLISHED', reviewNote: '' } }
      }
      if (method === 'content.submissions.submit') {
        submissions++
        await response.promise
        return { status: 'SUBMITTED', reviewNote: '' }
      }
      throw new Error(`Unexpected submission focus method: ${method}`)
    })
    await page.getByRole('button', { name: 'Skills', exact: true }).waitFor()
    await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
    await page.evaluate((failPreparation) => {
      let preparations = 0
      document.dispatchEvent(new CustomEvent('dsh:company-content-submit', { cancelable: true, detail: {
        name: 'Focus skill', prepare: async () => {
          if (failPreparation && ++preparations === 1) throw new Error('Fixture preparation failure')
          return { resourceKey: 'skills/focus', files: { 'skills/focus/SKILL.md': 'ZmlsZQ==' } }
        },
      } }))
    }, stage === 'prepare')
    const dialog = page.locator('[role="dialog"][aria-modal="true"]')
    if (stage === 'submit') await dialog.getByText('1 files included', { exact: true }).waitFor()
    else await dialog.getByRole('alert').waitFor()
    const primary = dialog.getByRole('button', { name: stage === 'submit' ? 'Submit for publication' : 'Retry', exact: true })
    const original = await primary.elementHandle()
    const close = dialog.getByRole('button', { name: 'Close', exact: true }).last()
    await primary.press('Enter')
    const pending = dialog.getByRole('button', { name: stage === 'submit' ? 'Working…' : 'Retry', exact: true })
    expect(await pending.evaluate((node, previous) => node === previous, original)).toBe(true)
    expect(await pending.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    expect(await pending.getAttribute('aria-disabled')).toBe('true')
    await page.keyboard.press('Enter')
    if (elsewhere) await dialog.getByRole('button', { name: 'Close', exact: true }).first().focus()
    response.resolve(undefined)
    await dialog.getByRole('status').waitFor()
    const completed = dialog.getByRole('button', { name: 'Submit for publication', exact: true })
    expect(await completed.evaluate(node => node instanceof HTMLButtonElement && node.disabled)).toBe(true)
    const focused = elsewhere ? dialog.getByRole('button', { name: 'Close', exact: true }).first() : close
    await expect.poll(() => focused.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    expect(submissions).toBe(stage === 'submit' ? 1 : 0)
    expect(inspections).toBe(stage === 'inspect' ? 2 : 1)
    if (!elsewhere && stage === 'submit') await capture(page, 'submission-complete', dialog, focused)
  },
)

it.each([
  ...(['card', 'details'] as const).flatMap(surface => (['removed', 'cleanup'] as const).flatMap(outcome =>
    [false, true].map(elsewhere => ({ surface, outcome, elsewhere, dismissal: 'close' as const })))),
  { surface: 'details' as const, outcome: 'cleanup' as const, elsewhere: false, dismissal: 'mask' as const },
  { surface: 'card' as const, outcome: 'cleanup' as const, elsewhere: false, dismissal: 'header' as const },
])(
  'recovers connector deletion from $surface ($outcome, elsewhere=$elsewhere, dismissal=$dismissal)', async ({ surface, outcome, elsewhere, dismissal }) => {
    const response = Promise.withResolvers<undefined>()
    onTestFinished(() => { response.resolve(undefined) })
    const entry = { id: 'delete-focus', version: '1.0.0', name: 'Receipt connector', visibility: 'PERSONAL',
      canEdit: true, canSubmit: true, canDelete: true, reviewStatus: 'DRAFT', authMode: 'none', tools: [] }
    let removed = false
    let writes = 0
    let reads = 0
    const page = await boot(async (method) => {
      switch (method) {
        case 'connectors.list': reads++; return removed ? [] : [entry]
        case 'extensions.connector.delete':
          if (++writes !== 1) throw new Error('Duplicate connector deletion')
          await response.promise
          removed = true
          return outcome === 'removed' ? { id: entry.id, removed: true } : { fixtureFailure: {
            code: 'CONNECTOR_DELETE_CLEANUP_FAILED', message: 'Synthetic cleanup failure', retryable: false,
            resources: [{ kind: 'connector', id: entry.id }],
          } }
        default: throw new Error(`Unexpected connector deletion method: ${method}`)
      }
    })
    await page.getByRole('button', { name: 'Connectors', exact: true }).click()
    const catalog = page.getByRole('region', { name: 'Connectors', exact: true })
    await catalog.getByRole('tab', { name: 'Mine', exact: true }).click()
    const search = catalog.getByRole('searchbox', { name: 'Search', exact: true })
    await search.fill('Receipt')
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
    const original = await search.elementHandle()
    if (surface === 'details') await catalog.getByRole('button', { name: entry.name, exact: true }).click()
    const area = surface === 'details' ? page.getByRole('dialog') : catalog
    await area.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `Delete “${entry.name}”?`, exact: true })
    const action = dialog.locator('button[aria-busy]')
    await action.press('Enter')
    await expect.poll(() => writes).toBe(1)
    await expect.poll(() => action.getAttribute('aria-busy')).toBe('true')
    expect(await action.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    const other = catalog.getByRole('tab', { name: 'Mine', exact: true })
    if (elsewhere) await other.focus()
    response.resolve(undefined)
    if (outcome === 'cleanup') {
      await dialog.getByRole('alert').waitFor()
      const close = dialog.getByRole('button', { name: 'Close', exact: true }).last()
      await expect.poll(() => (elsewhere ? other : close).evaluate(node => node === globalThis.document.activeElement)).toBe(true)
      if (elsewhere) await page.keyboard.press('Escape')
      else if (dismissal === 'mask') await page.locator('[role="presentation"] > [aria-hidden="true"]').last().click({ position: { x: 4, y: 4 } })
      else if (dismissal === 'header') await dialog.getByRole('button', { name: 'Close', exact: true }).first().click()
      else await close.press('Enter')
    }
    await dialog.waitFor({ state: 'hidden' })
    const focused = elsewhere ? other : search
    await expect.poll(() => focused.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    expect(await page.getByRole('dialog').count()).toBe(0)
    expect(await catalog.getByRole('button', { name: entry.name, exact: true }).count()).toBe(0)
    expect(await search.evaluate((node, previous) => node === previous, original)).toBe(true)
    expect(await search.inputValue()).toBe('Receipt')
    expect(await search.evaluate(node => node instanceof HTMLInputElement && [node.selectionStart, node.selectionEnd])).toEqual([1, 4])
    expect(writes).toBe(1)
    expect(reads).toBe(2)
    if (outcome === 'removed' && surface === 'card' && !elsewhere || dismissal === 'mask') {
      await capture(page, `connector-delete-${outcome}-${dismissal}`, catalog, focused)
    }
  },
)

it.each((['identity', 'retry', 'removed', 'failed'] as const)
  .flatMap(transition => [false, true].map(elsewhere => ({ transition, elsewhere }))))(
  'recovers connector catalog focus after $transition with elsewhere=$elsewhere', async ({ transition, elsewhere }) => {
    const response = Promise.withResolvers<undefined>()
    const identity = Promise.withResolvers<undefined>()
    onTestFinished(() => { response.resolve(undefined); identity.resolve(undefined) })
    const failure = { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture read failure', retryable: true, resources: [] } }
    let reads = 0
    let identityRetries = 0
    let allowIdentity = false
    const label = 'Connectors'
    const entry = { id: 'focus-entry', name: 'Focus entry', version: '1.0.0', visibility: 'COMPANY',
      reviewStatus: 'PUBLISHED', authMode: 'none', tools: [] }
    const page = await boot(async (method) => {
      if (method === 'connectors.refresh') return { connectedIds: [], unavailableIds: [] }
      if (method !== 'connectors.list') throw new Error(`Unexpected catalog focus method: ${method}`)
      if (++reads === 1 && transition !== 'identity') return transition === 'retry' ? failure : [entry]
      if (reads !== (transition === 'identity' ? 1 : 2)) throw new Error('Unexpected duplicate catalog read')
      await response.promise
      return transition === 'failed' ? failure : []
    }, async () => {
      if (transition === 'identity') {
        if (!allowIdentity) return failure
        identityRetries++
        await identity.promise
      }
      return { authenticated: true, employeeId: 'employee-fixture', displayName: 'Control reviewer' }
    })
    const navigation = page.getByRole('button', { name: label, exact: true })
    await navigation.click()
    const region = page.getByRole('region', { name: label, exact: true })
    const retrying = transition === 'identity' || transition === 'retry'
    const control = region.getByRole('button', { name: retrying ? 'Retry' : 'Refresh', exact: true })
    const card = region.getByRole('button', { name: entry.name, exact: true })
    if (retrying) await region.getByRole('alert').waitFor()
    else await card.waitFor()
    const original = await control.elementHandle()
    const box = await control.boundingBox()
    allowIdentity = true
    await control.press('Enter')
    await expect.poll(() => transition === 'identity' ? identityRetries : reads).toBe(transition === 'identity' ? 1 : 2)
    expect(await control.getAttribute('aria-disabled')).toBe('true')
    expect(await control.evaluate(node => node instanceof HTMLButtonElement && node.disabled)).toBe(false)
    expect(await control.boundingBox()).toEqual(box)
    expect(await control.evaluate((node, previous) => node === previous, original)).toBe(true)
    await page.keyboard.press('Enter')
    expect(transition === 'identity' ? identityRetries : reads).toBe(transition === 'identity' ? 1 : 2)
    if (!retrying) await card.focus()
    const other = transition === 'identity' ? navigation : region.getByRole('searchbox')
    if (elsewhere) await other.focus()
    identity.resolve(undefined)
    if (transition === 'identity') {
      await expect.poll(() => reads).toBe(1)
      await expect.poll(() => (elsewhere ? other : region).evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    }
    response.resolve(undefined)
    if (transition === 'failed') await region.getByRole('alert').waitFor()
    else await region.getByText('No connectors in the marketplace yet. Personal connectors appear here after publication is approved.', { exact: true }).waitFor()
    const focused = elsewhere ? other : region
    await expect.poll(() => focused.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    expect(await card.count()).toBe(0)
    if (!elsewhere && transition !== 'failed') await capture(page, `connector-catalog-focus-${transition}`, region, focused)
  },
)

it.each([
  { mode: 'edit', elsewhere: false }, { mode: 'device', elsewhere: false }, { mode: 'provider', elsewhere: false },
  { mode: 'edit', elsewhere: true }, { mode: 'device', elsewhere: true }, { mode: 'provider', elsewhere: true },
] as const)('recovers connector $mode read focus after retry (elsewhere: $elsewhere)', async ({ mode, elsewhere }) => {
  const response = Promise.withResolvers<undefined>()
  onTestFinished(() => { response.resolve(undefined) })
  const connector = { id: 'focus-connector', version: '1.0.0', name: 'Focus connector', tools: [],
    visibility: mode === 'device' ? 'COMPANY' : 'PERSONAL', canEdit: true, canConfigure: true,
    reviewStatus: mode === 'device' ? 'PUBLISHED' : 'DRAFT', status: 'needs-configuration', authMode: 'none' }
  const provider = { id: 'company-oauth', version: '1.0.0', name: 'Company OAuth', authMode: 'oauth', visibility: 'COMPANY', tools: [] }
  let reads = 0, catalogs = 0
  const read = async () => {
    if (++reads === 1) return { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture read failure', retryable: true, resources: [] } }
    if (reads !== 2) throw new Error('Unexpected duplicate connector read')
    await response.promise
    return mode === 'provider' ? [provider] : mode === 'device' ? { id: connector.id, version: connector.version,
      transport: 'streamable-http', url: 'https://example.test/mcp', arguments: [], headers: ['Authorization'],
      environment: [], configured: false, timeoutSeconds: 60 }
      : { draft: { kind: 'connector', id: connector.id, version: '1.0.1', name: connector.name, summary: 'Fixture connector',
        category: 'other', transport: 'streamable-http', url: 'https://example.test/mcp' }, configured: true, savePending: false }
  }
  const page = await boot(async (method) => {
    if (method === 'connectors.list') return mode === 'provider' ? ++catalogs === 1 ? [] : read() : [connector]
    if (method === 'extensions.connector.read' || method === 'extensions.connector.configuration.read') return read()
    throw new Error(`Unexpected connector recovery method: ${method}`)
  })
  await page.getByRole('button', { name: 'Connectors', exact: true }).click()
  if (mode === 'edit') {
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Modify', exact: true }).click()
  } else if (mode === 'device') {
    await page.getByText(connector.name, { exact: true }).click()
    await page.getByRole('button', { name: 'Configure this device', exact: true }).click()
  } else {
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByLabel('Server type', { exact: true }).selectOption('streamable-http')
  }
  const dialog = page.getByRole('dialog').last()
  const retry = dialog.getByRole('button', { name: 'Retry', exact: true })
  await retry.waitFor()
  const original = await retry.elementHandle()
  // Focusing a clipped control can scroll it into view before the request starts.
  await retry.focus()
  expect(await controlIsUnclipped(retry)).toBe(true)
  const bounds = await retry.boundingBox()
  await retry.press('Enter')
  await expect.poll(() => reads).toBe(2)
  expect(await retry.evaluate((node, prior) => node === prior && node === globalThis.document.activeElement, original)).toBe(true)
  expect(await retry.boundingBox()).toEqual(bounds)
  await page.keyboard.press('Enter')
  expect(reads).toBe(2)
  const other = dialog.getByRole('button', { name: 'Close', exact: true })
  if (elsewhere) await other.focus()
  response.resolve(undefined)
  await retry.waitFor({ state: 'hidden' })
  const target = elsewhere ? other : dialog.getByLabel(mode === 'device' ? 'Timeout' : 'Server type', { exact: true })
  await expect.poll(() => target.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
  expect(await dialog.getByRole('alert').count()).toBe(0)
  expect(reads).toBe(2)
  await capture(page, `connector-read-${mode}-${elsewhere ? 'elsewhere' : 'recovered'}`, dialog, target)
})

it.each(['prepare', 'inspect', 'submit'] as const)('keeps company %s publication focused through waiting and retry', async (stage) => {
  const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
  onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }) })
  const method = stage === 'prepare' ? 'fixture.content.prepare' : `content.submissions.${stage}`
  const failure = { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture publication failure', retryable: true, resources: [] } }
  let requests = 0
  const page = await boot(async (requested) => {
    if (requested === method) {
      const attempt = requests++
      if (stage !== 'submit' && attempt === 0) return failure
      const gate = gates[attempt - (stage === 'submit' ? 0 : 1)]
      if (!gate) throw new Error('Unexpected duplicate publication')
      await gate.promise
      return failure
    }
    if (requested === 'content.submissions.inspect') return { status: null }
    throw new Error(`Unexpected publication method: ${requested}`)
  })
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.fill('Retain the conversation draft.')
  await page.evaluate((stage) => {
    const api = globalThis as typeof globalThis & { __controlInvoke(method: string): Promise<unknown> }
    document.dispatchEvent(new CustomEvent('dsh:company-content-submit', { cancelable: true, detail: {
      name: 'Focus publication', prepare: async () => {
        if (stage === 'prepare') {
          const result = await api.__controlInvoke('fixture.content.prepare')
          if (typeof result === 'object' && result !== null && 'fixtureFailure' in result) throw new Error('Fixture content read failure')
        }
        return { resourceKey: 'skills/focus-publication', files: { 'skills/focus-publication/SKILL.md': 'ZmlsZQ==' } }
      },
    } }))
  }, stage)
  const dialog = page.getByRole('dialog', { name: 'Submit for publication', exact: true })
  const action = dialog.getByRole('button', { name: stage === 'submit' ? 'Submit for publication' : 'Retry', exact: true })
  await action.waitFor()
  const button = await action.elementHandle()
  let notice = stage === 'submit' ? null : await dialog.getByRole('alert').elementHandle()
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = dialog.locator('button[aria-busy]')
    if (attempt === 1) {
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.setViewportSize({ width: 390, height: 560 })
    }
    const bounds = await current.boundingBox()
    await current.press('Enter')
    const expected = attempt + (stage === 'submit' ? 1 : 2)
    await expect.poll(() => requests).toBe(expected)
    expect(await current.boundingBox()).toEqual(bounds)
    expect(await current.evaluate((node, original) => node === original && node === globalThis.document.activeElement, button)).toBe(true)
    expect(await current.getAttribute('aria-disabled')).toBe('true')
    await page.keyboard.press('Enter')
    await page.keyboard.press(' ')
    expect(requests).toBe(expected)
    if (notice) expect(await dialog.getByRole('alert').evaluate((node, original) => node === original, notice)).toBe(true)
    if (stage === 'submit') {
      await dialog.getByRole('button', { name: 'Close', exact: true }).last().dispatchEvent('click')
      await page.keyboard.press('Escape')
      expect(await dialog.isVisible()).toBe(true)
    }
    if (attempt === 1) await capture(page, `company-publication-${stage}`, dialog, current)
    gates[attempt]!.resolve(undefined)
    await expect.poll(() => current.getAttribute('aria-busy')).toBe('false')
    expect(await current.evaluate((node, original) => ({
      retained: node === original, focused: node === globalThis.document.activeElement,
    }), button))
      .toEqual({ retained: true, focused: true })
    notice = await dialog.getByRole('alert').elementHandle()
  }
  expect(await composer.textContent()).toBe('Retain the conversation draft.')
})

it.each((['delete', 'submit'] as const).flatMap(action => (['latin', 'chinese'] as const).map(language => ({ action, language }))))(
  'keeps a long connector $action confirmation readable through retry ($language)', async ({ action, language }) => {
    const name = (language === 'latin' ? 'OperationalReferenceConnector' : '订单处理与企业运营资料连接器').repeat(6).slice(0, 80)
    const entry = { id: 'long-confirmation', version: '1.0.0', name, visibility: 'PERSONAL', reviewStatus: 'DRAFT',
      canEdit: true, canDelete: true, canSubmit: true }
    const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }) })
    let writes = 0, completed = false
    const method = action === 'delete' ? 'extensions.connector.delete' : 'extensions.submit'
    const page = await boot(async (requested) => {
      if (requested === 'connectors.list') return completed ? action === 'delete' ? [] : [{ ...entry, canSubmit: false, reviewStatus: 'SUBMITTED' }] : [entry]
      if (requested === method) {
        const gate = gates[writes++]
        if (!gate) throw new Error('Unexpected duplicate confirmation write')
        await gate.promise
        if (writes === 1) return { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture confirmation failure', retryable: true, resources: [] } }
        completed = true
        return action === 'delete' ? { id: entry.id, removed: true } : { id: entry.id, version: entry.version, submitted: true }
      }
      throw new Error(`Unexpected long confirmation method: ${requested}`)
    })
    await page.emulateMedia({ colorScheme: language === 'latin' ? 'light' : 'dark' })
    await page.getByRole('button', { name: 'Connectors', exact: true }).click()
    const catalog = page.getByRole('region', { name: 'Connectors', exact: true })
    await catalog.getByRole('tab', { name: 'Mine', exact: true }).click()
    const search = catalog.getByRole('searchbox', { name: 'Search', exact: true })
    await search.fill(language === 'latin' ? 'Operational' : '订单')
    const input = await search.elementHandle()
    const trigger = catalog.getByRole('button', { name: 'More actions', exact: true })
    await trigger.click()
    await page.getByRole('menuitem', { name: action === 'delete' ? 'Delete' : 'Submit for publication', exact: true }).click()
    const dialog = page.getByRole('dialog').last()
    await page.setViewportSize({ width: 390, height: 560 })
    const title = dialog.getByRole('heading')
    const close = dialog.getByRole('button', { name: 'Close', exact: true })
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
    const submit = dialog.locator('button[aria-busy]').last()
    const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-control-focus')
    await mkdir(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, `connector-${action}-${language}-confirmation.png`), animations: 'disabled' })
    for (const control of [title, close, cancel, submit]) expect(await controlIsUnclipped(control)).toBe(true)
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    const button = await submit.elementHandle()
    await submit.press('Enter')
    await expect.poll(() => writes).toBe(1)
    gates[0]!.resolve(undefined)
    const notice = await dialog.getByRole('alert').elementHandle()
    for (const control of [title, close, cancel, submit]) expect(await controlIsUnclipped(control)).toBe(true)
    const titleBounds = await title.boundingBox(), submitBounds = await submit.boundingBox()
    await submit.press('Enter')
    await expect.poll(() => writes).toBe(2)
    expect(await title.boundingBox()).toEqual(titleBounds)
    expect(await submit.boundingBox()).toEqual(submitBounds)
    expect(await submit.evaluate((node, original) => node === original && node === document.activeElement, button)).toBe(true)
    expect(await dialog.getByRole('alert').evaluate((node, original) => node === original, notice)).toBe(true)
    await page.keyboard.press('Enter')
    await page.keyboard.press(' ')
    await page.keyboard.press('Escape')
    expect(writes).toBe(2)
    expect(await dialog.isVisible()).toBe(true)
    await capture(page, `connector-${action}-${language}-confirmation-retry`, dialog, submit)
    gates[1]!.resolve(undefined)
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => (action === 'delete' ? search : trigger).evaluate(node => node === document.activeElement)).toBe(true)
    expect(await search.evaluate((node, original) => node === original, input)).toBe(true)
  },
)

it.each(['light', 'dark'] as const)('keeps long publication review readable with reachable actions (%s)', async (theme) => {
  const reviewNote = '请补充参考资料并核对模板中的字段说明，确保每一步均可独立验证。'.repeat(60)
  const name = 'PublicationReview'.repeat(5)
  const page = await boot(async (method) => {
    if (method === 'content.submissions.inspect') return { status: { status: 'REJECTED', reviewNote } }
    throw new Error(`Unexpected long publication method: ${method}`)
  })
  await page.emulateMedia({ colorScheme: theme })
  await page.setViewportSize({ width: 390, height: 560 })
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.fill('Retain the publication draft.')
  await composer.focus()
  await page.evaluate((name) => {
    document.dispatchEvent(new CustomEvent('dsh:company-content-submit', { cancelable: true, detail: {
      name, prepare: async () => ({ resourceKey: 'skills/review', files: { 'skills/review/SKILL.md': 'ZmlsZQ==' } }),
    } }))
  }, name)
  const dialog = page.getByRole('dialog', { name: 'Submit for publication', exact: true })
  const note = dialog.getByText(reviewNote, { exact: true })
  await note.waitFor()
  const title = dialog.getByRole('heading', { name: 'Submit for publication', exact: true })
  const close = dialog.getByRole('button', { name: 'Close', exact: true })
  const action = dialog.getByRole('button', { name: 'Submit for publication', exact: true })
  const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-control-focus')
  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ path: join(screenshots, `long-publication-review-${theme}.png`), animations: 'disabled' })
  expect(await controlIsUnclipped(title)).toBe(true)
  expect(await controlIsUnclipped(close.first())).toBe(true)
  expect(await controlIsUnclipped(close.last())).toBe(true)
  expect(await controlIsUnclipped(action)).toBe(true)
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  const scroller = await note.evaluateHandle((node) => {
    for (let element = node.parentElement; element; element = element.parentElement) {
      if (['auto', 'scroll'].includes(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight) return element
    }
    throw new Error('Missing scrollable publication review')
  })
  const titleBounds = await title.boundingBox(), closeBounds = await close.last().boundingBox()
  const originalNote = await note.elementHandle()
  await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight - node.clientHeight })
  expect(await scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
  expect(await title.boundingBox()).toEqual(titleBounds)
  expect(await close.last().boundingBox()).toEqual(closeBounds)
  expect(await controlIsUnclipped(note)).toBe(false)
  await close.last().focus()
  await capture(page, 'publication-review', dialog, close.last())
  expect(await note.evaluate((node, original) => node === original, originalNote)).toBe(true)
  await close.last().press('Enter')
  await dialog.waitFor({ state: 'hidden' })
  expect(await composer.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await composer.textContent()).toBe('Retain the publication draft.')
})

it.each(['stdio', 'streamable-http'] as const)('keeps %s configuration focus beside removed rows and inside new rows', async (transport) => {
  const page = await boot(async () => [])
  await page.getByRole('button', { name: 'Connectors', exact: true }).click()
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add MCP server', exact: true })
  if (transport === 'streamable-http') await dialog.getByLabel('Server type', { exact: true }).selectOption(transport)
  const section = dialog.getByRole('region', { name: transport === 'stdio' ? 'Environment variables' : 'Private headers' })
  const add = section.getByRole('button', { name: transport === 'stdio' ? 'Add variable' : 'Add entry', exact: true })
  for (let index = transport === 'stdio' ? 2 : 1; index <= 3; index++) {
    await add.press('Enter')
    const field = section.getByRole('textbox', { name: `Key ${index}`, exact: true })
    expect(await field.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
  }
  await section.getByRole('textbox', { name: 'Key 1', exact: true }).fill('FIRST')
  await section.getByRole('textbox', { name: 'Key 3', exact: true }).fill('LAST')
  const retained = await section.getByRole('textbox', { name: 'Key 3', exact: true }).elementHandle()
  for (const index of [2, 2, 1]) {
    await section.getByRole('button', { name: `Remove ${index}`, exact: true }).press('Enter')
    const count = await section.getByRole('textbox', { name: /^Key \d+$/ }).count()
    const target = count ? section.getByRole('textbox', { name: `Key ${count}`, exact: true }) : add
    expect(await target.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    if (index === 2 && count === 2) {
      expect(await target.evaluate((node, original) => node === original, retained)).toBe(true)
      await capture(page, `connector-${transport}`, dialog, target)
    }
  }
})

it.each((['stdio', 'streamable-http'] as const).flatMap(transport =>
  (['append', 'update', 'empty'] as const).map(action => ({ transport, action })),
))('keeps $transport inputs focused after clipboard $action failure and retry', async ({ transport, action }) => {
  const caseChange = transport === 'streamable-http' && action === 'update'
  const gates = Array.from({ length: caseChange ? 4 : 2 }, () => Promise.withResolvers<undefined>())
  onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }) })
  const page = await boot(async () => [])
  let reads = 0
  await page.exposeFunction('__readConfiguration', async () => {
    const index = reads++, gate = gates[index]
    if (!gate) throw new Error('Unexpected clipboard read')
    await gate.promise
    if (index === 0) throw new Error('Clipboard temporarily unavailable')
    if (index === 2) return 'retained_key=first\nRETAINED_KEY=second'
    if (index === 3) return 'retained_key=corrected-value'
    return action === 'update' ? `${caseChange ? 'retained_key' : 'RETAINED_KEY'}=updated-value` : 'NEW_KEY=new-value'
  })
  await page.evaluate(() => {
    const bridge = globalThis as typeof globalThis & { __readConfiguration(): Promise<string> }
    Object.defineProperty(navigator, 'clipboard', { value: { readText: () => bridge.__readConfiguration() } })
  })
  await page.getByRole('button', { name: 'Connectors', exact: true }).click()
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add MCP server', exact: true })
  if (transport === 'streamable-http') {
    await dialog.getByLabel('Server type', { exact: true }).selectOption(transport)
    await dialog.getByRole('button', { name: 'Add entry', exact: true }).click()
  }
  const section = dialog.getByRole('region', { name: transport === 'stdio' ? 'Environment variables' : 'Private headers' })
  const key = section.getByLabel('Key 1', { exact: true }), value = section.getByLabel('Value 1', { exact: true })
  const originalKey = await key.elementHandle(), originalValue = await value.elementHandle()
  if (action !== 'empty') {
    await key.fill('RETAINED_KEY')
    await value.fill('private-fixture-value')
  }
  const paste = section.getByRole('button', { name: 'Paste', exact: true })
  const focused = action === 'append' ? value : key
  for (let attempt = 0; attempt < 2; attempt++) {
    const notice = attempt === 1 ? await dialog.getByRole('alert').elementHandle() : null
    await paste.press('Enter')
    await expect.poll(() => reads).toBe(attempt + 1)
    await page.keyboard.press('Tab')
    if (action === 'append') await page.keyboard.press('Tab')
    expect(await focused.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    await focused.evaluate((node, empty) => {
      if (!(node instanceof HTMLInputElement)) throw new Error('Missing configuration input')
      node.setSelectionRange(empty ? 0 : 1, empty ? 0 : 4)
    }, action === 'empty')
    if (notice) expect(await dialog.getByRole('alert').evaluate((node, prior) => node === prior, notice)).toBe(true)
    gates[attempt]!.resolve(undefined)
    if (attempt === 0) await dialog.getByRole('alert').waitFor()
  }
  await expect.poll(() => dialog.getByRole('alert').count()).toBe(0)
  expect(await key.evaluate((node, original) => node === original, originalKey)).toBe(true)
  expect(await value.evaluate((node, original) => node === original, originalValue)).toBe(true)
  expect(await focused.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
  if (action !== 'empty') expect(await focused.evaluate(node => node instanceof HTMLInputElement
    ? [node.selectionStart, node.selectionEnd] : [])).toEqual([1, 4])
  expect(await key.inputValue()).toBe(action === 'empty' ? 'NEW_KEY' : 'RETAINED_KEY')
  expect(await value.inputValue()).toBe(action === 'append' ? 'private-fixture-value' : action === 'update' ? 'updated-value' : 'new-value')
  expect(await section.getByRole('textbox', { name: /^Key \d+$/ }).count()).toBe(action === 'append' ? 2 : 1)
  if (caseChange) {
    const beforeDuplicate = await dialog.boundingBox(), pasteNode = await paste.elementHandle()
    await paste.press('Enter')
    await expect.poll(() => reads).toBe(3)
    gates[2]!.resolve(undefined)
    await dialog.getByRole('alert').waitFor()
    expect(await value.inputValue()).toBe('updated-value')
    expect(await section.getByRole('textbox', { name: /^Key \d+$/ }).count()).toBe(1)
    expect(await dialog.boundingBox()).toEqual(beforeDuplicate)
    expect(await paste.evaluate(node => node === document.activeElement)).toBe(true)
    const notice = await dialog.getByRole('alert').elementHandle()
    await paste.press('Enter')
    await expect.poll(() => reads).toBe(4)
    expect(await dialog.getByRole('alert').evaluate((node, prior) => node === prior, notice)).toBe(true)
    gates[3]!.resolve(undefined)
    await expect.poll(() => dialog.getByRole('alert').count()).toBe(0)
    expect(await value.inputValue()).toBe('corrected-value')
    expect(await key.evaluate((node, original) => node === original, originalKey)).toBe(true)
    expect(await value.evaluate((node, original) => node === original, originalValue)).toBe(true)
    expect(await paste.evaluate((node, original) => node === original && node === document.activeElement, pasteNode)).toBe(true)
  }
  await capture(page, `clipboard-${transport}-${action}`, dialog, caseChange ? paste : focused)
})

it('returns to the feedback draft and caret after removing a screenshot', async () => {
  const page = await boot(async () => [])
  await page.getByRole('button', { name: 'Control reviewer', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Feedback', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Feedback', exact: true })
  const input = dialog.getByRole('textbox', { name: 'Message', exact: true })
  await input.fill('Retain the feedback draft.')
  const bytes = [...await page.screenshot()]
  await input.evaluate((element, data) => {
    const clipboardData = new DataTransfer()
    for (const name of ['first.png', 'middle.png', 'last.png']) clipboardData.items.add(new File([new Uint8Array(data)], name, { type: 'image/png' }))
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    if (element instanceof HTMLTextAreaElement) element.setSelectionRange(3, 6)
  }, bytes)
  await dialog.getByRole('img', { name: 'last.png', exact: true }).waitFor()
  for (const name of ['middle.png', 'last.png', 'first.png']) {
    await dialog.getByRole('button', { name: `Remove ${name}`, exact: true }).press('Enter')
    expect(await input.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    expect(await input.inputValue()).toBe('Retain the feedback draft.')
    expect(await input.evaluate(node => node instanceof HTMLTextAreaElement
      ? [node.selectionStart, node.selectionEnd] : [])).toEqual([3, 6])
    if (name === 'middle.png') await capture(page, 'feedback', dialog, input)
  }
})

it.each((['create', 'edit', 'device'] as const).flatMap(surface => [1440, 390].map(width => ({ surface, width }))))(
  'keeps connector $surface failure feedback from resizing the draft viewport ($width)', async ({ surface, width }) => {
    const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }) })
    const entry = { id: 'stable-connector', version: '1.0.0', name: 'Stable connector', visibility: surface === 'device' ? 'COMPANY' : 'PERSONAL',
      reviewStatus: surface === 'device' ? 'PUBLISHED' : 'DRAFT', canConfigure: true, canEdit: true, authMode: 'none', tools: [] }
    const draft = { id: entry.id, version: entry.version, name: entry.name, kind: 'connector', summary: 'Retained connector notes. '.repeat(10), category: 'other',
      transport: 'stdio', command: 'node', arguments: ['fixture.js'], headers: {}, environment: {}, timeoutSeconds: 60 }
    const method = surface === 'create' ? 'extensions.save' : surface === 'edit' ? 'extensions.connector.update' : 'extensions.connector.configuration.save'
    const requests: unknown[] = []
    const page = await boot(async (requested, payload) => {
      if (requested === method) {
        requests.push(payload)
        if (requests.length > 2) throw new Error('Duplicate connector save')
        await gates[requests.length - 1]!.promise
        if (requests.length === 1) return { fixtureFailure: { code: 'CONNECTOR_DISCOVERY_FAILED', message: 'Fixture connection failed', retryable: true, resources: [] } }
        if (surface === 'device') return { id: entry.id, version: entry.version, configured: true }
        if (typeof payload !== 'object' || payload === null) throw new Error('Missing connector draft')
        const saved = surface === 'edit' && 'draft' in payload ? payload.draft : payload
        if (typeof saved !== 'object' || saved === null || !('id' in saved) || !('version' in saved)) throw new Error('Missing connector identity')
        return { id: saved.id, version: saved.version, kind: 'connector', visibility: 'PERSONAL' }
      }
      switch (requested) {
        case 'connectors.list': return surface === 'create' ? [] : [entry]
        case 'extensions.connector.read': return { draft, configured: true, savePending: false }
        case 'extensions.connector.configuration.read': return { id: entry.id, version: entry.version,
          transport: 'stdio', command: draft.command, arguments: draft.arguments, headers: [], environment: ['API_KEY'], configured: false, timeoutSeconds: 60 }
        default: throw new Error(`Unexpected connector viewport request: ${requested}`)
      }
    })
    await page.emulateMedia({ colorScheme: surface === 'edit' ? 'light' : 'dark' })
    await page.getByRole('button', { name: 'Connectors', exact: true }).click()
    if (surface === 'create') await page.getByRole('button', { name: 'Add', exact: true }).click()
    else if (surface === 'edit') {
      await page.getByRole('tab', { name: 'Mine', exact: true }).click()
      await page.getByRole('button', { name: 'More actions', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Modify', exact: true }).click()
    } else {
      await page.getByRole('button', { name: entry.name, exact: true }).click()
      await page.getByRole('button', { name: 'Configure this device', exact: true }).click()
    }
    const dialog = page.getByRole('dialog', { name: surface === 'create' ? 'Add MCP server' : surface === 'edit' ? 'Edit connector' : 'Configure this device', exact: true })
    await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
    const field = dialog.getByLabel(surface === 'device' ? 'API_KEY' : 'Description', { exact: true })
    const text = surface === 'device' ? 'retained-synthetic-secret' : draft.summary
    if (surface === 'create') {
      await dialog.getByLabel('Server name', { exact: true }).fill(entry.name)
      await dialog.getByLabel('Command', { exact: true }).fill('node fixture.js')
    }
    await field.fill(text)
    await field.evaluate((node) => {
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
        node.setSelectionRange(2, 7)
        node.scrollTop = 20
      }
    })
    const originalField = await field.elementHandle()
    const selection = () => field.evaluate(node => (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)
    && [node.selectionStart, node.selectionEnd, node.scrollTop])
    const originalSelection = await selection()
    await dialog.getByRole('button', { name: surface === 'create' ? 'Add' : 'Save connector', exact: true }).waitFor()
    const action = dialog.locator('button[aria-busy]').last()
    const originalAction = await action.elementHandle()
    const footer = action.locator('..')
    const bounds = await action.boundingBox(), footerBounds = await footer.boundingBox(), dialogBounds = await dialog.boundingBox()
    const fieldBounds = await field.boundingBox()
    const geometry = () => Promise.all([dialog.boundingBox(), footer.boundingBox(), action.boundingBox(), field.boundingBox()])
    const initialGeometry = [dialogBounds, footerBounds, bounds, fieldBounds]
    const scrollState = () => field.evaluate((node) => {
      const positions = []
      for (let element: Element | null = node; element; element = element.parentElement) {
        positions.push([element.scrollTop, element.scrollLeft])
        if (element.getAttribute('role') === 'dialog') break
      }
      return positions
    })
    const initialScroll = await scrollState()
    const close = dialog.getByRole('button', { name: 'Close', exact: true }).first()
    const originalClose = await close.elementHandle()
    await action.press('Enter')
    await expect.poll(() => requests.length).toBe(1)
    await page.keyboard.press('Escape')
    await dialog.getByRole('status').filter({ hasText: 'Wait for the current operation to finish before closing.' }).waitFor()
    const blockedImages = join(REPO_ROOT, '.artifacts/deepseek-harness-control-focus')
    await mkdir(blockedImages, { recursive: true })
    await page.screenshot({ path: join(blockedImages, `connector-${surface}-${width}-blocked.png`), animations: 'disabled' })
    expect(await geometry()).toEqual(initialGeometry)
    expect(await scrollState()).toEqual(initialScroll)
    await footer.getByRole('status').filter({ hasText: 'Wait for the current operation to finish before closing.' }).waitFor()
    expect(await action.evaluate((node, original) => node === original && node === document.activeElement, originalAction)).toBe(true)
    await close.click()
    expect(await close.evaluate((node, original) => node === original && node === document.activeElement, originalClose)).toBe(true)
    expect(await geometry()).toEqual(initialGeometry)
    expect(await field.evaluate((node, original) => node === original, originalField)).toBe(true)
    expect(await selection()).toEqual(originalSelection)
    gates[0]!.resolve(undefined)
    const notice = dialog.getByRole('alert')
    await notice.waitFor()
    expect(await geometry()).toEqual(initialGeometry)
    expect(await scrollState()).toEqual(initialScroll)
    expect(await dialog.getByRole('status').count()).toBe(0)
    expect(await footer.boundingBox()).toEqual(footerBounds)
    expect(await action.boundingBox()).toEqual(bounds)
    expect(await dialog.boundingBox()).toEqual(dialogBounds)
    expect(await close.evaluate((node, original) => node === original && node === document.activeElement, originalClose)).toBe(true)
    expect(await field.evaluate((node, original) => node === original, originalField)).toBe(true)
    expect(await field.inputValue()).toBe(text)
    expect(await selection()).toEqual(originalSelection)
    const originalNotice = await notice.elementHandle()
    expect(await notice.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
    await action.press('Shift+Tab')
    expect(await notice.evaluate(node => node === document.activeElement)).toBe(true)
    await page.keyboard.press('End')
    await expect.poll(() => notice.evaluate(node => node.scrollTop > 0
    && Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 1)).toBe(true)
    await action.focus()
    await action.press('Enter')
    await expect.poll(() => requests.length).toBe(2)
    expect(await footer.boundingBox()).toEqual(footerBounds)
    expect(await notice.evaluate((node, original) => node === original, originalNotice)).toBe(true)
    await page.keyboard.press('Escape')
    expect(await geometry()).toEqual(initialGeometry)
    expect(await scrollState()).toEqual(initialScroll)
    expect(await notice.evaluate((node, original) => node === original, originalNotice)).toBe(true)
    await page.keyboard.press('Enter')
    await page.keyboard.press(' ')
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    await capture(page, `connector-${surface}-${width}-feedback`, dialog, action)
    gates[1]!.resolve(undefined)
    await dialog.waitFor({ state: 'hidden' })
  })

it.each(['feedback', 'connector', 'device', 'authorize', 'revoke', 'resource-delete', 'resource-submit'] as const)(
  'retains %s submission focus through a failed request and retry', async (surface) => {
    const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }) })
    const authorization = surface === 'authorize' || surface === 'revoke'
    const resource = surface === 'resource-delete' || surface === 'resource-submit'
    const method = { feedback: 'support.feedback.submit', connector: 'extensions.save',
      device: 'extensions.connector.configuration.save',
      authorize: 'connectors.authorization.begin', revoke: 'connectors.authorization.revoke',
      'resource-delete': 'extensions.connector.delete', 'resource-submit': 'extensions.submit' }[surface]
    let writes = 0
    const page = await boot(async (requested) => {
      if (requested === method) {
        const gate = gates[writes++]
        if (surface === 'feedback' && writes === 3) return { id: 'focus-receipt' }
        if (!gate) throw new Error('Duplicate submission')
        await gate.promise
        return { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture write failure', retryable: true, resources: [] } }
      }
      switch (requested) {
        case 'connectors.list': return resource ? [{ id: 'focus-resource', version: '1.0.0', name: 'Focus resource', visibility: 'PERSONAL',
          canEdit: true, canSubmit: true, canDelete: true, reviewStatus: 'DRAFT' }] : surface === 'device' || authorization ? [{ id: 'focus-connector', version: '1.0.0',
          name: 'Focus connector', visibility: 'COMPANY', reviewStatus: 'PUBLISHED', canConfigure: true,
          authorizationStatus: surface === 'revoke' ? 'AUTHORIZED' : 'REQUIRED', authMode: authorization ? 'oauth' : 'none', tools: [] }] : []
        case 'extensions.connector.configuration.read': return { id: 'focus-connector', version: '1.0.0',
          transport: 'streamable-http', url: 'https://example.test/mcp', arguments: [], headers: ['Authorization'],
          environment: [], configured: false, timeoutSeconds: 60 }
        default: throw new Error(`Unexpected submission method: ${requested}`)
      }
    })
    onTestFinished(async ({ task }) => {
      if (task.result?.state !== 'fail') return
      const screenshots = join(REPO_ROOT, '.artifacts/deepseek-harness-control-focus')
      await mkdir(screenshots, { recursive: true })
      await page.screenshot({ path: join(screenshots, `submission-${surface}-failure.png`) })
      await writeFile(join(screenshots, `submission-${surface}-failure.txt`), await page.locator('body').innerText())
    })
    if (surface === 'feedback') {
      await waitForInitialComposer(page)
      await page.getByRole('button', { name: 'Control reviewer', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Feedback', exact: true }).click()
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Retain my feedback.')
    } else {
      await page.getByRole('button', { name: 'Connectors', exact: true }).click()
      if (resource) {
        await page.getByRole('tab', { name: 'Mine', exact: true }).click()
        await page.getByRole('button', { name: 'More actions', exact: true }).click()
        await page.getByRole('menuitem', { name: surface === 'resource-delete' ? 'Delete' : 'Submit for publication', exact: true }).click()
      } else if (surface !== 'connector') {
        await page.getByText('Focus connector', { exact: true }).click()
        if (surface === 'device') {
          await page.getByRole('button', { name: 'Configure this device', exact: true }).click()
          await page.getByLabel('Authorization', { exact: true }).fill('synthetic-fixture')
        }
      } else {
        await page.getByRole('button', { name: 'Add', exact: true }).click()
        await page.getByLabel('Server name', { exact: true }).fill('Retain my connector')
        await page.getByLabel('Command', { exact: true }).fill('node fixture.js')
      }
    }
    const region = page.getByRole('dialog').last()
    const actionName = { feedback: 'Submit feedback', connector: 'Add', device: 'Save connector', authorize: 'Connect account', revoke: 'Disconnect account',
      'resource-delete': 'Delete', 'resource-submit': 'Submit for publication' }[surface]
    await region.getByRole('button', { name: actionName, exact: true }).waitFor()
    const action = region.locator('button[aria-busy]').last()
    if (authorization) {
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.setViewportSize({ width: 390, height: 560 })
    }
    const actionBounds = await action.boundingBox()
    const cancel = ['resource-delete', 'resource-submit'].includes(surface)
      ? await region.getByRole('button', { name: 'Cancel', exact: true }).elementHandle() : null
    const cancelBounds = await cancel?.boundingBox()
    const neighbor = authorization ? region.getByRole('button', { name: 'Configure this device', exact: true }) : null
    const neighborBounds = await neighbor?.boundingBox()
    await action.press('Enter')
    await expect.poll(() => writes).toBe(1)
    expect(await action.boundingBox()).toEqual(actionBounds)
    if (cancel) expect(await cancel.boundingBox()).toEqual(cancelBounds)
    if (neighbor) expect(await neighbor.boundingBox()).toEqual(neighborBounds)
    expect(await action.evaluate(node => node === globalThis.globalThis.document.activeElement)).toBe(true)
    await page.keyboard.press('Enter')
    await page.keyboard.press(' ')
    expect(writes).toBe(1)
    gates[0]!.resolve(undefined)
    const notice = await region.getByRole('alert').elementHandle()
    await expect.poll(() => action.getAttribute('aria-busy')).toBe('false')
    expect(await action.evaluate(node => node === globalThis.globalThis.document.activeElement)).toBe(true)
    if (authorization) {
      expect(await action.boundingBox()).toEqual(actionBounds)
      expect(await neighbor?.boundingBox()).toEqual(neighborBounds)
    }
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.setViewportSize({ width: 390, height: 560 })
    const retryBounds = await action.boundingBox()
    const retryCancelBounds = await cancel?.boundingBox()
    const retryNeighborBounds = await neighbor?.boundingBox()
    await action.press('Enter')
    await expect.poll(() => writes).toBe(2)
    expect(await action.boundingBox()).toEqual(retryBounds)
    if (cancel) expect(await cancel.boundingBox()).toEqual(retryCancelBounds)
    if (neighbor) expect(await neighbor.boundingBox()).toEqual(retryNeighborBounds)
    expect(await action.evaluate(node => node === globalThis.globalThis.document.activeElement)).toBe(true)
    expect(await region.getByRole('alert').evaluate((node, original) => node === original, notice)).toBe(true)
    await page.keyboard.press('Enter')
    await page.keyboard.press(' ')
    expect(writes).toBe(2)
    await capture(page, `submission-${surface}`, region, action)
    if (authorization) {
      expect(await controlIsUnclipped(action)).toBe(true)
      expect(await controlIsUnclipped(region.getByRole('alert'))).toBe(true)
      expect(await action.evaluate((node) => {
        const range = node.ownerDocument.createRange()
        range.selectNodeContents(node.querySelector('[aria-hidden="false"]') ?? node)
        const label = range.getBoundingClientRect(), button = node.getBoundingClientRect()
        return label.width <= button.width && label.height <= button.height
      })).toBe(true)
    }
    gates[1]!.resolve(undefined)
    await expect.poll(() => action.getAttribute('aria-busy')).toBe('false')
    expect(await action.evaluate(node => node === globalThis.globalThis.document.activeElement)).toBe(true)
    if (surface === 'feedback') {
      expect(await region.getByRole('textbox', { name: 'Message', exact: true }).inputValue()).toBe('Retain my feedback.')
      await action.press('Enter')
      await region.getByText('focus-receipt', { exact: true }).waitFor()
      expect(await region.getByRole('textbox', { name: 'Message', exact: true })
        .evaluate(node => node === globalThis.globalThis.document.activeElement)).toBe(true)
    }
  },
)

it.each([
  { surface: 'download', focused: 'error' }, { surface: 'download', focused: 'other' },
  { surface: 'select', focused: 'error' }, { surface: 'select', focused: 'other' },
] as const)('keeps library feedback retry stable and recovers removed error focus ($surface, $focused)', async ({ surface, focused }) => {
  const now = '2026-11-13T01:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: 'Feedback library', description: 'Retained controls',
    scope: 'PERSONAL', ownerId: 'employee-fixture', managerEmployeeId: 'employee-fixture', canManage: true,
    version: 1, createdAt: now, updatedAt: now }
  const data = Array.from(new TextEncoder().encode(Array.from({ length: 60 }, (_, index) => `Retained reader line ${index}\n\n`).join('')))
  const file = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id, parentId: null,
    name: 'Retained reader.md', kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: data.length,
    favorite: false, version: 1, createdAt: now, updatedAt: now }
  const failed = Promise.withResolvers<undefined>(), succeeded = Promise.withResolvers<undefined>()
  onTestFinished(() => { failed.resolve(undefined); succeeded.resolve(undefined) })
  const methodName = surface === 'download' ? 'library.files.download' : 'library.files.upload.select'
  let attempts = 0
  const page = await boot(async (method) => {
    if (method === methodName) {
      const attempt = ++attempts
      if (attempt === 2) await failed.promise
      if (attempt === 3) { await succeeded.promise; return surface === 'download' ? true : [{
        selectionId: '33333333-3333-4333-8333-333333333333', name: 'Selected template.md', sizeBytes: 12,
      }] }
      return { fixtureFailure: { code: 'EXTERNAL_SERVICE_ERROR', message: 'File operation unavailable', retryable: true, resources: [] } }
    }
    switch (method) {
      case 'library.list': return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
      case 'library.get': return library
      case 'library.entries.list': return { data: [file], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
      case 'library.files.preview.open': return { transferId: 'retained-reader', byteLength: data.length, maxBytes: 100000,
        chunkSize: data.length, mediaType: 'text/markdown' }
      case 'library.files.preview.read': return { data, offset: 0, eof: true }
      case 'library.files.preview.close':
      case 'library.files.upload.discard': return true
      default: throw new Error(`Unexpected library feedback method: ${method}`)
    }
  })
  await page.getByRole('button', { name: 'Libraries', exact: true }).click()
  await page.getByRole('button', { name: 'Feedback library Retained controls', exact: true }).click()
  if (surface === 'download') await page.getByRole('button', { name: /^Retained reader.md/ }).click()
  else await page.getByRole('button', { name: 'Upload files', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: surface === 'download' ? file.name : 'Upload files', exact: true })
  const action = dialog.getByRole('button', { name: surface === 'download' ? 'Download original' : 'Choose local files', exact: true })
  const close = dialog.getByRole('button', { name: 'Close', exact: true }).last()
  if (surface === 'download') await dialog.getByText('Retained reader line 0', { exact: true }).waitFor()
  await action.press('Enter')
  const notice = dialog.getByRole('alert')
  await notice.waitFor()
  const actionNode = await action.elementHandle(), closeNode = await close.elementHandle(), noticeNode = await notice.elementHandle()
  await action.press('Enter'); await action.press(' ')
  await expect.poll(() => attempts).toBe(2)
  expect(await notice.evaluate((node, original) => node === original, noticeNode)).toBe(true)
  expect(await action.evaluate((node, original) => node === original && node === document.activeElement, actionNode)).toBe(true)
  await capture(page, `library-feedback-${surface}-${focused}`, dialog, action)
  const bounds = await action.boundingBox(), closeBounds = await close.boundingBox(), dialogBounds = await dialog.boundingBox()
  failed.resolve(undefined)
  await expect.poll(() => action.getAttribute('aria-busy')).toBe('false')
  expect(await notice.evaluate((node, original) => node === original, noticeNode)).toBe(true)
  expect(await action.boundingBox()).toEqual(bounds)
  expect(await close.boundingBox()).toEqual(closeBounds)
  expect(await dialog.boundingBox()).toEqual(dialogBounds)
  await action.press('Enter'); await action.press(' ')
  await expect.poll(() => attempts).toBe(3)
  const retained = surface === 'download' ? dialog.getByText('Retained reader line 20', { exact: true }) : undefined
  const retainedNode = await retained?.elementHandle()
  const scrollOwner = await (retained ?? action).evaluateHandle((node) => {
    for (let owner = node.parentElement; owner; owner = owner.parentElement) {
      if (['auto', 'scroll'].includes(getComputedStyle(owner).overflowY)) return owner
    }
    throw new Error('Missing library dialog scroll owner')
  })
  if (retained) {
    await retained.scrollIntoViewIfNeeded()
    await retained.evaluate((node) => { const range = document.createRange(); range.selectNodeContents(node)
      const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range) })
  }
  await (focused === 'error' ? notice : close).focus()
  const scroll = await scrollOwner.evaluate(node => node.scrollTop)
  succeeded.resolve(undefined)
  await notice.waitFor({ state: 'detached' })
  expect(await (focused === 'error' ? action : close).evaluate(node => node === document.activeElement)).toBe(true)
  expect(await action.evaluate((node, original) => node === original, actionNode)).toBe(true)
  expect(await close.evaluate((node, original) => node === original, closeNode)).toBe(true)
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  expect(await scrollOwner.evaluate(node => node.scrollTop)).toBe(scroll)
  if (retained) {
    expect(await action.boundingBox()).toEqual(bounds)
    expect(await close.boundingBox()).toEqual(closeBounds)
    expect(await dialog.boundingBox()).toEqual(dialogBounds)
    expect(await retained.evaluate((node, original) => node === original, retainedNode)).toBe(true)
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('Retained reader line 20')
  } else await dialog.getByText('Selected template.md · 1 KB', { exact: true }).waitFor()
  expect(attempts).toBe(3)
  await close.click()
  await dialog.waitFor({ state: 'detached' })
})

it.each((['edit', 'device', 'library'] as const).flatMap(surface => [1440, 390].map(width => ({ surface, width }))))(
  'scopes blocked-close feedback to the current $surface write ($width)', async ({ surface, width }) => {
    const first = Promise.withResolvers<undefined>(), retried = Promise.withResolvers<undefined>()
    onTestFinished(() => { first.resolve(undefined); retried.resolve(undefined) })
    const entry = { id: 'close-notice-connector', version: '1.0.0', name: 'Close notice connector',
      visibility: surface === 'device' ? 'COMPANY' : 'PERSONAL', reviewStatus: surface === 'device' ? 'PUBLISHED' : 'DRAFT',
      canConfigure: true, canEdit: true, authMode: 'none', tools: [] }
    const draft = { id: entry.id, version: entry.version, name: entry.name, kind: 'connector', summary: 'Retained description', category: 'other',
      transport: 'stdio', command: 'node', arguments: ['fixture.js'], headers: {}, environment: {}, timeoutSeconds: 60 }
    const now = '2026-11-13T01:00:00Z'
    const library = { id: '11111111-1111-4111-8111-111111111111', name: 'Close notice library', description: 'Retained library',
      scope: 'PERSONAL', ownerId: 'employee-fixture', managerEmployeeId: 'employee-fixture', canManage: true,
      version: 1, createdAt: now, updatedAt: now }
    const method = surface === 'edit' ? 'extensions.connector.update' : surface === 'device'
      ? 'extensions.connector.configuration.save' : 'library.update'
    let writes = 0
    const page = await boot(async (requested) => {
      if (requested === method) {
        const attempt = ++writes
        if (attempt === 1) {
          await first.promise
          return { fixtureFailure: { code: 'EXTERNAL_SERVICE_ERROR', message: 'Write unavailable', retryable: true, resources: [] } }
        }
        await retried.promise
        return surface === 'device' ? { id: entry.id, version: entry.version, configured: true }
          : surface === 'edit' ? { id: entry.id, version: entry.version, kind: 'connector', visibility: 'PERSONAL' } : true
      }
      switch (requested) {
        case 'connectors.list': return [entry]
        case 'extensions.connector.read': return { draft, configured: true, savePending: false }
        case 'extensions.connector.configuration.read': return { id: entry.id, version: entry.version, transport: 'stdio',
          command: draft.command, arguments: draft.arguments, headers: [], environment: ['API_KEY'], configured: false, timeoutSeconds: 60 }
        case 'library.list': return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
        default: throw new Error(`Unexpected close-notice request: ${requested}`)
      }
    })
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' })
    await page.getByRole('button', { name: surface === 'library' ? 'Libraries' : 'Connectors', exact: true }).click()
    if (surface === 'library') await page.getByRole('button', { name: 'Edit library', exact: true }).click()
    else if (surface === 'edit') {
      await page.getByRole('tab', { name: 'Mine', exact: true }).click()
      await page.getByRole('button', { name: 'More actions', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Modify', exact: true }).click()
    } else {
      await page.getByRole('button', { name: entry.name, exact: true }).click()
      await page.getByRole('button', { name: 'Configure this device', exact: true }).click()
    }
    const dialog = page.getByRole('dialog', { name: surface === 'library' ? 'Edit library'
      : surface === 'edit' ? 'Edit connector' : 'Configure this device', exact: true })
    await page.setViewportSize({ width, height: width === 390 ? 560 : 900 })
    const field = dialog.getByLabel(surface === 'library' ? 'Name' : surface === 'edit' ? 'Description' : 'API_KEY', { exact: true })
    const text = 'Retained draft value'
    await field.fill(text)
    await field.evaluate((node) => {
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) node.setSelectionRange(2, 7)
    })
    const fieldNode = await field.elementHandle()
    await dialog.getByRole('button', { name: surface === 'library' ? 'Save' : 'Save connector', exact: true }).waitFor()
    const save = dialog.locator('button[aria-busy]').last()
    const saveNode = await save.elementHandle()
    await save.press('Enter'); await save.press(' ')
    await expect.poll(() => writes).toBe(1)
    const wait = dialog.getByRole('status').filter({ hasText: 'Wait for the current operation to finish.' })
    expect(await wait.count()).toBe(0)
    await page.keyboard.press('Escape')
    await wait.waitFor()
    const bounds = await save.boundingBox(), dialogBounds = await dialog.boundingBox()
    first.resolve(undefined)
    const notice = dialog.getByRole('alert')
    await notice.waitFor()
    expect(await wait.count()).toBe(0)
    expect(await save.boundingBox()).toEqual(bounds)
    expect(await dialog.boundingBox()).toEqual(dialogBounds)
    const noticeNode = await notice.elementHandle()
    await save.press('Enter'); await save.press(' ')
    await expect.poll(() => writes).toBe(2)
    expect(await wait.count()).toBe(0)
    expect(await notice.evaluate((node, previous) => node === previous, noticeNode)).toBe(true)
    expect(await save.evaluate((node, previous) => node === previous && node === document.activeElement, saveNode)).toBe(true)
    expect(await field.evaluate((node, previous) => node === previous &&
      (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) && node.value === 'Retained draft value'
      && node.selectionStart === 2 && node.selectionEnd === 7, fieldNode)).toBe(true)
    expect(await save.boundingBox()).toEqual(bounds)
    expect(await dialog.boundingBox()).toEqual(dialogBounds)
    await page.keyboard.press('Escape')
    await wait.waitFor()
    expect(await save.evaluate(node => node === document.activeElement)).toBe(true)
    expect(await dialog.getByText('Discard unsaved changes?', { exact: true }).count()).toBe(0)
    expect(writes).toBe(2)
    await mkdir(join(REPO_ROOT, '.artifacts/deepseek-harness-control-focus'), { recursive: true })
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts/deepseek-harness-control-focus', `close-notice-${surface}-${width}.png`) })
    retried.resolve(undefined)
    await dialog.waitFor({ state: 'detached' })
    expect(writes).toBe(2)
  },
)

it.each(['success', 'failure'] as const)('preserves newer library folder feedback across an older refresh (%s)', async (outcome) => {
  const now = '2026-11-13T01:00:00Z'
  const library = { id: '11111111-1111-4111-8111-111111111111', name: 'Folder feedback library', description: 'Retained directory',
    scope: 'PERSONAL', ownerId: 'employee-fixture', managerEmployeeId: 'employee-fixture', canManage: true,
    version: 1, createdAt: now, updatedAt: now }
  const parent = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id, parentId: null,
    name: 'Parent folder', kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0, favorite: false,
    version: 1, createdAt: now, updatedAt: now }
  const nested = { ...parent, id: '33333333-3333-4333-8333-333333333333', parentId: parent.id, name: 'Nested match' }
  const background = Promise.withResolvers<undefined>(), navigation = Promise.withResolvers<undefined>()
  const recovery = Promise.withResolvers<undefined>()
  onTestFinished(() => { background.resolve(undefined); navigation.resolve(undefined); recovery.resolve(undefined) })
  let reads = 0, ancestry = 0
  const page = await boot(async (method, payload) => {
    switch (method) {
      case 'library.list': return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
      case 'library.get': return library
      case 'library.entries.list': {
        const read = ++reads
        if (read === 3) {
          await background.promise
          if (outcome === 'failure') return { fixtureFailure: {
            code: 'LIBRARY_FILE_INVALID', message: 'Older refresh failure', retryable: true, resources: [],
          } }
        }
        if (read === 4) await recovery.promise
        const query = typeof payload === 'object' && payload !== null && 'query' in payload ? payload.query : ''
        return { data: query ? [nested] : [parent], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
      }
      case 'library.entries.get':
        if (++ancestry === 1) {
          await navigation.promise
          return { fixtureFailure: {
            code: 'LIBRARY_ACCESS_DENIED', message: 'Folder access denied', retryable: true, resources: [],
          } }
        }
        return parent
      default: throw new Error(`Unexpected folder feedback method: ${method}`)
    }
  })
  await page.getByRole('button', { name: 'Libraries', exact: true }).click()
  await page.getByRole('button', { name: 'Folder feedback library Retained directory', exact: true }).click()
  const browser = page.getByRole('region', { name: 'Libraries', exact: true }).last()
  const search = browser.getByRole('searchbox', { name: 'Search names', exact: true })
  await search.fill(nested.name)
  const row = browser.getByRole('button', { name: `${nested.name} Folder`, exact: true }), refresh = browser.getByRole('button', { name: 'Refresh', exact: true })
  await row.waitFor()
  await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('false')
  const rowNode = await row.elementHandle(), searchNode = await search.elementHandle()
  await refresh.click()
  await expect.poll(() => reads).toBe(3)
  await row.press('Enter')
  await expect.poll(() => ancestry).toBe(1)
  await row.press(' ')
  navigation.resolve(undefined)
  const notice = browser.getByRole('alert'), retry = browser.getByRole('button', { name: 'Retry', exact: true })
  await notice.waitFor()
  expect(await notice.textContent()).toContain('(LIBRARY_ACCESS_DENIED)')
  expect(ancestry).toBe(1)
  await retry.focus()
  await capture(page, `library-folder-${outcome}-feedback`, browser, retry)
  const noticeNode = await notice.elementHandle(), retryNode = await retry.elementHandle()
  await search.focus()
  await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 4) })
  const bounds = await row.boundingBox(), retryBounds = await retry.boundingBox()
  const scroll = await browser.evaluate((node) => {
    const positions = []
    for (let owner: Element | null = node; owner; owner = owner.parentElement) positions.push([owner.scrollTop, owner.scrollLeft])
    return positions
  })
  background.resolve(undefined)
  await expect.poll(() => refresh.getAttribute('aria-busy')).toBe('false')
  expect(await notice.evaluate((node, original) => node === original && node.textContent?.includes('(LIBRARY_ACCESS_DENIED)'), noticeNode)).toBe(true)
  expect(await retry.evaluate((node, original) => node === original, retryNode)).toBe(true)
  expect(await row.evaluate((node, original) => node === original, rowNode)).toBe(true)
  expect(await search.evaluate((node, original) => node === original && node === document.activeElement &&
    node instanceof HTMLInputElement && node.selectionStart === 1 && node.selectionEnd === 4, searchNode)).toBe(true)
  expect(await row.boundingBox()).toEqual(bounds)
  expect(await retry.boundingBox()).toEqual(retryBounds)
  expect(await browser.evaluate((node) => {
    const positions = []
    for (let owner: Element | null = node; owner; owner = owner.parentElement) positions.push([owner.scrollTop, owner.scrollLeft])
    return positions
  })).toEqual(scroll)
  await retry.press('Enter'); await retry.press(' ')
  await expect.poll(() => reads).toBe(4)
  recovery.resolve(undefined)
  await notice.waitFor({ state: 'detached' })
  expect(await search.evaluate(node => node === document.activeElement)).toBe(true)
  expect(await row.evaluate((node, original) => node === original, rowNode)).toBe(true)
  await row.press('Enter')
  await expect.poll(() => ancestry).toBe(2)
  await expect.poll(() => search.inputValue()).toBe('')
  await browser.getByRole('button', { name: 'Parent folder', exact: true }).waitFor()
})

it.each(['Expert kits', 'Skills', 'Connectors', 'Libraries'] as const)(
  'opens one shared expiration prompt over %s without replacing its page', async (panel) => {
    let authenticated = true, writes = 0
    const authorization = Promise.withResolvers<undefined>()
    onTestFinished(() => { authorization.resolve(undefined) })
    const page = await boot(async (method) => {
      if (method === 'connectors.list') return []
      if (method === 'library.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
      if (method === 'auth.ensureDingTalk') {
        writes++
        await authorization.promise
        authenticated = true
        await page.evaluate(() => { dispatchEvent(new CustomEvent('control-product-event', { detail: {
          type: 'session.changed', payload: { authenticated: true, employeeId: 'employee-fixture', displayName: 'Control reviewer' },
        } })) })
        return { authenticated: true }
      }
      throw new Error(`Unexpected expiration prompt method: ${method}`)
    }, async () => ({ authenticated, ...authenticated ? { employeeId: 'employee-fixture', displayName: 'Control reviewer' } : {} }))
    await waitForInitialComposer(page)
    const navigation = page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: panel, exact: true })
    await navigation.click()
    const heading = page.getByRole('heading', { level: 1, name: new RegExp(`^${panel}$`, 'i') })
    await heading.waitFor()
    const originalHeading = await heading.elementHandle()
    await navigation.focus()
    authenticated = false
    const expire = () => page.evaluate(() => {
      dispatchEvent(new CustomEvent('control-product-event', { detail: { type: 'session.changed', payload: { authenticated: false } } }))
      dispatchEvent(new CustomEvent('control-product-event', { detail: { type: 'auth.required' } }))
    })
    await expire()
    const dialog = page.getByRole('dialog', { name: 'Sign in to use organization resources', exact: true })
    await dialog.waitFor()
    const originalDialog = await dialog.elementHandle()
    const action = dialog.getByRole('button', { name: 'Sign in with DingTalk', exact: true })
    await action.focus()
    const originalAction = await action.elementHandle(), bounds = await action.boundingBox()
    await expire()
    expect(await dialog.count()).toBe(1)
    expect(await dialog.evaluate((node, previous) => node === previous, originalDialog)).toBe(true)
    expect(await action.evaluate((node, previous) => node === previous && node === document.activeElement, originalAction)).toBe(true)
    expect(await action.boundingBox()).toEqual(bounds)
    expect(writes).toBe(0)
    await capture(page, `employee-expiration-${panel.toLowerCase().replaceAll(' ', '-')}`, dialog, action)
    await page.setViewportSize({ width: 1440, height: 900 })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await expire()
    expect(await dialog.count()).toBe(0)
    expect(await heading.evaluate((node, previous) => node === previous, originalHeading)).toBe(true)
    const employee = page.getByRole('button', { name: 'Not signed in', exact: true })
    await employee.click()
    await page.getByRole('menuitem', { name: 'Sign in with DingTalk', exact: true }).click()
    const waiting = dialog.getByRole('button', { name: 'Waiting for DingTalk…', exact: true })
    await waiting.waitFor()
    await waiting.press('Enter')
    await page.keyboard.press(' ')
    expect(writes).toBe(1)
    authorization.resolve(undefined)
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => heading.evaluate((node, previous) => node === previous, originalHeading)).toBe(true)
    expect(await page.getByRole('alert').count()).toBe(0)
    authenticated = false
    await expire()
    await dialog.waitFor()
    expect(await dialog.count()).toBe(1)
    expect(writes).toBe(1)
  },
)
