/** Exact company versions remain independent of catalog and Session updates. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { CompanyResourceVersion } from '@deepseek-harness/product/company-content'
import { contentIndex, encoded, expertFiles, versionRef } from '../../product/tests/content-fixtures.ts'
import { CompanyContentSync } from '../src/company-content-sync.ts'

async function fixture(cacheOld = false) {
  const root = await mkdtemp(join(tmpdir(), 'company-expert-versions-'))
  const original = { ...expertFiles('orders', 'Original {{literal}}'),
    'experts/orders/references/订单.md': encoded('Original reference'),
    'experts/orders/assets/template.bin': Buffer.from([0, 128, 255]).toString('base64') }
  const updated = expertFiles('orders', 'Updated instructions')
  const oldRef = versionRef('experts/orders', original), nextRef = versionRef('experts/orders', updated)
  let current = contentIndex('1.0.0', [cacheOld ? oldRef : nextRef])
  const loadResource = vi.fn<(ref: Pick<CompanyResourceVersion, 'resourceKey' | 'version' | 'sha256'>,
    signal: AbortSignal) => Promise<unknown>>(async ref => ({ ...ref, files: ref.sha256 === oldRef.sha256 ? original : updated }))
  const owners: CompanyContentSync[] = []
  const create = (employeeId = 'a') => {
    const sync = new CompanyContentSync({ root, employeeId, refreshIntervalMs: 0,
      load: async () => current, loadResource })
    owners.push(sync)
    return sync
  }
  onTestFinished(async () => {
    await Promise.allSettled(owners.map(sync => sync.close()))
    await rm(root, { recursive: true, force: true })
  })
  const sync = create()
  await sync.prepare()
  await sync.refresh()
  if (cacheOld) {
    current = contentIndex('2.0.0', [nextRef])
    await sync.refresh()
  }
  loadResource.mockClear()
  return { root, sync, create, loadResource, oldRef, original }
}

it('uses the cached fixed version after a catalog update without changing the catalog or Session binding', async () => {
  const { sync, root, oldRef, loadResource } = await fixture(true)
  const catalog = sync.read()
  const pin = await sync.pin({ sessionId: 'fixed', started: false })
  const employee = createHash('sha256').update('a').digest('hex')
  const binding = join(root, employee, 'sessions', createHash('sha256').update('fixed').digest('hex') + '.json')
  const saved = await readFile(binding, 'utf8')
  const packageRoot = await sync.expertVersion('orders', oldRef.sha256)
  expect(await readFile(join(packageRoot, 'config/SOUL.md'), 'utf8')).toBe('Original {{literal}}')
  expect(loadResource).not.toHaveBeenCalled()
  expect(sync.read()).toEqual(catalog)
  expect(await sync.pin({ sessionId: 'fixed', started: true })).toEqual(pin)
  expect(await readFile(binding, 'utf8')).toBe(saved)
})

it('fetches a missing exact version with complete resources and isolates its files by employee', async () => {
  const { sync, create, oldRef, loadResource } = await fixture()
  const a = await sync.expertVersion('orders', oldRef.sha256)
  const other = create('b')
  await other.prepare()
  await other.refresh()
  loadResource.mockClear()
  const b = await other.expertVersion('orders', oldRef.sha256)
  expect(a).not.toBe(b)
  expect(loadResource).toHaveBeenCalledWith({ resourceKey: 'experts/orders', version: oldRef.version,
    sha256: oldRef.sha256 }, expect.any(AbortSignal))
  for (const path of [a, b]) {
    expect(await readFile(join(path, 'references/订单.md'), 'utf8')).toBe('Original reference')
    expect(await readFile(join(path, 'assets/template.bin'))).toEqual(Buffer.from([0, 128, 255]))
  }
})

it.each(['changed', 'missing'] as const)('rejects a %s cached fixed version without downloading or replacing it', async (damage) => {
  const { sync, oldRef, loadResource } = await fixture(true)
  const path = join(await sync.expertVersion('orders', oldRef.sha256), 'config/SOUL.md')
  if (damage === 'changed') await writeFile(path, 'Damaged instructions')
  else await rm(path)
  await expect(sync.expertVersion('orders', oldRef.sha256)).rejects.toThrow('损坏')
  expect(loadResource).not.toHaveBeenCalled()
  if (damage === 'changed') expect(await readFile(path, 'utf8')).toBe('Damaged instructions')
  expect(sync.read().version).toBe('2.0.0')
})

it.each(['key', 'digest', 'namespace'] as const)('rejects a remote %s mismatch before installing the fixed version', async (field) => {
  const { sync, root, oldRef, original, loadResource } = await fixture()
  const wrong = expertFiles('another', 'Other instructions')
  const ref = field === 'namespace' ? versionRef('experts/another', wrong) : oldRef
  loadResource.mockResolvedValueOnce({ ...ref, resourceKey: field === 'key' ? 'experts/another' : 'experts/orders',
    sha256: field === 'digest' ? 'f'.repeat(64) : ref.sha256, files: field === 'namespace' ? wrong : original })
  await expect(sync.expertVersion('orders', ref.sha256)).rejects.toThrow()
  const employee = join(root, 'resources', createHash('sha256').update('a').digest('hex'))
  expect(await readdir(employee)).not.toContain(ref.sha256)
  expect((await readdir(employee)).some(name => name.startsWith('.staging-'))).toBe(false)
})

it.each(['caller', 'employee'] as const)('cancels a pending exact read on %s disposal and joins the remote request', async (owner) => {
  const { sync, root, oldRef, original, loadResource } = await fixture()
  const entered = Promise.withResolvers<AbortSignal>(), resume = Promise.withResolvers<undefined>()
  loadResource.mockImplementationOnce(async (ref, signal) => {
    entered.resolve(signal)
    await resume.promise
    return { ...ref, files: original }
  })
  const caller = new AbortController()
  const pending = sync.expertVersion('orders', oldRef.sha256, caller.signal)
  const rejected = expect(pending).rejects.toThrow(owner === 'caller' ? 'Caller stopped' : '同步已结束')
  const signal = await entered.promise
  if (owner === 'caller') caller.abort(new Error('Caller stopped'))
  let closed = false
  const closing = sync.close().then(() => { closed = true })
  try {
    expect(signal.aborted).toBe(true)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(closed).toBe(false)
  } finally { resume.resolve(undefined); await closing; await rejected }
  const employee = join(root, 'resources', createHash('sha256').update('a').digest('hex'))
  expect(await readdir(employee)).not.toContain(oldRef.sha256)
  expect((await readdir(employee)).some(name => name.startsWith('.staging-'))).toBe(false)
})
