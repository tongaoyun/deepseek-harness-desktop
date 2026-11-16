import { Context } from '@deepseek-ai/cordis'
import type { OfficeKitRequest } from '@deepseek-ai/dsh-office-kit'
import type { ProductRuntimeMethod } from '@deepseek-harness/product/protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { renderLibraryOffice } from '../src/library-preview.ts'

function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  let employee = 'alice'
  const source = { libraryId: '11111111-1111-4111-8111-111111111111', id: '22222222-2222-4222-8222-222222222222', parentId: null,
    name: '模板.docx', kind: 'FILE', sha256: 'a'.repeat(64), sizeBytes: 3, mediaType: 'application/octet-stream',
    version: 1, createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T01:00:00Z' }
  const identity = { libraryId: source.libraryId, entryId: source.id }
  const pdf = Buffer.from('%PDF-fixture')
  const descriptor = { transferId: '33333333-3333-4333-8333-333333333333', fileName: source.name, mediaType: source.mediaType,
    byteLength: 3, maxBytes: 1024, chunkSize: 1024 }
  const invoke = vi.fn(async (method: ProductRuntimeMethod, payload?: unknown): Promise<unknown> => {
    switch (method) {
      case 'auth.getSession': return { authenticated: true, employeeId: employee }
      case 'library.entries.get': return { ...source }
      case 'runtime.library.preview.policy': return { fileRequestTimeoutMs: 1000 }
      case 'library.files.preview.open': return descriptor
      case 'runtime.library.preview.readChunk': return { dataBase64: 'QUJD', offset: 0, eof: true }
      case 'library.files.preview.close': case 'runtime.library.preview.write.close': return { closed: true }
      case 'runtime.library.preview.write.open': return { ...descriptor, mediaType: 'application/pdf', byteLength: 0 }
      case 'runtime.library.preview.write.append': {
        if (!payload || typeof payload !== 'object' || !('dataBase64' in payload) || typeof payload.dataBase64 !== 'string') throw new Error('Invalid fixture write')
        return { offset: Buffer.from(payload.dataBase64, 'base64').length }
      }
      case 'runtime.library.preview.write.commit': return { ...descriptor, mediaType: 'application/pdf', byteLength: pdf.length }
      default: throw new Error(`Unexpected fixture method: ${method}`)
    }
  })
  const convert = vi.fn(async (request: OfficeKitRequest, signal?: AbortSignal) => {
    const original = await request.source.read(signal ?? new AbortController().signal, 1024)
    expect(original.bytes).toEqual(new Uint8Array([65, 66, 67]))
    return { pdf, missingFonts: [] }
  })
  ctx.provide('officeKit', { convert })
  return { ctx, source, identity, invoke, convert, switchEmployee: () => { employee = 'bob' } }
}

it('renders through the native Office provider with shared entry metadata and closes its original transfer', async () => {
  const f = fixture()
  await expect(renderLibraryOffice(f.ctx, { invoke: f.invoke }, f.identity, new AbortController().signal))
    .resolves.toMatchObject({ mediaType: 'application/pdf' })
  expect(f.convert).toHaveBeenCalledOnce()
  expect(f.invoke.mock.calls.filter(([method]) => method === 'library.files.preview.close')).toHaveLength(1)
  expect(f.invoke.mock.calls.some(([method]) => method === 'runtime.library.preview.write.commit')).toBe(true)
})

it.each(['employee', 'version'] as const)('rejects a cached conversion after the %s changes before delivery', async (change) => {
  const f = fixture()
  f.convert.mockImplementationOnce(async () => {
    if (change === 'employee') f.switchEmployee()
    else f.source.sha256 = 'b'.repeat(64)
    return { pdf: Buffer.from('%PDF-cached'), missingFonts: [] }
  })
  await expect(renderLibraryOffice(f.ctx, { invoke: f.invoke }, f.identity, new AbortController().signal))
    .rejects.toMatchObject({ code: change === 'employee' ? 'LIBRARY_ACCESS_DENIED' : 'LIBRARY_PREVIEW_SOURCE_CHANGED' })
  expect(f.invoke.mock.calls.some(([method]) => method === 'runtime.library.preview.write.open')).toBe(false)
})
