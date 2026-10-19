// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import { KnowledgeEditor } from '../src/client/KnowledgeEditor.tsx'
import { zh } from '../src/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('pins the read folder version and retry identity and retains the name on conflict', async () => {
  const folder = { id: 'folder', name: '原名称', parentId: null, updatedAt: '2026-10-17T00:00:00Z' }
  const writes: Record<string, unknown>[] = []
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: async (_namespace: string, _method: string, payload: Record<string, unknown>) => {
    writes.push(payload)
    return { ok: false, failure: productFailure(new ProductError(writes.length === 1 ? 'PRODUCT_NETWORK_UNAVAILABLE' : 'KNOWLEDGE_FOLDER_CHANGED',
      'Folder save failed', writes.length === 1)) }
  } } })
  const saved = vi.fn()
  render(<KnowledgeEditor knowledgeBaseId="personal" target={{ kind: 'folder', folder }} onClose={vi.fn()} onSaved={saved} t={key => zh[key]} />)
  fireEvent.change(screen.getByRole('textbox', { name: zh.knowledgeFolderName }), { target: { value: '我的名称' } })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeSave }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeRetrySave }))
  await screen.findByText(`${zh.knowledgeFolderChanged} (KNOWLEDGE_FOLDER_CHANGED)`)
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
  expect(writes[0]).toMatchObject({ folderId: 'folder', name: '我的名称', expectedUpdatedAt: folder.updatedAt })
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: zh.knowledgeFolderName }).value).toBe('我的名称')
  expect(saved).not.toHaveBeenCalled()
})

it.each(['KNOWLEDGE_ACCESS_REVOKED', 'KNOWLEDGE_MANAGEMENT_FORBIDDEN', 'ORGANIZATION_SERVICE_UNAVAILABLE'] as const)(
  'requires a fresh conflict review after a repeated latest read fails with %s', async (code) => {
    const original = { id: 'document', knowledgeBaseId: 'personal', filename: 'notes.md', mediaType: 'text/markdown',
      sizeBytes: 10, status: 'READY', chunkCount: 1, updatedAt: '2026-10-10T00:00:00Z', folderId: null,
      sourceType: 'manual', canManage: true, manualContent: 'Original text' }
    const latest = { ...original, updatedAt: '2026-10-11T00:00:00Z', manualContent: 'Previously reviewed text' }
    const refreshed = { ...original, updatedAt: '2026-10-12T00:00:00Z', manualContent: 'Freshly reviewed text' }
    const reread = Promise.withResolvers<undefined>()
    const writes: Record<string, unknown>[] = []
    let reads = 0
    const saved = vi.fn()
    vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(),
      invoke: async (_namespace: string, method: string, payload: Record<string, unknown>) => {
        if (method === 'knowledge.documents.get') {
          reads++
          if (reads === 3) {
            await reread.promise
            return { ok: false, failure: productFailure(new ProductError(code, 'Private read diagnostic', true)) }
          }
          return { ok: true, result: reads === 1 ? original : reads === 2 ? latest : refreshed }
        }
        writes.push(payload)
        return writes.length === 1
          ? { ok: false, failure: productFailure(new ProductError('KNOWLEDGE_DOCUMENT_CONFLICT', 'Document changed')) }
          : { ok: true, result: refreshed }
      } } })
    render(<KnowledgeEditor knowledgeBaseId="personal" target={{ kind: 'markdown', document: original }}
      onClose={vi.fn()} onSaved={saved} t={key => zh[key]} />)
    const dialog = within(await screen.findByRole('dialog'))
    const content = dialog.getByRole<HTMLTextAreaElement>('textbox', { name: zh.knowledgeMarkdownContent })
    await vi.waitFor(() => { expect(content.value).toBe(original.manualContent) })
    fireEvent.change(content, { target: { value: 'My unsaved changes' } })
    fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeSave }))
    await dialog.findByRole('alert')
    fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeReadLatest }))
    await dialog.findByRole('button', { name: zh.knowledgeContinueDraft })
    expect(dialog.getByRole<HTMLTextAreaElement>('textbox', { name: zh.knowledgeLatestVersion }).value).toBe(latest.manualContent)
    fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeReadLatest }))
    try {
      expect(dialog.queryByRole('button', { name: zh.knowledgeContinueDraft })).toBeNull()
      expect(dialog.queryByRole('textbox', { name: zh.knowledgeLatestVersion })).toBeNull()
      await act(async () => { reread.resolve(undefined); await reread.promise })
      await vi.waitFor(() => { expect(dialog.getByRole('alert').textContent).toContain(code) })
      expect(dialog.queryByRole('button', { name: zh.knowledgeContinueDraft })).toBeNull()
      expect(dialog.queryByRole('textbox', { name: zh.knowledgeLatestVersion })).toBeNull()
      expect(content.value).toBe('My unsaved changes')
      expect(dialog.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeSave }).disabled).toBe(true)
      expect(writes).toHaveLength(1)
      if (code === 'KNOWLEDGE_ACCESS_REVOKED') expect(screen.getByRole('dialog').textContent).toMatchSnapshot()
      fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeReadLatest }))
      const confirm = await dialog.findByRole('button', { name: zh.knowledgeContinueDraft })
      expect(dialog.getByRole<HTMLTextAreaElement>('textbox', { name: zh.knowledgeLatestVersion }).value).toBe(refreshed.manualContent)
      fireEvent.click(confirm)
      fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeSave }))
      await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
      expect(writes[1]).toMatchObject({ content: 'My unsaved changes', expectedUpdatedAt: refreshed.updatedAt })
      expect(writes[1]?.operationId).not.toBe(writes[0]?.operationId)
    } finally { reread.resolve(undefined) }
  },
)

it.each([false, true])('preserves edits through conflict recovery and a latest-read outage: %s', async (failRead) => {
  const original = { id: 'document', knowledgeBaseId: 'personal', filename: 'notes.md', mediaType: 'text/markdown',
    sizeBytes: 10, status: 'READY', chunkCount: 1, updatedAt: '2026-10-10T00:00:00Z', folderId: null,
    sourceType: 'manual', canManage: true, manualContent: 'Original text' }
  const latest = { ...original, updatedAt: '2026-10-11T00:00:00Z', manualContent: 'Someone else edited this' }
  let reads = 0
  const writes: Record<string, unknown>[] = []
  const saved = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(),
    invoke: async (_namespace: string, method: string, payload: Record<string, unknown>) => {
      if (method === 'knowledge.documents.get') {
        reads++
        if (reads === 2 && failRead) return { ok: false, failure: productFailure(new ProductError('KNOWLEDGE_SERVICE_UNAVAILABLE', 'Unavailable')) }
        return { ok: true, result: reads === 1 ? original : latest }
      }
      writes.push(payload)
      return writes.length === 1 ? { ok: false, failure: productFailure(new ProductError('KNOWLEDGE_DOCUMENT_CONFLICT', 'Document changed')) }
        : { ok: true, result: latest }
    } } })
  render(<KnowledgeEditor knowledgeBaseId="personal" target={{ kind: 'markdown', document: original }}
    onClose={vi.fn()} onSaved={saved} t={key => zh[key]} />)
  const dialog = within(await screen.findByRole('dialog'))
  const content = await dialog.findByRole<HTMLTextAreaElement>('textbox', { name: zh.knowledgeMarkdownContent })
  await vi.waitFor(() => { expect(content.value).toBe('Original text') })
  fireEvent.change(content, { target: { value: 'My unsaved changes' } })
  fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeSave }))
  await dialog.findByRole('alert')
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeSave }).disabled).toBe(true)
  fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeReadLatest }))
  if (failRead) {
    await vi.waitFor(() => { expect(dialog.getByRole('alert').textContent).toContain('KNOWLEDGE_SERVICE_UNAVAILABLE') })
    expect(content.value).toBe('My unsaved changes')
    expect(dialog.queryByRole('button', { name: zh.knowledgeContinueDraft })).toBeNull()
    fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeReadLatest }))
  }
  const confirm = await dialog.findByRole('button', { name: zh.knowledgeContinueDraft })
  expect(dialog.getByRole<HTMLTextAreaElement>('textbox', { name: zh.knowledgeLatestVersion }).value).toBe(latest.manualContent)
  expect(content.value).toBe('My unsaved changes')
  expect(writes).toHaveLength(1)
  fireEvent.click(confirm)
  fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeSave }))
  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  expect(writes[1]).toMatchObject({ content: 'My unsaved changes', expectedUpdatedAt: latest.updatedAt })
  expect(writes[1]?.operationId).not.toBe(writes[0]?.operationId)
})
