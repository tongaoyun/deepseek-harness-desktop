import { readFile, writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import OfficeToPdf, { OfficeSourceKey } from '@deepseek-ai/dsh-office-to-pdf'
import { expect, it, onTestFinished, vi } from 'vitest'
import { renderKnowledgeOffice } from '../src/knowledge-preview.ts'
import type { DeepSeekHarnessProductIpc } from '../src/deepseek-harness-product-ipc.ts'

const engine = vi.hoisted(() => ({ render: vi.fn<(request: { inputPath: string; outputPath: string }, signal?: AbortSignal) => Promise<{ backend: 'native'; missingFonts: string[] }>>() }))
vi.mock('@deepseek-ai/libreoffice-kit', () => ({ createConverter: async () => ({ render: engine.render, dispose: async () => undefined }) }))
const identity = { knowledgeBaseId: 'base', documentId: 'document' }
const original = Buffer.from([80, 75, 3, 4])
const pdf = Buffer.from('%PDF-1.7\noriginal-preview\n%%EOF\n')
const inputTransfer = { transferId: '10000000-0000-0000-0000-000000000001', fileName: 'policy.docx', mediaType: 'application/octet-stream', byteLength: original.length, maxBytes: 1024, chunkSize: 256 * 1024 }
const outputTransfer = { ...inputTransfer, transferId: '20000000-0000-0000-0000-000000000002', mediaType: 'application/pdf', byteLength: pdf.length, missingFonts: ['Example Serif'] }

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(OfficeToPdf, { maxConcurrentConversions: 1, maxInputBytes: 1024, maxOutputBytes: 1024 })
  let employeeId = 'employee-a'
  let denied = false
  let version = 'v1'
  let updatedAt = '2026-10-10T00:00:00Z'
  const invoke = vi.fn<DeepSeekHarnessProductIpc['invoke']>(async (method, payload) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId }
    if (method === 'runtime.knowledge.preview.policy') return { fileRequestTimeoutMs: 300_000 }
    if (denied) throw Object.assign(new Error('Revoked'), { code: 'KNOWLEDGE_ACCESS_REVOKED' })
    if (method === 'knowledge.documents.previewMetadata') return { id: identity.documentId, knowledgeBaseId: identity.knowledgeBaseId,
      filename: 'policy.docx', sizeBytes: original.length, contentVersion: version, updatedAt, status: 'FAILED' }
    if (method === 'knowledge.documents.preview.open') return inputTransfer
    if (method === 'runtime.knowledge.preview.readChunk') return { offset: 0, eof: true, dataBase64: original.toString('base64') }
    if (method === 'knowledge.documents.preview.close' || method === 'runtime.knowledge.preview.write.close') return { closed: true }
    if (method === 'runtime.knowledge.preview.write.open') return { ...outputTransfer, byteLength: 0 }
    if (method === 'runtime.knowledge.preview.write.append') {
      expect(payload).toEqual({ transferId: outputTransfer.transferId, offset: 0, dataBase64: pdf.toString('base64') })
      return { offset: pdf.length }
    }
    if (method === 'runtime.knowledge.preview.write.commit') return outputTransfer
    throw new Error(`Unexpected method ${method}`)
  })
  engine.render.mockReset().mockImplementation(async ({ inputPath, outputPath }) => {
    expect(await readFile(inputPath)).toEqual(original)
    await writeFile(outputPath, pdf)
    return { backend: 'native', missingFonts: ['Example Serif'] }
  })
  return { ctx, invoke, revoke: () => { denied = true }, change: () => { version = 'v2' },
    indexing: () => { updatedAt = '2026-10-10T00:01:00Z' },
    employee: () => { employeeId = 'employee-b' }, render: (signal = new AbortController().signal) => renderKnowledgeOffice(ctx, { invoke }, identity, signal) }
}

it('uses the official converter for a failed-index original and reauthorizes cached PDFs', async () => {
  const { render, invoke, revoke } = await fixture()
  expect(await render()).toEqual(outputTransfer)
  await render()
  expect(engine.render).toHaveBeenCalledTimes(1)
  expect(invoke.mock.calls.filter(call => call[0] === 'knowledge.documents.preview.open')).toHaveLength(1)
  revoke()
  await expect(render()).rejects.toMatchObject({ code: 'KNOWLEDGE_ACCESS_REVOKED' })
  expect(engine.render).toHaveBeenCalledTimes(1)
})

it('refuses a PDF when permission is withdrawn during conversion', async () => {
  const { render, revoke } = await fixture()
  engine.render.mockImplementationOnce(async ({ outputPath }) => {
    await writeFile(outputPath, pdf)
    revoke()
    return { backend: 'native', missingFonts: [] }
  })
  await expect(render()).rejects.toMatchObject({ code: 'KNOWLEDGE_ACCESS_REVOKED' })
})

it('retains the original conversion and cache while indexing updates its timestamp', async () => {
  const { render, indexing } = await fixture()
  engine.render.mockImplementationOnce(async ({ outputPath }) => {
    await writeFile(outputPath, pdf); indexing()
    return { backend: 'native', missingFonts: [] }
  })
  await expect(render()).resolves.toEqual(outputTransfer)
  await expect(render()).resolves.toEqual(outputTransfer)
  expect(engine.render).toHaveBeenCalledTimes(1)
})

it('rejects a changed original instead of returning a PDF of the prior version', async () => {
  const { render, change } = await fixture()
  engine.render.mockImplementationOnce(async ({ outputPath }) => {
    await writeFile(outputPath, pdf); change()
    return { backend: 'native', missingFonts: [] }
  })
  await expect(render()).rejects.toMatchObject({ code: 'KNOWLEDGE_PREVIEW_SOURCE_CHANGED' })
})

it('isolates converter cache identities across employees', async () => {
  const { render, employee, invoke } = await fixture()
  await render(); employee(); await render()
  expect(invoke.mock.calls.filter(call => call[0] === 'knowledge.documents.preview.open')).toHaveLength(2)
})

it('refuses converted bytes after an employee identity change', async () => {
  const { render, employee } = await fixture()
  engine.render.mockImplementationOnce(async ({ outputPath }) => {
    await writeFile(outputPath, pdf); employee()
    return { backend: 'native', missingFonts: [] }
  })
  await expect(render()).rejects.toMatchObject({ code: 'KNOWLEDGE_ACCESS_DENIED' })
})

it('does not prefetch original bytes while waiting for official conversion admission', async () => {
  const { ctx, render, invoke } = await fixture()
  let complete: (() => void) | undefined
  engine.render.mockImplementationOnce(async ({ outputPath }, signal) => {
    await new Promise<void>((resolve) => { complete = resolve; signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
    signal?.throwIfAborted()
    await writeFile(outputPath, pdf)
    return { backend: 'native', missingFonts: [] }
  })
  const first = ctx.officeToPdf.convert({ extension: 'docx', priority: 'foreground', source: {
    key: OfficeSourceKey('queue-occupant'), version: 'v1', bytes: original.length,
    read: async () => ({ bytes: original, version: 'v1' }),
  } })
  await vi.waitFor(() => { expect(complete).toBeDefined() })
  onTestFinished(() => { complete?.() })
  const second = render()
  await vi.waitFor(() => { expect(invoke).toHaveBeenCalledWith('knowledge.documents.previewMetadata', identity, expect.any(AbortSignal)) })
  expect(invoke.mock.calls.filter(call => call[0] === 'knowledge.documents.preview.open')).toHaveLength(0)
  complete?.()
  await first; await second
  expect(invoke.mock.calls.map(call => call[0])).toContain('knowledge.documents.preview.open')
})
