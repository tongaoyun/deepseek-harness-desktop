import { expect, it, vi } from 'vitest'
import { readMaterialDocuments } from '../src/client/knowledge-materials.ts'
import type { KnowledgeFolder, KnowledgePage } from '../src/client/knowledge-data.ts'

const rows = Array.from({ length: 45 }, (_, index) => ({ id: `doc-${index + 1}`, knowledgeBaseId: 'base',
  filename: `${index + 1}.md`, mediaType: 'text/markdown', sizeBytes: 1, status: 'READY', chunkCount: 1, updatedAt: '' }))
const request = () => vi.fn(async (_method: string, input: unknown) => {
  const { page, size } = input as { page: number; size: number }
  return { items: rows.slice((page - 1) * size, page * size), page, size, total: rows.length }
})
const folders = (total: number, count: number): KnowledgePage<KnowledgeFolder> => ({
  items: Array.from({ length: count }, (_, index) => ({ id: `folder-${index}`, name: 'Folder', parentId: null, updatedAt: '2026-10-17T00:00:00Z' })),
  total, page: 1, size: 20,
})

it.each([
  [21, 20, 1, []],
  [21, 1, 2, rows.slice(0, 19).map(row => row.id)],
  [21, 0, 3, rows.slice(19, 39).map(row => row.id)],
  [21, 0, 4, rows.slice(39).map(row => row.id)],
  [20, 0, 2, rows.slice(0, 20).map(row => row.id)],
  [0, 0, 2, rows.slice(20, 40).map(row => row.id)],
])('composes %i folders with %i visible folders on material page %i', async (total, count, page, ids) => {
  const invoke = request()
  const result = await readMaterialDocuments(invoke, { knowledgeBaseId: 'base', folderId: null }, folders(total, count), page, new AbortController().signal)
  expect(result.items.map(row => row.id)).toEqual(ids)
  expect(result.total).toBe(45)
  expect(result.page).toBe(page)
  expect(result.items.length + count).toBeLessThanOrEqual(20)
  expect(invoke.mock.calls.length).toBe(page >= 3 && total === 21 ? 2 : 1)
})

it('stops before the second document page when navigation is cancelled', async () => {
  const controller = new AbortController()
  const invoke = request().mockImplementationOnce(async () => {
    controller.abort()
    return { items: rows.slice(0, 20), page: 1, size: 20, total: 45 }
  })
  await expect(readMaterialDocuments(invoke, { knowledgeBaseId: 'base' }, folders(21, 0), 3, controller.signal)).rejects.toThrow()
  expect(invoke).toHaveBeenCalledTimes(1)
})

it.each([
  { page: 0, size: 20, total: 1 },
  { page: 1.5, size: 20, total: 1 },
  { page: 1, size: 0, total: 1 },
  { page: 1, size: 1.5, total: 1 },
  { page: 1, size: 20, total: 0.5 },
  { page: 1, size: 20, total: Number.MAX_SAFE_INTEGER + 1 },
  { page: 1, size: 20, total: 0 },
])('rejects invalid page counts instead of presenting an incomplete materials page: %j', async (counts) => {
  const invoke = vi.fn(async () => ({ items: rows.slice(0, 1), ...counts }))
  await expect(readMaterialDocuments(invoke, { knowledgeBaseId: 'base' }, folders(0, 0), 1,
    new AbortController().signal)).rejects.toThrow()
})

it('rejects a page containing more items than the server page size', async () => {
  const invoke = vi.fn(async () => ({ items: rows.slice(0, 2), page: 1, size: 1, total: 2 }))
  await expect(readMaterialDocuments(invoke, { knowledgeBaseId: 'base' }, folders(0, 0), 1,
    new AbortController().signal)).rejects.toThrow()
})

it.each([
  { page: 2 },
  { items: rows.slice(0, 1), size: 10 },
  { items: [{ ...rows[0]!, knowledgeBaseId: 'another-base' }] },
  { items: [{ ...rows[0]!, folderId: 'another-folder' }] },
  { items: [rows[0]!, rows[0]!] },
])('rejects mismatched document pages before returning material rows: %j', async (change) => {
  const invoke = vi.fn(async () => ({ items: rows.slice(0, 20), page: 1, size: 20, total: rows.length, ...change }))
  await expect(readMaterialDocuments(invoke, { knowledgeBaseId: 'base', folderId: null }, folders(0, 0), 1,
    new AbortController().signal)).rejects.toThrow()
})

it.each([null, 'another-folder'])('rejects documents outside the selected folder: %s', async (folderId) => {
  const invoke = vi.fn(async () => ({ items: [{ ...rows[0]!, folderId }], page: 1, size: 20, total: 1 }))
  await expect(readMaterialDocuments(invoke, { knowledgeBaseId: 'base', folderId: 'selected-folder' }, folders(0, 0), 1,
    new AbortController().signal)).rejects.toThrow()
})

it('accepts documents from multiple folders only when browsing all materials', async () => {
  const documents = [rows[0]!, { ...rows[1]!, folderId: null }, { ...rows[2]!, folderId: 'nested-folder' }]
  const invoke = vi.fn(async () => ({ items: documents, page: 1, size: 20, total: documents.length }))
  const result = await readMaterialDocuments(invoke, { knowledgeBaseId: 'base' }, folders(0, 0), 1, new AbortController().signal)
  expect(result.items.map(row => row.id)).toEqual(documents.map(row => row.id))
})

it.each([
  { page: 1 },
  { items: rows.slice(20, 21), size: 10 },
  { total: 44 },
  { items: [{ ...rows[20]!, knowledgeBaseId: 'another-base' }] },
  { items: [{ ...rows[20]!, folderId: 'another-folder' }] },
  { items: [rows[19]!, ...rows.slice(21, 40)] },
])('rejects an inconsistent second document page instead of returning a partial material page: %j', async (change) => {
  const invoke = request().mockImplementationOnce(async () => ({ items: rows.slice(0, 20), page: 1, size: 20, total: rows.length }))
    .mockImplementationOnce(async () => ({ items: rows.slice(20, 40), page: 2, size: 20, total: rows.length, ...change }))
  await expect(readMaterialDocuments(invoke, { knowledgeBaseId: 'base', folderId: null }, folders(21, 0), 3,
    new AbortController().signal)).rejects.toThrow()
  expect(invoke).toHaveBeenCalledTimes(2)
})
