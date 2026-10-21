import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { contentDigest } from '@deepseek-harness/product/company-content'
import { CompanyContentSync } from '../src/company-content-sync.ts'

function release(version: string) {
  const files = {
    'skills/orders/SKILL.md': Buffer.from(`---\nname: orders\ndescription: orders\n---\nSkill ${version}`).toString('base64'),
    'experts/operations/orders.md': Buffer.from(`---\nname: 订单专家\ndescription: orders\n---\nExpert ${version}`).toString('base64'),
  }
  return { version, sha256: contentDigest(files), files }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'company-sync-'))
  const load = vi.fn<(signal: AbortSignal) => Promise<unknown>>().mockResolvedValue(release('1.0.0'))
  const owners: CompanyContentSync[] = []
  const create = (employeeId = 'a') => {
    const sync = new CompanyContentSync({ root, employeeId, refreshIntervalMs: 1000, load })
    owners.push(sync)
    return sync
  }
  onTestFinished(async () => {
    await Promise.allSettled(owners.map(owner => owner.close()))
    await rm(root, { force: true, recursive: true })
    vi.restoreAllMocks()
  })
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
  return { root, load, create, now }
}

it('shows local content before the first request settles and coalesces page checks', async () => {
  const { load, create } = await fixture()
  const remote = Promise.withResolvers<unknown>()
  load.mockImplementationOnce((signal) => { signal.addEventListener('abort', () => { remote.reject(signal.reason) }, { once: true }); return remote.promise })
  const sync = create()
  expect((await sync.prepare()).version).toBe('0')
  const expertCheck = sync.refresh()
  expect(sync.refresh()).toBe(expertCheck)
  expect(load).toHaveBeenCalledOnce()
  remote.resolve(release('1.0.0'))
  await expertCheck
  expect(sync.read().version).toBe('1.0.0')
  await sync.refresh()
  expect(load).toHaveBeenCalledOnce()
})

it('new tasks use the new version while old tasks and child tasks keep their content after restart', async () => {
  const { create, load, now } = await fixture()
  const first = create()
  await first.prepare()
  await first.refresh()
  const old = await first.pin({ sessionId: 'old', started: false })
  now.mockReturnValue(102_000)
  load.mockResolvedValue(release('2.0.0'))
  await first.refresh()
  const current = await first.pin({ sessionId: 'new', started: false })
  expect(current.version).toBe('2.0.0')
  expect((await first.pin({ sessionId: 'child', parentSessionId: 'old', started: false })).sha256).toBe(old.sha256)
  await first.close()
  const restarted = create()
  expect((await restarted.prepare()).version).toBe('2.0.0')
  const restored = await restarted.pin({ sessionId: 'old', started: true })
  expect(restored).toEqual(old)
  expect(await readFile(join(restored.skillsRoot, 'orders/SKILL.md'), 'utf8')).toContain('Skill 1.0.0')
  expect(await readFile(join(restored.expertsRoot, 'operations/orders.md'), 'utf8')).toContain('Expert 1.0.0')
})

it('keeps the verified catalog after network failure and retries without waiting for the throttle', async () => {
  const { create, load, now } = await fixture()
  const sync = create()
  await sync.prepare()
  await sync.refresh()
  now.mockReturnValue(102_000)
  load.mockRejectedValueOnce(new Error('Network unavailable'))
  await expect(sync.refresh()).rejects.toThrow('Network unavailable')
  expect(sync.read().version).toBe('1.0.0')
  await sync.refresh()
  expect(load).toHaveBeenCalledTimes(3)
})

it.each(['changed', 'missing'])('rejects %s cached content for existing, child and new tasks without replacing bindings', async (damage) => {
  const { root, create, load, now } = await fixture()
  const sync = create()
  await sync.prepare(); await sync.refresh()
  const pinned = await sync.pin({ sessionId: 'old', started: false })
  const employeeRoot = join(root, createHash('sha256').update('a').digest('hex'))
  const bindingPath = join(employeeRoot, 'sessions', createHash('sha256').update('old').digest('hex') + '.json')
  const originalBinding = await readFile(bindingPath, 'utf8')
  const file = join(pinned.skillsRoot, 'orders/SKILL.md')
  if (damage === 'changed') await writeFile(file, 'Changed skill content')
  else await rm(file)
  const failure = { code: 'COMPANY_CONTENT_CACHE_INVALID', retryable: false,
    resources: [{ kind: 'company-content', id: pinned.sha256 }] }
  await expect(sync.pin({ sessionId: 'old', started: true })).rejects.toMatchObject(failure)
  await expect(sync.pin({ sessionId: 'child', parentSessionId: 'old', started: false })).rejects.toMatchObject(failure)
  await expect(sync.pin({ sessionId: 'new', started: false })).rejects.toMatchObject(failure)
  expect(await readFile(bindingPath, 'utf8')).toBe(originalBinding)
  expect(await readdir(join(employeeRoot, 'sessions'))).toEqual([basename(bindingPath)])
  if (damage === 'changed') expect(await readFile(file, 'utf8')).toBe('Changed skill content')
  now.mockReturnValue(102_000)
  load.mockResolvedValue(release('2.0.0'))
  await sync.refresh()
  expect((await sync.pin({ sessionId: 'healthy', started: false })).version).toBe('2.0.0')
  await expect(sync.pin({ sessionId: 'old', started: true })).rejects.toMatchObject(failure)
})

it('isolates employee bindings, serializes concurrent pins and refuses a missing running-task binding', async () => {
  const { create } = await fixture()
  const a = create('a'), b = create('b')
  await a.prepare(); await b.prepare()
  await Promise.all([a.refresh(), b.refresh()])
  const [one, two] = await Promise.all([a.pin({ sessionId: 'same', started: false }), a.pin({ sessionId: 'same', started: false })])
  expect(one).toEqual(two)
  const other = await b.pin({ sessionId: 'same', started: false })
  expect(other.skillsRoot).not.toBe(one.skillsRoot)
  await expect(a.pin({ sessionId: 'lost', started: true })).rejects.toMatchObject({
    code: 'COMPANY_CONTENT_BINDING_MISSING', retryable: false,
    message: '此任务缺少公司内容版本记录，请新建对话；原任务历史已保留。',
    resources: [{ kind: 'session', id: 'lost' }],
  })
})

it('preserves a broken binding and rejects a missing version instead of selecting the latest', async () => {
  const { root, create } = await fixture()
  const sync = create()
  await sync.prepare(); await sync.refresh()
  const pinned = await sync.pin({ sessionId: 'damaged', started: false })
  const employee = createHash('sha256').update('a').digest('hex')
  const filename = createHash('sha256').update('damaged').digest('hex') + '.json'
  const path = join(root, employee, 'sessions', filename)
  await writeFile(path, '{broken')
  await expect(sync.pin({ sessionId: 'damaged', started: true })).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe('{broken')
  await writeFile(path, JSON.stringify({ sessionId: 'damaged', version: pinned.version, sha256: 'f'.repeat(64) }))
  await expect(sync.pin({ sessionId: 'damaged', started: true })).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toContain('f'.repeat(64))
  expect((await sync.pin({ sessionId: 'healthy', started: false })).version).toBe('1.0.0')
})

it('cancels refresh on disposal, waits for it to settle and leaves no staging files', async () => {
  const { create, load, root } = await fixture()
  const entered = Promise.withResolvers<AbortSignal>()
  load.mockImplementationOnce(signal => new Promise((_resolve, reject) => {
    entered.resolve(signal)
    signal.addEventListener('abort', () => { reject(new Error('公司内容同步已结束')) }, { once: true })
  }))
  const sync = create()
  await sync.prepare()
  const pending = sync.refresh()
  const rejected = expect(pending).rejects.toThrow('同步已结束')
  const signal = await entered.promise
  await sync.close()
  await rejected
  expect(signal.aborted).toBe(true)
  const [employee] = await readdir(root)
  expect((await readdir(join(root, employee!))).some(name => name.includes('staging') || name.endsWith('.tmp'))).toBe(false)
})

it('cancels one page waiter without cancelling a concurrent reader', async () => {
  const { load, create } = await fixture()
  const remote = Promise.withResolvers<unknown>()
  load.mockImplementationOnce((signal) => {
    signal.addEventListener('abort', () => { remote.reject(signal.reason) }, { once: true })
    return remote.promise
  })
  const sync = create()
  await sync.prepare()
  const page = new AbortController()
  const cancelled = expect(sync.refresh(page.signal)).rejects.toThrow('Page closed')
  const other = sync.refresh()
  page.abort(new Error('Page closed'))
  await cancelled
  remote.resolve(release('1.0.0'))
  await other
  expect(sync.read().version).toBe('1.0.0')
  expect(load).toHaveBeenCalledOnce()
})

it('cancels a cold Session pin without committing its binding or blocking the next Session', async () => {
  const { load, create, root } = await fixture()
  const remote = Promise.withResolvers<unknown>()
  load.mockImplementationOnce((signal) => {
    signal.addEventListener('abort', () => { remote.reject(signal.reason) }, { once: true })
    return remote.promise
  })
  const sync = create()
  await sync.prepare()
  const stop = new AbortController()
  const stopped = expect(sync.pin({ sessionId: 'stopped', started: false }, stop.signal)).rejects.toThrow('User stopped')
  const next = sync.pin({ sessionId: 'next', started: false })
  const [employee] = await readdir(root)
  await vi.waitFor(async () => { expect(await readdir(join(root, employee!, 'sessions'))).toEqual([]) })
  stop.abort(new Error('User stopped'))
  await stopped
  remote.resolve(release('1.0.0'))
  expect((await next).version).toBe('1.0.0')
  const records = await readdir(join(root, employee!, 'sessions'))
  expect(records).toEqual([createHash('sha256').update('next').digest('hex') + '.json'])
  expect(await readFile(join(root, employee!, 'sessions', records[0]!), 'utf8')).toContain('"sessionId":"next"')
})
