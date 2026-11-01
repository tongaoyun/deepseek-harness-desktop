// @vitest-environment jsdom
/** Knowledge view cancellation settles independently of the main-process reply. */
import { StrictMode, useEffect } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { readKnowledgeFile, useKnowledgeRequests } from '../src/client/knowledge-data.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('settles caller cancellation while another request can still complete', async () => {
  const first = Promise.withResolvers<unknown>()
  const second = Promise.withResolvers<unknown>()
  const invoke = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  const hook = renderHook(useKnowledgeRequests)
  const controller = new AbortController()
  const reason = new Error('Folder changed')
  let failure: unknown
  const cancelled = hook.result.current('knowledge.documents.list', {}, controller.signal)
    .catch((error: unknown) => { failure = error })
  const active = hook.result.current('knowledge.folders.list', {})
  try {
    await act(async () => { controller.abort(reason) })
    expect(failure).toBe(reason)
    expect(cancel).toHaveBeenCalledExactlyOnceWith('product', invoke.mock.calls[0]![3])
    second.resolve({ ok: true, result: ['current folder'] })
    await expect(active).resolves.toEqual(['current folder'])
    hook.unmount()
    expect(cancel).toHaveBeenCalledOnce()
  } finally {
    first.resolve({ ok: true, result: ['stale document'] })
    second.resolve({ ok: true, result: [] })
    await Promise.allSettled([cancelled, active])
  }
})

it('settles every pending request on unmount even when transport cancellation throws', async () => {
  const pending = Promise.withResolvers<unknown>()
  const invoke = vi.fn(() => pending.promise)
  const cancel = vi.fn(() => { throw new Error('Bridge disconnected') })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  const hook = renderHook(useKnowledgeRequests)
  const failures: unknown[] = []
  const requests = ['knowledge.documents.list', 'knowledge.folders.list'].map(method =>
    hook.result.current(method, {}).catch((error: unknown) => { failures.push(error) }))
  try {
    await act(async () => { hook.unmount() })
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(failures).toHaveLength(2)
    expect(failures.every(error => error instanceof Error)).toBe(true)
  } finally {
    pending.resolve({ ok: true, result: [] })
    await Promise.allSettled(requests)
  }
})

it('allows the reactivated StrictMode effect to read after cancelling its abandoned request', async () => {
  const pending = [Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>()]
  const invoke = vi.fn().mockReturnValueOnce(pending[0]!.promise).mockReturnValueOnce(pending[1]!.promise)
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  const values: unknown[] = []
  const failures: unknown[] = []
  const requests: Promise<void>[] = []
  const hook = renderHook(() => {
    const request = useKnowledgeRequests()
    useEffect(() => {
      requests.push(request('knowledge.bases.list', {}).then((value) => { values.push(value) },
        (error: unknown) => { failures.push(error) }))
    }, [request])
  }, { wrapper: StrictMode })
  try {
    await act(async () => { pending[1]!.resolve({ ok: true, result: ['current library'] }) })
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(failures).toHaveLength(1)
    expect(values).toEqual([['current library']])
    hook.unmount()
    expect(cancel).toHaveBeenCalledOnce()
  } finally {
    for (const result of pending) result.resolve({ ok: true, result: ['abandoned library'] })
    await Promise.allSettled(requests)
  }
})

it('closes an opened preview after unmount without waiting for its pending chunk', async () => {
  const chunk = Promise.withResolvers<unknown>()
  const invoke = vi.fn(async (_namespace: string, method: string) => {
    if (method.endsWith('.open')) return { ok: true, result: {
      transferId: 'preview', mediaType: 'text/plain', byteLength: 1, maxBytes: 10, chunkSize: 1,
    } }
    if (method.endsWith('.read')) return chunk.promise
    return { ok: true, result: { closed: true } }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const hook = renderHook(useKnowledgeRequests)
  let failure: unknown
  const reading = readKnowledgeFile(hook.result.current, { knowledgeBaseId: 'base', documentId: 'doc' },
    new AbortController().signal).catch((error: unknown) => { failure = error })
  try {
    await waitFor(() => { expect(invoke).toHaveBeenCalledTimes(2) })
    await act(async () => { hook.unmount() })
    expect(failure).toBeInstanceOf(Error)
    expect(invoke).toHaveBeenLastCalledWith('product', 'knowledge.documents.preview.close', { transferId: 'preview' }, expect.any(String))
  } finally {
    chunk.resolve({ ok: true, result: { data: new Uint8Array([1]), offset: 0, eof: true } })
    await reading
  }
})
