import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import type { KnowledgeFileTransfer } from '@deepseek-harness/product/protocol'
import { KnowledgeFiles } from '../src/knowledge-files.ts'
import { resolveKnowledgeFilePolicy } from '../src/knowledge-file-policy.ts'

const filesystem = vi.hoisted(() => ({ failure: undefined as { path: string; error: Error } | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rm: async (...args: Parameters<typeof original.rm>) => {
    if (args[0] === filesystem.failure?.path) throw filesystem.failure.error
    return original.rm(...args)
  } }
})
afterEach(() => { filesystem.failure = undefined })

it.each(['resetIdentity', 'close'] as const)('reports failed private-file removal after %s releases the other transfers', async (method) => {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-cleanup-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const employee = { authenticated: true, employeeId: 'employee' }
  const identity = { knowledgeBaseId: 'personal', documentId: 'document' }
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'fixture-token',
    fetch: async url => (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith('/metadata')
      ? Response.json({ success: true, data: { ...identity, id: identity.documentId, filename: 'original.pdf',
        sourceType: 'file', contentVersion: 'v1', sizeBytes: 3, previewMaxBytes: 1024, downloadMaxBytes: 1024 } })
      : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/pdf' } }) })
  onTestFinished(() => { api.close() })
  const files = new KnowledgeFiles({ directory, policy: resolveKnowledgeFilePolicy(), getEmployeeId: () => employee.employeeId,
    renderOffice: async () => { throw new Error('No conversion requested') }, saveDialog: async () => undefined, openPath: async () => '' })
  onTestFinished(() => files.close())
  const first = await files.invoke('knowledge.documents.preview.open', identity, api, employee) as KnowledgeFileTransfer
  const [retained] = await readdir(directory)
  expect(retained).toBeDefined()
  await files.invoke('knowledge.documents.preview.open', identity, api, employee)
  const error = new Error('Private storage removal failed')
  filesystem.failure = { path: join(directory, retained!), error }
  const removal = files.invoke('knowledge.documents.preview.close', { transferId: first.transferId }, api, employee)
    .catch((cause: unknown) => cause)
  try {
    await expect(files[method]()).rejects.toBeInstanceOf(AggregateError)
    expect(await removal).toBe(error)
    expect(await readdir(directory)).toEqual([retained])
    await expect(files.invoke('knowledge.documents.preview.read', { transferId: first.transferId, offset: 0 }, api, employee)).rejects.toThrow()
  } finally { filesystem.failure = undefined }
})
