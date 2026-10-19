// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import { KnowledgeWorkspace } from '../src/client/KnowledgeWorkspace.tsx'
import { items } from '../src/client/catalog-shared.tsx'
import { zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'
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
const page = (values: readonly unknown[]) => ({ items: values, page: 1, size: 20, total: values.length })
const folderUpdatedAt = '2026-10-17T00:00:00Z'
const folders = page([{ id: 'stable-folder', name: '业务制度', parentId: null, updatedAt: folderUpdatedAt }])
const props = { entries, loading: false, authRequired: false, authPending: false, authError: false,
  onRefresh: vi.fn(), onSignIn: vi.fn(), renderFactorySlot: renderKnowledgePreview, t }

function transport(handler: (method: string, payload: Record<string, unknown>) => Promise<unknown>,
  pendingUploads: (payload: Record<string, unknown>) => Promise<unknown> = async () => [],
  metadata: (payload: Record<string, unknown>) => Promise<unknown> = async payload => originalMetadata(
    String(payload.knowledgeBaseId), String(payload.documentId),
  )) {
  const preview = createPreviewFixture()
  const folderMetadata = new Map<string, unknown>()
  const invoke = vi.fn(async (_namespace: string, method: string, payload: Record<string, unknown>, _requestId?: string) => {
    try {
      if (method === 'knowledge.documents.upload.pending') return { ok: true, result: await pendingUploads(payload) }
      if (method === 'knowledge.folders.get') {
        const result = folderMetadata.get(`${payload.knowledgeBaseId}:${payload.folderId}`)
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
  const navigation = container.querySelector<HTMLElement>('[data-knowledge-navigation]')
  const content = container.querySelector<HTMLElement>('[data-knowledge-content]')
  if (!navigation || !content) throw new Error('Missing knowledge workspace regions')
  return { navigation: within(navigation), content: within(content) }
}

function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((commit) => { resolve = commit })
  return { promise, resolve }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

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
  const view = render(<KnowledgeWorkspace {...props} />)
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
  expect(parts(view.container).navigation.queryByRole('button', { name: '业务制度' })).toBeNull()
  expect(parts(view.container).content.queryByRole('button', { name: zh.knowledgeAddMaterial })).toBeNull()
  expect(parts(view.container).content.queryByText(zh.loading)).toBeNull()
  expect(view.container.textContent).not.toContain('private processing diagnostic')
  const finalCalls = api.invoke.mock.calls.filter(call => call[1] === `knowledge.documents.${action}`)
  expect(finalCalls).toHaveLength(3)
  expect(finalCalls[2]?.[2]).not.toEqual(finalCalls[1]?.[2])
  expect(parts(view.container).content.getByRole('alert').textContent).toMatchSnapshot()
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
  const view = render(<KnowledgeWorkspace {...props} />)
  try {
    fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务规范.md' }))
    await parts(view.container).content.findByRole('heading', { name: '当前原文件' })
    if (stage === 'select') {
      fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeBackToFolder }))
      fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeUpload }))
      fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeUploadStandard }))
    } else await act(async () => { permission.resolve(undefined) })
    await waitFor(() => { expect(parts(view.container).content.getByRole('alert').textContent).toContain(zh.knowledgeAccessRevoked) })
    expect(view.container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
    expect(parts(view.container).content.queryByRole('button', { name: '业务规范.md' })).toBeNull()
    expect(parts(view.container).navigation.queryByRole('button', { name: '业务制度' })).toBeNull()
    expect(parts(view.container).content.queryByRole('button', { name: zh.knowledgeUpload })).toBeNull()
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
  const view = render(<KnowledgeWorkspace {...props} />)
  try {
    fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务规范.md' }))
    await parts(view.container).content.findByRole('heading', { name: 'personal原文件' })
    if (action === 'upload.select') {
      fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeBackToFolder }))
      fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeUpload }))
      fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeUploadStandard }))
    } else {
      fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', '业务规范.md') }))
      fireEvent.click(screen.getByRole('menuitem', { name: action === 'reindex' ? zh.knowledgeReindex : zh.knowledgeStopProcessing }))
    }
    await waitFor(() => { expect(api.invoke.mock.calls.filter(call => call[1] === method)).toHaveLength(1) })
    const call = api.invoke.mock.calls.find(call => call[1] === method)
    fireEvent.click(parts(view.container).navigation.getByRole('button', { name: '公司规范' }))
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
  const view = render(<KnowledgeWorkspace {...props} />)
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
  const view = render(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: zh.knowledgeAddMaterial }))
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
  expect(screen.getByText('Catalog temporarily unavailable').closest('[role="alert"]')).not.toBeNull()
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
  const view = render(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: zh.knowledgeAddMaterial }))
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
  expect(screen.getByText('Catalog temporarily unavailable')).not.toBeNull()
})

it('pages folder branches independently and never reloads them during document processing polls', async () => {
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.folders.list') return payload.parentId === null
      ? { items: [{ id: `parent-${payload.page}`, name: `目录 ${payload.page}`, parentId: null, updatedAt: folderUpdatedAt }], page: payload.page, size: 20, total: 21 }
      : page([{ id: 'child', name: '子目录', parentId: payload.parentId, updatedAt: folderUpdatedAt }])
    return page([{ ...documentRow('personal'), status: 'PROCESSING' }])
  })
  const view = render(<KnowledgeWorkspace {...props} />)
  const { navigation } = parts(view.container)
  await navigation.findByRole('button', { name: '目录 1' })
  fireEvent.click(navigation.getByRole('button', { name: zh.nextPage }))
  await navigation.findByRole('button', { name: '目录 2' })
  fireEvent.click(navigation.getByRole('button', { name: zh.knowledgeExpandFolder.replace('{name}', '目录 2') }))
  await navigation.findByRole('button', { name: '子目录' })
  const before = api.invoke.mock.calls.filter(call => call[1] === 'knowledge.folders.list').length
  await waitFor(() => { expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list').length).toBeGreaterThan(1) }, { timeout: 5_000 })
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.folders.list')).toHaveLength(before)
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.folders.list').map(call => call[2])).toEqual([
    { knowledgeBaseId: 'personal', parentId: null, page: 1, size: 20 },
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
  const view = render(<KnowledgeWorkspace {...props} />)
  await parts(view.container).content.findByRole('button', { name: '业务规范.md' })
  fireEvent.change(parts(view.container).content.getByRole('combobox', { name: zh.status }), { target: { value: 'PROCESSING' } })
  fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(view.container).content.findByRole('heading', { name: '阅读中的原文件' })
  status = nextStatus
  await waitFor(() => {
    expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list')).toHaveLength(3)
  }, { timeout: 5_000 })
  expect(parts(view.container).content.getByRole('heading', { name: '阅读中的原文件' })).toBeDefined()
  expect(view.container.querySelector('[data-knowledge-inline-reader]')).not.toBeNull()
  const label = nextStatus === 'READY' ? zh.knowledgeIndexed : nextStatus === 'FAILED' ? zh.knowledgeIndexFailed : zh.knowledgeCancelled
  await waitFor(() => { expect(parts(view.container).content.getByRole('status').textContent).toContain(label) })
  expect(parts(view.container).content.getByRole('status').textContent).toMatchSnapshot()
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.preview.open')).toHaveLength(1)
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
    const view = render(<KnowledgeWorkspace {...props} />)
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
    const view = await act(async () => render(<KnowledgeWorkspace {...props} />))
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
    await act(async () => { fireEvent.click(parts(view.container).navigation.getByRole('button', { name: '公司规范' })) })
    expect(parts(view.container).content.getByRole('button', { name: '业务规范.md' })).toBeDefined()
    expect(api.cancel).toHaveBeenCalledWith('product', recheck?.[3])
    await act(async () => { pending.resolve({ ...originalMetadata('personal', 'shared-document-id'), status: 'READY' }) })
    expect(view.container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
    expect(parts(view.container).content.queryByRole('heading', { name: '阅读中的原文件' })).toBeNull()
    expect(parts(view.container).content.queryByRole('alert')).toBeNull()
  } finally { vi.useRealTimers() }
})

it('reloads folder branches on explicit refresh and discards externally removed folders', async () => {
  let removed = false
  const api = transport(async method => method === 'knowledge.folders.list'
    ? page([{ id: 'kept', name: '保留目录', parentId: null, updatedAt: folderUpdatedAt },
      ...removed ? [] : [{ id: 'removed', name: '删除目录', parentId: null, updatedAt: folderUpdatedAt }]])
    : page([documentRow('personal')]))
  const view = render(<KnowledgeWorkspace {...props} />)
  const { navigation, content } = parts(view.container)
  await navigation.findByRole('button', { name: '删除目录' })
  removed = true
  fireEvent.click(content.getByRole('button', { name: zh.refresh }))
  await navigation.findByRole('button', { name: '保留目录' })
  expect(navigation.queryByRole('button', { name: '删除目录' })).toBeNull()
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.folders.list')).toHaveLength(4)
  fireEvent.click(navigation.getByRole('button', { name: '保留目录' }))
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
      values.splice(index, 1); return { deleted: true }
    }
    return page([])
  })
  const view = render(<KnowledgeWorkspace {...props} />)
  const { navigation, content } = parts(view.container)
  await content.findByRole('button', { name: '项目资料' })
  expect(navigation.queryByRole('button', { name: documentRow('personal').filename })).toBeNull()
  fireEvent.click(navigation.getByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '项目资料') }))
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
  const child = await navigation.findByRole('button', { name: '验收记录' })
  expect(child.getAttribute('aria-current')).toBe('page')
  const breadcrumb = content.getByRole('navigation', { name: zh.knowledgeLocation })
  expect(within(breadcrumb).getAllByRole('button').map(button => button.textContent)).toEqual(['我的资料', '项目资料', '验收记录'])
  fireEvent.click(navigation.getByRole('button', { name: zh.knowledgeCollapseFolder.replace('{name}', '项目资料') }))
  expect(navigation.queryByRole('button', { name: '验收记录' })).toBeNull()
  fireEvent.click(navigation.getByRole('button', { name: zh.knowledgeExpandFolder.replace('{name}', '项目资料') }))
  fireEvent.click(await navigation.findByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '验收记录') }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDeleteFolder }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.deleteResource }))
  await waitFor(() => { expect(navigation.queryByRole('button', { name: '验收记录' })).toBeNull() })
  expect(navigation.getByRole('button', { name: '项目资料' }).getAttribute('aria-current')).toBe('page')
  expect(api.invoke.mock.calls.some(call => call[1].startsWith('tasks.'))).toBe(false)
})

it('keeps an unrelated folder selected when another empty folder is deleted', async () => {
  let deleted = false
  transport(async method => method === 'knowledge.folders.list'
    ? page([{ id: 'current', name: '当前目录', parentId: null, updatedAt: folderUpdatedAt }, ...deleted ? [] : [{ id: 'other', name: '其他目录', parentId: null, updatedAt: folderUpdatedAt }]])
    : method === 'knowledge.folders.delete' ? (deleted = true, { deleted: true }) : page([]))
  const view = render(<KnowledgeWorkspace {...props} />)
  const { navigation } = parts(view.container)
  fireEvent.click(await navigation.findByRole('button', { name: '当前目录' }))
  fireEvent.click(navigation.getByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '其他目录') }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDeleteFolder }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.deleteResource }))
  await waitFor(() => { expect(navigation.queryByRole('button', { name: '其他目录' })).toBeNull() })
  expect(navigation.getByRole('button', { name: '当前目录' }).getAttribute('aria-current')).toBe('page')
})

it('clears file filters when entering a different folder and keeps the directory listing independent of document pages', async () => {
  const api = transport(async method => method === 'knowledge.folders.list' ? folders : page([]))
  const view = render(<KnowledgeWorkspace {...props} />)
  const { navigation, content } = parts(view.container)
  fireEvent.change(content.getByRole('searchbox'), { target: { value: '旧查询' } })
  fireEvent.click(content.getByRole('button', { name: zh.search }))
  fireEvent.change(content.getByRole('combobox', { name: zh.knowledgeFormat }), { target: { value: 'pdf' } })
  fireEvent.click(await navigation.findByRole('button', { name: '业务制度' }))
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list', {
    knowledgeBaseId: 'personal', page: 1, size: 20, folderId: 'stable-folder',
  }, expect.any(String)) })
  expect(content.getByRole<HTMLInputElement>('searchbox').value).toBe('')
  expect(content.getByRole<HTMLSelectElement>('combobox', { name: zh.knowledgeFormat }).value).toBe('')
  await waitFor(() => { expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.folders.list').map(call => call[2])).toEqual([
    { knowledgeBaseId: 'personal', parentId: null, page: 1, size: 20 },
    { knowledgeBaseId: 'personal', parentId: null, page: 1, size: 20 },
    { knowledgeBaseId: 'personal', parentId: 'stable-folder', page: 1, size: 20 },
    { knowledgeBaseId: 'personal', parentId: 'stable-folder', page: 1, size: 20 },
  ]) })
})

it('creates a personal library from an empty personal group and selects it after catalog refresh', async () => {
  const created = { id: 'new-personal', name: '我的项目资料', scope: 'PERSONAL', canManage: true }
  const refresh = vi.fn()
  const api = transport(async method => method === 'knowledge.bases.create' ? created : page([]))
  const initial = entries.filter(row => row.scope !== 'PERSONAL')
  const view = render(<KnowledgeWorkspace {...props} entries={initial} onRefresh={refresh} />)
  fireEvent.click(parts(view.container).navigation.getByRole('button', { name: zh.knowledgeCreatePersonalBase }))
  const dialog = await screen.findByRole('dialog', { name: zh.knowledgeCreatePersonalBase })
  fireEvent.change(within(dialog).getByRole('textbox', { name: zh.knowledgeBaseName }), { target: { value: '我的项目资料' } })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.knowledgeCreate }))
  await waitFor(() => { expect(refresh).toHaveBeenCalledOnce() })
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.bases.create', {
    name: '我的项目资料', description: '', operationId: expect.any(String) as string,
  }, expect.any(String))
  view.rerender(<KnowledgeWorkspace {...props} entries={[...initial, ...items([created])]} onRefresh={refresh} />)
  await waitFor(() => { expect(parts(view.container).navigation.getByRole('button', { name: created.name }).getAttribute('aria-current')).toBe('page') })
  expect(api.invoke.mock.calls.some(row => row[1].startsWith('tasks.'))).toBe(false)
})

it('preserves the personal library name and retry identity after creation fails', async () => {
  let failed = true
  const api = transport(async (method) => {
    if (method === 'knowledge.bases.create') {
      if (failed) throw new Error('Temporary outage')
      return { id: 'retry-personal', name: '项目资料', scope: 'PERSONAL', canManage: true }
    }
    return page([])
  })
  render(<KnowledgeWorkspace {...props} entries={[]} />)
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

it('deletes a managed personal library and selects the next available library', async () => {
  const refresh = vi.fn()
  const api = transport(async method => method === 'knowledge.bases.delete' ? undefined : page([]))
  const view = render(<KnowledgeWorkspace {...props} onRefresh={refresh} />)
  fireEvent.click(parts(view.container).navigation.getByRole('button', {
    name: zh.knowledgeLibraryActions.replace('{name}', '我的资料'),
  }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDeleteBase }))
  const dialog = await screen.findByRole('dialog', { name: zh.knowledgeDeleteBase })
  expect(within(dialog).getByText(zh.knowledgeDeleteBaseConfirmation.replace('{name}', '我的资料'))).toBeDefined()
  fireEvent.click(within(dialog).getByRole('button', { name: zh.deleteResource }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.bases.delete')).toBe(true) })
  expect(refresh).toHaveBeenCalledOnce()
  expect(parts(view.container).navigation.getByRole('button', { name: '公司规范' }).getAttribute('aria-current')).toBe('page')
  expect(screen.queryByRole('dialog', { name: zh.knowledgeDeleteBase })).toBeNull()
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.bases.delete', { knowledgeBaseId: 'personal' }, expect.any(String))
})

it('keeps the personal-library confirmation open when deletion fails', async () => {
  const api = transport(async (method) => {
    if (method === 'knowledge.bases.delete') throw new Error('Temporary outage')
    return page([])
  })
  const view = render(<KnowledgeWorkspace {...props} />)
  fireEvent.click(parts(view.container).navigation.getByRole('button', {
    name: zh.knowledgeLibraryActions.replace('{name}', '我的资料'),
  }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDeleteBase }))
  const dialog = await screen.findByRole('dialog', { name: zh.knowledgeDeleteBase })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.deleteResource }))
  await within(dialog).findByText(zh.knowledgeDeleteBaseFailed)
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.bases.delete', { knowledgeBaseId: 'personal' }, expect.any(String))
  expect(screen.getByRole('dialog', { name: zh.knowledgeDeleteBase })).toBeDefined()
  expect(parts(view.container).navigation.getByRole('button', { name: '我的资料' }).getAttribute('aria-current')).toBe('page')
})

it.each([false, true])('preserves the currently browsed library when another deletion completes (delayed: %s)', async (delayed) => {
  const deletion = deferred()
  const refresh = vi.fn()
  const api = transport(async method => method === 'knowledge.bases.delete' ? deletion.promise : page([]))
  const view = render(<KnowledgeWorkspace {...props} onRefresh={refresh} />)
  const navigation = () => parts(view.container).navigation
  fireEvent.click(navigation().getByRole('button', { name: '销售制度' }))
  fireEvent.click(navigation().getByRole('button', {
    name: zh.knowledgeLibraryActions.replace('{name}', '我的资料'),
  }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDeleteBase }))
  const dialog = await screen.findByRole('dialog', { name: zh.knowledgeDeleteBase })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.deleteResource }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.bases.delete')).toBe(true) })
  if (delayed) {
    fireEvent.click(navigation().getByRole('button', { name: '销售案例' }))
    view.rerender(<KnowledgeWorkspace {...props} entries={[...entries].reverse()} onRefresh={refresh} />)
  }
  await act(async () => { deletion.resolve(undefined); await deletion.promise })
  await waitFor(() => { expect(refresh).toHaveBeenCalledOnce() })
  expect(navigation().getByRole('button', { name: delayed ? '销售案例' : '销售制度' }).getAttribute('aria-current')).toBe('page')
  expect(screen.queryByRole('dialog', { name: zh.knowledgeDeleteBase })).toBeNull()
})

it('uses the latest directory for replacement when deleting the selected library', async () => {
  const deletion = deferred()
  const refresh = vi.fn()
  const api = transport(async method => method === 'knowledge.bases.delete' ? deletion.promise : page([]))
  const view = render(<KnowledgeWorkspace {...props} onRefresh={refresh} />)
  fireEvent.click(parts(view.container).navigation.getByRole('button', {
    name: zh.knowledgeLibraryActions.replace('{name}', '我的资料'),
  }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDeleteBase }))
  const dialog = await screen.findByRole('dialog', { name: zh.knowledgeDeleteBase })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.deleteResource }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.bases.delete')).toBe(true) })
  view.rerender(<KnowledgeWorkspace {...props} entries={entries.filter(entry => entry.id !== 'company')} onRefresh={refresh} />)
  await act(async () => { deletion.resolve(undefined); await deletion.promise })
  await waitFor(() => { expect(refresh).toHaveBeenCalledOnce() })
  expect(parts(view.container).navigation.getByRole('button', { name: '销售制度' }).getAttribute('aria-current')).toBe('page')
})

it('does not expose personal-library deletion for shared or read-only libraries', () => {
  const readOnly = entries.map(entry => ({ ...entry, canManage: false }))
  const view = render(<KnowledgeWorkspace {...props} entries={readOnly} />)
  expect(parts(view.container).navigation.queryByRole('button', {
    name: zh.knowledgeLibraryActions.replace('{name}', '公司规范'),
  })).toBeNull()
  expect(parts(view.container).navigation.queryByRole('button', {
    name: zh.knowledgeLibraryActions.replace('{name}', '我的资料'),
  })).toBeNull()
})

it('keeps the selected library heading above its material tree', async () => {
  const companyEntries = items([{ id: 'company', name: '公司规范', scope: 'COMPANY', ownerName: '测试公司', canManage: false }])
  transport(async method => method === 'knowledge.folders.list' ? page([]) : page([documentRow('company')]))
  const view = render(<KnowledgeWorkspace {...props} entries={companyEntries} />)
  const navigation = parts(view.container).navigation
  const library = await navigation.findByRole('button', { name: '公司规范' })
  const heading = library.parentElement
  expect(heading).not.toBeNull()
  expect(heading?.querySelector('nav[aria-label="文件夹"]')).toBeNull()
  expect(heading?.nextElementSibling?.matches('div')).toBe(true)
  expect(heading?.nextElementSibling?.querySelector('nav[aria-label="文件夹"]')).not.toBeNull()
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
  const view = render(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await parts(view.container).navigation.findByRole('button', { name: '业务制度' }))
  fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeUpload }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeUploadStandard }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.upload.select')).toBe(true) })
  expect(parts(view.container).navigation.getByRole('button', { name: '业务制度' }).getAttribute('aria-current')).toBe('page')
  fail = true
  await waitFor(() => { expect(parts(view.container).content.getByRole('button', { name: zh.knowledgeUpload }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(parts(view.container).content.getByRole('button', { name: zh.knowledgeUpload }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeUploadStandard }))
  await parts(view.container).content.findByText(zh.knowledgeUploadFailed)
  expect(parts(view.container).navigation.getByRole('button', { name: '业务制度' }).getAttribute('aria-current')).toBe('page')
  for (const call of api.invoke.mock.calls.filter(row => row[1] === 'knowledge.documents.upload.select')) {
    expect(call[2]).toMatchObject({ knowledgeBaseId: 'personal', folderId: 'stable-folder', pdfParseMode: 'STANDARD' })
  }
  const folderActions = parts(view.container).navigation.getByRole('button', {
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

it('offers folder rename and delete in its tree menu while shared libraries retain only reads', async () => {
  transport(async method => method === 'knowledge.folders.list' ? folders : page([]))
  const view = render(<KnowledgeWorkspace {...props} />)
  const actions = await parts(view.container).navigation.findByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '业务制度') })
  fireEvent.click(actions)
  expect(screen.getByRole('menuitem', { name: zh.knowledgeRenameFolder })).toBeDefined()
  expect(screen.getByRole('menuitem', { name: zh.knowledgeDeleteFolder })).toBeDefined()
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeRenameFolder }))
  const dialog = await screen.findByRole('dialog', { name: zh.knowledgeRenameFolder })
  expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: zh.knowledgeFolderName }).value).toBe('业务制度')
  fireEvent.click(within(dialog).getByRole('button', { name: zh.cancel }))
  fireEvent.click(parts(view.container).navigation.getByRole('button', { name: '公司规范' }))
  await parts(view.container).navigation.findByRole('button', { name: '业务制度' })
  expect(parts(view.container).navigation.queryByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '业务制度') })).toBeNull()
})

it.each(['cancel', 'close'] as const)('clears a failed folder deletion after %s before previewing its file', async (action) => {
  const api = transport(async (method) => {
    if (method === 'knowledge.folders.list') return folders
    if (method === 'knowledge.folders.delete') throw new ProductError('KNOWLEDGE_FOLDER_NOT_EMPTY', 'Folder is not empty', false)
    if (method === 'knowledge.documents.preview.open') return originalPreview('# Current document')
    return page([{ ...documentRow('personal'), folderId: 'stable-folder' }])
  })
  const view = render(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await parts(view.container).navigation.findByRole('button', { name: '业务制度' }))
  fireEvent.click(parts(view.container).navigation.getByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '业务制度') }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeDeleteFolder }))
  const dialog = await screen.findByRole('dialog', { name: zh.knowledgeDeleteFolder })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.deleteResource }))
  await within(dialog).findByRole('alert')
  expect(within(dialog).getByRole('alert').textContent).toContain(zh.knowledgeFolderNotEmpty)
  await waitFor(() => { expect(within(dialog).getByRole('button', { name: zh.cancel }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(within(dialog).getByRole('button', { name: action === 'cancel' ? zh.cancel : zh.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(parts(view.container).navigation.getByRole('button', { name: '业务制度' }).getAttribute('aria-current')).toBe('page')
  fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(view.container).content.findByRole('heading', { name: 'Current document' })
  expect(parts(view.container).content.queryByRole('alert')).toBeNull()
  expect(api.invoke.mock.calls.filter(row => row[1] === 'knowledge.folders.delete')).toHaveLength(1)
})

it('selects files from another folder without replacing the current reader, and recovers after navigation', async () => {
  const selected = { operationId: 'upload-operation-0001', filename: 'upload.md', pdfParseMode: 'STANDARD', folderId: 'stable-folder' }
  let retained = false
  let succeeded = false
  const api = transport(async (method) => {
    if (method === 'knowledge.folders.list') return folders
    if (method === 'knowledge.documents.preview.open') return originalPreview('# Current document')
    if (method === 'knowledge.documents.upload.select') { retained = true; return [selected] }
    if (method === 'knowledge.documents.upload') {
      if (!succeeded) throw new ProductError('PRODUCT_NETWORK_UNAVAILABLE', 'Lost receipt', true)
      return documentRow('personal')
    }
    if (method === 'knowledge.documents.upload.discard') { retained = false; return { discarded: true } }
    return page([documentRow('personal')])
  }, async payload => payload.knowledgeBaseId === 'personal' && retained ? [selected] : [])
  let view = render(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await parts(view.container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(view.container).content.findByRole('heading', { name: 'Current document' })
  fireEvent.click(parts(view.container).navigation.getByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '业务制度') }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeUpload }))
  let dialog = within(await screen.findByRole('dialog', { name: zh.knowledgeUploadFiles }))
  expect(api.invoke.mock.calls.some(call => call[1] === 'knowledge.documents.upload')).toBe(false)
  fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeUpload }))
  await dialog.findByRole('alert')
  const original = api.invoke.mock.calls.find(call => call[1] === 'knowledge.documents.upload')![2]
  fireEvent.click(dialog.getAllByRole('button', { name: zh.close }).at(-1)!)
  await parts(view.container).content.findByRole('heading', { name: 'Current document' })
  fireEvent.click(parts(view.container).navigation.getByRole('button', { name: '公司规范' }))
  fireEvent.click(parts(view.container).navigation.getByRole('button', { name: '我的资料' }))
  await parts(view.container).content.findByRole('button', { name: zh.knowledgeUploadViewQueue })
  expect(api.invoke.mock.calls.some(call => call[1] === 'knowledge.documents.upload.discard')).toBe(false)
  view.unmount()
  view = render(<KnowledgeWorkspace {...props} />)
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
  const view = render(<KnowledgeWorkspace {...props} />)
  const { content } = parts(view.container)
  await content.findByText(zh.knowledgeUploadRecoveryFailed)
  expect(content.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeUpload }).disabled).toBe(true)
  expect(api.invoke.mock.calls.some(call => call[1] === 'knowledge.documents.upload')).toBe(false)
  failed = false
  fireEvent.click(content.getByRole('button', { name: zh.refresh }))
  await waitFor(() => { expect(content.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeUpload }).disabled).toBe(false) })
})

it('allows a reader to download an unavailable preview without offering shared material mutation', async () => {
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.folders.list') return folders
    if (method === 'knowledge.documents.preview.open') throw new Error('Unsupported preview')
    if (method === 'knowledge.documents.download') return { cancelled: false }
    return page([documentRow(String(payload.knowledgeBaseId))])
  })
  const view = render(<KnowledgeWorkspace {...props} />)
  fireEvent.click(parts(view.container).navigation.getByRole('button', { name: '公司规范' }))
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
    const { container } = render(<KnowledgeWorkspace {...props} />)
    const file = await parts(container).content.findByRole('button', { name: '业务规范.md' })
    expect(file.hasAttribute('disabled')).toBe(false)
    expect(container.textContent).not.toContain(failureMessage)
    if (status === 'FAILED') {
      expect(parts(container).navigation.queryByText(zh.knowledgeIndexFailed)).toBeNull()
      expect(within(parts(container).content.getByRole('table')).getByText(zh.knowledgeIndexFailed)).toBeDefined()
    }
    fireEvent.click(file)
    await parts(container).content.findByRole('heading', { name: '原文件正常' })
    expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.read')).toBe(false)
  })

it('groups actual department identities and reads the personal library inline without changing a task', async () => {
  const api = transport(async (method, payload) => method === 'knowledge.folders.list' ? folders
    : method === 'knowledge.documents.preview.open' ? page([{ id: 'chunk', documentId: 'shared-document-id', content: '# 正文', locator: '' }])
      : page([documentRow(String(payload.knowledgeBaseId))]))
  const { container } = render(<KnowledgeWorkspace {...props} />)
  const { navigation, content } = parts(container)
  expect(navigation.getByRole('region', { name: zh.scopePersonal })).toBeDefined()
  expect(navigation.getByRole('region', { name: zh.scopeDepartment })).toBeDefined()
  expect(navigation.getByRole('region', { name: zh.scopeCompany })).toBeDefined()
  expect(navigation.getByRole('heading', { name: '销售部 (21)' })).toBeDefined()
  expect(navigation.getByRole('heading', { name: '销售部 (22)' })).toBeDefined()
  expect(navigation.getByRole('button', { name: '我的资料' }).getAttribute('aria-current')).toBe('page')
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await content.findByRole('heading', { name: '正文' })
  expect(container.querySelector('[data-knowledge-inline-reader]')).not.toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.preview.open', {
    knowledgeBaseId: 'personal', documentId: 'shared-document-id',
  }, expect.any(String), 300_000)
  expect(api.invoke.mock.calls.some(row => row[1].startsWith('tasks.'))).toBe(false)
})

it('cancels a pending reader when switching folders and never fills the next scope with old text', async () => {
  const stale = deferred()
  const api = transport(async (method, payload) => method === 'knowledge.documents.preview.open' ? stale.promise
    : method === 'knowledge.folders.list' ? folders : page(payload.folderId === 'stable-folder' ? [] : [documentRow('personal')]))
  const { container } = render(<KnowledgeWorkspace {...props} />)
  const { navigation } = parts(container)
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.preview.open')).toBe(true) })
  const read = api.invoke.mock.calls.find(row => row[1] === 'knowledge.documents.preview.open')
  fireEvent.click(await navigation.findByRole('button', { name: '业务制度' }))
  expect(api.cancel).toHaveBeenCalledWith('product', read?.[3])
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list', {
    knowledgeBaseId: 'personal', folderId: 'stable-folder', page: 1, size: 20,
  }, expect.any(String)) })
  await act(async () => { stale.resolve(page([{ id: 'old', documentId: 'shared-document-id', content: '旧资料正文', locator: '' }])) })
  expect(screen.queryByText('旧资料正文')).toBeNull()
  expect(container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
  fireEvent.click(navigation.getByRole('button', { name: '我的资料' }))
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
  const { container } = render(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.preview.open')).toBe(true) })
  const read = api.invoke.mock.calls.find(row => row[1] === 'knowledge.documents.preview.open')
  fireEvent.click(parts(container).navigation.getByRole('button', { name: '销售制度' }))
  expect(api.cancel).toHaveBeenCalledWith('product', read?.[3])
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(container).content.findByRole('heading', { name: '部门正文' })
  await act(async () => { stale.resolve(page([{ id: 'stale', documentId: 'shared-document-id', content: '# 个人旧正文', locator: '' }])) })
  expect(screen.queryByText('个人旧正文')).toBeNull()
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.preview.open', {
    knowledgeBaseId: 'sales-21', documentId: 'shared-document-id',
  }, expect.any(String), 300_000)
  expect(parts(container).content.queryByRole('button', { name: zh.knowledgeUpload })).toBeNull()
  expect(api.invoke.mock.calls.some(row => row[1].startsWith('tasks.'))).toBe(false)
})

it.each(['KNOWLEDGE_ACCESS_DENIED', 'KNOWLEDGE_ACCESS_REVOKED', 'ORGANIZATION_EMPLOYEE_INACTIVE', 'ORGANIZATION_EMPLOYEE_UNMAPPED'])(
  'clears the current library after %s without exposing diagnostics or widening access', async (code) => {
    const api = transport(async (method, payload) => {
      if (method === 'knowledge.folders.list') return folders
      if (method === 'knowledge.documents.preview.open') throw new ProductError(code, 'private diagnostic', false)
      return page([documentRow(String(payload.knowledgeBaseId))])
    })
    const { container } = render(<KnowledgeWorkspace {...props} />)
    fireEvent.click(parts(container).navigation.getByRole('button', { name: '公司规范' }))
    fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
    const alert = await parts(container).content.findByRole('alert')
    expect(alert.textContent).not.toContain('private diagnostic')
    expect(container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
    expect(parts(container).content.queryByRole('button', { name: '业务规范.md' })).toBeNull()
    expect(parts(container).navigation.queryByRole('button', { name: '业务制度' })).toBeNull()
    expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.preview.open', {
      knowledgeBaseId: 'company', documentId: 'shared-document-id',
    }, expect.any(String), 300_000)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

it('cancels pending content when a catalog refresh removes the selected library', async () => {
  const stale = deferred()
  const api = transport(async (method, payload) => method === 'knowledge.documents.preview.open' ? stale.promise
    : method === 'knowledge.folders.list' ? folders : page([documentRow(String(payload.knowledgeBaseId))]))
  const { container, rerender } = render(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.preview.open')).toBe(true) })
  const read = api.invoke.mock.calls.find(row => row[1] === 'knowledge.documents.preview.open')
  rerender(<KnowledgeWorkspace {...props} entries={entries.filter(row => row.id !== 'personal')} />)
  expect(api.cancel).toHaveBeenCalledWith('product', read?.[3])
  await act(async () => { stale.resolve(page([{ id: 'old', documentId: 'shared-document-id', content: '已撤权正文', locator: '' }])) })
  expect(screen.queryByText('已撤权正文')).toBeNull()
  expect(container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
  expect(parts(container).navigation.queryByRole('button', { name: '我的资料' })).toBeNull()
})

it('closes mobile navigation after selecting a document and supports an empty company group', async () => {
  transport(async method => method === 'knowledge.folders.list' ? folders : method === 'knowledge.documents.preview.open'
    ? page([{ id: 'current', documentId: 'shared-document-id', content: '# 当前正文', locator: '' }]) : page([documentRow('personal')]))
  const { container } = render(<KnowledgeWorkspace {...props} entries={entries.filter(row => row.scope !== 'COMPANY')} />)
  const browse = screen.getByRole('button', { name: zh.knowledgeBrowse })
  fireEvent.click(browse)
  expect(browse.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(container).content.findByRole('heading', { name: '当前正文' })
  expect(browse.getAttribute('aria-expanded')).toBe('false')
  expect(within(parts(container).navigation.getByRole('region', { name: zh.scopeCompany })).getByText(zh.empty)).toBeDefined()
})

it('retains content on directory failure and exposes retry without running a task', async () => {
  transport(async method => method === 'knowledge.folders.list' ? folders : page([documentRow('personal')]))
  const { container, rerender } = render(<KnowledgeWorkspace {...props} />)
  await parts(container).content.findByRole('button', { name: '业务规范.md' })
  rerender(<KnowledgeWorkspace {...props} error="组织目录暂不可用" />)
  expect(parts(container).navigation.getByRole('alert').textContent).toContain('组织目录暂不可用')
  expect(parts(container).content.getByRole('button', { name: '业务规范.md' })).toBeDefined()
  fireEvent.click(parts(container).navigation.getByRole('button', { name: zh.retry }))
  expect(props.onRefresh).toHaveBeenCalledOnce()
})

it('pages the file list and clears it after an explicit access revocation', async () => {
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.folders.list') return folders
    if (method === 'knowledge.documents.preview.open') return page([{ id: 'read', documentId: 'shared-document-id', content: '# 保留正文', locator: '' }])
    if (payload.page === 3) throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'private revocation diagnostic', false)
    return { items: [payload.page === 2 ? { ...documentRow('personal'), id: 'another-document', filename: '下一页.md' } : documentRow('personal')],
      page: Number(payload.page), size: 20, total: 41 }
  })
  const { container } = render(<KnowledgeWorkspace {...props} />)
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
  const { container } = render(<KnowledgeWorkspace {...props} />)
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
  const { container } = render(<KnowledgeWorkspace {...props} />)
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
  const { container, rerender } = render(<KnowledgeWorkspace {...props} refreshRevision={0} />)
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(container).content.findByRole('heading', { name: '初始正文' })
  generation = 1
  rerender(<KnowledgeWorkspace {...props} refreshRevision={1} />)
  await parts(container).navigation.findByRole('button', { name: '当前制度' })
  await parts(container).content.findByRole('heading', { name: '当前授权正文' })
  expect(screen.queryByRole('heading', { name: '初始正文' })).toBeNull()
  for (const method of ['knowledge.documents.list', 'knowledge.folders.list', 'knowledge.documents.preview.open']) {
    expect(api.invoke.mock.calls.filter(row => row[1] === method)).toHaveLength(method === 'knowledge.folders.list' ? 4 : 2)
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
  let folderRefreshReads = 0
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.documents.preview.open') return page([{ id: 'read', documentId: 'shared-document-id', content: '# 旧正文', locator: '' }])
    if (refreshing) {
      // The material query needs its own folder count before reading files;
      // the sidebar request remains in flight to exercise late settlement.
      if (method === 'knowledge.folders.list' && ++folderRefreshReads === 2) return folders
      if (method === deniedMethod) { await denied.promise; throw new ProductError(code, 'private permission diagnostic', false) }
      return late.promise
    }
    return method === 'knowledge.folders.list' ? folders : page([documentRow(String(payload.knowledgeBaseId))])
  })
  const { container, rerender } = render(<KnowledgeWorkspace {...props} />)
  fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
  await parts(container).content.findByRole('heading', { name: '旧正文' })
  refreshing = true
  rerender(<KnowledgeWorkspace {...props} refreshRevision={1} />)
  await waitFor(() => {
    expect(api.invoke.mock.calls.filter(row => row[1] === 'knowledge.documents.list')).toHaveLength(2)
    expect(api.invoke.mock.calls.filter(row => row[1] === 'knowledge.folders.list')).toHaveLength(4)
  })
  await act(async () => { denied.resolve(undefined) })
  await waitFor(() => { expect(container.querySelector('[data-knowledge-inline-reader]')).toBeNull() })
  const successMethod = deniedMethod === 'knowledge.folders.list' ? 'knowledge.documents.list' : 'knowledge.folders.list'
  const concurrentRequest = api.invoke.mock.calls.filter(row => row[1] === successMethod).at(successMethod === 'knowledge.folders.list' ? -2 : -1)
  expect(api.cancel).toHaveBeenCalledWith('product', concurrentRequest?.[3])
  await act(async () => { late.resolve(successMethod === 'knowledge.folders.list' ? folders : page([documentRow('personal')])) })
  expect(parts(container).content.queryByRole('button', { name: '业务规范.md' })).toBeNull()
  expect(parts(container).navigation.queryByRole('button', { name: '业务制度' })).toBeNull()
  expect(screen.queryByRole('heading', { name: '旧正文' })).toBeNull()
  expect(parts(container).content.queryByRole('button', { name: zh.knowledgeUpload })).toBeNull()
  expect(screen.queryByText('private permission diagnostic')).toBeNull()
  const requests = api.invoke.mock.calls.length
  fireEvent.click(parts(container).content.getByRole('tab', { name: zh.knowledgeAllMaterials }))
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
    const { container, rerender } = render(<KnowledgeWorkspace {...props} />)
    fireEvent.click(await parts(container).content.findByRole('button', { name: '业务规范.md' }))
    await parts(container).content.findByRole('heading', { name: '已读正文' })
    refreshing = true
    rerender(<KnowledgeWorkspace {...props} refreshRevision={1} />)
    await parts(container).content.findByRole('alert')
    expect(parts(container).content.queryByRole('heading', { name: '已读正文' })).toBeNull()
    expect(parts(container).content.getByRole('button', { name: zh.retry })).toBeDefined()
    expect(within(parts(container).content.getByRole('navigation', { name: zh.knowledgeLocation })).getByText('业务规范.md')).toBeDefined()
    expect(container.querySelector('[data-knowledge-inline-reader]')).not.toBeNull()
    expect(screen.queryByText('private temporary organization diagnostic')).toBeNull()
  })

it('removes material management when refreshed library metadata grants reading only', async () => {
  transport(async (method, payload) => method === 'knowledge.folders.list' ? folders
    : method === 'knowledge.documents.preview.open' ? page([{ id: 'read', documentId: 'shared-document-id', content: '# 可读正文', locator: '' }])
      : page([documentRow(String(payload.knowledgeBaseId))]))
  const { container, rerender } = render(<KnowledgeWorkspace {...props} />)
  await parts(container).content.findByRole('button', { name: '业务规范.md' })
  expect(parts(container).content.getByRole('button', { name: zh.knowledgeUpload })).toBeDefined()
  fireEvent.click(parts(container).content.getByRole('button', { name: zh.knowledgeAddMaterial }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeNewDocument }))
  await screen.findByRole('dialog', { name: zh.knowledgeNewDocument })
  const readOnly = entries.map(row => row.id === 'personal' ? { ...row, canManage: false } : row)
  rerender(<KnowledgeWorkspace {...props} entries={readOnly} />)
  expect(parts(container).content.queryByRole('button', { name: zh.knowledgeUpload })).toBeNull()
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
    if (method === 'knowledge.folders.list') return page([])
    if (payload.page === 2) empty = true
    return { items: empty ? [] : [documentRow('personal')], page: Number(payload.page), size: 20, total: empty ? 0 : 21 }
  })
  const { container } = render(<KnowledgeWorkspace {...props} />)
  await parts(container).content.findByRole('button', { name: '业务规范.md' })
  fireEvent.click(parts(container).content.getByRole('button', { name: zh.nextPage }))
  await parts(container).content.findByText(zh.knowledgeNoMaterials)
  expect(api.invoke.mock.calls.filter(row => row[1] === 'knowledge.documents.list' && row[2].page === 1)).toHaveLength(2)
  expect(parts(container).navigation.queryByRole('button', { name: zh.previousPage })).toBeNull()
  expect(parts(container).content.queryByRole('button', { name: zh.previousPage })).toBeNull()
  expect(parts(container).content.queryByRole('button', { name: zh.nextPage })).toBeNull()
})

it('shows files only in the main list and resolves their folder in the reader breadcrumb', async () => {
  const api = transport(async method => method === 'knowledge.folders.list' ? folders
    : method === 'knowledge.documents.preview.open' ? page([{ id: 'read', documentId: 'shared-document-id', content: '# 文件夹正文', locator: '' }])
      : page([{ ...documentRow('personal'), folderId: 'stable-folder' }, { ...documentRow('personal'), id: 'root-document', filename: '未归档.md' }]))
  const { container } = render(<KnowledgeWorkspace {...props} />)
  await parts(container).content.findByRole('button', { name: '业务规范.md' })
  const folder = await parts(container).navigation.findByRole('button', { name: '业务制度' })
  const document = parts(container).content.getByRole('button', { name: '业务规范.md' })
  const branch = folder.closest('[data-knowledge-folder]')
  if (!branch) throw new Error('Missing folder branch')
  expect(branch.contains(document)).toBe(false)
  expect(branch.contains(parts(container).content.getByRole('button', { name: '未归档.md' }))).toBe(false)
  fireEvent.click(document)
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
  const view = render(<KnowledgeWorkspace {...props} />)
  const content = parts(view.container).content
  await content.findByText(zh.knowledgeUploadRecoveryFailed)
  expect(content.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeUpload }).disabled).toBe(true)
  expect(api.invoke.mock.calls.some(call => call[1] === 'knowledge.documents.upload.select' || call[1] === 'knowledge.documents.upload')).toBe(false)
})
