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
  items: Array.from({ length: count }, (_, index) => ({ id: `folder-${index}`, name: 'Folder', parentId: null })),
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
