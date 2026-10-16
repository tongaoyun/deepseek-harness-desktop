// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import { KnowledgeEditor } from '../src/client/KnowledgeEditor.tsx'
import { KnowledgeBaseEditor } from '../src/client/KnowledgeBaseEditor.tsx'
import { zh } from '../src/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each(['markdown', 'url', 'base', 'folder'] as const)('retries the original %s creation after a lost receipt without creating another resource', async (kind) => {
  const writes: Record<string, unknown>[] = []
  const committed = new Map<string, Record<string, unknown>>()
  const saved = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: async (_namespace: string, method: string, payload: Record<string, unknown>) => {
    if (method === 'knowledge.folders.list') return { ok: true, result: { items: [], page: 1, size: 20, total: 0 } }
    writes.push(payload)
    const key = String(payload.operationId)
    if (!committed.has(key)) committed.set(key, { ...payload, id: `created-${committed.size + 1}`, name: payload.name ?? payload.title })
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
