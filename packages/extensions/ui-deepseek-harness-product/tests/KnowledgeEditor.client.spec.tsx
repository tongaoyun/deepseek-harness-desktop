// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import { KnowledgeEditor } from '../src/client/KnowledgeEditor.tsx'
import { zh } from '../src/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

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
