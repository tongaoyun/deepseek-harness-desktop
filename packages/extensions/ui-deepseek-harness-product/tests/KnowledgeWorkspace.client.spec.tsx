// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import { KnowledgeWorkspace } from '../src/client/KnowledgeWorkspace.tsx'
import { renderKnowledgeWorkspace } from './knowledge-workspace-fixture.client.tsx'
import { items } from '../src/client/catalog-shared.tsx'
import { en, zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'
import { createPreviewFixture, originalMetadata, originalPreview, renderKnowledgePreview } from './knowledge-preview-fixture.client.tsx'

const t = (key: DeepSeekHarnessProductKey) => zh[key]
const entries = items([
  { id: 'company', name: '公司规范', scope: 'COMPANY', ownerName: '测试公司', canManage: false },
  { id: 'sales-21', name: '销售制度', scope: 'DEPARTMENT', ownerDepartmentId: '21', ownerName: '销售部', canManage: false },
  { id: 'personal', name: '我的资料', scope: 'PERSONAL', ownerEmployeeId: 'employee', canManage: true },
  { id: 'sales-22', name: '销售案例', scope: 'DEPARTMENT', ownerDepartmentId: '22', ownerName: '销售部', canManage: false },
])
const documentRow = (baseId: string) => ({ id: 'shared-document-id', knowledgeBaseId: baseId, filename: '业务规范.md',
  mediaType: 'text/markdown', sizeBytes: 120, status: 'READY', chunkCount: 1, updatedAt: '2026-10-10T00:00:00Z', folderId: null })
const page = (values: readonly unknown[], number = 1) => ({ items: values, page: number, size: 20, total: values.length })
const folderUpdatedAt = '2026-10-17T00:00:00Z'
const folders = page([{ id: 'stable-folder', name: '业务制度', parentId: null, updatedAt: folderUpdatedAt }])
const props = { entries, loading: false, authRequired: false,
  onRefresh: vi.fn(), onSignIn: vi.fn(), renderFactorySlot: renderKnowledgePreview, t }

function transport(handler: (method: string, payload: Record<string, unknown>) => Promise<unknown>,
  pendingUploads: (payload: Record<string, unknown>) => Promise<unknown> = async () => [],
  metadata: (payload: Record<string, unknown>) => Promise<unknown> = async payload => originalMetadata(
    String(payload.knowledgeBaseId), String(payload.documentId),
  ), folderMetadataRead?: (payload: Record<string, unknown>) => Promise<unknown>) {
  const preview = createPreviewFixture()
  const folderMetadata = new Map<string, unknown>()
  const invoke = vi.fn(async (_namespace: string, method: string, payload: Record<string, unknown>, _requestId?: string) => {
    try {
      if (method === 'knowledge.documents.upload.pending') return { ok: true, result: await pendingUploads(payload) }
      if (method === 'knowledge.folders.get') {
        const result = folderMetadataRead ? await folderMetadataRead(payload) : folderMetadata.get(`${payload.knowledgeBaseId}:${payload.folderId}`)
        if (!result) throw new Error('Folder not found')
        return { ok: true, result }
      }
      if (method === 'knowledge.documents.previewMetadata') return { ok: true, result: await metadata(payload) }
      const result = await preview(method, payload, (name, data) => handler(name, data as Record<string, unknown>))
      if (method === 'knowledge.folders.list' && typeof result === 'object' && result !== null && 'items' in result && Array.isArray(result.items)) {
        const folderRows: readonly unknown[] = result.items
        for (const folder of folderRows) if (typeof folder === 'object' && folder !== null && 'id' in folder) {
          folderMetadata.set(`${payload.knowledgeBaseId}:${folder.id}`, folder)
        }
        const items = result.items.filter((folder: unknown) => typeof folder === 'object' && folder !== null
          && 'parentId' in folder && folder.parentId === (payload.parentId ?? null))
        return { ok: true, result: { ...result, items, total: items.length === result.items.length && 'total' in result ? result.total : items.length } }
      }
      if (method === 'knowledge.folders.create' && typeof result === 'object' && result !== null && 'id' in result) {
        folderMetadata.set(`${payload.knowledgeBaseId}:${result.id}`, result)
      }
      return { ok: true, result }
    }
    catch (error) { return { ok: false, failure: productFailure(error) } }
  })
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  return { invoke, cancel }
}

function parts(container: HTMLElement) {
  const content = container.querySelector<HTMLElement>('[data-knowledge-content]')
  if (!content) throw new Error('Missing knowledge materials browser')
  return { content: within(content) }
}

function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((commit) => { resolve = commit })
  return { promise, resolve }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

function chooseLibrary(container: HTMLElement, name: string): void {
  fireEvent.click(parts(container).content.getByRole('button', { name: zh.knowledge }))
  fireEvent.click(screen.getByRole('button', { name }))
}

it('filters the directory without loading materials and opens only the chosen library', async () => {
  const api = transport(async method => method === 'knowledge.folders.list' ? folders : page([documentRow('sales-21')]))
  const view = render(<KnowledgeWorkspace {...props} />)
  expect(view.container.querySelector('[data-knowledge-directory]')).not.toBeNull()
  expect(api.invoke).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('tab', { name: zh.scopeDepartment }))
  expect(screen.queryByRole('button', { name: '我的资料' })).toBeNull()
  fireEvent.change(screen.getByRole('searchbox', { name: zh.knowledgeSelectionSearch }), { target: { value: '销售制度' } })
  const search = screen.getByRole('searchbox', { name: zh.knowledgeSelectionSearch })
  const directory = view.container.querySelector<HTMLElement>('[data-knowledge-directory]')!
  const scroll = directory.parentElement!
  scroll.scrollTop = 180
  const library = screen.getByRole('button', { name: '销售制度' })
  expect(screen.getByRole('button', { name: '销售制度' })).toBeDefined()
  expect(screen.queryByRole('button', { name: '销售案例' })).toBeNull()
  expect(api.invoke).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '销售制度' }))
  await parts(view.container).content.findByRole('button', { name: '业务规范.md' })
  expect(api.invoke.mock.calls.every(row => row[2].knowledgeBaseId === 'sales-21')).toBe(true)
  expect(document.activeElement).toBe(parts(view.container).content.getByRole('heading', { name: '销售制度', level: 1 }))
  expect(screen.queryByRole('searchbox', { name: zh.knowledgeSelectionSearch })).toBeNull()
  expect(directory.isConnected).toBe(true)
  fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledge }))
  expect(screen.getByRole('searchbox', { name: zh.knowledgeSelectionSearch })).toBe(search)
  expect(screen.getByRole('button', { name: '销售制度' })).toBe(library)
  expect(directory.parentElement).toBe(scroll)
  expect(scroll.scrollTop).toBe(180)
  expect(screen.getByRole<HTMLInputElement>('searchbox', { name: zh.knowledgeSelectionSearch }).value).toBe('销售制度')
  expect(screen.getByRole('tab', { name: zh.scopeDepartment }).getAttribute('aria-selected')).toBe('true')
  expect(screen.queryByRole('button', { name: '销售案例' })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '销售制度' }))
})

it('clears an empty directory filter and exposes refresh failures without reading materials', () => {
  const api = transport(async () => page([]))
  const refresh = vi.fn()
  const view = render(<KnowledgeWorkspace {...props} onRefresh={refresh} />)
  fireEvent.change(screen.getByRole('searchbox', { name: zh.knowledgeSelectionSearch }), { target: { value: '不存在' } })
  expect(screen.getByText(zh.noSearchResults)).toBeDefined()
  const search = screen.getByRole('searchbox', { name: zh.knowledgeSelectionSearch })
  const clear = screen.getByRole('button', { name: zh.knowledgeClearFilters })
  clear.focus()
  fireEvent.click(clear)
  expect(screen.getByRole('button', { name: '我的资料' })).toBeDefined()
  expect(document.activeElement).toBe(search)
  view.rerender(<KnowledgeWorkspace {...props} error="目录暂不可用" onRefresh={refresh} />)
  expect(screen.getByRole('alert').textContent).toContain('目录暂不可用')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeCreatePersonalBase }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  expect(refresh).toHaveBeenCalledOnce()
  expect(api.invoke).not.toHaveBeenCalled()
})

it('keeps a confirmed empty directory in place while refreshing without replacing it with a spinner', () => {
  const view = render(<KnowledgeWorkspace {...props} entries={[]} loading loaded={false} />)
  expect(screen.getByRole('status', { name: zh.loading })).toBeTruthy()
  expect(screen.queryByText(zh.knowledgeNoLibraries)).toBeNull()
  const create = screen.getByRole('button', { name: zh.knowledgeCreatePersonalBase })
  expect(create).toHaveProperty('disabled', true)
  view.rerender(<KnowledgeWorkspace {...props} entries={[]} loaded />)
  expect(create).toHaveProperty('disabled', false)
  const empty = screen.getByRole('heading', { name: zh.knowledgeNoLibraries }).parentElement!
  view.rerender(<KnowledgeWorkspace {...props} entries={[]} loading loaded />)
  expect(screen.getByRole('heading', { name: zh.knowledgeNoLibraries }).parentElement).toBe(empty)
  expect(empty.closest('[role="tabpanel"]')?.getAttribute('aria-busy')).toBe('true')
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  expect(screen.getByRole('button', { name: zh.refresh }).getAttribute('aria-disabled')).toBe('true')
  expect(screen.getByRole('button', { name: zh.knowledgeCreatePersonalBase })).toBe(create)
  expect(create).toHaveProperty('disabled', false)
  fireEvent.click(create)
  expect(screen.getByRole('dialog', { name: zh.knowledgeCreatePersonalBase })).toBeDefined()
})

it('shows a directory failure without claiming there are no libraries', () => {
  const api = transport(async () => page([]))
  const view = render(<KnowledgeWorkspace {...props} entries={[]} error="目录暂不可用" />)
  expect(screen.getByRole('alert').textContent).toContain('目录暂不可用')
  expect(screen.queryByText(zh.knowledgeNoLibraries)).toBeNull()
  expect(view.container.querySelector('[data-knowledge-content]')).toBeNull()
  expect(api.invoke).not.toHaveBeenCalled()
})

it.each(['directory', 'sign-in'] as const)('cancels a pending reader and hides library contents on return to %s', async (destination) => {
  const stale = deferred()
  const api = transport(async method => method === 'knowledge.documents.preview.open' ? stale.promise
    : method === 'knowledge.folders.list' ? folders : page([documentRow('personal')]))
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务规范.md' }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.preview.open')).toBe(true) })
  const read = api.invoke.mock.calls.find(row => row[1] === 'knowledge.documents.preview.open')
  if (destination === 'directory') fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledge }))
  else view.rerender(<KnowledgeWorkspace {...props} authRequired />)
  expect(api.cancel).toHaveBeenCalledWith('product', read?.[3])
  await act(async () => { stale.resolve(page([{ content: '# 不应出现的正文' }])) })
  expect(screen.queryByText('不应出现的正文')).toBeNull()
  expect(view.container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
  expect(screen.queryByRole('button', { name: '业务规范.md' })).toBeNull()
  expect(view.container.querySelector('[data-knowledge-directory]') !== null).toBe(destination === 'directory')
  if (destination === 'directory') expect(document.activeElement).toBe(screen.getByRole('button', { name: '我的资料' }))
  expect(api.invoke.mock.calls.some(row => row[2].knowledgeBaseId !== undefined && row[2].knowledgeBaseId !== 'personal')).toBe(false)
})

it.each(['reindex', 'cancel'] as const)('handles authorization and outage failures during %s without losing retry identity', async (action) => {
  let failure: string | undefined = 'ORGANIZATION_SERVICE_UNAVAILABLE'
  let status = action === 'reindex' ? 'FAILED' : 'PROCESSING'
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.folders.list') return folders
    if (method === 'knowledge.documents.preview.open') return page([{ content: '# 当前原文件' }])
    if (method === `knowledge.documents.${action}`) {
      if (failure) throw new ProductError(failure, 'private processing diagnostic', failure !== 'KNOWLEDGE_ACCESS_REVOKED')
      status = action === 'reindex' ? 'QUEUED' : 'CANCELLED'
      return { ...documentRow('personal'), status }
    }
    return page([{ ...documentRow(String(payload.knowledgeBaseId)), status }])
  })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  await act(async () => {})
  fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(view.container).content.findByRole('heading', { name: '当前原文件' })
  const submit = () => {
    fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', '业务规范.md') }))
    fireEvent.click(screen.getByRole('menuitem', { name: action === 'reindex' ? zh.knowledgeReindex : zh.knowledgeStopProcessing }))
  }
  submit()
  await waitFor(() => { expect(parts(view.container).content.getByRole('alert').textContent).toContain(zh.organizationServiceUnavailable) })
  expect(parts(view.container).content.getByRole('heading', { name: '当前原文件' })).toBeDefined()
  failure = undefined
  submit()
  await waitFor(() => { expect(parts(view.container).content.queryByRole('alert')).toBeNull() })
  await waitFor(() => { expect(parts(view.container).content.getByRole('status').textContent).toContain(
    action === 'reindex' ? zh.knowledgeQueued : zh.knowledgeCancelled,
  ) })
  const calls = api.invoke.mock.calls.filter(call => call[1] === `knowledge.documents.${action}`)
  expect(calls).toHaveLength(2)
  expect(calls[1]?.[2]).toEqual(calls[0]?.[2])
  expect(parts(view.container).content.getByRole('heading', { name: '当前原文件' })).toBeDefined()
  status = action === 'reindex' ? 'FAILED' : 'PROCESSING'
  fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeBackToFolder }))
  fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.refresh }))
  fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(view.container).content.findByRole('heading', { name: '当前原文件' })
  failure = 'KNOWLEDGE_ACCESS_REVOKED'
  submit()
  await waitFor(() => { expect(parts(view.container).content.getByRole('alert').textContent).toContain(zh.knowledgeAccessRevoked) })
  expect(view.container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
  expect(parts(view.container).content.queryByRole('button', { name: '业务规范.md' })).toBeNull()
  expect(parts(view.container).content.queryByRole('button', { name: '业务制度' })).toBeNull()
  expect(parts(view.container).content.queryByRole('button', { name: zh.knowledgeAddMaterial })).toBeNull()
  expect(parts(view.container).content.queryByText(zh.loading)).toBeNull()
  expect(view.container.textContent).not.toContain('private processing diagnostic')
  const finalCalls = api.invoke.mock.calls.filter(call => call[1] === `knowledge.documents.${action}`)
  expect(finalCalls).toHaveLength(3)
  expect(finalCalls[2]?.[2]).not.toEqual(finalCalls[1]?.[2])
  const alert = parts(view.container).content.getByRole('alert')
  expect(alert.querySelector('p')?.textContent).toMatchSnapshot()
  expect(within(alert).getByRole('button', { name: zh.retry })).toBeDefined()
})

it.each(['pending', 'select'] as const)('clears cached materials when upload %s authoritatively denies access', async (stage) => {
  const permission = deferred()
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.folders.list') return folders
    if (method === 'knowledge.documents.preview.open') return page([{ content: '# 当前原文件' }])
    if (method === 'knowledge.documents.upload.select') throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'private upload diagnostic', false)
    return page([documentRow(String(payload.knowledgeBaseId))])
  }, async () => {
    if (stage === 'pending') {
      await permission.promise
      throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'private upload diagnostic', false)
    }
    return []
  })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  try {
    fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务规范.md' }))
    await parts(view.container).content.findByRole('heading', { name: '当前原文件' })
    if (stage === 'select') {
      fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeBackToFolder }))
      fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeAddMaterial }))
      fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeUpload }))
    } else await act(async () => { permission.resolve(undefined) })
    await waitFor(() => { expect(parts(view.container).content.getByRole('alert').textContent).toContain(zh.knowledgeAccessRevoked) })
    expect(view.container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
    expect(parts(view.container).content.queryByRole('button', { name: '业务规范.md' })).toBeNull()
    expect(parts(view.container).content.queryByRole('button', { name: '业务制度' })).toBeNull()
    expect(parts(view.container).content.queryByRole('button', { name: zh.knowledgeAddMaterial })).toBeNull()
    expect(parts(view.container).content.queryByText(zh.loading)).toBeNull()
    expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.upload.pending')).toHaveLength(1)
    expect(view.container.textContent).not.toContain('private upload diagnostic')
  } finally {
    view.unmount()
    await act(async () => { permission.resolve(undefined) })
    await Promise.allSettled(api.invoke.mock.results.map((result): unknown => result.value))
  }
})

it.each(['reindex', 'cancel', 'upload.select'] as const)('cancels %s on library switch and ignores its late access denial', async (action) => {
  const response = deferred()
  const method = `knowledge.documents.${action}`
  const api = transport(async (name, payload) => {
    if (name === 'knowledge.folders.list') return folders
    if (name === 'knowledge.documents.preview.open') return page([{ content: `# ${payload.knowledgeBaseId}原文件` }])
    if (name === method) {
      await response.promise
      throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'private late diagnostic', false)
    }
    return page([{ ...documentRow(String(payload.knowledgeBaseId)), status: action === 'cancel' ? 'PROCESSING' : 'FAILED' }])
  })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  try {
    fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务规范.md' }))
    await parts(view.container).content.findByRole('heading', { name: 'personal原文件' })
    if (action === 'upload.select') {
      fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeBackToFolder }))
      fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeAddMaterial }))
      fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeUpload }))
    } else {
      fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', '业务规范.md') }))
      fireEvent.click(screen.getByRole('menuitem', { name: action === 'reindex' ? zh.knowledgeReindex : zh.knowledgeStopProcessing }))
    }
    await waitFor(() => { expect(api.invoke.mock.calls.filter(call => call[1] === method)).toHaveLength(1) })
    const call = api.invoke.mock.calls.find(call => call[1] === method)
    chooseLibrary(view.container, '公司规范')
    fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务规范.md' }))
    await parts(view.container).content.findByRole('heading', { name: 'company原文件' })
    expect(api.cancel).toHaveBeenCalledWith('product', call?.[3])
    await act(async () => { response.resolve(undefined) })
    expect(parts(view.container).content.getByRole('heading', { name: 'company原文件' })).toBeDefined()
    expect(parts(view.container).content.queryByRole('alert')).toBeNull()
    expect(view.container.textContent).not.toContain('private late diagnostic')
    expect(api.invoke.mock.calls.filter(call => call[1] === method)).toHaveLength(1)
  } finally {
    view.unmount()
    await act(async () => { response.resolve(undefined) })
    await Promise.allSettled(api.invoke.mock.results.map((result): unknown => result.value))
  }
})

it('cancels a pending reindex when upload recovery revokes access and ignores its late success', async () => {
  const permission = deferred()
  const reindex = deferred()
  const api = transport(async (method) => {
    if (method === 'knowledge.folders.list') return folders
    if (method === 'knowledge.documents.preview.open') return page([{ content: '# 当前原文件' }])
    if (method === 'knowledge.documents.reindex') return reindex.promise
    return page([{ ...documentRow('personal'), status: 'FAILED' }])
  }, async () => {
    await permission.promise
    throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'private recovery diagnostic', false)
  })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  try {
    fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务规范.md' }))
    await parts(view.container).content.findByRole('heading', { name: '当前原文件' })
    fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', '业务规范.md') }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeReindex }))
    await waitFor(() => { expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.reindex')).toHaveLength(1) })
    const call = api.invoke.mock.calls.find(call => call[1] === 'knowledge.documents.reindex')
    await act(async () => { permission.resolve(undefined) })
    await waitFor(() => { expect(parts(view.container).content.getByRole('alert').textContent).toContain(zh.knowledgeAccessRevoked) })
    expect(api.cancel).toHaveBeenCalledWith('product', call?.[3])
    await act(async () => { reindex.resolve({ ...documentRow('personal'), status: 'QUEUED' }) })
    expect(view.container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
    expect(parts(view.container).content.queryByRole('button', { name: '业务规范.md' })).toBeNull()
    expect(parts(view.container).content.queryByText(zh.loading)).toBeNull()
    expect(parts(view.container).content.getByRole('button', { name: zh.refresh }).hasAttribute('disabled')).toBe(false)
    expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list')).toHaveLength(1)
  } finally {
    view.unmount()
    await act(async () => { permission.resolve(undefined); reindex.resolve(undefined) })
    await Promise.allSettled(api.invoke.mock.results.map((result): unknown => result.value))
  }
})

it.each([false, true])('preserves the open document and original save during a catalog outage (unconfirmed: %s)', async (unconfirmed) => {
  const writes: Record<string, unknown>[] = []
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.documents.save') {
      writes.push(payload)
      if (writes.length === 1) throw new ProductError('PRODUCT_NETWORK_UNAVAILABLE', 'Lost receipt', true)
      return documentRow('personal')
    }
    return page([])
  })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  await screen.findByText(zh.knowledgeNoMaterials)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeAddMaterial }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.knowledgeNewDocument }))
  const dialog = within(await screen.findByRole('dialog'))
  const title = dialog.getByRole<HTMLInputElement>('textbox', { name: zh.knowledgeDocumentTitle })
  const body = dialog.getByRole<HTMLTextAreaElement>('textbox', { name: zh.knowledgeMarkdownContent })
  fireEvent.change(title, { target: { value: 'Retained title' } })
  fireEvent.change(body, { target: { value: 'Retained content' } })
  if (unconfirmed) {
    fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeSave }))
    await dialog.findByRole('alert')
  }
  view.rerender(<KnowledgeWorkspace {...props} error="Catalog temporarily unavailable" />)
  expect(screen.getByRole('dialog').contains(body)).toBe(true)
  expect(body.value).toBe('Retained content')
  expect(title.value).toBe('Retained title')
  expect(title.disabled).toBe(unconfirmed)
  expect(api.cancel).not.toHaveBeenCalled()
  expect(parts(view.container).content.getByText('Catalog temporarily unavailable').closest('[role="alert"]')).not.toBeNull()
  view.rerender(<KnowledgeWorkspace {...props} />)
  expect(screen.getByRole('dialog').contains(body)).toBe(true)
  expect(body.value).toBe('Retained content')
  if (unconfirmed) {
    fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeRetrySave }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
  }
})

it('settles an in-flight save after a catalog outage without cancelling or repeating it', async () => {
  const pending = deferred()
  const api = transport(async method => method === 'knowledge.documents.save' ? pending.promise : page([]))
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  await screen.findByText(zh.knowledgeNoMaterials)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeAddMaterial }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.knowledgeNewDocument }))
  const dialog = within(await screen.findByRole('dialog'))
  fireEvent.change(dialog.getByRole('textbox', { name: zh.knowledgeDocumentTitle }), { target: { value: 'Pending title' } })
  fireEvent.change(dialog.getByRole('textbox', { name: zh.knowledgeMarkdownContent }), { target: { value: 'Pending content' } })
  fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeSave }))
  view.rerender(<KnowledgeWorkspace {...props} error="Catalog temporarily unavailable" />)
  expect(screen.getByRole('dialog')).not.toBeNull()
  expect(api.cancel).not.toHaveBeenCalled()
  await act(async () => { pending.resolve(documentRow('personal')) })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.save')).toHaveLength(1)
  expect(parts(view.container).content.getByText('Catalog temporarily unavailable')).not.toBeNull()
})

it('pages folder contents without refetching them during document processing polls', async () => {
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.folders.list') return payload.parentId === null
      ? { items: [{ id: `parent-${payload.page}`, name: `目录 ${payload.page}`, parentId: null, updatedAt: folderUpdatedAt }], page: payload.page, size: 20, total: 21 }
      : page([{ id: 'child', name: '子目录', parentId: payload.parentId, updatedAt: folderUpdatedAt }])
    return page([{ ...documentRow('personal'), folderId: payload.folderId ?? null, status: 'PROCESSING' }])
  })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const { content } = parts(view.container)
  await content.findByRole('button', { name: '目录 1' })
  fireEvent.click(content.getByRole('button', { name: zh.nextPage }))
  fireEvent.click(await content.findByRole('button', { name: '目录 2' }))
  await content.findByRole('button', { name: '子目录' })
  const before = api.invoke.mock.calls.filter(call => call[1] === 'knowledge.folders.list').length
  await waitFor(() => { expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list' && call[2].folderId === 'parent-2').length).toBeGreaterThan(1) }, { timeout: 5_000 })
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.folders.list')).toHaveLength(before)
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.folders.list').map(call => call[2])).toEqual([
    { knowledgeBaseId: 'personal', parentId: null, page: 1, size: 20 },
    { knowledgeBaseId: 'personal', parentId: null, page: 2, size: 20 },
    { knowledgeBaseId: 'personal', parentId: 'parent-2', page: 1, size: 20 },
  ])
})

it.each(['READY', 'FAILED', 'CANCELLED'])('keeps reading a file when processing becomes %s and it leaves the active status filter', async (nextStatus) => {
  let status = 'PROCESSING'
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.folders.list') return folders
    if (method === 'knowledge.documents.preview.open') return page([{ content: '# 阅读中的原文件' }])
    return page(payload.status && payload.status !== status ? [] : [{ ...documentRow('personal'), status }])
  }, undefined, async () => ({ ...originalMetadata('personal', 'shared-document-id'), status }))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
    await act(async () => {})
    await act(async () => { fireEvent.change(parts(view.container).content.getByRole('combobox', { name: zh.status }), { target: { value: 'PROCESSING' } }) })
    await act(async () => { fireEvent.click(parts(view.container).content.getByRole('button', { name: '业务规范.md' })) })
    expect(parts(view.container).content.getByRole('heading', { name: '阅读中的原文件' })).toBeDefined()
    status = nextStatus
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list')).toHaveLength(3)
    expect(parts(view.container).content.getByRole('heading', { name: '阅读中的原文件' })).toBeDefined()
    expect(view.container.querySelector('[data-knowledge-inline-reader]')).not.toBeNull()
    const label = nextStatus === 'READY' ? zh.knowledgeIndexed : nextStatus === 'FAILED' ? zh.knowledgeIndexFailed : zh.knowledgeCancelled
    expect(parts(view.container).content.getByRole('status').textContent).toContain(label)
    expect(parts(view.container).content.getByRole('status').textContent).toMatchSnapshot()
    expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.preview.open')).toHaveLength(1)
  } finally { vi.useRealTimers() }
})

it.each(['KNOWLEDGE_ACCESS_REVOKED', 'ORGANIZATION_SERVICE_UNAVAILABLE'])(
  'independently rechecks a filtered file that disappears and handles %s', async (code) => {
    let finished = false
    const api = transport(async (method, payload) => {
      if (method === 'knowledge.folders.list') return folders
      if (method === 'knowledge.documents.preview.open') return page([{ content: '# 阅读中的原文件' }])
      return page(payload.status && finished ? [] : [{ ...documentRow('personal'), status: 'PROCESSING' }])
    }, undefined, async () => {
      if (finished) throw new ProductError(code, 'private parser diagnostic', code === 'ORGANIZATION_SERVICE_UNAVAILABLE')
      return originalMetadata('personal', 'shared-document-id')
    })
    const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
    await parts(view.container).content.findByRole('button', { name: '业务规范.md' })
    fireEvent.change(parts(view.container).content.getByRole('combobox', { name: zh.status }), { target: { value: 'PROCESSING' } })
    fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务规范.md' }))
    await parts(view.container).content.findByRole('heading', { name: '阅读中的原文件' })
    finished = true
    await waitFor(() => { expect(parts(view.container).content.getByRole('alert').textContent).toContain(
      code === 'KNOWLEDGE_ACCESS_REVOKED' ? zh.knowledgeAccessRevoked : zh.organizationServiceUnavailable,
    ) }, { timeout: 5_000 })
    expect(view.container.querySelector('[data-knowledge-inline-reader]') !== null).toBe(code !== 'KNOWLEDGE_ACCESS_REVOKED')
    expect(view.container.textContent).not.toContain('private parser diagnostic')
    expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.previewMetadata')).toHaveLength(2)
  })

it('cancels a missing filtered file recheck when switching libraries and ignores its late result', async () => {
  let finished = false
  const pending = deferred()
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.folders.list') return folders
    if (method === 'knowledge.documents.preview.open') return page([{ content: '# 阅读中的原文件' }])
    return page(payload.status && finished ? [] : [{ ...documentRow(String(payload.knowledgeBaseId)), status: 'PROCESSING' }])
  }, undefined, async () => finished ? pending.promise : originalMetadata('personal', 'shared-document-id'))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
    await act(async () => {})
    await act(async () => { fireEvent.change(parts(view.container).content.getByRole('combobox', { name: zh.status }), {
      target: { value: 'PROCESSING' },
    }) })
    await act(async () => { fireEvent.click(parts(view.container).content.getByRole('button', { name: '业务规范.md' })) })
    expect(parts(view.container).content.getByRole('heading', { name: '阅读中的原文件' })).toBeDefined()
    finished = true
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.previewMetadata')).toHaveLength(2)
    const recheck = api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.previewMetadata')[1]
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
    expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list')).toHaveLength(3)
    expect(api.cancel).not.toHaveBeenCalledWith('product', recheck?.[3])
    chooseLibrary(view.container, '公司规范')
    await act(async () => {})
    expect(parts(view.container).content.getByRole('button', { name: '业务规范.md' })).toBeDefined()
    expect(api.cancel).toHaveBeenCalledWith('product', recheck?.[3])
    await act(async () => { pending.resolve({ ...originalMetadata('personal', 'shared-document-id'), status: 'READY' }) })
    expect(view.container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
    expect(parts(view.container).content.queryByRole('heading', { name: '阅读中的原文件' })).toBeNull()
    expect(parts(view.container).content.queryByRole('alert')).toBeNull()
  } finally { vi.useRealTimers() }
})

it('loads folders and files concurrently and keeps initial loading distinct from an empty library', async () => {
  const folderResponse = deferred()
  const documentResponse = deferred()
  const api = transport(async method => method === 'knowledge.folders.list' ? folderResponse.promise : documentResponse.promise)
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} entries={[]} loading />)
  expect(screen.getByRole('status', { name: zh.loading })).toBeDefined()
  expect(view.container.textContent).not.toContain(zh.loading)
  expect(view.container.textContent).not.toContain(zh.empty)
  view.rerender(<KnowledgeWorkspace {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '我的资料' }))
  const { content } = parts(view.container)
  expect(content.getByRole('status', { name: zh.knowledgeLoadingMaterials }).textContent).toContain(zh.knowledgeLoadingMaterials)
  expect(content.getByRole('tablist', { name: zh.knowledgeBrowseMode })).toBeDefined()
  expect(content.queryByRole('button', { name: zh.retry })).toBeNull()
  expect(content.queryByRole('searchbox')).toBeNull()
  expect(content.queryByRole('combobox')).toBeNull()
  expect(content.getByRole('button', { name: zh.knowledgeAddMaterial }).hasAttribute('disabled')).toBe(true)
  expect(content.getByRole('button', { name: zh.knowledgeAddMaterial }).hasAttribute('disabled')).toBe(true)
  expect(content.queryByText(zh.knowledgeNoMaterials)).toBeNull()
  await waitFor(() => { expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list')).toHaveLength(1) })
  await act(async () => { folderResponse.resolve(folders) })
  expect(content.getByRole('status', { name: zh.knowledgeLoadingMaterials })).toBeDefined()
  expect(content.queryByRole('button', { name: '业务制度' })).toBeNull()
  expect(content.queryByText(zh.knowledgeNoMaterials)).toBeNull()
  await act(async () => { documentResponse.resolve(page([documentRow('personal')])) })
  await parts(view.container).content.findByRole('button', { name: '业务规范.md' })
  expect(content.queryByRole('status', { name: zh.knowledgeLoadingMaterials })).toBeNull()
})

it('cancels a slow initial load on directory return and ignores late rows after reopening', async () => {
  const stale = deferred()
  let retrying = false
  const api = transport(async method => !retrying ? stale.promise : method === 'knowledge.folders.list' ? page([]) : page([documentRow('personal')]))
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const { content } = parts(view.container)
  await content.findByRole('status', { name: zh.knowledgeLoadingMaterials })
  expect(content.queryByRole('button', { name: zh.retry })).toBeNull()
  retrying = true
  chooseLibrary(view.container, '我的资料')
  await parts(view.container).content.findByRole('button', { name: '业务规范.md' })
  expect(api.cancel).toHaveBeenCalled()
  await act(async () => { stale.resolve(page([])) })
  expect(parts(view.container).content.getByRole('button', { name: '业务规范.md' })).toBeDefined()
  expect(parts(view.container).content.queryByText(zh.knowledgeNoMaterials)).toBeNull()
})

it.each(['pending', 'failed'] as const)('never offers library deletion while the selected folder path is %s', async (state) => {
  const path = deferred()
  transport(async (method, payload) => method === 'knowledge.folders.list' ? payload.parentId === null ? folders : page([]) : page([]),
    undefined, undefined, async () => {
      await path.promise
      if (state === 'failed') throw new Error('Folder path unavailable')
      return folders.items[0]
    })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const { content } = parts(view.container)
  fireEvent.click(await content.findByRole('button', { name: '业务制度' }))
  await content.findByText(zh.knowledgeEmptyFolder)
  if (state === 'failed') await act(async () => { path.resolve(undefined) })
  const heading = content.getByRole('heading', { level: 1 })
  expect(heading.textContent).not.toBe('我的资料')
  expect(content.queryByRole('button', { name: zh.knowledgeLibraryActions.replace('{name}', '我的资料') })).toBeNull()
  expect(content.getByRole('button', { name: zh.knowledgeAddMaterial }).hasAttribute('disabled')).toBe(true)
  if (state === 'pending') {
    await act(async () => { path.resolve(undefined) })
    await content.findByRole('heading', { name: '业务制度', level: 1 })
    expect(content.getByRole('button', { name: zh.knowledgeAddMaterial }).hasAttribute('disabled')).toBe(false)
  } else expect(content.getByRole('alert')).toBeDefined()
})

it.each(['knowledge.folders.list', 'knowledge.documents.list'])('offers retry after %s fails without publishing a partial page', async (failedMethod) => {
  const sibling = deferred()
  let retrying = false
  const api = transport(async (method) => {
    if (!retrying) {
      if (method === failedMethod) throw new Error('Connection interrupted')
      return sibling.promise
    }
    return method === 'knowledge.folders.list' ? folders : page([documentRow('personal')])
  })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const { content } = parts(view.container)
  const alert = await content.findByRole('alert')
  expect(within(alert).getByRole('button', { name: zh.retry })).toBeDefined()
  expect(content.queryByText(zh.knowledgeNoMaterials)).toBeNull()
  expect(content.queryByRole('button', { name: '业务制度' })).toBeNull()
  expect(content.getByRole('button', { name: zh.knowledgeAddMaterial }).hasAttribute('disabled')).toBe(true)
  expect(api.cancel).toHaveBeenCalled()
  const reads = api.invoke.mock.calls.length
  view.rerender(<KnowledgeWorkspace {...props} t={key => en[key]} />)
  expect(within(alert).getByText(failedMethod === 'knowledge.folders.list' ? en.knowledgeFoldersFailed : en.knowledgeListFailed)).toBeDefined()
  expect(api.invoke).toHaveBeenCalledTimes(reads)
  retrying = true
  fireEvent.click(within(alert).getByRole('button', { name: en.retry }))
  await content.findByRole('button', { name: '业务规范.md' })
  await act(async () => { sibling.resolve(page([])) })
  expect(content.getByRole('button', { name: '业务制度' })).toBeDefined()
  expect(content.queryByRole('alert')).toBeNull()
})

it('keeps the selected library while directory refreshes without adding empty scope groups', async () => {
  transport(async method => method === 'knowledge.folders.list' ? folders : page([documentRow('personal')]))
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  await parts(view.container).content.findByRole('button', { name: '业务规范.md' })
  const noDepartment = { ...props, entries: entries.filter(entry => entry.scope !== 'DEPARTMENT') }
  view.rerender(<KnowledgeWorkspace {...noDepartment} />)
  const library = parts(view.container).content.getByRole('heading', { name: '我的资料', level: 1 })
  view.rerender(<KnowledgeWorkspace {...noDepartment} loading />)
  expect(parts(view.container).content.getByRole('heading', { name: '我的资料', level: 1 })).toBe(library)
  expect(parts(view.container).content.queryByText(zh.scopeDepartment)).toBeNull()
  expect(parts(view.container).content.queryByText(zh.empty)).toBeNull()
})

it.each(['catalog', 'materials'] as const)('keeps the current table and folder tree mounted during a slow %s refresh', async (source) => {
  const response = deferred()
  let refreshing = false
  transport(async (method, payload) => {
    if (refreshing) await response.promise
    return method === 'knowledge.folders.list' ? folders : page([documentRow(String(payload.knowledgeBaseId))])
  })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const { content } = parts(view.container)
  const file = await content.findByRole('button', { name: '业务规范.md' })
  const folder = await content.findByRole('button', { name: '业务制度' })
  refreshing = true
  if (source === 'catalog') view.rerender(<KnowledgeWorkspace {...props} refreshRevision={1} />)
  else fireEvent.click(content.getByRole('button', { name: zh.refresh }))
  expect(content.getByRole('button', { name: zh.refresh }).getAttribute('aria-busy')).toBe('true')
  expect(within(content.getByRole('button', { name: zh.refresh })).getByRole('status', { name: zh.loading })).toBeDefined()
  expect(content.queryByRole('status', { name: zh.knowledgeLoadingMaterials })).toBeNull()
  expect(content.getByRole('button', { name: '业务规范.md' })).toBe(file)
  expect(content.getByRole('button', { name: '业务制度' })).toBe(folder)
  expect(content.queryByText(zh.loading)).toBeNull()
  await act(async () => { response.resolve(undefined) })
  await waitFor(() => { expect(content.getByRole('button', { name: zh.refresh }).hasAttribute('disabled')).toBe(false) })
  expect(content.getByRole('button', { name: '业务规范.md' })).toBe(file)
  expect(content.getByRole('button', { name: '业务制度' })).toBe(folder)
})

it('keeps an empty library stable while refreshing without flashing a loading placeholder', async () => {
  const response = deferred()
  let refreshing = false
  transport(async () => {
    if (refreshing) await response.promise
    return page([])
  })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const { content } = parts(view.container)
  const empty = await content.findByText(zh.knowledgeNoMaterials)
  expect(view.container.querySelector('aside')).toBeNull()
  expect(content.queryByRole('searchbox')).toBeNull()
  expect(content.queryByRole('combobox')).toBeNull()
  expect(content.getByRole('tablist', { name: zh.knowledgeBrowseMode })).toBeDefined()
  const emptyActions = within(empty.parentElement!)
  expect(emptyActions.queryByRole('button', { name: zh.knowledgeAddMaterial })).toBeNull()
  expect(emptyActions.queryByRole('button', { name: zh.knowledgeAddMaterial })).toBeNull()
  const upload = content.getByRole('button', { name: zh.knowledgeAddMaterial })
  const create = content.getByRole('button', { name: zh.knowledgeAddMaterial })
  expect(content.getAllByRole('button', { name: zh.knowledgeAddMaterial })).toHaveLength(1)
  refreshing = true
  view.rerender(<KnowledgeWorkspace {...props} refreshRevision={1} />)
  expect(content.getByText(zh.knowledgeNoMaterials)).toBe(empty)
  expect(content.queryByText(zh.loading)).toBeNull()
  await act(async () => { response.resolve(undefined) })
  expect(content.getByText(zh.knowledgeNoMaterials)).toBe(empty)
  expect(content.getByRole('button', { name: zh.knowledgeAddMaterial })).toBe(upload)
  expect(content.getByRole('button', { name: zh.knowledgeAddMaterial })).toBe(create)
})

it('shows folder metadata without file selection and keeps header actions when opening an empty folder', async () => {
  const api = transport(async (method, payload) => method === 'knowledge.folders.list' ? folders
    : page(payload.folderId === undefined ? [documentRow('personal')] : []))
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const { content } = parts(view.container)
  const folder = await content.findByRole('button', { name: '业务制度' })
  const row = within(folder.closest('tr')!)
  expect(content.queryByRole('checkbox')).toBeNull()
  expect(row.getAllByRole('cell').map(cell => cell.textContent).slice(1, 5)).toEqual([
    '—', zh.knowledgeFolderType, '—', new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(folderUpdatedAt)),
  ])
  const upload = content.getByRole('button', { name: zh.knowledgeAddMaterial })
  const create = content.getByRole('button', { name: zh.knowledgeAddMaterial })
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '业务制度') }))
  expect(screen.getByRole('menuitem', { name: zh.knowledgeUploadToFolder })).toBeDefined()
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.click(folder)
  const empty = await content.findByText(zh.knowledgeEmptyFolder)
  expect(within(empty.parentElement!).queryByRole('button')).toBeNull()
  expect(content.getByRole('button', { name: zh.knowledgeAddMaterial })).toBe(upload)
  expect(content.getByRole('button', { name: zh.knowledgeAddMaterial })).toBe(create)
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeAllMaterials }))
  await content.findByRole('button', { name: '业务规范.md' })
  expect(content.getByRole('checkbox', { name: zh.knowledgeSelectPage })).toBeDefined()
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list', {
    knowledgeBaseId: 'personal', page: 1, size: 20,
  }, expect.any(String))
  fireEvent.click(content.getByRole('tab', { name: zh.knowledgeFolderView }))
  await content.findByRole('heading', { name: '业务制度', level: 1 })
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '业务制度') }))
  expect(screen.queryByRole('menuitem', { name: zh.knowledgeCreateSubfolder })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: zh.knowledgeUploadToFolder })).toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeAddMaterial }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeNewDocument }))
  const editor = await screen.findByRole('dialog', { name: zh.knowledgeNewDocument })
  await within(editor).findByText('我的资料 / 业务制度')
})

it('does not restore cached folders while retrying after an access revocation', async () => {
  let phase: 'initial' | 'denied' | 'retry' = 'initial'
  const response = deferred()
  transport(async (method, payload) => {
    if (phase === 'retry') await response.promise
    if (phase === 'denied') throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'private diagnostic', false)
    return method === 'knowledge.folders.list' ? folders : page([documentRow(String(payload.knowledgeBaseId))])
  })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  await parts(view.container).content.findByRole('button', { name: '业务规范.md' })
  phase = 'denied'
  view.rerender(<KnowledgeWorkspace {...props} refreshRevision={1} />)
  await waitFor(() => { expect(parts(view.container).content.getByRole('alert').textContent).toContain(zh.knowledgeAccessRevoked) })
  expect(parts(view.container).content.queryByRole('button', { name: zh.knowledgeLibraryActions.replace('{name}', '我的资料') })).toBeNull()
  phase = 'retry'
  fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.refresh }))
  for (const region of [parts(view.container).content]) {
    expect(region.queryByRole('button', { name: '业务制度' })).toBeNull()
    expect(region.queryByRole('button', { name: '业务规范.md' })).toBeNull()
  }
  await act(async () => { response.resolve(undefined) })
  await parts(view.container).content.findByRole('button', { name: '业务规范.md' })
})

it('reloads folder branches on explicit refresh and discards externally removed folders', async () => {
  let removed = false
  const api = transport(async method => method === 'knowledge.folders.list'
    ? page([{ id: 'kept', name: '保留目录', parentId: null, updatedAt: folderUpdatedAt },
      ...removed ? [] : [{ id: 'removed', name: '删除目录', parentId: null, updatedAt: folderUpdatedAt }]])
    : page([documentRow('personal')]))
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const { content } = parts(view.container)
  await content.findByRole('button', { name: '删除目录' })
  removed = true
  fireEvent.click(content.getByRole('button', { name: zh.refresh }))
  await content.findByRole('button', { name: '保留目录' })
  await waitFor(() => { expect(content.queryByRole('button', { name: '删除目录' })).toBeNull() })
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.folders.list')).toHaveLength(2)
  fireEvent.click(content.getByRole('button', { name: '保留目录' }))
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list',
    expect.objectContaining({ folderId: 'kept' }), expect.any(String)) })
})

it('creates nested folders with retained retry input, browses their paths and deletes back to the parent', async () => {
  const values = [
    { id: 'root', name: '项目资料', parentId: null as string | null, updatedAt: folderUpdatedAt },
    { id: 'other', name: '其他资料', parentId: null as string | null, updatedAt: folderUpdatedAt },
  ]
  let failed = true
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.folders.list') return page([...values])
    if (method === 'knowledge.folders.create') {
      if (failed) throw new Error('Temporary outage')
      const value = { id: 'child', name: String(payload.name), parentId: String(payload.parentId), updatedAt: folderUpdatedAt }
      values.push(value); return value
    }
    if (method === 'knowledge.folders.delete') {
      const index = values.findIndex(folder => folder.id === payload.folderId)
      values.splice(index, 1); return { folderId: payload.folderId, deleted: true }
    }
    return page([])
  })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const { content } = parts(view.container)
  await content.findByRole('button', { name: '项目资料' })
  expect(content.queryByRole('button', { name: documentRow('personal').filename })).toBeNull()
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '项目资料') }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeCreateSubfolder }))
  const dialog = await screen.findByRole('dialog', { name: zh.knowledgeCreateFolder })
  const name = within(dialog).getByRole<HTMLInputElement>('textbox', { name: zh.knowledgeFolderName })
  expect(name.maxLength).toBe(80)
  await within(dialog).findByRole('button', { name: '项目资料', current: 'page' })
  fireEvent.change(name, { target: { value: '验收记录' } })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.knowledgeSave }))
  await within(dialog).findByRole('alert')
  expect(name.value).toBe('验收记录')
  failed = false
  fireEvent.click(within(dialog).getByRole('button', { name: zh.knowledgeRetrySave }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  const creates = api.invoke.mock.calls.filter(call => call[1] === 'knowledge.folders.create')
  expect(creates).toHaveLength(2)
  expect(creates[0]?.[2]).toEqual(creates[1]?.[2])
  expect(creates[0]?.[2]).toMatchObject({ parentId: 'root', name: '验收记录' })
  const child = await content.findByRole('heading', { name: '验收记录', level: 1 })
  expect(child.getAttribute('aria-current')).toBe('page')
  const breadcrumb = content.getByRole('navigation', { name: zh.knowledgeLocation })
  expect(within(breadcrumb).getAllByRole('button').map(button => button.textContent)).toEqual([zh.knowledge, '我的资料', '项目资料'])
  fireEvent.click(await content.findByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '验收记录') }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDeleteFolder }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.deleteResource }))
  await waitFor(() => { expect(content.queryByRole('heading', { name: '验收记录', level: 1 })).toBeNull() })
  expect(content.getByRole('heading', { name: '项目资料', level: 1 }).getAttribute('aria-current')).toBe('page')
  expect(api.invoke.mock.calls.some(call => call[1].startsWith('tasks.'))).toBe(false)
})

it('keeps unrelated folders available after another empty folder is deleted', async () => {
  let deleted = false
  transport(async method => method === 'knowledge.folders.list'
    ? page([{ id: 'current', name: '当前目录', parentId: null, updatedAt: folderUpdatedAt }, ...deleted ? [] : [{ id: 'other', name: '其他目录', parentId: null, updatedAt: folderUpdatedAt }]])
    : method === 'knowledge.folders.delete' ? (deleted = true, { folderId: 'other', deleted: true }) : page([]))
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const { content } = parts(view.container)
  fireEvent.click(await content.findByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '其他目录') }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDeleteFolder }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.deleteResource }))
  await waitFor(() => { expect(content.queryByRole('button', { name: '其他目录' })).toBeNull() })
  fireEvent.click(content.getByRole('button', { name: '当前目录' }))
  await content.findByRole('heading', { name: '当前目录', level: 1 })
})

it('clears file filters when entering a different folder and keeps the directory listing independent of document pages', async () => {
  const api = transport(async method => method === 'knowledge.folders.list' ? folders : page([]))
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const { content } = parts(view.container)
  fireEvent.change(await content.findByRole('searchbox'), { target: { value: '旧查询' } })
  fireEvent.click(content.getByRole('button', { name: zh.search }))
  fireEvent.change(content.getByRole('combobox', { name: zh.knowledgeFormat }), { target: { value: 'pdf' } })
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeClearFilters }))
  fireEvent.click(await content.findByRole('button', { name: '业务制度' }))
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list', {
    knowledgeBaseId: 'personal', page: 1, size: 20, folderId: 'stable-folder',
  }, expect.any(String)) })
  await content.findByText(zh.knowledgeEmptyFolder)
  expect(content.queryByRole('searchbox')).toBeNull()
  expect(content.queryByRole('combobox', { name: zh.knowledgeFormat })).toBeNull()
  expect(document.activeElement).toBe(content.getByRole('heading', { name: '业务制度', level: 1 }))
  await waitFor(() => { expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.folders.list').map(call => call[2])).toEqual([
    { knowledgeBaseId: 'personal', parentId: null, page: 1, size: 20 },
    { knowledgeBaseId: 'personal', parentId: 'stable-folder', page: 1, size: 20 },
  ]) })
})

it('creates a personal library from an empty personal group and selects it after catalog refresh', async () => {
  const created = { id: 'new-personal', name: '我的项目资料', scope: 'PERSONAL', canManage: true,
    description: '', updatedAt: '2026-10-20T00:00:00Z' }
  const refresh = vi.fn()
  const api = transport(async method => method === 'knowledge.bases.create' ? created : page([]))
  const initial = entries.filter(row => row.scope !== 'PERSONAL')
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} entries={initial} onRefresh={refresh} />)
  fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledge }))
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeCreatePersonalBase }))
  const dialog = await screen.findByRole('dialog', { name: zh.knowledgeCreatePersonalBase })
  fireEvent.change(within(dialog).getByRole('textbox', { name: zh.knowledgeBaseName }), { target: { value: '我的项目资料' } })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.knowledgeCreate }))
  await waitFor(() => { expect(refresh).toHaveBeenCalledOnce() })
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.bases.create', {
    name: '我的项目资料', description: '', operationId: expect.any(String) as string,
  }, expect.any(String))
  view.rerender(<KnowledgeWorkspace {...props} entries={[...initial, ...items([created])]} onRefresh={refresh} />)
  await parts(view.container).content.findByRole('heading', { name: created.name, level: 1 })
  expect(api.invoke.mock.calls.some(row => row[1].startsWith('tasks.'))).toBe(false)
})

it('preserves the personal library name and retry identity after creation fails', async () => {
  let failed = true
  const api = transport(async (method) => {
    if (method === 'knowledge.bases.create') {
      if (failed) throw new Error('Temporary outage')
      return { id: 'retry-personal', name: '项目资料', scope: 'PERSONAL', canManage: true,
        description: '', updatedAt: '2026-10-20T00:00:00Z' }
    }
    return page([])
  })
  renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} entries={[]} />)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeCreatePersonalBase }))
  fireEvent.change(screen.getByRole('textbox', { name: zh.knowledgeBaseName }), { target: { value: '项目资料' } })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeCreate }))
  await screen.findByText(zh.knowledgeCreateBaseFailed)
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: zh.knowledgeBaseName }).value).toBe('项目资料')
  failed = false
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeRetrySave }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  const calls = api.invoke.mock.calls.filter(row => row[1] === 'knowledge.bases.create')
  expect(calls).toHaveLength(2)
  expect(calls[0]?.[2]).toEqual(calls[1]?.[2])
})

it.each(['directory', 'materials'] as const)('deletes a managed personal library from %s and focuses the directory without opening another library', async (source) => {
  const refresh = vi.fn()
  const api = transport(async method => method === 'knowledge.bases.delete' ? undefined : page([]))
  const view = source === 'materials' ? renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} onRefresh={refresh} />)
    : render(<KnowledgeWorkspace {...props} onRefresh={refresh} />)
  fireEvent.click(screen.getByRole('button', {
    name: zh.knowledgeLibraryActions.replace('{name}', '我的资料'),
  }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDeleteBase }))
  const dialog = await screen.findByRole('dialog', { name: zh.knowledgeDeleteBase })
  expect(within(dialog).getByText(zh.knowledgeDeleteBaseConfirmation.replace('{name}', '我的资料'))).toBeDefined()
  fireEvent.click(within(dialog).getByRole('button', { name: zh.deleteResource }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.bases.delete')).toBe(true) })
  expect(refresh).toHaveBeenCalledOnce()
  expect(view.container.querySelector('[data-knowledge-directory]')).not.toBeNull()
  expect(screen.queryByRole('button', { name: '我的资料' })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: zh.knowledge, level: 1 }))
  expect(view.container.querySelector('[data-knowledge-content]')).toBeNull()
  expect(api.invoke.mock.calls.some(row => row[2].knowledgeBaseId === 'company')).toBe(false)
  expect(screen.queryByRole('dialog', { name: zh.knowledgeDeleteBase })).toBeNull()
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.bases.delete', { knowledgeBaseId: 'personal' }, expect.any(String))
})

it('keeps the personal-library confirmation open when deletion fails', async () => {
  const response = deferred()
  let attempts = 0
  const api = transport(async (method) => {
    if (method === 'knowledge.bases.delete') {
      if (++attempts === 1) throw new Error('Temporary outage')
      return response.promise
    }
    return page([])
  })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  onTestFinished(() => { view.unmount(); response.resolve(undefined) })
  fireEvent.click(parts(view.container).content.getByRole('button', {
    name: zh.knowledgeLibraryActions.replace('{name}', '我的资料'),
  }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDeleteBase }))
  const dialog = await screen.findByRole('dialog', { name: zh.knowledgeDeleteBase })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.deleteResource }))
  await within(dialog).findByText(zh.knowledgeDeleteBaseFailed)
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.bases.delete', { knowledgeBaseId: 'personal' }, expect.any(String))
  expect(screen.getByRole('dialog', { name: zh.knowledgeDeleteBase })).toBeDefined()
  expect(parts(view.container).content.getByRole('heading', { name: '我的资料', level: 1 })).toBeDefined()
  view.rerender(<KnowledgeWorkspace {...props} t={key => en[key]} />)
  expect(within(dialog).getByRole('alert').textContent).toBe(en.knowledgeDeleteBaseFailed)
  expect(within(dialog).getByRole('alert').textContent).toMatchInlineSnapshot('"Could not delete the knowledge base. Try again."')
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.bases.delete')).toHaveLength(1)
  const error = within(dialog).getByRole('alert')
  const retry = within(dialog).getByRole<HTMLButtonElement>('button', { name: en.deleteResource })
  const cancel = within(dialog).getByRole<HTMLButtonElement>('button', { name: en.cancel })
  retry.focus()
  act(() => { retry.click(); retry.click(); cancel.click(); fireEvent.keyDown(dialog, { key: 'Escape' }) })
  expect(attempts).toBe(2)
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(within(dialog).getByRole('alert')).toBe(error)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(cancel.classList.contains('product-control-pending')).toBe(true)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(cancel.disabled).toBe(false)
  expect(cancel.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect({ message: error.textContent, action: retry.textContent, focused: document.activeElement === retry }).toMatchSnapshot('Pending library deletion retry')
  await act(async () => { response.resolve(undefined) })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
})

it.each([false, true])('preserves the currently browsed library when another deletion completes (delayed: %s)', async (delayed) => {
  const deletion = deferred()
  const refresh = vi.fn()
  const api = transport(async method => method === 'knowledge.bases.delete' ? deletion.promise : page([]))
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} onRefresh={refresh} />)
  const content = () => parts(view.container).content
  fireEvent.click(content().getByRole('button', { name: zh.knowledge }))
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeLibraryActions.replace('{name}', '我的资料') }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDeleteBase }))
  const dialog = await screen.findByRole('dialog', { name: zh.knowledgeDeleteBase })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.deleteResource }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.bases.delete')).toBe(true) })
  fireEvent.click(screen.getByRole('button', { name: '销售制度' }))
  if (delayed) {
    chooseLibrary(view.container, '销售案例')
    view.rerender(<KnowledgeWorkspace {...props} entries={[...entries].reverse()} onRefresh={refresh} />)
  }
  await act(async () => { deletion.resolve(undefined); await deletion.promise })
  await waitFor(() => { expect(refresh).toHaveBeenCalledOnce() })
  expect(content().getByRole('heading', { name: delayed ? '销售案例' : '销售制度', level: 1 })).toBeDefined()
  expect(screen.queryByRole('dialog', { name: zh.knowledgeDeleteBase })).toBeNull()
})

it('shows the latest directory without replacement when deleting the selected library', async () => {
  const deletion = deferred()
  const refresh = vi.fn()
  const api = transport(async method => method === 'knowledge.bases.delete' ? deletion.promise : page([]))
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} onRefresh={refresh} />)
  fireEvent.click(parts(view.container).content.getByRole('button', {
    name: zh.knowledgeLibraryActions.replace('{name}', '我的资料'),
  }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDeleteBase }))
  const dialog = await screen.findByRole('dialog', { name: zh.knowledgeDeleteBase })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.deleteResource }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.bases.delete')).toBe(true) })
  view.rerender(<KnowledgeWorkspace {...props} entries={entries.filter(entry => entry.id !== 'company')} onRefresh={refresh} />)
  await act(async () => { deletion.resolve(undefined); await deletion.promise })
  await waitFor(() => { expect(refresh).toHaveBeenCalledOnce() })
  expect(view.container.querySelector('[data-knowledge-directory]')).not.toBeNull()
  expect(screen.getByRole('button', { name: '销售制度' })).toBeDefined()
  expect(screen.queryByRole('button', { name: '公司规范' })).toBeNull()
  expect(screen.queryByRole('button', { name: '我的资料' })).toBeNull()
  expect(api.invoke.mock.calls.some(row => row[2].knowledgeBaseId === 'sales-21')).toBe(false)
})

it('does not expose personal-library deletion for shared or read-only libraries', () => {
  const readOnly = entries.map(entry => ({ ...entry, canManage: false }))
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} entries={readOnly} />)
  expect(parts(view.container).content.queryByRole('button', {
    name: zh.knowledgeLibraryActions.replace('{name}', '公司规范'),
  })).toBeNull()
  expect(parts(view.container).content.queryByRole('button', {
    name: zh.knowledgeLibraryActions.replace('{name}', '我的资料'),
  })).toBeNull()
})

it('uses one full-width materials browser with a directory return and no sidebar', async () => {
  const companyEntries = items([{ id: 'company', name: '公司规范', scope: 'COMPANY', ownerName: '测试公司', canManage: false }])
  transport(async method => method === 'knowledge.folders.list' ? page([]) : page([documentRow('company')]))
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} entries={companyEntries} />)
  const { content } = parts(view.container)
  await content.findByRole('heading', { name: '公司规范', level: 1 })
  expect(view.container.querySelector('aside')).toBeNull()
  expect(view.container.querySelector('[data-knowledge-content]')?.parentElement?.children).toHaveLength(1)
  expect(content.getByRole('button', { name: zh.knowledge })).toBeDefined()
  expect(content.queryByText(zh.knowledgeNoFolders)).toBeNull()
})

it('uploads into the selected folder and preserves the destination after cancellation or failure', async () => {
  let fail = false
  const api = transport(async (method) => {
    if (method === 'knowledge.folders.list') return folders
    if (method === 'knowledge.documents.upload.select') {
      if (fail) throw new Error('Temporary outage')
      return []
    }
    return page([])
  })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务制度' }))
  await waitFor(() => { expect(parts(view.container).content.getByRole('button', { name: zh.knowledgeAddMaterial }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeAddMaterial }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeUpload }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.upload.select')).toBe(true) })
  expect(parts(view.container).content.getByRole('heading', { name: '业务制度', level: 1 }).getAttribute('aria-current')).toBe('page')
  fail = true
  await waitFor(() => { expect(parts(view.container).content.getByRole('button', { name: zh.knowledgeAddMaterial }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeAddMaterial }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeUpload }))
  await parts(view.container).content.findByText(zh.knowledgeUploadFailed)
  expect(parts(view.container).content.getByRole('heading', { name: '业务制度', level: 1 }).getAttribute('aria-current')).toBe('page')
  for (const call of api.invoke.mock.calls.filter(row => row[1] === 'knowledge.documents.upload.select')) {
    expect(call[2]).toMatchObject({ knowledgeBaseId: 'personal', folderId: 'stable-folder', pdfParseMode: 'STANDARD' })
  }
  const folderActions = parts(view.container).content.getByRole('button', {
    name: zh.knowledgeFolderActions.replace('{name}', '业务制度'),
  })
  fireEvent.click(folderActions)
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDeleteFolder }))
  const confirmation = await screen.findByRole('dialog', { name: zh.knowledgeDeleteFolder })
  expect(within(confirmation).queryByRole('alert')).toBeNull()
  fireEvent.click(within(confirmation).getByRole('button', { name: zh.cancel }))
  fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeAddMaterial }))
  expect(screen.getByRole('menuitem', { name: zh.knowledgeNewDocument }).hasAttribute('disabled')).toBe(false)
  expect(screen.getByRole('menuitem', { name: zh.knowledgeImportUrl }).hasAttribute('disabled')).toBe(false)
  expect(screen.getByRole('menuitem', { name: zh.knowledgeCreateFolder }).hasAttribute('disabled')).toBe(false)
})

it('offers folder rename and delete in the materials list while shared libraries retain only reads', async () => {
  transport(async method => method === 'knowledge.folders.list' ? folders : page([]))
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const actions = await parts(view.container).content.findByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '业务制度') })
  fireEvent.click(actions)
  expect(screen.getByRole('menuitem', { name: zh.knowledgeRenameFolder })).toBeDefined()
  expect(screen.getByRole('menuitem', { name: zh.knowledgeDeleteFolder })).toBeDefined()
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeRenameFolder }))
  const dialog = await screen.findByRole('dialog', { name: zh.knowledgeRenameFolder })
  expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: zh.knowledgeFolderName }).value).toBe('业务制度')
  fireEvent.click(within(dialog).getByRole('button', { name: zh.cancel }))
  chooseLibrary(view.container, '公司规范')
  await parts(view.container).content.findByRole('button', { name: '业务制度' })
  expect(parts(view.container).content.queryByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '业务制度') })).toBeNull()
})

it.each(['cancel', 'close'] as const)('clears a failed folder deletion after %s before previewing its file', async (action) => {
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.folders.list') return folders
    if (method === 'knowledge.folders.delete') throw new ProductError('KNOWLEDGE_FOLDER_NOT_EMPTY', 'Folder is not empty', false)
    if (method === 'knowledge.documents.preview.open') return originalPreview('# Current document')
    return page([{ ...documentRow('personal'), folderId: payload.folderId ?? null }])
  })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务制度' }))
  fireEvent.click(await parts(view.container).content.findByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '业务制度') }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDeleteFolder }))
  const dialog = await screen.findByRole('dialog', { name: zh.knowledgeDeleteFolder })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.deleteResource }))
  await within(dialog).findByRole('alert')
  expect(within(dialog).getByRole('alert').textContent).toContain(zh.knowledgeFolderNotEmpty)
  await waitFor(() => { expect(within(dialog).getByRole('button', { name: zh.cancel }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(within(dialog).getByRole('button', { name: action === 'cancel' ? zh.cancel : zh.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(parts(view.container).content.getByRole('heading', { name: '业务制度', level: 1 }).getAttribute('aria-current')).toBe('page')
  fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(view.container).content.findByRole('heading', { name: 'Current document' })
  expect(parts(view.container).content.queryByRole('alert')).toBeNull()
  expect(api.invoke.mock.calls.filter(row => row[1] === 'knowledge.folders.delete')).toHaveLength(1)
})

it('preserves folder upload recovery after leaving the reader and switching libraries', async () => {
  const selected = { operationId: 'upload-operation-0001', filename: 'upload.md', pdfParseMode: 'STANDARD', folderId: 'stable-folder' }
  let retained = false
  let succeeded = false
  const api = transport(async (method) => {
    if (method === 'knowledge.folders.list') return folders
    if (method === 'knowledge.documents.preview.open') return originalPreview('# Current document')
    if (method === 'knowledge.documents.upload.select') { retained = true; return [selected] }
    if (method === 'knowledge.documents.upload') {
      if (!succeeded) throw new ProductError('PRODUCT_NETWORK_UNAVAILABLE', 'Lost receipt', true)
      return { ...documentRow('personal'), folderId: 'stable-folder' }
    }
    if (method === 'knowledge.documents.upload.discard') { retained = false; return { discarded: true } }
    return page([documentRow('personal')])
  }, async payload => payload.knowledgeBaseId === 'personal' && retained ? [selected] : [])
  let view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(view.container).content.findByRole('heading', { name: 'Current document' })
  fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeBackToFolder }))
  fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '业务制度') }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeUploadToFolder }))
  let dialog = within(await screen.findByRole('dialog', { name: zh.knowledgeUploadFiles }))
  expect(api.invoke.mock.calls.some(call => call[1] === 'knowledge.documents.upload')).toBe(false)
  fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeUpload }))
  await dialog.findByRole('alert')
  const original = api.invoke.mock.calls.find(call => call[1] === 'knowledge.documents.upload')![2]
  fireEvent.click(dialog.getAllByRole('button', { name: zh.close }).at(-1)!)
  await parts(view.container).content.findByRole('button', { name: '业务规范.md' })
  chooseLibrary(view.container, '公司规范')
  chooseLibrary(view.container, '我的资料')
  await parts(view.container).content.findByRole('button', { name: zh.knowledgeUploadViewQueue })
  expect(api.invoke.mock.calls.some(call => call[1] === 'knowledge.documents.upload.discard')).toBe(false)
  view.unmount()
  view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await parts(view.container).content.findByRole('button', { name: zh.knowledgeUploadViewQueue }))
  dialog = within(await screen.findByRole('dialog', { name: zh.knowledgeUploadFiles }))
  succeeded = true
  fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeUpload }))
  await dialog.findByText(zh.knowledgeUploadAccepted)
  const attempts = api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.upload')
  expect(attempts).toHaveLength(2)
  expect(attempts[1]?.[2]).toEqual(original)
  expect(original).toMatchObject({ folderId: 'stable-folder', pdfParseMode: 'STANDARD' })
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.upload.select')).toHaveLength(1)
})

it('blocks new uploads until pending operations are known and allows recovery refresh', async () => {
  let failed = true
  const api = transport(async () => page([]), async () => {
    if (failed) throw new Error('Pending read failed')
    return []
  })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const { content } = parts(view.container)
  await content.findByText(zh.knowledgeUploadRecoveryFailed)
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeAddMaterial }))
  expect(screen.getByRole('menuitem', { name: zh.knowledgeUpload }).hasAttribute('disabled')).toBe(true)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(api.invoke.mock.calls.some(call => call[1] === 'knowledge.documents.upload')).toBe(false)
  failed = false
  fireEvent.click(content.getByRole('button', { name: zh.refresh }))
  await waitFor(() => { expect(content.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeAddMaterial }).disabled).toBe(false) })
})

it('allows a reader to download an unavailable preview without offering shared material mutation', async () => {
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.folders.list') return folders
    if (method === 'knowledge.documents.preview.open') throw new Error('Unsupported preview')
    if (method === 'knowledge.documents.download') return { cancelled: false }
    return page([documentRow(String(payload.knowledgeBaseId))])
  })
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  chooseLibrary(view.container, '公司规范')
  fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(view.container).content.findByRole('alert')
  fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', '业务规范.md') }))
  expect(screen.queryByRole('menuitem', { name: zh.knowledgeOpenExternal })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: zh.deleteResource })).toBeNull()
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDownloadOriginal }))
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.download', {
    knowledgeBaseId: 'company', documentId: 'shared-document-id',
  }, expect.any(String), 300_000) })
})

it.each(['FAILED', 'PROCESSING', 'QUEUED', 'CANCELLED'])(
  'previews the original file while its retrieval index is %s', async (status) => {
    const failureMessage = 'anydoc malformed archive; internal source path: /private/parser/uploads/document.docx'
    const api = transport(async method => method === 'knowledge.folders.list' ? folders
      : method === 'knowledge.documents.preview.open' ? page([{ content: '# 原文件正常' }])
        : page([{ ...documentRow('personal'), status, failureMessage }]))
    const { container } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
    const file = await parts(container).content.findByRole('button', { name: '业务规范.md' })
    expect(file.hasAttribute('disabled')).toBe(false)
    expect(container.textContent).not.toContain(failureMessage)
    if (status === 'FAILED') {
      expect(within(parts(container).content.getByRole('table')).getByText(zh.knowledgeIndexFailed)).toBeDefined()
    }
    fireEvent.click(file)
    await parts(container).content.findByRole('heading', { name: '原文件正常' })
    expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.read')).toBe(false)
  })

it('keeps only the selected library and reads personal materials inline without changing a task', async () => {
  const api = transport(async (method, payload) => method === 'knowledge.folders.list' ? folders
    : method === 'knowledge.documents.preview.open' ? page([{ id: 'chunk', documentId: 'shared-document-id', content: '# 正文', locator: '' }])
      : page([documentRow(String(payload.knowledgeBaseId))]))
  const { container } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const { content } = parts(container)
  expect(content.getByText(zh.scopePersonal)).toBeDefined()
  expect(content.queryByText(zh.scopeDepartment)).toBeNull()
  expect(content.queryByText(zh.scopeCompany)).toBeNull()
  expect(content.queryByRole('heading', { name: '销售制度' })).toBeNull()
  expect(content.getByRole('heading', { name: '我的资料', level: 1 })).toBeDefined()
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await content.findByRole('heading', { name: '正文' })
  expect(document.activeElement).toBe(content.getByRole('button', { name: zh.knowledgeBackToFolder }))
  expect(container.querySelector('[data-knowledge-inline-reader]')).not.toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.preview.open', {
    knowledgeBaseId: 'personal', documentId: 'shared-document-id',
  }, expect.any(String), 300_000)
  expect(api.invoke.mock.calls.some(row => row[1].startsWith('tasks.'))).toBe(false)
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeBackToFolder }))
  expect(document.activeElement).toBe(content.getByRole('button', { name: '业务规范.md' }))
})

it('cancels a pending reader when switching folders and never fills the next scope with old text', async () => {
  const stale = deferred()
  const api = transport(async (method, payload) => method === 'knowledge.documents.preview.open' ? stale.promise
    : method === 'knowledge.folders.list' ? folders : page(payload.folderId === 'stable-folder' ? [] : [documentRow('personal')]))
  const { container } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const { content } = parts(container)
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.preview.open')).toBe(true) })
  const read = api.invoke.mock.calls.find(row => row[1] === 'knowledge.documents.preview.open')
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeBackToFolder }))
  fireEvent.click(await content.findByRole('button', { name: '业务制度' }))
  expect(api.cancel).toHaveBeenCalledWith('product', read?.[3])
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list', {
    knowledgeBaseId: 'personal', folderId: 'stable-folder', page: 1, size: 20,
  }, expect.any(String)) })
  await act(async () => { stale.resolve(page([{ id: 'old', documentId: 'shared-document-id', content: '旧资料正文', locator: '' }])) })
  expect(screen.queryByText('旧资料正文')).toBeNull()
  expect(container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
  chooseLibrary(container, '我的资料')
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list', {
    knowledgeBaseId: 'personal', folderId: null, page: 1, size: 20,
  }, expect.any(String)) })
})

it('releases the old library reader even when the next library reuses the same document ID', async () => {
  const stale = deferred()
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.folders.list') return folders
    if (method === 'knowledge.documents.preview.open') return payload.knowledgeBaseId === 'personal' ? stale.promise
      : page([{ id: 'current', documentId: 'shared-document-id', content: '# 部门正文', locator: '' }])
    return page([documentRow(String(payload.knowledgeBaseId))])
  })
  const { container } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.preview.open')).toBe(true) })
  const read = api.invoke.mock.calls.find(row => row[1] === 'knowledge.documents.preview.open')
  chooseLibrary(container, '销售制度')
  expect(api.cancel).toHaveBeenCalledWith('product', read?.[3])
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(container).content.findByRole('heading', { name: '部门正文' })
  await act(async () => { stale.resolve(page([{ id: 'stale', documentId: 'shared-document-id', content: '# 个人旧正文', locator: '' }])) })
  expect(screen.queryByText('个人旧正文')).toBeNull()
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.preview.open', {
    knowledgeBaseId: 'sales-21', documentId: 'shared-document-id',
  }, expect.any(String), 300_000)
  expect(parts(container).content.queryByRole('button', { name: zh.knowledgeAddMaterial })).toBeNull()
  expect(api.invoke.mock.calls.some(row => row[1].startsWith('tasks.'))).toBe(false)
})

it.each(['KNOWLEDGE_ACCESS_DENIED', 'KNOWLEDGE_ACCESS_REVOKED', 'ORGANIZATION_EMPLOYEE_INACTIVE', 'ORGANIZATION_EMPLOYEE_UNMAPPED'])(
  'clears the current library after %s without exposing diagnostics or widening access', async (code) => {
    const api = transport(async (method, payload) => {
      if (method === 'knowledge.folders.list') return folders
      if (method === 'knowledge.documents.preview.open') throw new ProductError(code, 'private diagnostic', false)
      return page([documentRow(String(payload.knowledgeBaseId))])
    })
    const { container } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
    chooseLibrary(container, '公司规范')
    fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
    const alert = await parts(container).content.findByRole('alert')
    expect(alert.textContent).not.toContain('private diagnostic')
    expect(container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
    expect(parts(container).content.queryByRole('button', { name: '业务规范.md' })).toBeNull()
    expect(parts(container).content.queryByRole('button', { name: '业务制度' })).toBeNull()
    expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.preview.open', {
      knowledgeBaseId: 'company', documentId: 'shared-document-id',
    }, expect.any(String), 300_000)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

it.each([false, true])('cancels pending content when a catalog refresh removes the selected library without taking focus elsewhere (elsewhere=%s)', async (elsewhere) => {
  const stale = deferred()
  const api = transport(async (method, payload) => method === 'knowledge.documents.preview.open' ? stale.promise
    : method === 'knowledge.folders.list' ? folders : page([documentRow(String(payload.knowledgeBaseId))]))
  const content = (values = entries) => <><KnowledgeWorkspace {...props} entries={values} /><button type="button">其他操作</button></>
  const { container, rerender } = renderKnowledgeWorkspace(content())
  const other = screen.getByRole('button', { name: '其他操作' })
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.preview.open')).toBe(true) })
  const read = api.invoke.mock.calls.find(row => row[1] === 'knowledge.documents.preview.open')
  if (elsewhere) other.focus()
  rerender(content(entries.filter(row => row.id !== 'personal')))
  expect(api.cancel).toHaveBeenCalledWith('product', read?.[3])
  await act(async () => { stale.resolve(page([{ id: 'old', documentId: 'shared-document-id', content: '已撤权正文', locator: '' }])) })
  expect(screen.queryByText('已撤权正文')).toBeNull()
  expect(container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
  expect(container.querySelector('[data-knowledge-directory]')).not.toBeNull()
  expect(screen.queryByRole('button', { name: '我的资料' })).toBeNull()
  expect(document.activeElement).toBe(elsewhere ? other : screen.getByRole('heading', { name: zh.knowledge, level: 1 }))
  expect(api.invoke.mock.calls.some(row => row[2].knowledgeBaseId !== undefined && row[2].knowledgeBaseId !== 'personal')).toBe(false)
  const listCalls = api.invoke.mock.calls.filter(row => row[1] === 'knowledge.documents.list').length
  rerender(content())
  expect(container.querySelector('[data-knowledge-directory]')).not.toBeNull()
  expect(api.invoke.mock.calls.filter(row => row[1] === 'knowledge.documents.list')).toHaveLength(listCalls)
  expect(document.activeElement).toBe(elsewhere ? other : screen.getByRole('heading', { name: zh.knowledge, level: 1 }))
})

it('opens documents directly without an extra mobile browse layer', async () => {
  transport(async method => method === 'knowledge.folders.list' ? folders : method === 'knowledge.documents.preview.open'
    ? page([{ id: 'current', documentId: 'shared-document-id', content: '# 当前正文', locator: '' }]) : page([documentRow('personal')]))
  const { container } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} entries={entries.filter(row => row.scope !== 'COMPANY')} />)
  expect(screen.queryByRole('button', { name: zh.knowledgeBrowse })).toBeNull()
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(container).content.findByRole('heading', { name: '当前正文' })
  expect(container.querySelector('aside')).toBeNull()
})

it('retains content on directory failure and exposes retry without running a task', async () => {
  transport(async method => method === 'knowledge.folders.list' ? folders : page([documentRow('personal')]))
  const { container, rerender } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  await parts(container).content.findByRole('button', { name: '业务规范.md' })
  rerender(<KnowledgeWorkspace {...props} error="组织目录暂不可用" />)
  expect(parts(container).content.getByRole('alert').textContent).toContain('组织目录暂不可用')
  expect(parts(container).content.getByRole('button', { name: '业务规范.md' })).toBeDefined()
  const retry = parts(container).content.getByRole<HTMLButtonElement>('button', { name: zh.retry })
  const notice = parts(container).content.getByRole('alert')
  retry.focus()
  fireEvent.click(retry)
  expect(props.onRefresh).toHaveBeenCalledOnce()
  rerender(<KnowledgeWorkspace {...props} error="组织目录暂不可用" loading />)
  expect(parts(container).content.getByRole('alert')).toBe(notice)
  expect(parts(container).content.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(globalThis.document.activeElement).toBe(retry)
  fireEvent.click(retry)
  expect(props.onRefresh).toHaveBeenCalledOnce()
})

it('pages the file list and clears it after an explicit access revocation', async () => {
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.folders.list') return { ...folders, items: payload.page === 1 ? folders.items : [], page: payload.page }
    if (method === 'knowledge.documents.preview.open') return page([{ id: 'read', documentId: 'shared-document-id', content: '# 保留正文', locator: '' }])
    if (payload.page === 3) throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'private revocation diagnostic', false)
    return { items: [payload.page === 2 ? { ...documentRow('personal'), id: 'another-document', filename: '下一页.md' } : documentRow('personal')],
      page: Number(payload.page), size: 20, total: 41 }
  })
  const { container } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(container).content.findByRole('heading', { name: '保留正文' })
  fireEvent.click(parts(container).content.getByRole('button', { name: zh.knowledgeBackToFolder }))
  fireEvent.click(parts(container).content.getByRole('button', { name: zh.nextPage }))
  await parts(container).content.findByRole('button', { name: '下一页.md' })
  expect(parts(container).content.queryByRole('heading', { name: '保留正文' })).toBeNull()
  fireEvent.click(parts(container).content.getByRole('button', { name: zh.nextPage }))
  await parts(container).content.findByRole('alert')
  expect(container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
  expect(screen.queryByRole('heading', { name: '保留正文' })).toBeNull()
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list', {
    knowledgeBaseId: 'personal', page: 3, size: 20, folderId: null,
  }, expect.any(String))
})

it('offers previous-page navigation when the next file page fails temporarily', async () => {
  transport(async (method, payload) => {
    if (method === 'knowledge.folders.list') return folders
    if (method === 'knowledge.documents.preview.open') return page([{ id: 'read', documentId: 'shared-document-id', content: '# 当前正文', locator: '' }])
    if (payload.page === 2) throw new ProductError('ORGANIZATION_SERVICE_UNAVAILABLE', 'private network diagnostic', true)
    return { items: [documentRow('personal')], page: 1, size: 20, total: 21 }
  })
  const { container } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(container).content.findByRole('heading', { name: '当前正文' })
  fireEvent.click(parts(container).content.getByRole('button', { name: zh.knowledgeBackToFolder }))
  fireEvent.click(parts(container).content.getByRole('button', { name: zh.nextPage }))
  await waitFor(() => { expect(parts(container).content.getByRole('button', { name: zh.previousPage }).hasAttribute('disabled')).toBe(false) })
  expect(parts(container).content.queryByRole('heading', { name: '当前正文' })).toBeNull()
  expect(container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
  expect(screen.queryByText('private network diagnostic')).toBeNull()
})

it('returns to files and searches the current folder without keeping a pending reader', async () => {
  const stale = deferred()
  const api = transport(async (method, payload) => method === 'knowledge.documents.preview.open' ? stale.promise
    : method === 'knowledge.folders.list' ? folders : page(payload.query ? [] : [documentRow('personal')]))
  const { container } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.preview.open')).toBe(true) })
  const read = api.invoke.mock.calls.find(row => row[1] === 'knowledge.documents.preview.open')
  fireEvent.click(parts(container).content.getByRole('button', { name: zh.knowledgeBackToFolder }))
  fireEvent.change(parts(container).content.getByRole('searchbox', { name: zh.knowledgeFindFiles }), { target: { value: '合同' } })
  fireEvent.click(parts(container).content.getByRole('button', { name: zh.search }))
  expect(api.cancel).toHaveBeenCalledWith('product', read?.[3])
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list', {
    knowledgeBaseId: 'personal', query: '合同', page: 1, size: 20, folderId: null,
  }, expect.any(String)) })
  await act(async () => { stale.resolve(page([{ id: 'old', documentId: 'shared-document-id', content: '搜索前正文', locator: '' }])) })
  expect(screen.queryByText('搜索前正文')).toBeNull()
  expect(container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
})

it('rechecks a same-ID library and its open document after a directory refresh', async () => {
  let generation = 0
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.folders.list') return page([{ id: 'stable-folder', parentId: null, name: generation === 0 ? '业务制度' : '当前制度', updatedAt: folderUpdatedAt }])
    if (method === 'knowledge.documents.preview.open') return page([{ id: 'read', documentId: 'shared-document-id',
      content: generation === 0 ? '# 初始正文' : '# 当前授权正文', locator: '' }])
    return page([documentRow(String(payload.knowledgeBaseId))])
  })
  const { container, rerender } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} refreshRevision={0} />)
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(container).content.findByRole('heading', { name: '初始正文' })
  generation = 1
  rerender(<KnowledgeWorkspace {...props} refreshRevision={1} />)
  await parts(container).content.findByRole('heading', { name: '当前授权正文' })
  expect(screen.queryByRole('heading', { name: '初始正文' })).toBeNull()
  for (const method of ['knowledge.documents.list', 'knowledge.folders.list', 'knowledge.documents.preview.open']) {
    expect(api.invoke.mock.calls.filter(row => row[1] === method)).toHaveLength(2)
  }
})

it.each([
  ['knowledge.documents.list', 'KNOWLEDGE_ACCESS_DENIED'],
  ['knowledge.folders.list', 'KNOWLEDGE_ACCESS_REVOKED'],
  ['knowledge.documents.list', 'ORGANIZATION_EMPLOYEE_INACTIVE'],
  ['knowledge.folders.list', 'ORGANIZATION_EMPLOYEE_UNMAPPED'],
])('clears the library after %s denies access and ignores a concurrent successful response', async (deniedMethod, code) => {
  let refreshing = false
  const denied = deferred()
  const late = deferred()
  const api = transport(async (method, payload) => {
    if (refreshing && method === deniedMethod) {
      await denied.promise
      throw new ProductError(code, 'private permission diagnostic', false)
    }
    if (method === 'knowledge.documents.preview.open') {
      if (refreshing) return late.promise
      return page([{ id: 'read', documentId: 'shared-document-id', content: '# 旧正文', locator: '' }])
    }
    return method === 'knowledge.folders.list' ? folders : page([documentRow(String(payload.knowledgeBaseId))])
  })
  const { container, rerender } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(container).content.findByRole('heading', { name: '旧正文' })
  refreshing = true
  rerender(<KnowledgeWorkspace {...props} refreshRevision={1} />)
  await waitFor(() => {
    expect(api.invoke.mock.calls.filter(row => row[1] === deniedMethod)).toHaveLength(2)
    expect(api.invoke.mock.calls.filter(row => row[1] === 'knowledge.documents.preview.open')).toHaveLength(2)
  })
  const concurrentRequest = api.invoke.mock.calls.filter(row => row[1] === 'knowledge.documents.preview.open').at(-1)
  await act(async () => { denied.resolve(undefined) })
  await waitFor(() => { expect(container.querySelector('[data-knowledge-inline-reader]')).toBeNull() })
  expect(api.cancel).toHaveBeenCalledWith('product', concurrentRequest?.[3])
  await act(async () => { late.resolve(page([{ id: 'late', documentId: 'shared-document-id', content: '# 不应显示的正文', locator: '' }])) })
  expect(screen.queryByRole('heading', { name: '不应显示的正文' })).toBeNull()
  expect(parts(container).content.queryByRole('button', { name: '业务规范.md' })).toBeNull()
  expect(parts(container).content.queryByRole('button', { name: '业务制度' })).toBeNull()
  expect(screen.queryByRole('heading', { name: '旧正文' })).toBeNull()
  expect(parts(container).content.queryByRole('button', { name: zh.knowledgeAddMaterial })).toBeNull()
  expect(screen.queryByText('private permission diagnostic')).toBeNull()
  const requests = api.invoke.mock.calls.length
  expect(parts(container).content.queryByRole('tablist')).toBeNull()
  await act(async () => {})
  expect(api.invoke.mock.calls).toHaveLength(requests)
})

it.each(['ORGANIZATION_SERVICE_UNAVAILABLE', 'ORGANIZATION_SYNC_EXPIRED'])(
  'retains the selected file and offers retry when refreshed authorization fails with %s', async (code) => {
    let refreshing = false
    transport(async (method, payload) => {
      if (method === 'knowledge.folders.list') return folders
      if (method === 'knowledge.documents.preview.open') {
        if (refreshing) throw new ProductError(code, 'private temporary organization diagnostic', true)
        return page([{ id: 'read', documentId: 'shared-document-id', content: '# 已读正文', locator: '' }])
      }
      return page([documentRow(String(payload.knowledgeBaseId))])
    })
    const { container, rerender } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
    fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
    await parts(container).content.findByRole('heading', { name: '已读正文' })
    refreshing = true
    rerender(<KnowledgeWorkspace {...props} refreshRevision={1} />)
    await parts(container).content.findByRole('alert')
    expect(parts(container).content.queryByRole('heading', { name: '已读正文' })).toBeNull()
    expect(parts(container).content.getByRole('button', { name: zh.retry })).toBeDefined()
    expect(parts(container).content.getByRole('heading', { name: '业务规范.md', level: 1 })).toBeDefined()
    expect(container.querySelector('[data-knowledge-inline-reader]')).not.toBeNull()
    expect(screen.queryByText('private temporary organization diagnostic')).toBeNull()
  })

it('removes material management when refreshed library metadata grants reading only', async () => {
  transport(async (method, payload) => method === 'knowledge.folders.list' ? folders
    : method === 'knowledge.documents.preview.open' ? page([{ id: 'read', documentId: 'shared-document-id', content: '# 可读正文', locator: '' }])
      : page([documentRow(String(payload.knowledgeBaseId))]))
  const { container, rerender } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  await parts(container).content.findByRole('button', { name: '业务规范.md' })
  expect(parts(container).content.getByRole('button', { name: zh.knowledgeAddMaterial })).toBeDefined()
  fireEvent.click(parts(container).content.getByRole('button', { name: zh.knowledgeAddMaterial }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeNewDocument }))
  await screen.findByRole('dialog', { name: zh.knowledgeNewDocument })
  const readOnly = entries.map(row => row.id === 'personal' ? { ...row, canManage: false } : row)
  rerender(<KnowledgeWorkspace {...props} entries={readOnly} />)
  expect(parts(container).content.queryByRole('button', { name: zh.knowledgeAddMaterial })).toBeNull()
  expect(parts(container).content.queryByRole('button', { name: zh.knowledgeAddMaterial })).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(parts(container).content.getByRole('button', { name: '业务规范.md' }))
  await parts(container).content.findByRole('heading', { name: '可读正文' })
  fireEvent.click(parts(container).content.getByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', '业务规范.md') }))
  expect(screen.getByRole('menuitem', { name: zh.knowledgeDownloadOriginal })).toBeDefined()
  expect(screen.queryByRole('menuitem', { name: zh.deleteResource })).toBeNull()
})

it('returns to the first materials page after the library becomes empty', async () => {
  let empty = false
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.folders.list') return page([], Number(payload.page))
    if (payload.page === 2) empty = true
    return { items: empty ? [] : [documentRow('personal')], page: Number(payload.page), size: 20, total: empty ? 0 : 21 }
  })
  const { container } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  await parts(container).content.findByRole('button', { name: '业务规范.md' })
  fireEvent.click(parts(container).content.getByRole('button', { name: zh.nextPage }))
  await parts(container).content.findByText(zh.knowledgeNoMaterials)
  expect(api.invoke.mock.calls.filter(row => row[1] === 'knowledge.documents.list' && row[2].page === 1)).toHaveLength(2)
  expect(parts(container).content.queryByRole('button', { name: zh.previousPage })).toBeNull()
  expect(parts(container).content.queryByRole('button', { name: zh.nextPage })).toBeNull()
})

it('shows root files beside folders and resolves all-materials files in the reader breadcrumb', async () => {
  const nested = { ...documentRow('personal'), folderId: 'stable-folder' }
  const root = { ...documentRow('personal'), id: 'root-document', filename: '未归档.md' }
  const api = transport(async (method, payload) => method === 'knowledge.folders.list' ? folders
    : method === 'knowledge.documents.preview.open' ? page([{ id: 'read', documentId: 'shared-document-id', content: '# 文件夹正文', locator: '' }])
      : page(payload.folderId === null ? [root] : payload.folderId === undefined ? [nested, root] : [nested]))
  const { container } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  await parts(container).content.findByRole('button', { name: '未归档.md' })
  const folder = await parts(container).content.findByRole('button', { name: '业务制度' })
  const branch = folder.closest('tr')
  if (!branch) throw new Error('Missing folder branch')
  expect(parts(container).content.queryByRole('button', { name: '业务规范.md' })).toBeNull()
  expect(branch.contains(parts(container).content.getByRole('button', { name: '未归档.md' }))).toBe(false)
  fireEvent.click(parts(container).content.getByRole('tab', { name: zh.knowledgeAllMaterials }))
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(container).content.findByRole('heading', { name: '文件夹正文' })
  const breadcrumb = parts(container).content.getByRole('navigation', { name: zh.knowledgeLocation })
  expect(within(breadcrumb).getByRole('button', { name: '业务制度' })).toBeDefined()
  fireEvent.click(within(breadcrumb).getByRole('button', { name: '业务制度' }))
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list', {
    knowledgeBaseId: 'personal', folderId: 'stable-folder', page: 1, size: 20,
  }, expect.any(String)) })
  expect(container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
})

it.each(['duplicate', 'path', 'destination', 'overflow'] as const)('blocks uploads when recovered file metadata contains %s', async (invalid) => {
  const row = { operationId: 'upload-operation-0001', filename: 'file.md', pdfParseMode: 'STANDARD', folderId: null }
  const pending = invalid === 'duplicate' ? [row, row] : invalid === 'path' ? [{ ...row, filename: '/private/file.md' }]
    : invalid === 'destination' ? [{ ...row, folderId: '../outside' }] : Array.from({ length: 17 }, (_, index) => ({ ...row, operationId: `upload-operation-${index}` }))
  const api = transport(async () => page([]), async () => pending)
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const content = parts(view.container).content
  await content.findByText(zh.knowledgeUploadRecoveryFailed)
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeAddMaterial }))
  expect(screen.getByRole('menuitem', { name: zh.knowledgeUpload }).hasAttribute('disabled')).toBe(true)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(api.invoke.mock.calls.some(call => call[1] === 'knowledge.documents.upload.select' || call[1] === 'knowledge.documents.upload')).toBe(false)
})

it.each([true, false])('keeps a folder deletion unconfirmed until the target is acknowledged, deleted=%s', async (deleted) => {
  let valid = false
  const api = transport(async (method, payload) => method === 'knowledge.folders.list'
    ? page([{ id: 'folder', name: '待删除目录', parentId: null, updatedAt: folderUpdatedAt }])
    : method === 'knowledge.folders.delete' ? { folderId: valid ? payload.folderId : 'another-folder', deleted } : page([]))
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const { content } = parts(view.container)
  fireEvent.click(await content.findByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '待删除目录') }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDeleteFolder }))
  const dialog = within(screen.getByRole('dialog'))
  fireEvent.click(dialog.getByRole('button', { name: zh.deleteResource }))
  await dialog.findByRole('alert')
  valid = true
  fireEvent.click(dialog.getByRole('button', { name: zh.deleteResource }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  const writes = api.invoke.mock.calls.filter(call => call[1] === 'knowledge.folders.delete')
  expect(writes).toHaveLength(2)
  expect(writes[0]![2]).toEqual(writes[1]![2])
})

it('restarts pending upload recovery on catalog refresh and ignores its late previous result', async () => {
  const previous = deferred()
  let reads = 0
  const api = transport(async () => page([]), async () => ++reads === 1 ? previous.promise : [])
  const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  try {
    await waitFor(() => { expect(reads).toBe(1) })
    const first = api.invoke.mock.calls.find(call => call[1] === 'knowledge.documents.upload.pending')!
    view.rerender(<KnowledgeWorkspace {...props} refreshRevision={1} />)
    await waitFor(() => { expect(reads).toBe(2) })
    expect(api.cancel).toHaveBeenCalledWith('product', first[3])
    await waitFor(() => { expect(parts(view.container).content.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeAddMaterial }).disabled).toBe(false) })
    await act(async () => { previous.resolve([{ operationId: 'old-operation-identity', filename: 'old.md', pdfParseMode: 'STANDARD', folderId: null }]) })
    expect(parts(view.container).content.queryByText('old.md')).toBeNull()
    expect(parts(view.container).content.queryByRole('button', { name: zh.knowledgeUploadViewQueue })).toBeNull()
  } finally {
    view.unmount()
    previous.resolve([])
    await Promise.allSettled(api.invoke.mock.results.map((result): unknown => result.value))
  }
})
