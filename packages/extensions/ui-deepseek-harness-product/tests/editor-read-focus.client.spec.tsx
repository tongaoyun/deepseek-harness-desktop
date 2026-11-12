// @vitest-environment jsdom
/** Editor read transitions retain their native dialog and the invoking control. */
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { productFailure, ProductError } from '@deepseek-harness/product/errors'
import { KnowledgeBaseEditor } from '../src/client/KnowledgeBaseEditor.tsx'
import { KnowledgeEditor } from '../src/client/KnowledgeEditor.tsx'
import { zh } from '../src/locales.ts'

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals() })

const original = { id: 'document', knowledgeBaseId: 'personal', filename: 'Notes.md', mediaType: 'text/markdown',
  sizeBytes: 10, status: 'READY', chunkCount: 1, updatedAt: '2026-11-11T00:00:00Z', folderId: null,
  sourceType: 'manual', canManage: true, manualContent: 'Original contents' }
const library = { id: 'personal', name: 'My library', description: 'Library description', scope: 'PERSONAL', canManage: true,
  updatedAt: '2026-11-11T00:00:00Z' }

it.each((['document', 'library', 'document-recovery', 'library-recovery', 'document-restored', 'library-restored'] as const)
  .flatMap(surface => [false, true].map(elsewhere => ({ surface, elsewhere }))))(
  'keeps $surface dialog and return focus after a read retry (elsewhere=$elsewhere)', async ({ surface, elsewhere }) => {
    const response = Promise.withResolvers<undefined>()
    onTestFinished(() => { response.resolve(undefined) })
    const restored = surface.endsWith('restored')
    const recovery = surface.endsWith('recovery') || restored
    const base = surface.startsWith('library')
    if (recovery) sessionStorage.setItem('product.knowledge.suspended.v1.other-scope', '{}')
    if (restored) {
      const scope = base ? 'personal-library' : JSON.stringify(['personal', 'markdown', 'create', null])
      sessionStorage.setItem(`product.knowledge.suspended.v1.employee.${scope}`, JSON.stringify({
        title: 'Retained draft', content: base ? 'Description' : 'Retained contents', url: '', parentId: null,
        save: { method: base ? 'knowledge.bases.create' : 'knowledge.documents.save', payload: { operationId: 'original-operation',
          ...base ? { name: 'Retained draft', description: 'Description' }
            : { knowledgeBaseId: 'personal', title: 'Retained draft', content: 'Retained contents', folderId: null } },
        },
      }))
    }
    let reads = 0
    let closing = false
    vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: async (_namespace: string, method: string) => {
      if (!closing && method === (recovery ? 'auth.getSession' : base ? 'knowledge.bases.get' : 'knowledge.documents.get')) {
        if (++reads === 1) return { ok: false, failure: productFailure(new ProductError('PRODUCT_NETWORK_UNAVAILABLE', 'Offline', true)) }
        if (reads !== 2) throw new Error('Duplicate editor read')
        await response.promise
      }
      return { ok: true, result: method === 'auth.getSession' ? { authenticated: true, employeeId: 'employee' }
        : method === 'knowledge.bases.get' ? library : original }
    } } })
    function Editor() {
      const [open, setOpen] = useState(false)
      return <><button onClick={() => { setOpen(true) }}>打开编辑器</button>{open && (base
        ? <KnowledgeBaseEditor {...recovery ? {} : { knowledgeBaseId: library.id }} t={key => zh[key]}
          onClose={() => { setOpen(false) }} onSaved={vi.fn()} />
        : <KnowledgeEditor knowledgeBaseId="personal" target={recovery ? { kind: 'markdown' } : { kind: 'markdown', document: original }}
          t={key => zh[key]} onClose={() => { setOpen(false) }} onSaved={vi.fn()} />)}</>
    }
    render(<Editor />)
    const opener = screen.getByRole<HTMLButtonElement>('button', { name: '打开编辑器' })
    opener.focus(); fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog')
    const retry = await screen.findByRole<HTMLButtonElement>('button', { name: zh.retry })
    const close = within(dialog).getByRole<HTMLButtonElement>('button', { name: zh.close })
    const notice = screen.getByRole('alert')
    retry.focus()
    act(() => { retry.click(); retry.click() })
    await waitFor(() => { expect(reads).toBe(2) })
    expect(screen.getByRole('alert')).toBe(notice)
    expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
    expect(document.activeElement).toBe(retry)
    expect(retry.disabled).toBe(false)
    expect(retry.getAttribute('aria-disabled')).toBe('true')
    if (elsewhere) close.focus()
    await act(async () => { response.resolve(undefined); await response.promise })
    const title = await screen.findByRole('textbox', { name: base ? zh.knowledgeBaseName : zh.knowledgeDocumentTitle })
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(document.activeElement).toBe(elsewhere ? close : title.closest('form'))
    expect((title as HTMLInputElement).disabled).toBe(restored)
    expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
    expect({ dialog: dialog.getAttribute('aria-label'), focus: document.activeElement?.getAttribute('aria-label'),
      error: screen.queryByRole('alert') !== null, title: (title as HTMLInputElement).value }).toMatchSnapshot()
    closing = true
    fireEvent.click(close)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(document.activeElement).toBe(opener)
  },
)

it.each(['failed', 'elsewhere', 'continue'] as const)('recovers conflict review focus after %s', async (outcome) => {
  const response = Promise.withResolvers<undefined>()
  onTestFinished(() => { response.resolve(undefined) })
  const latest = { ...original, updatedAt: '2026-11-11T01:00:00Z', manualContent: 'Latest contents' }
  let reads = 0
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: async (_namespace: string, method: string) => {
    if (method === 'knowledge.documents.get') {
      if (++reads <= 2) return { ok: true, result: reads === 1 ? original : latest }
      if (reads !== 3) throw new Error('Duplicate review read')
      await response.promise
      return { ok: false, failure: productFailure(new ProductError('KNOWLEDGE_SERVICE_UNAVAILABLE', 'Offline', true)) }
    }
    return { ok: false, failure: productFailure(new ProductError('KNOWLEDGE_DOCUMENT_CONFLICT', 'Changed')) }
  } } })
  render(<KnowledgeEditor knowledgeBaseId="personal" target={{ kind: 'markdown', document: original }}
    t={key => zh[key]} onClose={vi.fn()} onSaved={vi.fn()} />)
  const content = await screen.findByDisplayValue(original.manualContent)
  fireEvent.change(content, { target: { value: 'My draft' } })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeSave }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeReadLatest }))
  const comparison = await screen.findByDisplayValue(latest.manualContent)
  const form = screen.getByRole('form', { name: zh.knowledgeEditDocument })
  const close = screen.getByRole<HTMLButtonElement>('button', { name: zh.close })
  if (outcome === 'continue') {
    const accept = screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeContinueDraft })
    accept.focus(); fireEvent.click(accept)
  } else {
    const read = screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeReadLatest })
    act(() => { read.click(); read.click() })
    await waitFor(() => { expect(reads).toBe(3) })
    fireEvent.click(screen.getByText(zh.knowledgeLatestVersion, { selector: 'summary' }))
    comparison.focus()
    if (outcome === 'elsewhere') close.focus()
    await act(async () => { response.resolve(undefined); await response.promise })
    await screen.findByRole('alert')
  }
  expect(screen.queryByDisplayValue(latest.manualContent)).toBeNull()
  expect(screen.getByDisplayValue('My draft')).toBe(content)
  expect(document.activeElement).toBe(outcome === 'elsewhere' ? close : form)
  expect({ focus: document.activeElement?.getAttribute('aria-label'), error: screen.queryByRole('alert') !== null,
    editable: !screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeSave }).disabled }).toMatchSnapshot()
})
