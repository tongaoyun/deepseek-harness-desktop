/** Original Office previews through the public runtime entry, Loader and official conversion admission. */
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import Sessions from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import OfficeToPdf, { OfficeSourceKey } from '@deepseek-ai/dsh-office-to-pdf'
import * as Runtime from '@deepseek-harness/product-runtime'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

const engine = vi.hoisted(() => ({
  render: vi.fn<(request: { inputPath: string; outputPath: string }, signal?: AbortSignal) => Promise<{ backend: 'native'; missingFonts: string[] }>>(),
  dispose: vi.fn<() => Promise<void>>(),
}))
vi.mock('@deepseek-ai/libreoffice-kit', () => ({ createConverter: async () => ({ render: engine.render, dispose: engine.dispose }) }))

const original = Buffer.from([80, 75, 3, 4])
const pdf = Buffer.from('%PDF-1.7\nOriginal policy pages\n%%EOF\n')
const identity = { knowledgeBaseId: 'personal', documentId: 'policy' }
const originalTransfer = { transferId: '10000000-0000-0000-0000-000000000001', fileName: 'policy.docx', mediaType: 'application/octet-stream', byteLength: original.length, maxBytes: 1024, chunkSize: 256 * 1024 }
const pdfTransfer = { ...originalTransfer, transferId: '20000000-0000-0000-0000-000000000002', mediaType: 'application/pdf', byteLength: pdf.length, missingFonts: ['Example Serif'] }
const emit = (message: object): void => { EventEmitter.prototype.emit.call(process, 'message', message) }

interface DispatchResult { readonly result?: unknown; readonly failure?: { code: string }; readonly error?: string }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-preview-loader-'))
  vi.stubEnv('DSH_HOME', root)
  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  const descriptors = new Map(['connected', 'send'].map(key => [key, Object.getOwnPropertyDescriptor(process, key)]))
  const before = process.listenerCount('message')
  const calls: Array<{ method: string; requestId: string }> = []
  const cancelled: string[] = []
  const results = new Map<number, DispatchResult>()
  const awaiting = new Map<number, (result: DispatchResult) => void>()
  let employeeId = 'employee-a'
  let revoked = false
  let number = 0
  let pendingMetadata: string | undefined
  let holdMetadata = false
  Object.defineProperty(process, 'connected', { value: true, configurable: true })
  Object.defineProperty(process, 'send', { configurable: true, value: (message: Record<string, unknown>, callback?: (error: Error | null) => void) => {
    callback?.(null)
    if (message.type === 'extension-control' && typeof message.requestId === 'number') {
      results.set(message.requestId, message)
      awaiting.get(message.requestId)?.(message)
      awaiting.delete(message.requestId)
    } else if (message.type === 'extension-cancel') {
      cancelled.push(String(message.requestId))
    } else if (message.type === 'extension-invoke') {
      const method = String(message.method)
      const requestId = String(message.requestId)
      calls.push({ method, requestId })
      if (method === 'knowledge.documents.previewMetadata' && holdMetadata) { pendingMetadata = requestId; return true }
      queueMicrotask(() => {
        if (method !== 'auth.getSession' && revoked) {
          emit({ type: 'extension-result', requestId, error: 'Knowledge access revoked',
            failure: { code: 'KNOWLEDGE_ACCESS_REVOKED', message: 'Knowledge access revoked', retryable: false, resources: [] } })
        } else {
          const result = method === 'auth.getSession' ? { authenticated: true, employeeId }
            : method === 'runtime.knowledge.preview.policy' ? { fileRequestTimeoutMs: 300_000 }
              : method === 'knowledge.documents.previewMetadata' ? { id: identity.documentId, knowledgeBaseId: identity.knowledgeBaseId,
                filename: 'policy.docx', sizeBytes: original.length, contentVersion: 'v1', updatedAt: 'v1', status: 'FAILED' }
                : method === 'knowledge.documents.preview.open' ? originalTransfer
                  : method === 'runtime.knowledge.preview.readChunk' ? { offset: 0, eof: true, dataBase64: original.toString('base64') }
                    : method === 'runtime.knowledge.preview.write.open' ? { ...pdfTransfer, byteLength: 0 }
                      : method === 'runtime.knowledge.preview.write.append' ? { offset: pdf.length }
                        : method === 'runtime.knowledge.preview.write.commit' ? pdfTransfer
                          : method === 'extensions.authoring.read' ? null : []
          emit({ type: 'extension-result', requestId, result })
        }
      })
    }
    return true
  } })
  const cleanup = async (): Promise<void> => {
    try { await ctx.fiber.dispose() }
    finally {
      for (const [key, descriptor] of descriptors) {
        if (descriptor === undefined) Reflect.deleteProperty(process, key)
        else Object.defineProperty(process, key, descriptor)
      }
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  }
  onTestFinished(cleanup)
  engine.dispose.mockReset().mockResolvedValue(undefined)
  engine.render.mockReset().mockImplementation(async ({ inputPath, outputPath }, signal) => {
    signal?.throwIfAborted()
    expect(await readFile(inputPath)).toEqual(original)
    await writeFile(outputPath, pdf)
    return { backend: 'native', missingFonts: ['Example Serif'] }
  })
  await ctx.plugin(Loader)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Skills)
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(Agents)
  await ctx.plugin(Presets, { default: 'minimal' })
  ctx.provide('sessionQuery', { listSessions: async () => [], observeSession: vi.fn() })
  ctx.loader.builtins['original-preview-provider'] = OfficeToPdf
  ctx.loader.builtins['original-preview-product'] = Runtime
  const profile = [
    { id: 'office', name: 'cordis:original-preview-provider', config: { maxConcurrentConversions: 1, maxInputBytes: 1024, maxOutputBytes: 1024 } },
    { id: 'product', name: 'cordis:original-preview-product' },
  ]
  await ctx.loader.root.update(structuredClone(profile))
  await ctx.loader.await()
  await ctx.loader.resolve('product').fiber?.await()
  const dispatch = () => {
    const requestId = ++number
    const completion = Promise.withResolvers<DispatchResult>()
    awaiting.set(requestId, completion.resolve)
    emit({ type: 'extension-control', namespace: 'product', requestId, method: 'knowledge.documents.renderOffice', payload: identity })
    return { requestId, settled: completion.promise }
  }
  return { ctx, root, before, calls, results, cancelled, dispatch,
    revoke: () => { revoked = true }, changeEmployee: () => { employeeId = 'employee-b' },
    holdMetadata: () => { holdMetadata = true }, pendingMetadata: () => pendingMetadata,
    settleMetadata: () => { if (pendingMetadata !== undefined) emit({ type: 'extension-result', requestId: pendingMetadata,
      result: { id: identity.documentId, knowledgeBaseId: identity.knowledgeBaseId, filename: 'policy.docx', sizeBytes: original.length, contentVersion: 'v1', updatedAt: 'v1' } }) },
  }
}

describe('original Office preview public Loader entry', () => {
  it('returns original-file pages for a failed index without creating a Session', async () => {
    const h = await fixture()
    const result = await h.dispatch().settled
    expect(result).toEqual({ type: 'extension-control', requestId: 1,
      result: pdfTransfer })
    expect(h.ctx.sessions.list()).toEqual([])
    expect(h.ctx.agents.list()).toEqual([])
    expect(await readdir(join(h.root, 'product-capabilities-v1/tasks-v1'))).toEqual([])
    expect(h.calls.map(call => call.method)).not.toContain('knowledge.documents.read')
    expect(JSON.stringify(result)).not.toContain('employee-a')
    expect(engine.render).toHaveBeenCalledOnce()
  })

  it('defers original reads until the official converter admits the request', async () => {
    const h = await fixture()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    engine.render.mockImplementationOnce(async ({ outputPath }, signal) => {
      await release.promise
      signal?.throwIfAborted()
      await writeFile(outputPath, pdf)
      return { backend: 'native', missingFonts: [] }
    })
    const occupied = h.ctx.officeToPdf.convert({ extension: 'docx', priority: 'foreground', source: {
      key: OfficeSourceKey('independent-queue-occupant'), version: 'v1', bytes: original.length,
      read: async () => ({ bytes: original, version: 'v1' }),
    } })
    await vi.waitFor(() => { expect(engine.render).toHaveBeenCalledOnce() })
    const operation = h.dispatch()
    await vi.waitFor(() => { expect(h.calls.some(call => call.method === 'knowledge.documents.previewMetadata')).toBe(true) })
    expect(h.calls.some(call => call.method === 'knowledge.documents.preview.open')).toBe(false)
    expect(h.results.size).toBe(0)
    release.resolve(undefined)
    await occupied
    expect((await operation.settled).failure).toBeUndefined()
    expect(h.calls.filter(call => call.method === 'knowledge.documents.preview.open')).toHaveLength(1)
  })

  it.each(['permission', 'employee'] as const)('rejects pages after %s changes during conversion', async (change) => {
    const h = await fixture()
    engine.render.mockImplementationOnce(async ({ outputPath }) => {
      await writeFile(outputPath, pdf)
      if (change === 'permission') h.revoke()
      else h.changeEmployee()
      return { backend: 'native', missingFonts: [] }
    })
    const result = await h.dispatch().settled
    expect(result.failure?.code).toBe(change === 'permission' ? 'KNOWLEDGE_ACCESS_REVOKED' : 'KNOWLEDGE_ACCESS_DENIED')
    expect(result.result).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain(pdf.toString('base64'))
  })

  it('cancels the main-process read and suppresses late results on product plugin unload', async () => {
    const h = await fixture()
    h.holdMetadata()
    h.dispatch()
    await vi.waitFor(() => { expect(h.pendingMetadata()).toBeDefined() })
    await h.ctx.loader.resolve('product').fiber?.dispose()
    expect(h.cancelled).toContain(h.pendingMetadata())
    expect(process.listenerCount('message')).toBe(h.before)
    expect(h.results.size).toBe(0)
    h.settleMetadata()
    await Promise.resolve()
    expect(h.results.size).toBe(0)
    expect(engine.render).not.toHaveBeenCalled()
  })

  it('waits for the official engine to settle before Host unload removes its scratch files', async () => {
    const h = await fixture()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    let inputPath: string | undefined
    let signal: AbortSignal | undefined
    engine.render.mockImplementationOnce(async (request, lifetime) => {
      inputPath = request.inputPath
      signal = lifetime
      await release.promise
      lifetime?.throwIfAborted()
      await writeFile(request.outputPath, pdf)
      return { backend: 'native', missingFonts: [] }
    })
    h.dispatch()
    await vi.waitFor(() => { expect(inputPath).toBeDefined() })
    let disposed = false
    const unload = h.ctx.fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(signal?.aborted).toBe(true) })
    expect(disposed).toBe(false)
    expect(await readFile(inputPath!)).toEqual(original)
    release.resolve(undefined)
    await unload
    await expect(readFile(inputPath!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(engine.dispose).toHaveBeenCalledOnce()
  })
})
