/** Product controls over the native Harness UI; only the enterprise transport is replaced. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { builtinCapabilityPatches } from '../../../packages/deepseek-harness-product/desktop/src/builtin-capabilities.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

async function boot(invoke: (method: string, payload?: unknown) => Promise<unknown>,
  getSession = async (): Promise<unknown> => ({ authenticated: true, employeeId: 'employee-fixture', displayName: 'Control reviewer' })) {
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
        if (method === 'knowledge.documents.preview.read' && typeof result === 'object' && result !== null
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
      case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
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

it.each([
  ...(['library', 'document'] as const).flatMap(resource => (['reader', 'sidebar'] as const).map(focus => ({ resource, focus }))),
  { resource: 'document', focus: 'header' },
])(
  'returns from a removed $resource without taking focus elsewhere (focus=$focus)', async ({ resource, focus }) => {
    const response = Promise.withResolvers<undefined>()
    onTestFinished(() => { response.resolve(undefined) })
    const library = { id: 'removal-library', name: 'Removal library', scope: 'PERSONAL', canRead: true, canManage: true }
    const document = { id: 'removal-document', knowledgeBaseId: library.id, filename: 'Removal.md', mediaType: 'text/markdown',
      sizeBytes: 10, status: 'READY', chunkCount: 1, updatedAt: '2026-11-11T00:00:00Z', folderId: null }
    let catalogs = 0
    let lists = 0
    let reads = 0
    const page = await boot(async (method) => {
      switch (method) {
        case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
        case 'knowledge.bases.list':
          if (++catalogs === 1 || resource === 'document') return [library]
          if (catalogs !== 2) throw new Error('Duplicate removal catalog read')
          await response.promise
          return []
        case 'knowledge.documents.upload.pending': return []
        case 'knowledge.folders.list': return { items: [], page: 1, size: 20, total: 0 }
        case 'knowledge.documents.list':
          if (++lists === 1) return { items: [document], page: 1, size: 20, total: 1 }
          if (lists !== 2) throw new Error('Duplicate removal document read')
          await response.promise
          return { items: [], page: 1, size: 20, total: 0 }
        case 'knowledge.documents.read':
          if (++reads > 2) throw new Error('Duplicate removal content read')
          if (reads === 2) await response.promise
          return { items: [{ id: 'removal-passage', documentId: document.id, locator: 'Page 1',
            content: '[Removal reference](https://example.com/reference)\n\nConfirmed removal content.' }], page: 1, size: 20, total: 1 }
        default: throw new Error(`Unexpected removal focus method: ${method}`)
      }
    })
    await page.getByRole('button', { name: 'Knowledge bases', exact: true }).click()
    await page.getByRole('button', { name: library.name, exact: true }).click()
    const materials = page.locator('[data-knowledge-content]')
    const input = materials.getByRole('searchbox', { name: 'Search material names…', exact: true })
    await input.fill('Unsubmitted material filter')
    const originalInput = await input.elementHandle()
    await materials.getByRole('button', { name: 'Actions for “Removal.md”', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Parsed content', exact: true }).click()
    const reader = materials.getByRole('region', { name: 'Parsed content', exact: true })
    const link = reader.getByRole('link', { name: 'Removal reference', exact: true })
    await link.focus()
    const target = focus === 'reader' ? link : focus === 'header'
      ? materials.getByRole('button', { name: 'Knowledge bases', exact: true })
      : page.getByRole('button', { name: 'Skills', exact: true })
    await target.focus()
    const originalLink = await link.elementHandle()
    const bounds = await link.boundingBox()
    await page.evaluate(() => globalThis.dispatchEvent(new CustomEvent('control-product-event', { detail: { type: 'catalog.changed' } })))
    await expect.poll(() => resource === 'library' ? catalogs : lists).toBe(2)
    if (resource === 'document') await expect.poll(() => reads).toBe(2)
    expect(await link.evaluate((node, previous) => node === previous, originalLink)).toBe(true)
    expect(await link.boundingBox()).toEqual(bounds)
    expect(await target.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    response.resolve(undefined)
    await reader.waitFor({ state: 'hidden' })
    const heading = page.getByRole('heading', { name: resource === 'library' ? 'Knowledge bases' : library.name, exact: true, level: 1 })
    await heading.waitFor()
    const focused = focus === 'reader' ? heading : target
    expect(await focused.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    expect(await page.getByText('Confirmed removal content.', { exact: true }).count()).toBe(0)
    if (resource === 'library') {
      expect(await materials.count()).toBe(0)
      expect(await page.getByRole('button', { name: library.name, exact: true }).count()).toBe(0)
    } else {
      expect(await input.evaluate((node, previous) => node === previous, originalInput)).toBe(true)
      expect(await input.inputValue()).toBe('Unsubmitted material filter')
      expect(await materials.getByRole('button', { name: document.filename, exact: true }).count()).toBe(0)
    }
    expect(catalogs).toBe(2)
    expect(lists).toBe(resource === 'library' ? 1 : 2)
    expect(reads).toBe(resource === 'library' ? 1 : 2)
    if (focus !== 'sidebar') await capture(page, `removed-${resource}-${focus}`, page.locator('[data-knowledge-workspace]'), focused)
  },
)

it.each([
  ...(['results', 'reader'] as const).flatMap(surface => [false, true].map(elsewhere => ({ surface, elsewhere, outcome: 'confirmed' as const }))),
  ...(['failed', 'revoked'] as const).map(outcome => ({ surface: 'reader' as const, elsewhere: false, outcome })),
])(
  'revalidates content $surface in place on background catalog refresh (elsewhere=$elsewhere, outcome=$outcome)', async ({ surface, elsewhere, outcome }) => {
    const response = Promise.withResolvers<undefined>()
    onTestFinished(() => { response.resolve(undefined) })
    const library = { id: 'refresh-library', name: 'Refresh library', scope: 'PERSONAL', canRead: true, canManage: true }
    const document = { id: 'refresh-document', knowledgeBaseId: library.id, filename: 'Refresh.md', mediaType: 'text/markdown',
      sizeBytes: 10, status: 'READY', chunkCount: 1, updatedAt: '2026-11-11T00:00:00Z', folderId: null }
    const hit = { sourceId: 'refresh-source', knowledgeBaseId: library.id, documentId: document.id,
      filename: document.filename, locator: 'Page 1', content: '[Fixture reference](https://example.com/reference)\n\nConfirmed knowledge text.' }
    let searches = 0
    let sources = 0
    const page = await boot(async (method) => {
      switch (method) {
        case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
        case 'knowledge.bases.list': return [library]
        case 'knowledge.documents.upload.pending': return []
        case 'knowledge.folders.list': return { items: [], page: 1, size: 20, total: 0 }
        case 'knowledge.documents.list': return { items: [document], page: 1, size: 20, total: 1 }
        case 'knowledge.search':
          if (++searches === 1) return [hit]
          if (searches !== 2) throw new Error('Duplicate background search')
          await response.promise
          return [{ ...hit, content: 'Revalidated search text.' }]
        case 'knowledge.sources.read':
          if (++sources === 1) return hit
          if (sources !== 2) throw new Error('Duplicate background source read')
          await response.promise
          if (outcome !== 'confirmed') return { fixtureFailure: {
            code: outcome === 'revoked' ? 'KNOWLEDGE_ACCESS_REVOKED' : 'SERVER_ERROR',
            message: 'Fixture source refresh failure', retryable: outcome !== 'revoked', resources: [],
          } }
          return { ...hit, content: '[Fixture reference](https://example.com/reference)\n\nRevalidated source text.' }
        default: throw new Error(`Unexpected background refresh method: ${method}`)
      }
    })
    await page.getByRole('button', { name: 'Knowledge bases', exact: true }).click()
    await page.getByRole('button', { name: library.name, exact: true }).click()
    const materials = page.locator('[data-knowledge-content]')
    await materials.getByRole('button', { name: document.filename, exact: true }).waitFor()
    await materials.getByRole('button', { name: 'Search content', exact: true }).click()
    const region = materials.getByRole('region', { name: 'Search content', exact: true })
    const input = region.getByRole('searchbox', { name: 'Search content', exact: true })
    await input.fill('knowledge')
    await region.getByRole('button', { name: 'Search', exact: true }).press('Enter')
    const result = region.getByRole('button', { name: /Refresh.md Page 1/ })
    const originalResult = await result.elementHandle()
    const reader = region.getByRole('region', { name: 'View file', exact: true })
    if (surface === 'reader') {
      await result.click()
      await reader.getByRole('button', { name: 'View original file', exact: true }).waitFor()
    }
    const owned = surface === 'reader' ? reader.getByRole('link', { name: 'Fixture reference', exact: true }) : result
    await owned.focus()
    const target = elsewhere ? page.getByRole('button', { name: 'Skills', exact: true }) : owned
    if (elsewhere) await target.focus()
    const original = await owned.elementHandle()
    const bounds = await owned.boundingBox()
    await page.evaluate(() => globalThis.dispatchEvent(new CustomEvent('control-product-event', { detail: { type: 'catalog.changed' } })))
    await expect.poll(() => searches).toBe(2)
    if (surface === 'reader') await expect.poll(() => sources).toBe(2)
    expect(await owned.evaluate((node, previous) => node === previous, original)).toBe(true)
    expect(await owned.boundingBox()).toEqual(bounds)
    expect(await target.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    expect(await region.getByRole('status', { name: 'Loading…', exact: true }).count()).toBe(0)
    response.resolve(undefined)
    if (outcome !== 'confirmed') {
      const error = materials.getByRole('alert')
      await error.waitFor()
      expect(await materials.getByText('Confirmed knowledge text.', { exact: true }).count()).toBe(0)
      expect(await materials.getByRole('button', { name: 'View original file', exact: true }).count()).toBe(0)
      if (outcome === 'revoked') {
        expect(await error.textContent()).toContain('Access to selected knowledge bases has been revoked.')
        expect(await region.count()).toBe(0)
        expect(await materials.getByRole('button', { name: 'Add materials', exact: true }).count()).toBe(0)
      } else {
        expect(await reader.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
        await reader.getByRole('button', { name: 'Retry', exact: true }).waitFor()
        await region.getByRole('button', { name: 'Back to search results', exact: true }).click()
        expect(await result.evaluate((node, previous) => node === previous, originalResult)).toBe(true)
        expect(await input.inputValue()).toBe('knowledge')
      }
      expect(searches).toBe(2)
      expect(sources).toBe(2)
      return
    }
    await region.getByText(surface === 'reader' ? 'Revalidated source text.' : 'Revalidated search text.', { exact: surface === 'reader' }).waitFor()
    expect(await target.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    if (!elsewhere) await capture(page, `background-search-${surface}`, region, owned)
    if (surface === 'reader') {
      expect(await input.isVisible()).toBe(false)
      await region.getByRole('button', { name: 'Back to search results', exact: true }).click()
    }
    expect(await result.evaluate((node, previous) => node === previous, originalResult)).toBe(true)
    expect(await input.inputValue()).toBe('knowledge')
    expect(searches).toBe(2)
    expect(sources).toBe(surface === 'reader' ? 2 : 0)
  },
)

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

it.each((['CURRENT_SESSION', 'NEW_SESSION'] as const).flatMap(kind => [false, true].flatMap(remaining =>
  [false, true].map(elsewhere => ({ kind, remaining, elsewhere })))))(
  'preserves knowledge removal focus and native task navigation ($kind, remaining=$remaining, elsewhere=$elsewhere)', async ({ kind, remaining, elsewhere }) => {
    const response = Promise.withResolvers<undefined>()
    onTestFinished(() => { response.resolve(undefined) })
    let ids = remaining ? ['focus-policy', 'focus-manual'] : ['focus-policy']
    let writes = 0
    const page = await boot(async (method) => {
      if (method === 'tasks.capabilities.read') return { basePresetId: 'standard', knowledgeBaseIds: ids }
      if (method === 'knowledge.bases.list') return [
        { id: 'focus-policy', name: 'Focus policy', scope: 'COMPANY' },
        { id: 'focus-manual', name: 'Focus manual', scope: 'COMPANY' },
      ]
      if (method === 'tasks.capabilities.prepare') {
        if (++writes !== 1) throw new Error('Duplicate knowledge removal')
        await response.promise
        ids = remaining ? ['focus-manual'] : []
        return { kind, presetId: 'standard',
          capabilities: { basePresetId: 'standard', knowledgeBaseIds: ids },
          dependencyChecks: ids.map(reference => ({ kind: 'KNOWLEDGE_BASE', reference, status: 'READY' })) }
      }
      throw new Error(`Unexpected removal method: ${method}`)
    })
    await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    const draft = 'Keep the draft and its caret.'
    await composer.fill(draft)
    await composer.press('ArrowLeft')
    await composer.press('ArrowLeft')
    const selection = await composer.evaluate(() => {
      const selected = document.getSelection()
      return [selected?.anchorOffset, selected?.focusOffset]
    })
    const references = page.getByRole('group', { name: 'Task knowledge bases', exact: true })
    const remove = references.getByRole('button', { name: 'Remove knowledge base "Focus policy"', exact: true })
    const button = await remove.elementHandle()
    const bounds = await remove.boundingBox()
    await remove.press('Enter')
    await expect.poll(() => writes).toBe(1)
    expect(await remove.evaluate((node, prior) => node === prior && node === globalThis.document.activeElement, button)).toBe(true)
    expect(await remove.boundingBox()).toEqual(bounds)
    await page.keyboard.press('Enter')
    expect(writes).toBe(1)
    const other = page.getByRole('button', { name: 'Skills', exact: true })
    if (elsewhere) await other.focus()
    response.resolve(undefined)
    await remove.waitFor({ state: 'hidden' })
    const target = kind === 'CURRENT_SESSION' && elsewhere ? other : composer
    await expect.poll(() => target.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    expect(await composer.textContent()).toBe(draft)
    if (!elsewhere) {
      if (kind === 'CURRENT_SESSION') expect(await composer.evaluate(() => {
        const selected = document.getSelection()
        return [selected?.anchorOffset, selected?.focusOffset]
      })).toEqual(selection)
      await capture(page, `knowledge-removal-success-${kind}-${remaining ? 'remaining' : 'empty'}`, composer, target)
    }
  },
)

it.each((['empty', 'selected'] as const).flatMap(result => [false, true].map(elsewhere => ({ result, elsewhere }))))(
  'restores native composer focus after a capability retry with $result knowledge (elsewhere=$elsewhere)', async ({ result, elsewhere }) => {
    const response = Promise.withResolvers<undefined>()
    onTestFinished(() => { response.resolve(undefined) })
    let retrying = false
    let reads = 0
    const page = await boot(async (method) => {
      if (method === 'tasks.capabilities.read') {
        if (!retrying) return { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture capability failure', retryable: true, resources: [] } }
        if (++reads !== 1) throw new Error('Duplicate capability retry')
        await response.promise
        return { knowledgeBaseIds: result === 'selected' ? ['focus-policy'] : [] }
      }
      if (method === 'knowledge.bases.list') return [{ id: 'focus-policy', name: 'Focus policy', scope: 'COMPANY' }]
      throw new Error(`Unexpected capability read method: ${method}`)
    })
    await expect.poll(() => page.getByRole('button', { name: 'Choose workspace', exact: true }).textContent()).toBe('Default workspace')
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    const draft = 'Keep this draft and its caret.'
    await composer.fill(draft)
    await composer.press('ArrowLeft')
    await composer.press('ArrowLeft')
    const selection = await composer.evaluate(() => {
      const selected = document.getSelection()
      return [selected?.anchorOffset, selected?.focusOffset]
    })
    const notice = page.getByRole('alert')
    const retry = notice.getByRole('button', { name: 'Retry', exact: true })
    await expect.poll(() => retry.getAttribute('aria-disabled')).toBe('false')
    const button = await retry.elementHandle()
    const bounds = await retry.boundingBox()
    const alert = await notice.elementHandle()
    retrying = true
    await retry.press('Enter')
    await expect.poll(() => reads).toBe(1)
    expect(await retry.evaluate((node, previous) => node === previous && node === globalThis.document.activeElement, button)).toBe(true)
    expect(await retry.boundingBox()).toEqual(bounds)
    expect(await retry.getAttribute('aria-disabled')).toBe('true')
    expect(await notice.evaluate((node, previous) => node === previous, alert)).toBe(true)
    await page.keyboard.press('Enter')
    expect(reads).toBe(1)
    const other = page.getByRole('button', { name: 'Skills', exact: true })
    if (elsewhere) await other.focus()
    response.resolve(undefined)
    await retry.waitFor({ state: 'hidden' })
    await expect.poll(() => (elsewhere ? other : composer).evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    expect(await composer.textContent()).toBe(draft)
    if (!elsewhere) {
      expect(await composer.evaluate(() => {
        const selected = document.getSelection()
        return [selected?.anchorOffset, selected?.focusOffset]
      })).toEqual(selection)
      await capture(page, `capability-retry-${result}`, composer, composer)
    }
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
      case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
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
        case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
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
      if (method === 'tasks.capabilities.read') return { knowledgeBaseIds: [] }
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
        case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
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

it.each(([
  ['connectors', 'identity'], ['knowledge', 'identity'], ['knowledge', 'retry'],
  ['connectors', 'removed'], ['knowledge', 'removed'], ['connectors', 'failed'],
] as const).flatMap(([catalog, transition]) => [false, true].map(elsewhere => ({ catalog, transition, elsewhere }))))(
  'recovers catalog $catalog focus after $transition with elsewhere=$elsewhere', async ({ catalog, transition, elsewhere }) => {
    const response = Promise.withResolvers<undefined>()
    const identity = Promise.withResolvers<undefined>()
    onTestFinished(() => { response.resolve(undefined); identity.resolve(undefined) })
    const failure = { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture read failure', retryable: true, resources: [] } }
    let reads = 0
    let identityRetries = 0
    let allowIdentity = false
    const label = catalog === 'connectors' ? 'Connectors' : 'Knowledge bases'
    const entry = catalog === 'connectors'
      ? { id: 'focus-entry', name: 'Focus entry', version: '1.0.0', visibility: 'COMPANY', reviewStatus: 'PUBLISHED', authMode: 'none', tools: [] }
      : { id: 'focus-entry', name: 'Focus entry', scope: 'PERSONAL', canRead: true, canManage: true }
    const page = await boot(async (method) => {
      if (method === 'tasks.capabilities.read') return { knowledgeBaseIds: [] }
      if (method === 'connectors.refresh') return { connectedIds: [], unavailableIds: [] }
      if (method !== (catalog === 'connectors' ? 'connectors.list' : 'knowledge.bases.list')) throw new Error(`Unexpected catalog focus method: ${method}`)
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
    else await region.getByText(catalog === 'connectors' ? 'No connectors in the marketplace yet. Personal connectors appear here after publication is approved.' : 'No knowledge bases yet', { exact: true }).waitFor()
    const focused = elsewhere ? other : region
    await expect.poll(() => focused.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    expect(await card.count()).toBe(0)
    if (!elsewhere && transition !== 'failed') await capture(page, `catalog-focus-${catalog}-${transition}`, region, focused)
  },
)

it.each((['document', 'library', 'document-recovery', 'library-recovery', 'document-restored', 'library-restored'] as const)
  .flatMap(surface => [false, true].map(elsewhere => ({ surface, elsewhere }))))(
  'retains editor $surface dialog and focus after a read retry (elsewhere=$elsewhere)', async ({ surface, elsewhere }) => {
    const response = Promise.withResolvers<undefined>()
    onTestFinished(() => { response.resolve(undefined) })
    const restored = surface.endsWith('restored')
    const recovering = surface.endsWith('recovery') || restored
    const base = surface.startsWith('library')
    const library = { id: 'focus-library', name: 'Focus library', description: 'Library description', scope: 'PERSONAL',
      canRead: true, canManage: true, updatedAt: '2026-11-11T00:00:00Z' }
    const document = { id: 'focus-document', knowledgeBaseId: library.id, filename: 'Focus.md', sourceType: 'manual', canManage: true,
      mediaType: 'text/markdown', manualContent: 'Original contents', sizeBytes: 10, status: 'READY', chunkCount: 1,
      updatedAt: library.updatedAt, folderId: null }
    const failure = { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture editor read failure', retryable: true, resources: [] } }
    let reads = 0
    let recoveringNow = false
    let closing = false
    const page = await boot(async (method) => {
      if (!recovering && method === (base ? 'knowledge.bases.get' : 'knowledge.documents.get')) {
        if (++reads === 1) return failure
        if (reads !== 2) throw new Error('Unexpected duplicate editor read')
        await response.promise
      }
      switch (method) {
        case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
        case 'knowledge.bases.list': return [library]
        case 'knowledge.bases.get': return library
        case 'knowledge.documents.get': return document
        case 'knowledge.documents.list': return { items: [document], page: 1, size: 20, total: 1 }
        case 'knowledge.folders.list': return { items: [], page: 1, size: 20, total: 0 }
        case 'knowledge.documents.upload.pending': return []
        default: throw new Error(`Unexpected editor read method: ${method}`)
      }
    }, async () => {
      if (recoveringNow && !closing) {
        if (++reads === 1) return failure
        if (reads !== 2) throw new Error('Unexpected duplicate recovery read')
        await response.promise
      }
      return { authenticated: true, employeeId: 'employee-fixture', displayName: 'Control reviewer' }
    })
    await page.getByRole('button', { name: 'Knowledge bases', exact: true }).click()
    if (!base) await page.getByRole('button', { name: library.name, exact: true }).click()
    if (recovering) {
      const scope = base ? 'personal-library' : JSON.stringify([library.id, 'markdown', 'create', null])
      await page.evaluate(({ scope, base, libraryId, restored }) => {
        sessionStorage.setItem('product.knowledge.suspended.v1.other-scope', '{}')
        if (restored) sessionStorage.setItem(`product.knowledge.suspended.v1.employee-fixture.${scope}`, JSON.stringify({
          title: 'Retained draft', content: base ? 'Description' : 'Retained contents', url: '', parentId: null,
          save: { method: base ? 'knowledge.bases.create' : 'knowledge.documents.save', payload: { operationId: 'original-operation',
            ...base ? { name: 'Retained draft', description: 'Description' }
              : { knowledgeBaseId: libraryId, title: 'Retained draft', content: 'Retained contents', folderId: null } },
          },
        }))
      }, { scope, base, libraryId: library.id, restored })
    }
    recoveringNow = recovering
    const opener = base ? page.getByRole('button', { name: recovering ? 'New personal knowledge base' : 'Actions for “Focus library”', exact: true })
      : page.getByRole('button', { name: recovering ? 'Add materials' : 'Actions for “Focus.md”', exact: true })
    await opener.click()
    if (!base || !recovering) await page.getByRole('menuitem', { name: base ? 'Edit library' : recovering ? 'New document' : 'Modify', exact: true }).click()
    const dialog = page.locator('[role="dialog"][aria-modal="true"]')
    const original = await dialog.elementHandle()
    const close = dialog.getByRole('button', { name: 'Close', exact: true })
    const closeNode = await close.elementHandle()
    const retry = dialog.getByRole('button', { name: 'Retry', exact: true })
    await retry.waitFor()
    const button = await retry.elementHandle()
    const notice = await dialog.getByRole('alert').elementHandle()
    const box = await retry.boundingBox()
    await retry.press('Enter')
    await expect.poll(() => reads).toBe(2)
    expect(await retry.getAttribute('aria-disabled')).toBe('true')
    expect(await retry.boundingBox()).toEqual(box)
    expect(await retry.evaluate((node, previous) => node === previous && node === globalThis.document.activeElement, button)).toBe(true)
    expect(await dialog.getByRole('alert').evaluate((node, previous) => node === previous, notice)).toBe(true)
    await page.keyboard.press('Enter')
    expect(reads).toBe(2)
    if (elsewhere) await close.focus()
    response.resolve(undefined)
    const field = dialog.getByRole('textbox', { name: base ? 'Knowledge base name' : 'Name', exact: true })
    await field.waitFor()
    const form = dialog.getByRole('form')
    const focused = elsewhere ? close : form
    expect(await dialog.evaluate((node, previous) => node === previous, original)).toBe(true)
    expect(await close.evaluate((node, previous) => node === previous, closeNode)).toBe(true)
    await expect.poll(() => focused.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    expect(await field.isDisabled()).toBe(restored)
    expect(await field.inputValue()).toBe(restored ? 'Retained draft' : recovering ? '' : base ? library.name : 'Focus')
    expect(await dialog.getByRole('status', { name: 'Loading…', exact: true }).count()).toBe(0)
    if (!elsewhere && ['document', 'library', 'document-restored'].includes(surface)) {
      await capture(page, `editor-read-${surface}`, dialog, focused)
    }
    if (!elsewhere) {
      await page.keyboard.press('Tab')
      const next = restored ? dialog.getByRole('button', { name: 'Keep and Close', exact: true }) : field
      await expect.poll(() => next.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    }
    closing = true
    await close.click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => opener.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
  },
)

it.each(['failed', 'elsewhere', 'continue'] as const)('recovers editor conflict review focus after %s', async (outcome) => {
  const response = Promise.withResolvers<undefined>()
  onTestFinished(() => { response.resolve(undefined) })
  const library = { id: 'focus-library', name: 'Focus library', scope: 'PERSONAL', canRead: true, canManage: true }
  const document = { id: 'focus-document', knowledgeBaseId: library.id, filename: 'Focus.md', sourceType: 'manual', canManage: true,
    mediaType: 'text/markdown', manualContent: 'Original contents', sizeBytes: 10, status: 'READY', chunkCount: 1,
    updatedAt: '2026-11-11T00:00:00Z', folderId: null }
  const latest = { ...document, updatedAt: '2026-11-11T01:00:00Z', manualContent: 'Latest contents' }
  let reads = 0
  const page = await boot(async (method) => {
    if (method === 'knowledge.documents.get') {
      if (++reads <= 2) return reads === 1 ? document : latest
      if (reads !== 3) throw new Error('Unexpected duplicate review read')
      await response.promise
      return { fixtureFailure: { code: 'KNOWLEDGE_SERVICE_UNAVAILABLE', message: 'Offline', retryable: true, resources: [] } }
    }
    switch (method) {
      case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
      case 'knowledge.bases.list': return [library]
      case 'knowledge.documents.list': return { items: [document], page: 1, size: 20, total: 1 }
      case 'knowledge.folders.list': return { items: [], page: 1, size: 20, total: 0 }
      case 'knowledge.documents.upload.pending': return []
      case 'knowledge.documents.save': return { fixtureFailure: { code: 'KNOWLEDGE_DOCUMENT_CONFLICT', message: 'Changed', retryable: false, resources: [] } }
      default: throw new Error(`Unexpected conflict review method: ${method}`)
    }
  })
  await page.getByRole('button', { name: 'Knowledge bases', exact: true }).click()
  await page.getByRole('button', { name: library.name, exact: true }).click()
  await page.getByRole('button', { name: 'Actions for “Focus.md”', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Modify', exact: true }).click()
  const dialog = page.locator('[role="dialog"][aria-modal="true"]')
  const content = dialog.getByRole('textbox', { name: 'Content', exact: true })
  await expect.poll(() => content.inputValue()).toBe(document.manualContent)
  await content.fill('My draft')
  const save = dialog.getByRole('button', { name: 'Save', exact: true })
  await save.click()
  await dialog.getByRole('alert').waitFor()
  const read = dialog.getByRole('button', { name: 'Read latest version', exact: true })
  await read.click()
  const accept = dialog.getByRole('button', { name: 'Confirm and continue editing my draft', exact: true })
  await accept.waitFor()
  const form = dialog.getByRole('form')
  const close = dialog.getByRole('button', { name: 'Close', exact: true })
  const comparison = dialog.getByRole('textbox', { name: 'Latest content', exact: true })
  if (outcome === 'continue') await accept.press('Enter')
  else {
    await read.press('Enter')
    await expect.poll(() => reads).toBe(3)
    await page.keyboard.press('Enter')
    expect(reads).toBe(3)
    await dialog.locator('summary').click()
    await comparison.focus()
    if (outcome === 'elsewhere') await close.focus()
    response.resolve(undefined)
    await dialog.getByRole('alert').waitFor()
  }
  await accept.waitFor({ state: 'hidden' })
  const focused = outcome === 'elsewhere' ? close : form
  await expect.poll(() => focused.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
  expect(await content.inputValue()).toBe('My draft')
  expect(await save.isDisabled()).toBe(outcome !== 'continue')
  if (outcome !== 'elsewhere') await capture(page, `editor-review-${outcome}`, dialog, focused)
})

it.each(['search-empty', 'search-replaced', 'search-reordered', 'search-failed', 'search-retry', 'search-elsewhere', 'parsed-retry', 'parsed-elsewhere'] as const)(
  'restores knowledge %s result focus without replacing retained controls or taking another control’s focus', async (surface) => {
    const response = Promise.withResolvers<undefined>()
    onTestFinished(() => { response.resolve(undefined) })
    const parsed = surface.startsWith('parsed')
    const retrying = surface.endsWith('retry') || surface.endsWith('elsewhere')
    const library = { id: 'focus-library', name: 'Focus library', scope: 'PERSONAL', canRead: true, canManage: true }
    const document = { id: 'focus-document', knowledgeBaseId: library.id, filename: 'Focus.md', mediaType: 'text/markdown',
      sizeBytes: 10, status: 'READY', chunkCount: 1, updatedAt: '2026-11-11T00:00:00Z', folderId: null }
    const hit = { sourceId: 'focus-source', knowledgeBaseId: library.id, documentId: document.id,
      filename: document.filename, locator: 'Page 1', content: 'Confirmed knowledge text.' }
    const other = { ...hit, sourceId: 'other-source', filename: 'Other.md' }
    const failure = { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture read failure', retryable: true, resources: [] } }
    let reads = 0
    const page = await boot(async (method) => {
      if (method === (parsed ? 'knowledge.documents.read' : 'knowledge.search')) {
        reads++
        if (reads === 1) return retrying ? failure : [hit, other]
        if (reads !== 2) throw new Error('Unexpected duplicate knowledge read')
        await response.promise
        if (parsed) return { items: [{ id: 'focus-fragment', documentId: document.id, content: hit.content, locator: hit.locator }],
          page: 1, size: 20, total: 1 }
        if (surface === 'search-failed') return failure
        return surface === 'search-empty' ? [] : surface === 'search-reordered' ? [other, hit]
          : surface === 'search-replaced' ? [other] : [hit]
      }
      switch (method) {
        case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
        case 'knowledge.bases.list': return [library]
        case 'knowledge.documents.upload.pending': return []
        case 'knowledge.folders.list': return { items: [], page: 1, size: 20, total: 0 }
        case 'knowledge.documents.list': return { items: [document], page: 1, size: 20, total: 1 }
        default: throw new Error(`Unexpected knowledge focus method: ${method}`)
      }
    })
    await page.getByRole('button', { name: 'Knowledge bases', exact: true }).click()
    await page.getByRole('button', { name: library.name, exact: true }).click()
    const materials = page.locator('[data-knowledge-content]')
    await materials.getByRole('button', { name: document.filename, exact: true }).waitFor()
    if (parsed) {
      await materials.getByRole('button', { name: 'Actions for “Focus.md”', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Parsed content', exact: true }).click()
    } else {
      await materials.getByRole('button', { name: 'Search content', exact: true }).click()
      await materials.getByRole('searchbox', { name: 'Search content', exact: true }).fill('knowledge')
      await materials.getByRole('button', { name: 'Search', exact: true }).press('Enter')
    }
    const region = materials.getByRole('region', { name: parsed ? 'Parsed content' : 'Search content', exact: true })
    const input = region.getByRole('searchbox', { name: 'Search content', exact: true })
    const back = parsed ? materials.locator('[data-knowledge-reader-back]') : region.getByRole('button', { name: 'Back to materials', exact: true })
    const result = region.getByRole('button', { name: /Focus.md Page 1/ })
    const retry = region.getByRole('button', { name: 'Retry', exact: true })
    const original = await (retrying ? retry : result).elementHandle()
    const action = retrying ? retry : region.getByRole('button', { name: 'Search', exact: true })
    const box = await action.boundingBox()
    await action.press('Enter')
    await expect.poll(() => reads).toBe(2)
    expect(await action.getAttribute('aria-disabled')).toBe('true')
    expect(await action.evaluate(node => node instanceof HTMLButtonElement && node.disabled)).toBe(false)
    expect(await action.boundingBox()).toEqual(box)
    await page.keyboard.press('Enter')
    expect(reads).toBe(2)
    if (!retrying) await result.focus()
    if (surface.endsWith('elsewhere')) await back.focus()
    expect(await (retrying ? retry : result).evaluate((node, previous) => node === previous, original)).toBe(true)
    response.resolve(undefined)
    if (retrying) await retry.waitFor({ state: 'hidden' })
    else await expect.poll(() => action.getAttribute('aria-busy')).toBe('false')
    if (parsed) await region.getByText(hit.content, { exact: true }).waitFor()
    else if (surface === 'search-failed') await region.getByRole('alert').waitFor()
    else if (surface === 'search-empty') await region.getByText('No matching content. Try a more specific question or keywords.', { exact: true }).waitFor()
    else await region.getByRole('button', { name: surface === 'search-replaced' ? /Other.md Page 1/ : /Focus.md Page 1/ }).waitFor()
    const focused = surface.endsWith('elsewhere') ? back : parsed ? region : surface === 'search-reordered' ? result : input
    await expect.poll(() => focused.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    if (surface === 'search-reordered') expect(await result.evaluate((node, previous) => node === previous, original)).toBe(true)
    if (retrying) expect(await retry.count()).toBe(0)
    if (['search-empty', 'search-reordered', 'parsed-retry'].includes(surface)) await capture(page, `read-focus-${surface}`, region, focused)
  },
)

it.each(['source-retry', 'source-elsewhere', 'original-retry', 'original-elsewhere'] as const)(
  'hands knowledge %s focus to its inline reader while retaining pending controls', async (surface) => {
    const response = Promise.withResolvers<undefined>()
    onTestFinished(() => { response.resolve(undefined) })
    const original = surface.startsWith('original')
    const elsewhere = surface.endsWith('elsewhere')
    const library = { id: 'focus-library', name: 'Focus library', scope: 'PERSONAL', canRead: true, canManage: true }
    const document = { id: 'focus-document', knowledgeBaseId: library.id, filename: 'Focus.md', sourceType: 'file', mediaType: 'text/markdown',
      sizeBytes: 10, status: 'READY', chunkCount: 1, updatedAt: '2026-11-11T00:00:00Z', folderId: null,
      previewMaxBytes: 50 * 1024 * 1024, downloadMaxBytes: 250 * 1024 * 1024, uploadMaxBytes: 50 * 1024 * 1024 }
    const hit = { sourceId: 'focus-source', knowledgeBaseId: library.id, documentId: document.id,
      filename: document.filename, locator: 'Page 1', content: 'Confirmed source passage.' }
    const bytes = new TextEncoder().encode('# Confirmed original file\n\nOriginal Markdown content.')
    const failure = { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture read failure', retryable: true, resources: [] } }
    let reads = 0
    const page = await boot(async (method) => {
      if (method === (original ? 'knowledge.documents.previewMetadata' : 'knowledge.sources.read')) {
        if (++reads === 1) return failure
        if (reads !== 2) throw new Error('Unexpected duplicate reader request')
        await response.promise
        return original ? document : hit
      }
      switch (method) {
        case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
        case 'knowledge.bases.list': return [library]
        case 'knowledge.documents.upload.pending': return []
        case 'knowledge.folders.list': return { items: [], page: 1, size: 20, total: 0 }
        case 'knowledge.documents.list': return { items: [document], page: 1, size: 20, total: 1 }
        case 'knowledge.search': return [hit]
        case 'knowledge.documents.previewMetadata': return document
        case 'knowledge.documents.preview.open': return { transferId: 'focus-transfer', fileName: document.filename,
          mediaType: document.mediaType, byteLength: bytes.byteLength, maxBytes: document.previewMaxBytes, chunkSize: 256 * 1024 }
        case 'knowledge.documents.preview.read': return { data: [...bytes], offset: 0, eof: true }
        case 'knowledge.documents.preview.close': return { closed: true }
        default: throw new Error(`Unexpected inline reader method: ${method}`)
      }
    })
    await page.getByRole('button', { name: 'Knowledge bases', exact: true }).click()
    await page.getByRole('button', { name: library.name, exact: true }).click()
    const materials = page.locator('[data-knowledge-content]')
    await materials.getByRole('button', { name: document.filename, exact: true }).waitFor()
    if (original) await materials.getByRole('button', { name: document.filename, exact: true }).click()
    else {
      await materials.getByRole('button', { name: 'Search content', exact: true }).click()
      const search = materials.getByRole('region', { name: 'Search content', exact: true })
      await search.getByRole('searchbox', { name: 'Search content', exact: true }).fill('source')
      await search.getByRole('button', { name: 'Search', exact: true }).press('Enter')
      await search.getByRole('button', { name: /Focus.md Page 1/ }).click()
    }
    const reader = materials.getByRole('region', { name: 'View file', exact: true })
    const retry = reader.getByRole('button', { name: 'Retry', exact: true })
    await retry.waitFor()
    const notice = await reader.getByRole('alert').elementHandle()
    const button = await retry.elementHandle()
    const box = await retry.boundingBox()
    await retry.press('Enter')
    await expect.poll(() => reads).toBe(2)
    expect(await retry.getAttribute('aria-busy')).toBe('true')
    expect(await retry.getAttribute('aria-disabled')).toBe('true')
    expect(await retry.evaluate(node => node instanceof HTMLButtonElement && node.disabled)).toBe(false)
    expect(await retry.boundingBox()).toEqual(box)
    expect(await reader.getByRole('alert').evaluate((node, prior) => node === prior, notice)).toBe(true)
    await page.keyboard.press('Enter')
    expect(reads).toBe(2)
    expect(await retry.evaluate((node, prior) => node === prior && node === globalThis.document.activeElement, button)).toBe(true)
    const back = original ? materials.locator('[data-knowledge-reader-back]')
      : materials.getByRole('button', { name: 'Back to search results', exact: true })
    if (elsewhere) await back.focus()
    response.resolve(undefined)
    await retry.waitFor({ state: 'hidden' })
    if (original) await reader.getByRole('heading', { name: 'Confirmed original file', exact: true }).waitFor()
    else await reader.getByText(hit.content, { exact: true }).waitFor()
    await expect.poll(() => (elsewhere ? back : reader).evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    if (!original && !elsewhere) {
      await reader.getByRole('button', { name: 'View original file', exact: true }).press('Enter')
      await reader.getByRole('heading', { name: 'Confirmed original file', exact: true }).waitFor()
      expect(await reader.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    }
    await capture(page, `reader-focus-${surface}`, reader, elsewhere ? back : reader)
  },
)

it.each([
  { surface: 'parsed', elsewhere: false }, { surface: 'parsed', elsewhere: true },
  { surface: 'materials', elsewhere: false }, { surface: 'materials', elsewhere: true },
])('recovers removed $surface pagination focus after a smaller total (focus elsewhere: $elsewhere)', async ({ surface, elsewhere }) => {
  const parsed = surface === 'parsed'
  const response = Promise.withResolvers<undefined>()
  onTestFinished(() => { response.resolve(undefined) })
  const library = { id: 'focus-library', name: 'Focus library', scope: 'PERSONAL', canRead: true, canManage: true }
  const document = { id: 'focus-document', knowledgeBaseId: library.id, filename: 'Focus.md', mediaType: 'text/markdown',
    sizeBytes: 10, status: 'READY', chunkCount: 21, updatedAt: '2026-11-11T00:00:00Z', folderId: null }
  const requests: unknown[] = []
  const page = await boot(async (method, payload) => {
    if (method === (parsed ? 'knowledge.documents.read' : 'knowledge.documents.list')) {
      if (typeof payload !== 'object' || payload === null || !('page' in payload)) throw new Error('Missing parsed page')
      requests.push(payload.page)
      if (requests.length === 2) await response.promise
      if (requests.length > 3) throw new Error('Unexpected duplicate parsed-page read')
      if (!parsed) return { items: requests.length === 1 ? [document] : [], page: payload.page, size: 20,
        total: requests.length === 1 ? 21 : 0 }
      return payload.page === 2 ? { items: [], page: 2, size: 20, total: 1 }
        : { items: [{ id: 'focus-fragment', documentId: document.id, locator: 'Page 1',
          content: requests.length === 1 ? 'Confirmed original passage.' : 'Confirmed remaining passage.' }],
        page: 1, size: 20, total: requests.length === 1 ? 21 : 1 }
    }
    switch (method) {
      case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
      case 'knowledge.bases.list': return [library]
      case 'knowledge.documents.upload.pending': return []
      case 'knowledge.folders.list': return { items: [], page: typeof payload === 'object' && payload !== null && 'page' in payload ? payload.page : 1, size: 20, total: 0 }
      case 'knowledge.documents.list': return { items: [document], page: 1, size: 20, total: 1 }
      default: throw new Error(`Unexpected parsed pagination method: ${method}`)
    }
  })
  await page.getByRole('button', { name: 'Knowledge bases', exact: true }).click()
  await page.getByRole('button', { name: library.name, exact: true }).click()
  const materials = page.locator('[data-knowledge-content]')
  if (parsed) {
    await materials.getByRole('button', { name: 'Actions for “Focus.md”', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Parsed content', exact: true }).click()
  }
  const reader = parsed ? materials.getByRole('region', { name: 'Parsed content', exact: true }) : materials
  const next = reader.getByRole('button', { name: 'Next page', exact: true })
  await next.press('Enter')
  await expect.poll(() => requests).toEqual([1, 2])
  expect(await next.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
  expect(await next.getAttribute('aria-disabled')).toBe('true')
  await page.keyboard.press('Enter')
  expect(requests).toEqual([1, 2])
  const back = parsed ? materials.locator('[data-knowledge-reader-back]') : materials.getByRole('button', { name: 'Search content', exact: true })
  if (elsewhere) await back.focus()
  const scroll = await materials.evaluate(node => ({ top: node.scrollTop, left: node.scrollLeft }))
  response.resolve(undefined)
  await reader.getByText(parsed ? 'Confirmed remaining passage.' : 'No materials yet', { exact: true }).waitFor()
  await next.waitFor({ state: 'hidden' })
  const target = elsewhere ? back : parsed ? reader : materials.locator('[data-knowledge-materials-heading]')
  await expect.poll(() => target.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
  expect(await materials.evaluate(node => ({ top: node.scrollTop, left: node.scrollLeft }))).toEqual(scroll)
  expect(requests).toEqual([1, 2, 1])
  await capture(page, `${surface}-pagination-${elsewhere ? 'elsewhere' : 'reader'}`, reader, target)
})

it.each(['removed', 'failed', 'elsewhere'] as const)('retains processing focus after a summary is %s', async (outcome) => {
  const response = Promise.withResolvers<undefined>()
  onTestFinished(() => { response.resolve(undefined) })
  const library = { id: 'focus-library', name: 'Focus library', scope: 'PERSONAL', canRead: true, canManage: true }
  const document = { id: 'focus-document', knowledgeBaseId: library.id, filename: 'Focus.md', mediaType: 'text/markdown',
    sizeBytes: 10, status: 'READY', chunkCount: 1, updatedAt: '2026-11-11T00:00:00Z', folderId: null }
  let reads = 0
  const page = await boot(async (method) => {
    if (method === 'knowledge.documents.processing') {
      if (++reads > 2) throw new Error('Unexpected duplicate processing read')
      if (reads === 2) await response.promise
      if (reads === 2 && outcome === 'failed') return { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture read failure', retryable: true, resources: [] } }
      return { documentId: document.id, knowledgeBaseId: library.id, status: 'READY', attempt: 1, stalled: false,
        summaryStatus: 'COMPLETED', summary: reads === 1 ? '[Read reference](https://example.com/reference)' : 'Confirmed updated summary.',
        summaryEnabled: true, stages: ['DOCUMENT', 'CHUNKING', 'EMBEDDING', 'MULTIMODAL', 'ENRICHMENT']
          .map(name => ({ name, status: 'COMPLETED', durationMillis: 1250 })) }
    }
    switch (method) {
      case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
      case 'knowledge.bases.list': return [library]
      case 'knowledge.documents.upload.pending': return []
      case 'knowledge.folders.list': return { items: [], page: 1, size: 20, total: 0 }
      case 'knowledge.documents.list': return { items: [document], page: 1, size: 20, total: 1 }
      default: throw new Error(`Unexpected processing focus method: ${method}`)
    }
  })
  await page.getByRole('button', { name: 'Knowledge bases', exact: true }).click()
  await page.getByRole('button', { name: library.name, exact: true }).click()
  const materials = page.locator('[data-knowledge-content]')
  await materials.getByRole('button', { name: 'Actions for “Focus.md”', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Processing details', exact: true }).click()
  const reader = materials.getByRole('region', { name: 'Processing details', exact: true })
  const link = reader.getByRole('link', { name: 'Read reference', exact: true })
  await link.waitFor()
  const refresh = reader.getByRole('button', { name: 'Refresh', exact: true })
  await refresh.press('Enter')
  await expect.poll(() => reads).toBe(2)
  await link.focus()
  expect(await refresh.getAttribute('aria-disabled')).toBe('true')
  const back = materials.locator('[data-knowledge-reader-back]')
  if (outcome === 'elsewhere') await back.focus()
  const scroll = await materials.evaluate(node => node.scrollTop)
  response.resolve(undefined)
  if (outcome === 'failed') await reader.getByRole('alert').waitFor()
  else await reader.getByText('Confirmed updated summary.', { exact: true }).waitFor()
  const target = outcome === 'elsewhere' ? back : reader
  await expect.poll(() => target.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
  expect(await link.count()).toBe(0)
  expect(await materials.evaluate(node => node.scrollTop)).toBe(scroll)
  await capture(page, `processing-result-${outcome}`, reader, target)
})

it.each(['path-last', 'list-last', 'elsewhere'] as const)('retains destination retry focus after both confirmations (order: %s)', async (order) => {
  const path = Promise.withResolvers<undefined>()
  const list = Promise.withResolvers<undefined>()
  onTestFinished(() => { path.resolve(undefined); list.resolve(undefined) })
  const library = { id: 'focus-library', name: 'Focus library', scope: 'PERSONAL', canRead: true, canManage: true }
  const folder = { id: 'focus-folder', name: 'Focus folder', parentId: null, updatedAt: '2026-11-11T00:00:00Z' }
  const document = { id: 'focus-document', knowledgeBaseId: library.id, filename: 'Focus.md', mediaType: 'text/markdown',
    sizeBytes: 10, status: 'READY', chunkCount: 1, updatedAt: '2026-11-11T00:00:00Z', folderId: null }
  let paths = 0, lists = 0
  const page = await boot(async (method, payload) => {
    if (method === 'knowledge.folders.get') {
      if (++paths === 2) await path.promise
      if (paths > 2) throw new Error('Unexpected duplicate destination path read')
      return folder
    }
    if (method === 'knowledge.folders.list') {
      if (typeof payload === 'object' && payload !== null && 'parentId' in payload && payload.parentId === folder.id) {
        if (++lists === 1) return { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture read failure', retryable: true, resources: [] } }
        if (lists > 2) throw new Error('Unexpected duplicate destination list read')
        await list.promise
        return { items: [], page: 1, size: 20, total: 0 }
      }
      return { items: [folder], page: 1, size: 20, total: 1 }
    }
    switch (method) {
      case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
      case 'knowledge.bases.list': return [library]
      case 'knowledge.documents.upload.pending': return []
      case 'knowledge.documents.list': return { items: [document], page: 1, size: 20, total: 1 }
      default: throw new Error(`Unexpected destination focus method: ${method}`)
    }
  })
  await page.getByRole('button', { name: 'Knowledge bases', exact: true }).click()
  await page.getByRole('button', { name: library.name, exact: true }).click()
  await page.getByRole('button', { name: 'Actions for “Focus.md”', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Move material', exact: true }).click()
  const dialog = page.getByRole('dialog').last()
  const other = dialog.getByRole('button', { name: 'Cancel', exact: true })
  const picker = dialog.getByRole('group', { name: 'Destination folder', exact: true })
  await picker.getByRole('button', { name: folder.name, exact: true }).click()
  const retry = picker.getByRole('button', { name: 'Retry', exact: true })
  await retry.waitFor()
  const notice = await picker.getByRole('alert').elementHandle()
  const button = await retry.elementHandle()
  const box = await retry.boundingBox()
  await retry.press('Enter')
  await expect.poll(() => [paths, lists]).toEqual([2, 2])
  expect(await retry.boundingBox()).toEqual(box)
  expect(await retry.evaluate((node, prior) => node === prior && node === globalThis.document.activeElement, button)).toBe(true)
  await page.keyboard.press('Enter')
  expect([paths, lists]).toEqual([2, 2])
  if (order === 'elsewhere') await other.focus()
  if (order === 'list-last') path.resolve(undefined)
  else list.resolve(undefined)
  await expect.poll(() => picker.getAttribute('aria-busy')).toBe('true')
  expect(await picker.getByRole('alert').evaluate((node, prior) => node === prior, notice)).toBe(true)
  expect(await dialog.getByRole('button', { name: 'Move', exact: true }).isDisabled()).toBe(true)
  if (order === 'list-last') list.resolve(undefined)
  else path.resolve(undefined)
  await retry.waitFor({ state: 'hidden' })
  await expect.poll(() => picker.getAttribute('aria-busy')).toBe('false')
  const target = order === 'elsewhere' ? other : picker
  await expect.poll(() => target.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
  expect(await dialog.getByRole('button', { name: 'Move', exact: true }).isEnabled()).toBe(true)
  await capture(page, `destination-result-${order}`, dialog, target)
})

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
    if (method === 'tasks.capabilities.read') return { knowledgeBaseIds: [] }
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

it.each([
  { result: 'retry', elsewhere: false }, { result: 'removed', elsewhere: false }, { result: 'failed', elsewhere: false },
  { result: 'retry', elsewhere: true }, { result: 'removed', elsewhere: true }, { result: 'failed', elsewhere: true },
] as const)('recovers task knowledge $result focus after reading (elsewhere: $elsewhere)', async ({ result, elsewhere }) => {
  const response = Promise.withResolvers<undefined>()
  onTestFinished(() => { response.resolve(undefined) })
  const policy = { id: 'policy', name: 'Policy', scope: 'COMPANY' }
  const research = { id: 'research', name: 'Research', scope: 'PERSONAL' }
  const failure = { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture read failure', retryable: true, resources: [] } }
  let reads = 0
  const page = await boot(async (method) => {
    if (method === 'tasks.capabilities.read') return { knowledgeBaseIds: [policy.id] }
    if (method !== 'knowledge.bases.list') throw new Error(`Unexpected selection recovery method: ${method}`)
    if (++reads === 1) return [policy, research]
    if (result === 'retry' && reads === 2) return failure
    if (reads !== (result === 'retry' ? 3 : 2)) throw new Error('Unexpected duplicate selection read')
    await response.promise
    return result === 'failed' ? failure : result === 'removed' ? [policy] : [policy, research]
  })
  await page.getByRole('group', { name: 'Task knowledge bases', exact: true }).getByRole('button', { name: policy.name, exact: true }).click()
  const dialog = page.getByRole('dialog').last()
  const origin = result === 'retry' ? dialog.getByRole('button', { name: 'Retry', exact: true })
    : dialog.getByRole('checkbox', { name: research.name, exact: true })
  await origin.waitFor()
  if (result === 'retry') await origin.press('Enter')
  else await origin.focus()
  await expect.poll(() => reads).toBe(result === 'retry' ? 3 : 2)
  const other = dialog.getByRole('button', { name: 'Cancel', exact: true })
  if (elsewhere) await other.focus()
  response.resolve(undefined)
  if (result === 'retry') await dialog.getByRole('checkbox', { name: research.name, exact: true }).waitFor()
  else if (result === 'failed') await dialog.getByRole('alert').waitFor()
  await origin.waitFor({ state: 'hidden' })
  const target = elsewhere ? other : dialog.getByRole('searchbox')
  await expect.poll(() => target.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
  expect(reads).toBe(result === 'retry' ? 3 : 2)
  await capture(page, `task-selection-${result}-${elsewhere ? 'elsewhere' : 'recovered'}`, dialog, target)
})

it.each((['unavailable', 'department'] as const).flatMap(change => [false, true].map(elsewhere => ({ change, elsewhere }))))(
  'keeps task knowledge controls through $change regrouping and restoration (elsewhere=$elsewhere)', async ({ change, elsewhere }) => {
    const response = Promise.withResolvers<undefined>()
    onTestFinished(() => { response.resolve(undefined) })
    const policy = { id: 'policy', name: 'Policy', scope: 'COMPANY' }
    const manual = { id: 'manual', name: 'Manual', scope: 'COMPANY' }
    let reads = 0
    const page = await boot(async (method) => {
      if (method === 'tasks.capabilities.read') return { knowledgeBaseIds: [policy.id] }
      if (method !== 'knowledge.bases.list') throw new Error(`Unexpected knowledge regrouping method: ${method}`)
      if (++reads === 1 || reads === 3) return [policy, manual]
      if (reads !== 2 && reads !== 4) throw new Error('Duplicate knowledge regrouping read')
      await response.promise
      return change === 'unavailable' ? [policy]
        : [policy, { ...manual, scope: 'DEPARTMENT', ownerDepartmentId: '22', ownerName: 'Product' }]
    })
    await page.getByRole('group', { name: 'Task knowledge bases', exact: true }).getByRole('button', { name: policy.name, exact: true }).click()
    const dialog = page.getByRole('dialog').last()
    const checkbox = dialog.getByRole('checkbox', { name: manual.name, exact: true })
    await checkbox.check()
    const search = dialog.getByRole('searchbox')
    await search.fill('manual')
    await search.evaluate((node) => { if (node instanceof HTMLInputElement) node.setSelectionRange(1, 3) })
    const originalSearch = await search.elementHandle(), originalCheckbox = await checkbox.elementHandle()
    const originalDialog = await dialog.elementHandle(), searchBounds = await search.boundingBox()
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
    await (elsewhere ? cancel : checkbox).focus()
    await expect.poll(() => reads).toBe(2)
    response.resolve(undefined)
    const regrouped = dialog.getByRole('checkbox', { name: change === 'unavailable' ? manual.id : manual.name, exact: true })
    await regrouped.waitFor()
    const target = elsewhere ? cancel : regrouped
    await expect.poll(() => target.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    expect(await regrouped.evaluate((node, previous) => node === previous, originalCheckbox)).toBe(true)
    expect(await regrouped.isChecked()).toBe(true)
    expect(await search.evaluate((node, previous) => node === previous, originalSearch)).toBe(true)
    expect(await search.inputValue()).toBe('manual')
    expect(await search.evaluate(node => node instanceof HTMLInputElement && [node.selectionStart, node.selectionEnd])).toEqual([1, 3])
    expect(await search.boundingBox()).toEqual(searchBounds)
    if (change === 'department') await dialog.getByRole('heading', { name: 'Department · Product (22)', exact: true }).waitFor()
    if (!elsewhere) await capture(page, `knowledge-regroup-${change}`, dialog, target)
    await page.evaluate(() => globalThis.dispatchEvent(new CustomEvent('control-product-event', { detail: { type: 'catalog.changed' } })))
    await dialog.getByRole('heading', { name: 'Company', exact: true }).waitFor()
    await expect.poll(() => (elsewhere ? cancel : checkbox).evaluate(node => node === globalThis.document.activeElement)).toBe(true)
    expect(await checkbox.evaluate((node, previous) => node === previous, originalCheckbox)).toBe(true)
    expect(await checkbox.isChecked()).toBe(true)
    expect(await dialog.evaluate((node, previous) => node === previous, originalDialog)).toBe(true)
    expect(await search.inputValue()).toBe('manual')
    expect(await search.evaluate(node => node instanceof HTMLInputElement && [node.selectionStart, node.selectionEnd])).toEqual([1, 3])
    expect(reads).toBe(3)
    if (!elsewhere && change === 'unavailable') await capture(page, 'knowledge-regroup-restored', dialog, checkbox)
    if (!elsewhere && change === 'unavailable') {
      await page.evaluate(() => globalThis.dispatchEvent(new CustomEvent('control-product-event', { detail: { type: 'catalog.changed' } })))
      const unavailable = dialog.getByRole('checkbox', { name: manual.id, exact: true })
      await unavailable.waitFor()
      expect(await unavailable.evaluate((node, previous) => node === previous
        && node === globalThis.document.activeElement, originalCheckbox)).toBe(true)
      await unavailable.press('Space')
      await unavailable.waitFor({ state: 'hidden' })
      await expect.poll(() => search.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
      expect(await search.inputValue()).toBe('manual')
      expect(await search.evaluate(node => node instanceof HTMLInputElement && [node.selectionStart, node.selectionEnd])).toEqual([1, 3])
      expect(await originalCheckbox?.evaluate(node => node.isConnected)).toBe(false)
      expect(reads).toBe(4)
    }
  },
)

it.each(['markdown', 'url', 'folder', 'base-create', 'base-edit'] as const)(
  'retains the %s suspension focus and original save through identity failure and retry', async (kind) => {
    const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }) })
    const library = { id: 'focus-library', name: 'Focus library', description: '', scope: 'PERSONAL', canRead: true, canManage: true,
      updatedAt: '2026-11-11T00:00:00Z' }
    const method = kind === 'markdown' ? 'knowledge.documents.save' : kind === 'url' ? 'knowledge.documents.importUrl'
      : kind === 'folder' ? 'knowledge.folders.create' : kind === 'base-create' ? 'knowledge.bases.create' : 'knowledge.bases.update'
    const requests: unknown[] = []
    let checking = false, reads = 0
    const page = await boot(async (requested, payload) => {
      if (requested === method) {
        requests.push(payload)
        return { fixtureFailure: { code: 'IDEMPOTENCY_OPERATION_UNKNOWN', message: 'Fixture outcome unknown', retryable: true, resources: [] } }
      }
      switch (requested) {
        case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
        case 'knowledge.bases.list': return [library]
        case 'knowledge.bases.get': return library
        case 'knowledge.documents.list':
        case 'knowledge.folders.list': return { items: [], page: 1, size: 20, total: 0 }
        case 'knowledge.documents.upload.pending': return []
        default: throw new Error(`Unexpected suspension request: ${requested}`)
      }
    }, async () => {
      if (checking) {
        const index = reads++, gate = gates[index]
        if (!gate) throw new Error('Unexpected duplicate identity check')
        await gate.promise
        if (index === 0) return { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture identity unavailable', retryable: true, resources: [] } }
      }
      return { authenticated: true, employeeId: 'employee-fixture', displayName: 'Control reviewer' }
    })
    await page.getByRole('button', { name: 'Knowledge bases', exact: true }).click()
    const open = async () => {
      if (kind === 'base-create') await page.getByRole('button', { name: 'New personal knowledge base', exact: true }).click()
      else if (kind === 'base-edit') {
        await page.getByRole('button', { name: 'Actions for “Focus library”', exact: true }).click()
        await page.getByRole('menuitem', { name: 'Edit library', exact: true }).click()
      } else {
        if (await page.getByRole('button', { name: 'Add materials', exact: true }).count() === 0) {
          await page.getByRole('button', { name: /Focus library/ }).first().click()
        }
        await page.getByRole('button', { name: 'Add materials', exact: true }).click()
        await page.getByRole('menuitem', { name: kind === 'markdown' ? 'New document' : kind === 'url' ? 'Import webpage' : 'New folder', exact: true }).click()
      }
    }
    await open()
    const dialog = page.getByRole('dialog').last()
    const field = dialog.getByRole('textbox', { name: kind.startsWith('base-') ? 'Knowledge base name'
      : kind === 'url' ? 'Name (optional)' : kind === 'folder' ? 'Folder name' : 'Name', exact: true })
    await field.fill('Retained draft')
    if (kind === 'markdown') await dialog.getByRole('textbox', { name: 'Content', exact: true }).fill('Retained {{literal}}.')
    if (kind === 'url') await dialog.getByRole('textbox', { name: 'Website URL', exact: true }).fill('https://example.test/retained')
    await dialog.getByRole('button', { name: kind === 'base-create' ? 'Create' : kind === 'url' ? 'Start import' : 'Save', exact: true }).click()
    const notice = await dialog.getByRole('alert').elementHandle()
    const action = dialog.getByRole('button', { name: 'Keep and Close', exact: true })
    const original = await action.elementHandle()
    const save = dialog.getByRole('button', { name: 'Retry Original Save', exact: true })
    checking = true
    for (let attempt = 0; attempt < 2; attempt++) {
      await action.press('Enter')
      await expect.poll(() => reads).toBe(attempt + 1)
      expect(await action.evaluate((node, prior) => node === prior && node === globalThis.document.activeElement, original)).toBe(true)
      expect(await action.getAttribute('aria-disabled')).toBe('true')
      expect(await action.getAttribute('aria-busy')).toBe('true')
      expect(await save.getAttribute('aria-busy')).toBe('false')
      expect(await save.getAttribute('aria-disabled')).toBe('true')
      expect(await dialog.getByRole('alert').evaluate((node, prior) => node === prior, notice)).toBe(true)
      await page.keyboard.press('Enter')
      await page.keyboard.press(' ')
      await save.dispatchEvent('click')
      await dialog.getByRole('button', { name: 'Close', exact: true }).dispatchEvent('click')
      await page.keyboard.press('Escape')
      expect(reads).toBe(attempt + 1)
      expect(requests).toHaveLength(1)
      expect(await dialog.isVisible()).toBe(true)
      expect(await dialog.getByText('Wait for the current operation to finish before closing.', { exact: true }).isVisible()).toBe(true)
      if (attempt === 1) await capture(page, `suspend-${kind}`, dialog, action)
      gates[attempt]!.resolve(undefined)
      if (attempt === 0) {
        await expect.poll(() => action.getAttribute('aria-busy')).toBe('false')
        expect(await action.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
        expect(await field.inputValue()).toBe('Retained draft')
      }
    }
    await dialog.waitFor({ state: 'hidden' })
    checking = false
    await open()
    await field.waitFor()
    expect(await field.inputValue()).toBe('Retained draft')
    await save.click()
    await expect.poll(() => requests.length).toBe(2)
    expect(requests[1]).toEqual(requests[0])
    await dialog.getByRole('alert').waitFor()
  },
)

it.each(['file-delete', 'folder-delete', 'base-delete', 'file-move', 'file-download', 'file-reindex', 'file-cancel', 'add-upload', 'folder-upload'] as const)(
  'retains the %s menu or confirmation through failure and retry', async (surface) => {
    const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }) })
    const method = { 'file-delete': 'knowledge.documents.delete', 'folder-delete': 'knowledge.folders.delete', 'base-delete': 'knowledge.bases.delete',
      'file-move': 'knowledge.documents.move', 'file-download': 'knowledge.documents.download', 'file-reindex': 'knowledge.documents.reindex',
      'file-cancel': 'knowledge.documents.cancel', 'add-upload': 'knowledge.documents.upload.select', 'folder-upload': 'knowledge.documents.upload.select' }[surface]
    const confirm = ['file-delete', 'folder-delete', 'base-delete', 'file-move'].includes(surface)
    const library = { id: 'focus-library', name: 'Focus library', scope: 'PERSONAL', canRead: true, canManage: true }
    const document = { id: 'focus-document', knowledgeBaseId: library.id, filename: 'Focus.md', mediaType: 'text/markdown',
      sizeBytes: 10, status: surface === 'file-cancel' ? 'PROCESSING' : 'READY', chunkCount: 1, updatedAt: '2026-11-11T00:00:00Z', folderId: null }
    const folder = { id: 'focus-folder', name: 'Focus folder', parentId: null, updatedAt: document.updatedAt }
    const requests: unknown[] = []
    const page = await boot(async (requested, payload) => {
      if (requested === method) {
        requests.push(payload)
        const gate = gates[requests.length - 1]
        if (!gate) throw new Error('Unexpected duplicate material action')
        await gate.promise
        return { fixtureFailure: { code: 'IDEMPOTENCY_OPERATION_UNKNOWN', message: 'Fixture outcome unknown', retryable: true, resources: [] } }
      }
      switch (requested) {
        case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
        case 'knowledge.bases.list': return [library]
        case 'knowledge.bases.get': return library
        case 'knowledge.documents.list': return { items: [document], page: 1, size: 20, total: 1 }
        case 'knowledge.folders.list': {
          const items = typeof payload === 'object' && payload !== null && 'parentId' in payload && payload.parentId === null ? [folder] : []
          return { items, page: 1, size: 20, total: items.length }
        }
        case 'knowledge.folders.get': return folder
        case 'knowledge.documents.upload.pending': return []
        default: throw new Error(`Unexpected material action: ${requested}`)
      }
    })
    await page.getByRole('button', { name: 'Knowledge bases', exact: true }).click()
    await page.getByRole('button', { name: /Focus library/ }).first().waitFor()
    if (surface !== 'base-delete') await page.getByRole('button', { name: /Focus library/ }).first().click()
    const triggerName = surface === 'base-delete' ? 'Actions for “Focus library”' : surface.startsWith('folder-') ? 'Folder actions for Focus folder'
      : surface === 'add-upload' ? 'Add materials' : 'Actions for “Focus.md”'
    const trigger = page.getByRole('button', { name: triggerName, exact: true })
    const menuLabel = { 'file-delete': 'Delete', 'folder-delete': 'Delete folder', 'base-delete': 'Delete knowledge base', 'file-move': 'Move material',
      'file-download': 'Download original file', 'file-reindex': 'Reprocess', 'file-cancel': 'Stop processing', 'add-upload': 'Upload files',
      'folder-upload': 'Upload to this folder' }[surface]
    const selectAction = async () => {
      await trigger.press('Enter')
      await page.getByRole('menuitem', { name: menuLabel, exact: true }).press('Enter')
    }
    if (confirm) {
      await selectAction()
      if (surface === 'file-move') await page.getByRole('dialog').getByRole('button', { name: folder.name, exact: true }).click()
    }
    const region = confirm ? page.getByRole('dialog').last() : page.locator('[data-knowledge-workspace]')
    const action = confirm ? region.locator('button[aria-busy]').last() : trigger
    await expect.poll(() => action.isEnabled()).toBe(true)
    const button = await action.elementHandle()
    let notice: Awaited<ReturnType<Locator['elementHandle']>> | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      if (confirm) await action.press('Enter')
      else await selectAction()
      await expect.poll(() => requests.length).toBe(attempt + 1)
      expect(await action.evaluate((node, original) =>
        node === original && node === globalThis.globalThis.document.activeElement, button)).toBe(true)
      expect(await action.getAttribute('aria-disabled')).toBe('true')
      await page.keyboard.press('Enter')
      await page.keyboard.press(' ')
      expect(requests).toHaveLength(attempt + 1)
      if (notice) expect(await region.getByRole('alert').evaluate((node, original) => node === original, notice)).toBe(true)
      if (confirm) {
        await region.getByRole('button', { name: 'Close', exact: true }).last().dispatchEvent('click')
        await region.getByRole('button', { name: 'Cancel', exact: true }).dispatchEvent('click')
        await page.keyboard.press('Escape')
        expect(await region.isVisible()).toBe(true)
      } else expect(await page.getByRole('menu').count()).toBe(0)
      if (attempt === 1) await capture(page, surface, region, action)
      gates[attempt]!.resolve(undefined)
      await expect.poll(() => action.getAttribute('aria-disabled')).toBe('false')
      expect(await action.evaluate(node => node === globalThis.globalThis.document.activeElement)).toBe(true)
      notice = await region.getByRole('alert').elementHandle()
    }
    expect(requests[1]).toEqual(requests[0])
  },
)

it.each(['upload-queue', 'upload-retry', 'release-retry', 'upload-remove', 'batch-delete', 'batch-reindex', 'batch-move'] as const)(
  'retains %s focus and request identity through failure and retry', async (surface) => {
    const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }) })
    const upload = !surface.startsWith('batch-')
    const rowRetry = surface === 'upload-retry' || surface === 'release-retry'
    const method = upload ? surface === 'release-retry' || surface === 'upload-remove'
      ? 'knowledge.documents.upload.discard' : 'knowledge.documents.upload' : `knowledge.documents.${surface.slice(6)}`
    const library = { id: 'focus-library', name: 'Focus library', scope: 'PERSONAL', canRead: true, canManage: true }
    const document = { id: 'focus-document', knowledgeBaseId: library.id, filename: 'Focus.md', mediaType: 'text/markdown',
      sizeBytes: 10, status: 'READY', chunkCount: 1, updatedAt: '2026-11-11T00:00:00Z', folderId: null }
    const folder = { id: 'focus-folder', name: 'Focus folder', parentId: null, updatedAt: document.updatedAt }
    const requests: unknown[] = []
    let uploads = 0
    const page = await boot(async (requested, payload) => {
      if (requested === 'knowledge.documents.upload') uploads++
      if (requested === method) {
        requests.push(payload)
        const failure = { fixtureFailure: { code: 'IDEMPOTENCY_OPERATION_UNKNOWN', message: 'Fixture outcome unknown', retryable: true, resources: [] } }
        if (rowRetry && requests.length === 1) return failure
        const attempt = requests.length - (rowRetry ? 2 : 1)
        const gate = gates[attempt]
        if (!gate) throw new Error('Unexpected duplicate file operation')
        await gate.promise
        if (attempt === 2) {
          if (method === 'knowledge.documents.upload.discard') return { discarded: true }
          if (method === 'knowledge.documents.delete') return { documentId: document.id, status: 'DELETING', taskId: 'focus-delete-task' }
          if (method === 'knowledge.documents.move') return { documentId: document.id, folderId: folder.id, moved: true }
          return { ...document, status: 'QUEUED' }
        }
        return failure
      }
      switch (requested) {
        case 'tasks.capabilities.read': return { knowledgeBaseIds: [] }
        case 'knowledge.bases.list': return [library]
        case 'knowledge.bases.get': return library
        case 'knowledge.documents.list': return { items: [document], page: 1, size: 20, total: 1 }
        case 'knowledge.folders.list': {
          const items = typeof payload === 'object' && payload !== null && 'parentId' in payload && payload.parentId === null ? [folder] : []
          return { items, page: 1, size: 20, total: items.length }
        }
        case 'knowledge.folders.get': return folder
        case 'knowledge.documents.upload.pending': return upload ? [{ operationId: 'fixture-upload-focus-0001', filename: 'Focus.md', pdfParseMode: 'STANDARD' }] : []
        case 'knowledge.documents.upload': return { ...document, status: 'QUEUED' }
        case 'knowledge.documents.upload.discard': return { discarded: true }
        default: throw new Error(`Unexpected file operation: ${requested}`)
      }
    })
    await page.getByRole('button', { name: 'Knowledge bases', exact: true }).click()
    await page.getByRole('button', { name: /Focus library/ }).first().click()
    if (upload) {
      await page.getByRole('button', { name: 'View uploads', exact: true }).click()
      if (rowRetry) {
        await page.getByRole('dialog').getByRole('button', { name: 'Upload files', exact: true }).click()
        await page.getByRole('dialog').getByRole('alert').waitFor()
      }
    } else {
      await page.getByRole('checkbox', { name: 'Select files on this page', exact: true }).check()
      const title = surface === 'batch-delete' ? 'Delete selected' : surface === 'batch-reindex' ? 'Reprocess selected' : 'Move selected'
      await page.getByRole('group', { name: 'Batch file actions', exact: true }).getByRole('button', { name: title, exact: true }).click()
      if (surface === 'batch-move') await page.getByRole('dialog').getByRole('button', { name: folder.name, exact: true }).click()
    }
    const dialog = page.getByRole('dialog').last()
    const label = upload ? rowRetry ? surface === 'release-retry' ? 'Retry' : 'Retry upload' : surface === 'upload-remove' ? 'Remove' : 'Upload files'
      : surface === 'batch-delete' ? 'Delete' : surface === 'batch-move' ? 'Move' : 'Reprocess'
    const action = upload && surface !== 'upload-queue' ? dialog.getByRole('listitem').getByRole('button', { name: label, exact: true })
      : dialog.locator('button[aria-busy]').last()
    await action.waitFor()
    await expect.poll(() => action.isEnabled()).toBe(true)
    const button = await action.elementHandle()
    let notice = rowRetry ? await dialog.getByRole('alert').elementHandle() : null
    for (let attempt = 0; attempt < 2; attempt++) {
      await action.press('Enter')
      const expected = attempt + (rowRetry ? 2 : 1)
      await expect.poll(() => requests.length).toBe(expected)
      expect(await action.evaluate((node, original) =>
        node === original && node === globalThis.globalThis.document.activeElement, button)).toBe(true)
      expect(await action.getAttribute('aria-disabled')).toBe('true')
      await page.keyboard.press('Enter')
      await page.keyboard.press(' ')
      if (upload) {
        for (const sibling of await dialog.locator('button[aria-busy]').all()) await sibling.dispatchEvent('click')
      }
      expect(requests).toHaveLength(expected)
      if (notice) expect(await dialog.getByRole('alert').evaluate((node, original) => node === original, notice)).toBe(true)
      if (!upload) {
        await dialog.getByRole('button', { name: 'Close', exact: true }).last().dispatchEvent('click')
        await page.keyboard.press('Escape')
        expect(await dialog.isVisible()).toBe(true)
      }
      if (attempt === 1) await capture(page, surface, dialog, action)
      gates[attempt]!.resolve(undefined)
      await expect.poll(() => action.getAttribute('aria-busy')).toBe('false')
      expect(await action.evaluate(node => node === globalThis.globalThis.document.activeElement)).toBe(true)
      notice = await dialog.getByRole('alert').elementHandle()
    }
    expect(requests.at(-1)).toEqual(requests.at(-2))
    await action.press('Enter')
    await expect.poll(() => requests.length).toBe(rowRetry ? 4 : 3)
    const elsewhere = surface === 'release-retry'
    const headerClose = dialog.getByRole('button', { name: 'Close', exact: true }).first()
    if (elsewhere) await headerClose.focus()
    gates[2]!.resolve(undefined)
    await action.waitFor({ state: 'hidden' })
    const focused = elsewhere ? headerClose : dialog.getByRole('button', { name: 'Close', exact: true }).last()
    await expect.poll(() => focused.evaluate(node => node === globalThis.globalThis.document.activeElement)).toBe(true)
    expect(await dialog.getByRole('alert').count()).toBe(0)
    expect(requests.at(-1)).toEqual(requests.at(-2))
    if (surface === 'upload-queue' || surface === 'batch-move') await capture(page, `${surface}-completed`, dialog, focused)
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(node => node.contains(globalThis.globalThis.document.activeElement))).toBe(true)
    if (surface === 'release-retry') expect(uploads).toBe(1)
    if (surface === 'upload-remove') expect(uploads).toBe(0)
  },
)

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
    if (requested === 'tasks.capabilities.read') return { knowledgeBaseIds: [] }
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
    await current.press('Enter')
    const expected = attempt + (stage === 'submit' ? 1 : 2)
    await expect.poll(() => requests).toBe(expected)
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

it.each(['stdio', 'streamable-http'] as const)('keeps %s configuration focus beside removed rows and inside new rows', async (transport) => {
  const page = await boot(async method => method === 'tasks.capabilities.read' ? { knowledgeBaseIds: [] } : [])
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
  const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
  onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }) })
  const page = await boot(async method => method === 'tasks.capabilities.read' ? { knowledgeBaseIds: [] } : [])
  let reads = 0
  await page.exposeFunction('__readConfiguration', async () => {
    const index = reads++, gate = gates[index]
    if (!gate) throw new Error('Unexpected clipboard read')
    await gate.promise
    if (index === 0) throw new Error('Clipboard temporarily unavailable')
    return action === 'update' ? 'RETAINED_KEY=updated-value' : 'NEW_KEY=new-value'
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
  await capture(page, `clipboard-${transport}-${action}`, dialog, focused)
})

it('returns to the feedback draft and caret after removing a screenshot', async () => {
  const page = await boot(async method => method === 'tasks.capabilities.read' ? { knowledgeBaseIds: [] } : [])
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

it('keeps a knowledge removal focused through failed preparation and a locked retry', async () => {
  const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
  onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }) })
  let requests = 0
  const page = await boot(async (method) => {
    if (method === 'tasks.capabilities.read') return { knowledgeBaseIds: ['policy'] }
    if (method === 'knowledge.bases.list') return [{ id: 'policy', name: 'Policy', scope: 'COMPANY' }]
    if (method === 'tasks.capabilities.prepare') {
      const gate = gates[requests++]
      if (!gate) throw new Error('Unexpected duplicate preparation')
      await gate.promise
      return { fixtureFailure: { code: 'SERVER_ERROR', message: 'Fixture preparation failure', retryable: true, resources: [] } }
    }
    return []
  })
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await composer.fill('Keep the conversation draft.')
  const references = page.getByRole('group', { name: 'Task knowledge bases', exact: true })
  const remove = references.getByRole('button', { name: 'Remove knowledge base "Policy"', exact: true })
  await remove.press('Enter')
  await expect.poll(() => requests).toBe(1)
  expect(await remove.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
  expect(await remove.evaluate(node => node instanceof HTMLButtonElement && !node.disabled)).toBe(true)
  expect(await remove.getAttribute('aria-disabled')).toBe('true')
  await page.keyboard.press('Enter')
  await page.keyboard.press(' ')
  expect(requests).toBe(1)
  gates[0]!.resolve(undefined)
  await page.getByRole('alert').waitFor()
  expect(await remove.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
  const notice = await page.getByRole('alert').elementHandle()
  await remove.press('Enter')
  await expect.poll(() => requests).toBe(2)
  expect(await page.getByRole('alert').evaluate((node, previous) => node === previous, notice)).toBe(true)
  expect(await remove.evaluate(node => node === globalThis.document.activeElement)).toBe(true)
  await capture(page, 'knowledge-removal', references, remove)
  gates[1]!.resolve(undefined)
  await expect.poll(() => remove.getAttribute('aria-disabled')).toBe('false')
  expect(await composer.textContent()).toBe('Keep the conversation draft.')
})

it.each(['feedback', 'connector', 'device', 'authorize', 'revoke', 'library', 'summary', 'knowledge-selection', 'resource-delete', 'resource-submit'] as const)(
  'retains %s submission focus through a failed request and retry', async (surface) => {
    const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    onTestFinished(() => { gates.forEach((gate) => { gate.resolve(undefined) }) })
    const authorization = surface === 'authorize' || surface === 'revoke'
    const resource = surface === 'resource-delete' || surface === 'resource-submit'
    const method = { feedback: 'support.feedback.submit', connector: 'extensions.save',
      device: 'extensions.connector.configuration.save', library: 'knowledge.bases.create', summary: 'knowledge.documents.summary.refresh',
      authorize: 'connectors.authorization.begin', revoke: 'connectors.authorization.revoke', 'knowledge-selection': 'tasks.capabilities.prepare',
      'resource-delete': 'extensions.connector.delete', 'resource-submit': 'extensions.submit' }[surface]
    const library = { id: 'focus-library', name: 'Focus library', scope: 'PERSONAL', canRead: true, canManage: true,
      updatedAt: '2026-11-11T00:00:00Z' }
    const document = { id: 'focus-document', knowledgeBaseId: library.id, filename: 'Focus.md', mediaType: 'text/markdown',
      sizeBytes: 10, status: 'READY', chunkCount: 1, updatedAt: library.updatedAt }
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
        case 'tasks.capabilities.read': return { knowledgeBaseIds: surface === 'knowledge-selection' ? [library.id] : [] }
        case 'connectors.list': return resource ? [{ id: 'focus-resource', version: '1.0.0', name: 'Focus resource', visibility: 'PERSONAL',
          canEdit: true, canSubmit: true, canDelete: true, reviewStatus: 'DRAFT' }] : surface === 'device' || authorization ? [{ id: 'focus-connector', version: '1.0.0',
          name: 'Focus connector', visibility: 'COMPANY', reviewStatus: 'PUBLISHED', canConfigure: true,
          authorizationStatus: surface === 'revoke' ? 'AUTHORIZED' : 'REQUIRED', authMode: authorization ? 'oauth' : 'none', tools: [] }] : []
        case 'extensions.connector.configuration.read': return { id: 'focus-connector', version: '1.0.0',
          transport: 'streamable-http', url: 'https://example.test/mcp', arguments: [], headers: ['Authorization'],
          environment: [], configured: false, timeoutSeconds: 60 }
        case 'knowledge.bases.list': return surface === 'library' ? [] : [library,
          ...surface === 'knowledge-selection' ? [{ ...library, id: 'second-library', name: 'Second library' }] : []]
        case 'knowledge.bases.get': return library
        case 'knowledge.folders.list': return { items: [], page: 1, size: 20, total: 0 }
        case 'knowledge.documents.list': return { items: [document], page: 1, size: 20, total: 1 }
        case 'knowledge.documents.upload.pending': return []
        case 'knowledge.documents.processing': return { documentId: document.id, knowledgeBaseId: library.id, status: 'READY',
          attempt: 0, stalled: false, summaryStatus: 'COMPLETED', summary: 'Keep this summary.', summaryEnabled: true, stages: [] }
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
      await page.getByRole('button', { name: 'Control reviewer', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Feedback', exact: true }).click()
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Retain my feedback.')
    } else if (surface === 'knowledge-selection') {
      await page.getByRole('group', { name: 'Task knowledge bases', exact: true }).getByRole('button', { name: library.name, exact: true }).click()
      await page.getByRole('checkbox', { name: 'Second library', exact: true }).check()
    } else if (surface === 'connector' || surface === 'device' || authorization || resource) {
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
    } else {
      await page.getByRole('button', { name: 'Knowledge bases', exact: true }).click()
      if (surface === 'library') {
        await page.getByRole('button', { name: 'New personal knowledge base', exact: true }).click()
        await page.getByRole('textbox', { name: 'Knowledge base name', exact: true }).fill('Retain my library')
      } else {
        await page.getByRole('button', { name: /Focus library/ }).first().click()
        await page.getByRole('button', { name: 'Actions for “Focus.md”', exact: true }).click()
        await page.getByRole('menuitem', { name: 'Processing details', exact: true }).click()
      }
    }
    const region = surface === 'summary' ? page.getByRole('region', { name: 'Processing details', exact: true })
      : page.getByRole('dialog').last()
    const actionName = { feedback: 'Submit feedback', connector: 'Add', device: 'Save connector', library: 'Create',
      summary: 'Regenerate summary', authorize: 'Connect account', revoke: 'Disconnect account', 'knowledge-selection': 'Apply',
      'resource-delete': 'Delete', 'resource-submit': 'Submit for publication' }[surface]
    await region.getByRole('button', { name: actionName, exact: true }).waitFor()
    const action = region.locator('button[aria-busy]').last()
    await action.press('Enter')
    await expect.poll(() => writes).toBe(1)
    expect(await action.evaluate(node => node === globalThis.globalThis.document.activeElement)).toBe(true)
    await page.keyboard.press('Enter')
    await page.keyboard.press(' ')
    expect(writes).toBe(1)
    gates[0]!.resolve(undefined)
    const notice = await region.getByRole('alert').elementHandle()
    expect(await action.evaluate(node => node === globalThis.globalThis.document.activeElement)).toBe(true)
    await action.press('Enter')
    await expect.poll(() => writes).toBe(2)
    expect(await action.evaluate(node => node === globalThis.globalThis.document.activeElement)).toBe(true)
    expect(await region.getByRole('alert').evaluate((node, original) => node === original, notice)).toBe(true)
    await page.keyboard.press('Enter')
    await page.keyboard.press(' ')
    expect(writes).toBe(2)
    await capture(page, `submission-${surface}`, region, action)
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
