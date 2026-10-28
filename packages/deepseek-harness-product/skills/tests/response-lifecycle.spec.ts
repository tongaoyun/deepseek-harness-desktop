import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { listClawHub, searchClawHub } from '../src/clawhub-catalog.ts'
import { searchSkillsSh } from '../src/skills-sh-catalog.ts'
import { readCatalogSkill, loadCatalogPackage } from '../src/catalog-skill.ts'
import { createRepositoryManager } from '../src/repositories.ts'
import { readSkillResponse } from '../src/response-bytes.ts'

const catalogs = [
  { name: 'ClawHub list', body: '{"items":[]}', timeoutMs: 10_000, read: (fetchImpl: typeof fetch) => listClawHub({}, fetchImpl) },
  { name: 'ClawHub search', body: '{"results":[]}', timeoutMs: 10_000, read: (fetchImpl: typeof fetch) => searchClawHub('audit', {}, fetchImpl) },
  { name: 'skills.sh search', body: '{"skills":[]}', timeoutMs: 10_000, read: (fetchImpl: typeof fetch) => searchSkillsSh('audit', fetchImpl) },
  { name: 'catalog detail', body: '---\nname: audit\ndescription: Read orders\n---\nReview', timeoutMs: 15_000,
    read: (fetchImpl: typeof fetch) => readCatalogSkill({ catalog: 'clawhub', owner: 'instudio', slug: 'audit' }, fetchImpl) },
  { name: 'catalog package', body: JSON.stringify({ files: [{ path: 'SKILL.md', contents: '---\nname: audit\ndescription: Read orders\n---\nReview' }] }), timeoutMs: 15_000,
    read: (fetchImpl: typeof fetch) => loadCatalogPackage({ catalog: 'skillsh', source: 'instudio/skills', skillId: 'audit' }, fetchImpl) },
]

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

it.each(catalogs)('$name releases rejected HTTP bodies without replacing the upstream failure', async ({ read }) => {
  const cancel = vi.fn(() => Promise.reject(new Error('Connection cleanup failed')))
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 })
  await expect(read(vi.fn(async () => response))).rejects.toMatchObject({ code: 'error.catalog.upstream', statusCode: 502 })
  expect(cancel).toHaveBeenCalledOnce()
  expect(response.body?.locked).toBe(false)
})

it.each(catalogs)('$name ends a stalled body read at its deadline even when transport cleanup stalls', async ({ read, timeoutMs }) => {
  vi.useFakeTimers()
  const cancel = vi.fn(() => new Promise<void>(() => {}))
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }))
  let signal: AbortSignal | null | undefined
  const fetchImpl: typeof fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal; return response })
  const outcome = read(fetchImpl).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(timeoutMs)
  expect(await outcome).toMatchObject({ code: 'error.catalog.response', statusCode: 502 })
  expect(signal?.aborted).toBe(true)
  expect(cancel).toHaveBeenCalledOnce()
  expect(response.body?.locked).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it.each(catalogs)('$name clears the deadline and reader after a complete response', async ({ read, body }) => {
  vi.useFakeTimers()
  const response = new Response(body)
  let signal: AbortSignal | null | undefined
  const fetchImpl: typeof fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal; return response })
  await read(fetchImpl)
  expect(response.body?.locked).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(signal?.aborted).toBe(false)
})

it('returns exact complete UTF-8 bytes and rejects an extra byte without keeping a reader', async () => {
  const controller = new AbortController()
  const sizeError = Object.assign(new Error('Too large'), { code: 'test/size' })
  const text = '专家'
  const bytes = Buffer.from(text)
  const exact = new Response(bytes)
  expect(await readSkillResponse(exact, bytes.byteLength, controller.signal, sizeError)).toEqual(bytes)
  expect(exact.body?.locked).toBe(false)
  const cancel = vi.fn()
  const tooLarge = new Response(new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(bytes); stream.enqueue(new Uint8Array([1])) }, cancel,
  }))
  await expect(readSkillResponse(tooLarge, bytes.byteLength, controller.signal, sizeError)).rejects.toBe(sizeError)
  expect(cancel).toHaveBeenCalledOnce()
  expect(tooLarge.body?.locked).toBe(false)
})

it('releases declared oversize responses before reading any bytes', async () => {
  const cancel = vi.fn()
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-length': '7' } })
  const sizeError = new Error('Too large')
  await expect(readSkillResponse(response, 6, new AbortController().signal, sizeError)).rejects.toBe(sizeError)
  expect(cancel).toHaveBeenCalledOnce()
  expect(response.body?.locked).toBe(false)
})

it('preserves caller cancellation and releases a pending read without waiting for cleanup', async () => {
  const controller = new AbortController()
  const cancel = vi.fn(() => new Promise<void>(() => {}))
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }))
  const outcome = readSkillResponse(response, 6, controller.signal, new Error('Too large')).catch((error: unknown) => error)
  const reason = new Error('Owner unloaded')
  controller.abort(reason)
  expect(await outcome).toBe(reason)
  expect(cancel).toHaveBeenCalledOnce()
  expect(response.body?.locked).toBe(false)
})

it('preserves a transport read failure and unlocks the failed stream', async () => {
  const failure = new Error('Connection lost during download')
  const response = new Response(new ReadableStream<Uint8Array>({ start(stream) { stream.error(failure) } }))
  await expect(readSkillResponse(response, 6, new AbortController().signal, new Error('Too large'))).rejects.toBe(failure)
  expect(response.body?.locked).toBe(false)
})

it('releases a response cancelled before reading instead of returning empty bytes', async () => {
  const cancel = vi.fn()
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }))
  const controller = new AbortController()
  const reason = new Error('Request already cancelled')
  controller.abort(reason)
  await expect(readSkillResponse(response, 6, controller.signal, new Error('Too large'))).rejects.toBe(reason)
  expect(cancel).toHaveBeenCalledOnce()
  expect(response.body?.locked).toBe(false)
})

it('releases a missing branch response before reading the fallback tag and preserves its archive', async () => {
  const home = await mkdtemp(join(tmpdir(), 'harness-response-branch-'))
  vi.stubEnv('DSH_HOME', home)
  const cancel = vi.fn(() => Promise.reject(new Error('Connection cleanup failed')))
  const missing = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 404 })
  const archive = new Response(zipSync({ 'repo-v1/SKILL.md': strToU8('---\nname: audit\ndescription: Review orders\n---\nReview') }))
  const fetchImpl: typeof fetch = vi.fn<typeof fetch>().mockResolvedValueOnce(missing).mockResolvedValueOnce(archive)
  try {
    const manager = createRepositoryManager({ fetchImpl })
    const repo = await manager.add({ url: 'instudio/skills', ref: 'v1' })
    const result = await manager.refresh({ id: repo.id })
    expect(result.error).toBeNull()
    expect(result.skills).toMatchObject([{ name: 'audit', body: 'Review', valid: true }])
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(archive.body?.locked).toBe(false)
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('keeps the archive size diagnostic when cancellation itself rejects', async () => {
  const home = await mkdtemp(join(tmpdir(), 'harness-response-lifecycle-'))
  vi.stubEnv('DSH_HOME', home)
  const cancel = vi.fn(() => Promise.reject(new Error('Connection cleanup failed')))
  try {
    const manager = createRepositoryManager({ fetchImpl: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array((32 << 20) + 1)) }, cancel,
    }))) })
    const repo = await manager.add({ url: 'instudio/skills', ref: 'main' })
    const result = await manager.refresh({ id: repo.id })
    expect(result.error).toEqual({ code: 'error.repo.tooLarge', error: '仓库归档超过 32 MiB' })
    expect(result.error).toMatchSnapshot()
    expect(cancel).toHaveBeenCalledOnce()
  } finally { await rm(home, { recursive: true, force: true }) }
})
