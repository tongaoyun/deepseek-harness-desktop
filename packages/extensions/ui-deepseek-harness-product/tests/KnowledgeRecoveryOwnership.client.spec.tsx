// @vitest-environment jsdom
/** Suspended knowledge writes belong to the current editor and latest recovery attempt. */
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { KnowledgeEditor } from '../src/client/KnowledgeEditor.tsx'
import { useKnowledgeSaveRecovery, type KnowledgeSaveDraft } from '../src/client/knowledge-save-recovery.ts'
import { zh } from '../src/locales.ts'

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals() })

function draft(title: string): KnowledgeSaveDraft {
  return { title, content: 'Contents', url: '', parentId: null, save: { method: 'knowledge.documents.save',
    payload: { operationId: title, knowledgeBaseId: 'base', title, content: 'Contents', folderId: null } } }
}
function storageKey(scope: string, employee = 'employee'): string {
  return `product.knowledge.suspended.v1.${employee}.${scope}`
}
function session(employeeId = 'employee') {
  return { ok: true, result: { authenticated: true, employeeId } }
}
function transport(invoke: (namespace: string, method: string) => Promise<unknown>): void {
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke } })
}

it('restores the newly selected scope without exposing or clearing the previous draft', async () => {
  sessionStorage.setItem(storageKey('first'), JSON.stringify(draft('First draft')))
  sessionStorage.setItem(storageKey('second'), JSON.stringify(draft('Second draft')))
  transport(async () => session())
  const hook = renderHook(({ scope }) => useKnowledgeSaveRecovery(scope), { initialProps: { scope: 'first' } })
  await vi.waitFor(() => { expect(hook.result.current.draft?.title).toBe('First draft') })
  hook.rerender({ scope: 'second' })
  expect(hook.result.current.draft).toBeUndefined()
  await vi.waitFor(() => { expect(hook.result.current.draft?.title).toBe('Second draft') })
  hook.result.current.recovery.clear()
  expect(sessionStorage.getItem(storageKey('first'))).not.toBeNull()
  expect(sessionStorage.getItem(storageKey('second'))).toBeNull()
})

it('keeps the latest retry and its employee receipt when an older identity read finishes last', async () => {
  sessionStorage.setItem(storageKey('scope'), JSON.stringify(draft('Initial draft')))
  sessionStorage.setItem(storageKey('scope', 'old'), JSON.stringify(draft('Old draft')))
  sessionStorage.setItem(storageKey('scope', 'new'), JSON.stringify(draft('New draft')))
  const old = Promise.withResolvers<ReturnType<typeof session>>()
  const latest = Promise.withResolvers<ReturnType<typeof session>>()
  const invoke = vi.fn<(namespace: string, method: string) => Promise<unknown>>()
    .mockResolvedValueOnce(session()).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
  transport(invoke)
  const hook = renderHook(() => useKnowledgeSaveRecovery('scope'))
  await vi.waitFor(() => { expect(hook.result.current.ready).toBe(true) })
  let first: Promise<void> | undefined
  let second: Promise<void> | undefined
  act(() => { first = hook.result.current.reload() })
  act(() => { second = hook.result.current.reload() })
  await act(async () => { latest.resolve(session('new')); await second })
  expect(hook.result.current.draft?.title).toBe('New draft')
  await act(async () => { old.resolve(session('old')); await first })
  expect(hook.result.current.draft?.title).toBe('New draft')
  hook.result.current.recovery.clear()
  expect(sessionStorage.getItem(storageKey('scope', 'new'))).toBeNull()
  expect(sessionStorage.getItem(storageKey('scope', 'old'))).not.toBeNull()
})

it('ignores a failed read from the disposed StrictMode effect', async () => {
  sessionStorage.setItem(storageKey('scope'), JSON.stringify(draft('Current draft')))
  const old = Promise.withResolvers<ReturnType<typeof session>>()
  const invoke = vi.fn<(namespace: string, method: string) => Promise<unknown>>()
    .mockReturnValueOnce(old.promise).mockResolvedValue(session())
  transport(invoke)
  const hook = renderHook(() => useKnowledgeSaveRecovery('scope'), { wrapper: StrictMode })
  await vi.waitFor(() => { expect(hook.result.current.draft?.title).toBe('Current draft') })
  await act(async () => { old.reject(new Error('Old read failed')); await Promise.resolve() })
  expect(hook.result.current.ready).toBe(true)
  expect(hook.result.current.error).toBeUndefined()
  expect(hook.result.current.draft?.title).toBe('Current draft')
})

it('does not start recovery through callbacks retained after unmount or scope replacement', async () => {
  const invoke = vi.fn(async () => session())
  transport(invoke)
  const hook = renderHook(({ scope }) => useKnowledgeSaveRecovery(scope), { initialProps: { scope: 'first' } })
  const stale = hook.result.current.reload
  hook.rerender({ scope: 'second' })
  await act(async () => { await stale() })
  const current = hook.result.current.reload
  hook.unmount()
  await act(async () => { await current() })
  expect(invoke).not.toHaveBeenCalled()
})

it('resets the editable values when the document creation target changes', () => {
  const props = { onClose: vi.fn(), onSaved: vi.fn(), t: (key: keyof typeof zh) => zh[key] }
  const editor = render(<KnowledgeEditor {...props} knowledgeBaseId="first" target={{ kind: 'markdown' }} />)
  fireEvent.change(screen.getByLabelText(zh.knowledgeDocumentTitle), { target: { value: 'First title' } })
  fireEvent.change(screen.getByLabelText(zh.knowledgeMarkdownContent), { target: { value: 'First contents' } })
  editor.rerender(<KnowledgeEditor {...props} knowledgeBaseId="second" target={{ kind: 'markdown' }} />)
  expect({ title: screen.getByLabelText<HTMLInputElement>(zh.knowledgeDocumentTitle).value,
    content: screen.getByLabelText<HTMLTextAreaElement>(zh.knowledgeMarkdownContent).value,
    saveDisabled: screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeSave }).disabled,
  }).toMatchInlineSnapshot(`
    {
      "content": "",
      "saveDisabled": true,
      "title": "",
    }
  `)
})

it('cancels the previous target save and creates an independent request for the new target', async () => {
  const response = Promise.withResolvers<{ ok: boolean; result: unknown }>()
  const writes: Record<string, unknown>[] = []
  const saved = vi.fn()
  const cancel = vi.fn()
  const receipt = (base: string) => ({ id: base, knowledgeBaseId: base, filename: 'Saved.md',
    mediaType: 'text/markdown', sizeBytes: 10, status: 'READY', chunkCount: 1, updatedAt: '2026-10-20T00:00:00Z' })
  vi.stubGlobal('dshDesktop', { extensions: { cancel, invoke: async (_namespace: string, _method: string, input: Record<string, unknown>) => {
    writes.push(input)
    return writes.length === 1 ? response.promise : { ok: true, result: receipt('second') }
  } } })
  const props = { onClose: vi.fn(), onSaved: saved, t: (key: keyof typeof zh) => zh[key] }
  const editor = render(<KnowledgeEditor {...props} knowledgeBaseId="first" target={{ kind: 'markdown' }} />)
  fireEvent.change(screen.getByLabelText(zh.knowledgeDocumentTitle), { target: { value: 'First title' } })
  fireEvent.change(screen.getByLabelText(zh.knowledgeMarkdownContent), { target: { value: 'First contents' } })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeSave }))
  await vi.waitFor(() => { expect(writes).toHaveLength(1) })
  editor.rerender(<KnowledgeEditor {...props} knowledgeBaseId="second" target={{ kind: 'markdown' }} />)
  expect(cancel).toHaveBeenCalledOnce()
  fireEvent.change(screen.getByLabelText(zh.knowledgeDocumentTitle), { target: { value: 'Second title' } })
  fireEvent.change(screen.getByLabelText(zh.knowledgeMarkdownContent), { target: { value: 'Second contents' } })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeSave }))
  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  await act(async () => { response.resolve({ ok: true, result: receipt('first') }); await response.promise })
  expect(saved).toHaveBeenCalledOnce()
  expect(writes).toMatchObject([{ knowledgeBaseId: 'first', title: 'First title', content: 'First contents' },
    { knowledgeBaseId: 'second', title: 'Second title', content: 'Second contents' }])
  expect(writes[0]?.operationId).not.toBe(writes[1]?.operationId)
})
