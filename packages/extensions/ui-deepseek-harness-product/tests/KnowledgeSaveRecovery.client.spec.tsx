// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import { KnowledgeEditor } from '../src/client/KnowledgeEditor.tsx'
import { KnowledgeBaseEditor } from '../src/client/KnowledgeBaseEditor.tsx'
import { zh } from '../src/locales.ts'

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals() })

const savedDocumentMetadata = { knowledgeBaseId: 'personal', filename: 'Saved.md', mediaType: 'text/markdown',
  sizeBytes: 17, status: 'READY', chunkCount: 1 }

it.each(['markdown', 'url', 'edit'] as const)('retains the original %s request until its document receipt is valid', async (kind) => {
  const document = { id: 'document', knowledgeBaseId: 'personal', filename: 'Retained draft.md', mediaType: 'text/markdown',
    sizeBytes: 17, status: 'READY', chunkCount: 1, updatedAt: '2026-10-20T00:00:00Z', sourceType: 'manual', canManage: true,
    manualContent: 'Retained contents', folderId: null }
  const method = kind === 'url' ? 'knowledge.documents.importUrl' : 'knowledge.documents.save'
  const payload = { operationId: 'original-operation', knowledgeBaseId: 'personal', title: 'Retained draft',
    ...(kind === 'url' ? { url: 'https://example.com', folderId: null } : { content: 'Retained contents',
      ...(kind === 'edit' ? { documentId: document.id, expectedUpdatedAt: document.updatedAt } : { folderId: null }) }) }
  const scope = JSON.stringify(['personal', kind === 'url' ? 'url' : 'markdown', kind === 'edit' ? 'edit' : 'create', kind === 'edit' ? document.id : null])
  const key = `product.knowledge.suspended.v1.employee.${scope}`
  const original = JSON.stringify({ title: 'Retained draft', content: 'Retained contents', url: kind === 'url' ? 'https://example.com' : '', parentId: null,
    ...(kind === 'edit' ? { metadata: document } : {}), save: { method, payload } })
  sessionStorage.setItem(key, original)
  const invalidReceipts = [null, { id: document.id }, { ...document, id: '' }, { ...document, filename: '' },
    { ...document, updatedAt: '' }, { ...document, knowledgeBaseId: 'another-library' },
    ...(kind === 'edit' ? [{ ...document, id: 'another-document' }] : [])]
  let receipt = 0
  const writes: unknown[] = []
  const saved = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: async (_namespace: string, name: string, input: unknown) => {
    if (name === 'auth.getSession') return { ok: true, result: { authenticated: true, employeeId: 'employee' } }
    writes.push(input)
    return { ok: true, result: receipt < invalidReceipts.length ? invalidReceipts[receipt] : document }
  } } })
  render(<KnowledgeEditor knowledgeBaseId="personal" target={kind === 'url' ? { kind: 'url' } : { kind: 'markdown', ...(kind === 'edit' ? { document } : {}) }}
    onClose={vi.fn()} onSaved={saved} t={key => zh[key]} />)
  const title = await screen.findByDisplayValue<HTMLInputElement>('Retained draft')
  for (; receipt < invalidReceipts.length; receipt++) {
    fireEvent.click(screen.getByRole('button', { name: zh.knowledgeRetrySave }))
    await screen.findByRole('alert')
    expect(title.disabled).toBe(true)
    expect(saved).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(key)).toBe(original)
    if (receipt === 0) expect(screen.getByRole('dialog').textContent).toMatchSnapshot()
  }
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeRetrySave }))
  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  expect(writes).toEqual(Array.from({ length: invalidReceipts.length + 1 }, () => payload))
  expect(sessionStorage.getItem(key)).toBeNull()
})

it('keeps the suspended folder request when a cancelled editor receives a late success', async () => {
  const scope = JSON.stringify(['personal', 'folder', 'create', null])
  const key = `product.knowledge.suspended.v1.employee.${scope}`
  const original = JSON.stringify({ title: 'Retained draft', content: '', url: '', parentId: null,
    save: { method: 'knowledge.folders.create', payload: { knowledgeBaseId: 'personal', name: 'Retained draft', parentId: null, operationId: 'original-operation' } } })
  sessionStorage.setItem(key, original)
  const response = Promise.withResolvers<{ ok: boolean; result: unknown }>()
  const started = Promise.withResolvers<undefined>()
  const saved = vi.fn()
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { cancel, invoke: async (_namespace: string, method: string) => {
    if (method === 'auth.getSession') return { ok: true, result: { authenticated: true, employeeId: 'employee' } }
    if (method === 'knowledge.folders.list') return { ok: true, result: { items: [], page: 1, size: 20, total: 0 } }
    started.resolve(undefined)
    return response.promise
  } } })
  try {
    const editor = render(<KnowledgeEditor knowledgeBaseId="personal" target={{ kind: 'folder' }} onClose={vi.fn()} onSaved={saved} t={key => zh[key]} />)
    await screen.findByDisplayValue('Retained draft')
    fireEvent.click(screen.getByRole('button', { name: zh.knowledgeRetrySave }))
    await started.promise
    editor.unmount()
    expect(cancel).toHaveBeenCalled()
    await act(async () => {
      response.resolve({ ok: true, result: { id: 'created', name: 'Retained draft', parentId: null, updatedAt: '2026-10-20T00:00:00Z' } })
      await response.promise
    })
    expect(saved).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(key)).toBe(original)
  } finally {
    await act(async () => { response.resolve({ ok: false, result: null }); await response.promise })
  }
})

it.each(['base', 'folder', 'rename'] as const)('retains the original %s save until its receipt is valid', async (kind) => {
  const method = kind === 'base' ? 'knowledge.bases.create' : kind === 'rename' ? 'knowledge.folders.rename' : 'knowledge.folders.create'
  const folder = { id: 'folder', name: 'Before', parentId: null, updatedAt: '2026-10-20T00:00:00Z' }
  const payload = { operationId: 'original-operation', ...(kind === 'base' ? { name: 'Retained draft', description: '' }
    : { knowledgeBaseId: 'personal', name: 'Retained draft', ...(kind === 'rename'
      ? { folderId: folder.id, expectedUpdatedAt: folder.updatedAt } : { parentId: null }) }) }
  const scope = kind === 'base' ? 'personal-library' : JSON.stringify(['personal', 'folder', kind === 'rename' ? 'edit' : 'create', kind === 'rename' ? folder.id : null])
  const key = `product.knowledge.suspended.v1.employee.${scope}`
  const original = JSON.stringify({ title: 'Retained draft', content: '', url: '', parentId: null, save: { method, payload } })
  sessionStorage.setItem(key, original)
  const writes: unknown[] = []
  const saved = vi.fn()
  const invalidReceipts = kind === 'base' ? [{ name: 'Retained draft' }, { id: '', name: 'Retained draft' }, { id: 'created' }]
    : [{ id: folder.id }, { ...folder, id: '' }, { ...folder, name: '' }, { ...folder, updatedAt: '' },
      ...(kind === 'rename' ? [{ ...folder, id: 'another-folder' }] : [])]
  let invalidIndex = 0
  let validReceipt = false
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: async (_namespace: string, name: string, input: unknown) => {
    if (name === 'auth.getSession') return { ok: true, result: { authenticated: true, employeeId: 'employee' } }
    if (name === 'knowledge.folders.list') return { ok: true, result: { items: [], page: 1, size: 20, total: 0 } }
    writes.push(input)
    return { ok: true, result: validReceipt ? { ...folder, name: 'Retained draft' } : invalidReceipts[invalidIndex] }
  } } })
  if (kind === 'base') render(<KnowledgeBaseEditor onClose={vi.fn()} onCreated={saved} t={key => zh[key]} />)
  else render(<KnowledgeEditor knowledgeBaseId="personal" target={{ kind: 'folder', ...(kind === 'rename' ? { folder } : {}) }} onClose={vi.fn()} onSaved={saved} t={key => zh[key]} />)
  const title = await screen.findByDisplayValue<HTMLInputElement>('Retained draft')
  for (; invalidIndex < invalidReceipts.length; invalidIndex++) {
    fireEvent.click(screen.getByRole('button', { name: zh.knowledgeRetrySave }))
    await screen.findByRole('alert')
    expect(title.disabled).toBe(true)
    expect(saved).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(key)).toBe(original)
    if (invalidIndex === 0) expect(screen.getByRole('dialog').textContent).toMatchSnapshot()
  }
  fireEvent.change(title, { target: { value: 'Another resource' } })
  expect(title.value).toBe('Retained draft')
  validReceipt = true
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeRetrySave }))
  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  expect(writes).toEqual(Array.from({ length: invalidReceipts.length + 1 }, () => payload))
  expect(saved).toHaveBeenCalledWith(kind === 'base' ? folder.id : { ...folder, name: 'Retained draft' })
  expect(sessionStorage.getItem(key)).toBeNull()
})

it.each(['markdown', 'url', 'base', 'folder'] as const)('contains unreadable recovery storage for %s and restores the original request after retry', async (kind) => {
  const method = kind === 'base' ? 'knowledge.bases.create' : kind === 'folder' ? 'knowledge.folders.create'
    : kind === 'url' ? 'knowledge.documents.importUrl' : 'knowledge.documents.save'
  const payload = { operationId: 'original-operation', ...(kind === 'base' ? { name: 'Retained draft', description: '' }
    : { knowledgeBaseId: 'personal', ...(kind === 'folder' ? { name: 'Retained draft', parentId: null }
      : kind === 'url' ? { title: 'Retained draft', url: 'https://example.com', folderId: null }
        : { title: 'Retained draft', content: 'Retained contents', folderId: null }) }) }
  const scope = kind === 'base' ? 'personal-library' : JSON.stringify(['personal', kind, 'create', null])
  const key = `product.knowledge.suspended.v1.employee.${scope}`
  sessionStorage.setItem(key, JSON.stringify({ title: 'Retained draft', content: kind === 'markdown' ? 'Retained contents' : '',
    url: kind === 'url' ? 'https://example.com' : '', parentId: null, save: { method, payload } }))
  const writes: { method: string; payload: unknown }[] = []
  const identity = Promise.withResolvers<undefined>()
  let holdIdentity = false
  const saved = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: async (_namespace: string, name: string, input: unknown) => {
    if (name === 'auth.getSession') {
      if (holdIdentity) await identity.promise
      return { ok: true, result: { authenticated: true, employeeId: 'employee' } }
    }
    if (name === 'knowledge.folders.list') return { ok: true, result: { items: [], page: 1, size: 20, total: 0 } }
    writes.push({ method: name, payload: input })
    return { ok: true, result: { id: 'created', name: 'Retained draft', parentId: null, updatedAt: '2026-10-20T00:00:00Z',
      ...(kind === 'markdown' || kind === 'url' ? savedDocumentMetadata : {}) } }
  } } })
  const storage = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw new DOMException('Storage blocked', 'SecurityError') })
  try {
    if (kind === 'base') render(<KnowledgeBaseEditor onClose={vi.fn()} onCreated={saved} t={key => zh[key]} />)
    else render(<KnowledgeEditor knowledgeBaseId="personal" target={{ kind }} onClose={vi.fn()} onSaved={saved} t={key => zh[key]} />)
    await screen.findByText(zh.knowledgeRecoveryFailed)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(writes).toHaveLength(0)
    if (kind === 'base') expect(screen.getByRole('dialog').textContent).toMatchSnapshot()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await screen.findByText(zh.knowledgeRecoveryFailed)
    expect(screen.queryByRole('textbox')).toBeNull()
    storage.mockRestore()
    expect(sessionStorage.getItem(key)).not.toBeNull()
    holdIdentity = true
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(screen.getByRole('status', { name: zh.loading }).textContent).toBe('')
    expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(writes).toHaveLength(0)
    await act(async () => { identity.resolve(undefined); await identity.promise })
    const name = await screen.findByDisplayValue<HTMLInputElement>('Retained draft')
    expect(name.disabled).toBe(true)
    if (kind === 'markdown') expect(screen.getByDisplayValue<HTMLTextAreaElement>('Retained contents').disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh.knowledgeRetrySave }))
    await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
    expect(writes).toEqual([{ method, payload }])
    expect(sessionStorage.getItem(key)).toBeNull()
  } finally {
    storage.mockRestore()
    await act(async () => { identity.resolve(undefined); await identity.promise })
  }
})

it.each(['markdown', 'url', 'base', 'folder'] as const)('retries the original %s creation after a lost receipt without creating another resource', async (kind) => {
  const writes: Record<string, unknown>[] = []
  const committed = new Map<string, Record<string, unknown>>()
  const saved = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: async (_namespace: string, method: string, payload: Record<string, unknown>) => {
    if (method === 'knowledge.folders.list') return { ok: true, result: { items: [], page: 1, size: 20, total: 0 } }
    writes.push(payload)
    const key = String(payload.operationId)
    if (!committed.has(key)) committed.set(key, { ...payload, id: `created-${committed.size + 1}`, name: payload.name ?? payload.title,
      updatedAt: '2026-10-17T00:00:00Z', ...(kind === 'markdown' || kind === 'url' ? savedDocumentMetadata : {}) })
    if (writes.length === 1) return { ok: false, failure: productFailure(new ProductError('PRODUCT_NETWORK_UNAVAILABLE', 'Receipt lost', true)) }
    return { ok: true, result: committed.get(key) }
  } } })
  if (kind === 'base') render(<KnowledgeBaseEditor onClose={vi.fn()} onCreated={saved} t={key => zh[key]} />)
  else render(<KnowledgeEditor knowledgeBaseId="personal" target={{ kind }} onClose={vi.fn()} onSaved={saved} t={key => zh[key]} />)
  const dialog = within(await screen.findByRole('dialog'))
  const title = dialog.getByRole<HTMLInputElement>('textbox', { name: kind === 'base' ? zh.knowledgeBaseName
    : kind === 'folder' ? zh.knowledgeFolderName : zh.knowledgeDocumentTitle })
  fireEvent.change(title, { target: { value: 'My notes' } })
  if (kind === 'markdown') fireEvent.change(dialog.getByRole('textbox', { name: zh.knowledgeMarkdownContent }), { target: { value: 'Important contents' } })
  if (kind === 'url') fireEvent.change(dialog.getByRole('textbox', { name: zh.knowledgeWebsiteUrl }), { target: { value: 'https://example.com/document' } })
  const button = dialog.getByRole<HTMLButtonElement>('button', { name: kind === 'base' ? zh.knowledgeCreate : zh.knowledgeSave })
  await vi.waitFor(() => { expect(button.disabled).toBe(false) })
  fireEvent.click(button)
  await dialog.findByRole('alert')
  expect(committed.size).toBe(1)
  expect(saved).not.toHaveBeenCalled()
  expect(title.disabled).toBe(true)
  fireEvent.change(title, { target: { value: 'Another resource' } })
  expect(title.value).toBe('My notes')
  fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeRetrySave }))
  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
  expect(committed.size).toBe(1)
})

it('retains the request and draft while an external create outcome remains unknown', async () => {
  const writes: Record<string, unknown>[] = []
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: async (_namespace: string, _method: string, payload: Record<string, unknown>) => {
    writes.push(payload)
    return { ok: false, failure: productFailure(new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Outcome unknown')) }
  } } })
  const saved = vi.fn()
  render(<KnowledgeBaseEditor onClose={vi.fn()} onCreated={saved} t={key => zh[key]} />)
  const title = screen.getByRole<HTMLInputElement>('textbox', { name: zh.knowledgeBaseName })
  fireEvent.change(title, { target: { value: 'My library' } })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeCreate }))
  await screen.findByRole('alert')
  expect(title.disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeRetrySave }))
  await vi.waitFor(() => { expect(writes).toHaveLength(2) })
  expect(writes[1]).toEqual(writes[0])
  expect(title.value).toBe('My library')
  expect(saved).not.toHaveBeenCalled()
})

it('allows changes and a new request after an authoritative rejection', async () => {
  const writes: Record<string, unknown>[] = []
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: async (_namespace: string, _method: string, payload: Record<string, unknown>) => {
    writes.push(payload)
    return { ok: false, failure: productFailure(new ProductError('KNOWLEDGE_MANAGEMENT_FORBIDDEN', 'Not permitted')) }
  } } })
  render(<KnowledgeBaseEditor onClose={vi.fn()} onCreated={vi.fn()} t={key => zh[key]} />)
  const title = screen.getByRole<HTMLInputElement>('textbox', { name: zh.knowledgeBaseName })
  fireEvent.change(title, { target: { value: 'First name' } })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeCreate }))
  await screen.findByRole('alert')
  expect(title.disabled).toBe(false)
  fireEvent.change(title, { target: { value: 'Revised name' } })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeCreate }))
  await vi.waitFor(() => { expect(writes).toHaveLength(2) })
  expect(writes[1]?.operationId).not.toBe(writes[0]?.operationId)
  expect(writes[1]?.name).toBe('Revised name')
})

it.each(['markdown', 'url', 'base', 'folder'] as const)('protects the %s draft through close, Escape, mask and cancel', async (kind) => {
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: async () => ({ ok: true,
    result: { items: [], page: 1, size: 20, total: 0 } }) } })
  const closed = vi.fn()
  if (kind === 'base') render(<KnowledgeBaseEditor onClose={closed} onCreated={vi.fn()} t={key => zh[key]} />)
  else render(<KnowledgeEditor knowledgeBaseId="personal" target={{ kind }} onClose={closed} onSaved={vi.fn()} t={key => zh[key]} />)
  const dialog = within(await screen.findByRole('dialog'))
  const label = kind === 'base' ? zh.knowledgeBaseName : kind === 'folder' ? zh.knowledgeFolderName : zh.knowledgeDocumentTitle
  fireEvent.change(dialog.getByRole('textbox', { name: label }), { target: { value: 'Retained draft' } })
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
  for (const dismiss of [
    () => { fireEvent.click(dialog.getByRole('button', { name: zh.close })) },
    () => { fireEvent.keyDown(document, { key: 'Escape' }) },
    () => { fireEvent.click(screen.getByRole('dialog').previousElementSibling!) },
    () => { fireEvent.click(dialog.getByRole('button', { name: zh.cancel })) },
  ]) {
    dismiss()
    expect(closed).not.toHaveBeenCalled()
    await dialog.findByText(zh.knowledgeDiscardDraftConfirmation)
    fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeKeepEditing }))
    expect(dialog.getByRole<HTMLInputElement>('textbox', { name: label }).value).toBe('Retained draft')
  }
  fireEvent.click(dialog.getByRole('button', { name: zh.close }))
  fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeDiscardDraft }))
  expect(closed).toHaveBeenCalledOnce()
})

it('closes a loaded unchanged document without asking to discard its saved content', async () => {
  const document = { id: 'document', filename: 'Notes.md', sourceType: 'manual', canManage: true,
    manualContent: 'Saved contents', updatedAt: '2026-10-17T10:00:00Z', knowledgeBaseId: 'personal',
    mediaType: 'text/markdown', sizeBytes: 14, status: 'ready', chunkCount: 1 }
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: async () => ({ ok: true, result: document }) } })
  const closed = vi.fn()
  render(<KnowledgeEditor knowledgeBaseId="personal" target={{ kind: 'markdown', document }} onClose={closed} onSaved={vi.fn()} t={key => zh[key]} />)
  await screen.findByDisplayValue('Saved contents')
  fireEvent.click(screen.getByRole('button', { name: zh.close }))
  expect(closed).toHaveBeenCalledOnce()
  expect(screen.queryByText(zh.knowledgeDiscardDraftConfirmation)).toBeNull()
})

it.each(['markdown', 'url', 'base', 'folder'] as const)('suspends and restores the %s draft and request after an unknown outcome', async (kind) => {
  let finish: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const writes: Record<string, unknown>[] = []
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: async (_namespace: string, method: string, payload: Record<string, unknown>) => {
    if (method === 'auth.getSession') return { ok: true, result: { authenticated: true, employeeId: 'employee-1' } }
    if (method === 'knowledge.folders.list') return { ok: true, result: { items: [], page: 1, size: 20, total: 0 } }
    writes.push(payload)
    await gate
    return writes.length === 1
      ? { ok: false, failure: productFailure(new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Unknown external outcome')) }
      : { ok: true, result: { ...payload, id: 'created', name: payload.name ?? payload.title, updatedAt: '2026-10-17T00:00:00Z',
        ...(kind === 'markdown' || kind === 'url' ? savedDocumentMetadata : {}) } }
  } } })
  const closed = vi.fn()
  const saved = vi.fn()
  if (kind === 'base') render(<KnowledgeBaseEditor onClose={closed} onCreated={saved} t={key => zh[key]} />)
  else render(<KnowledgeEditor knowledgeBaseId="personal" target={{ kind }} onClose={closed} onSaved={saved} t={key => zh[key]} />)
  const dialog = within(await screen.findByRole('dialog'))
  fireEvent.change(dialog.getByRole('textbox', { name: kind === 'base' ? zh.knowledgeBaseName
    : kind === 'folder' ? zh.knowledgeFolderName : zh.knowledgeDocumentTitle }), { target: { value: 'Draft' } })
  if (kind === 'markdown') fireEvent.change(dialog.getByRole('textbox', { name: zh.knowledgeMarkdownContent }), { target: { value: 'Contents' } })
  if (kind === 'url') fireEvent.change(dialog.getByRole('textbox', { name: zh.knowledgeWebsiteUrl }), { target: { value: 'https://example.com' } })
  const save = dialog.getByRole<HTMLButtonElement>('button', { name: kind === 'base' ? zh.knowledgeCreate : zh.knowledgeSave })
  await vi.waitFor(() => { expect(save.disabled).toBe(false) })
  fireEvent.click(save)
  fireEvent.click(dialog.getByRole('button', { name: zh.close }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(closed).not.toHaveBeenCalled()
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: zh.cancel }).disabled).toBe(true)
  finish?.()
  await dialog.findByRole('alert')
  fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeSuspendSave }))
  await vi.waitFor(() => { expect(closed).toHaveBeenCalledOnce() })
  cleanup()
  if (kind === 'base') render(<KnowledgeBaseEditor onClose={closed} onCreated={saved} t={key => zh[key]} />)
  else render(<KnowledgeEditor knowledgeBaseId="personal" target={{ kind }} onClose={closed} onSaved={saved} t={key => zh[key]} />)
  await screen.findByDisplayValue('Draft')
  const restored = within(screen.getByRole('dialog'))
  expect(restored.getByRole<HTMLInputElement>('textbox', { name: kind === 'base' ? zh.knowledgeBaseName
    : kind === 'folder' ? zh.knowledgeFolderName : zh.knowledgeDocumentTitle }).disabled).toBe(true)
  fireEvent.click(restored.getByRole('button', { name: zh.knowledgeRetrySave }))
  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  expect(writes[1]).toEqual(writes[0])
  expect(sessionStorage.length).toBe(0)
})

it('keeps suspended saves private to their employee and blocks writes if a stored receipt is damaged', async () => {
  let employeeId = 'one'
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: async (_namespace: string, method: string) => {
    if (method === 'auth.getSession') return { ok: true, result: { authenticated: true, employeeId } }
    return { ok: false, failure: productFailure(new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Unknown')) }
  } } })
  const close = vi.fn()
  render(<KnowledgeBaseEditor onClose={close} onCreated={vi.fn()} t={key => zh[key]} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Private draft' } })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeCreate }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeSuspendSave }))
  await vi.waitFor(() => { expect(close).toHaveBeenCalledOnce() })
  cleanup()
  employeeId = 'two'
  render(<KnowledgeBaseEditor onClose={close} onCreated={vi.fn()} t={key => zh[key]} />)
  expect((await screen.findByRole<HTMLInputElement>('textbox')).value).toBe('')
  cleanup()
  employeeId = 'one'
  sessionStorage.setItem(sessionStorage.key(0)!, '{broken')
  render(<KnowledgeBaseEditor onClose={close} onCreated={vi.fn()} t={key => zh[key]} />)
  await screen.findByText(zh.knowledgeRecoveryFailed)
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(sessionStorage.length).toBe(1)
})

it('retains the editor and original operation when local suspension storage fails', async () => {
  const writes: unknown[] = []
  const closed = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: async (_namespace: string, method: string, payload: unknown) => {
    if (method === 'auth.getSession') return { ok: true, result: { authenticated: true, employeeId: 'employee' } }
    writes.push(payload)
    return { ok: false, failure: productFailure(new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Unknown')) }
  } } })
  render(<KnowledgeBaseEditor onClose={closed} onCreated={vi.fn()} t={key => zh[key]} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Retained library' } })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeCreate }))
  await screen.findByRole('alert')
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
  try {
    fireEvent.click(screen.getByRole('button', { name: zh.knowledgeSuspendSave }))
    await screen.findByText(zh.knowledgeRecoveryFailed)
    expect(closed).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue<HTMLInputElement>('Retained library').disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh.knowledgeRetrySave }))
    await vi.waitFor(() => { expect(writes).toHaveLength(2) })
    expect(writes[1]).toEqual(writes[0])
  } finally { storage.mockRestore() }
})
