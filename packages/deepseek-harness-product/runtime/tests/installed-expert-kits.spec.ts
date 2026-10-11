import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createInstalledExpertKits } from '../src/installed-expert-kits.ts'
import type { TaskContent } from '../src/tasks.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rename: vi.fn(original.rename) }
})
afterEach(() => { vi.mocked(rename).mockClear() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'installed-expert-kits-'))
  const ctx = new Context()
  let employee = 'employee-one'
  let version = '1'
  const prepare = vi.fn(async (id: string, _signal?: AbortSignal): Promise<TaskContent> => ({
    identity: { id, name: id, version, sha256: (version === '1' ? 'a' : 'b').repeat(64) },
    connectorRefs: ['needs-authorization'], knowledgeBaseRefs: ['company:manuals'], plugins: [],
  }))
  const kits = createInstalledExpertKits(ctx, {
    root, product: { invoke: async () => ({ authenticated: true, employeeId: employee }) }, prepare,
  })
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, ctx, kits, prepare,
    employee: (value: string) => { employee = value }, version: (value: string) => { version = value },
    path: (id = 'employee-one') => join(root, `installed-${createHash('sha256').update(id).digest('hex')}.json`),
  }
}

it('keeps installations employee-scoped, records fixed identities, updates versions, and removes only local membership', async () => {
  const f = await fixture()
  expect(await f.kits.read()).toEqual({ installed: [] })
  const first = await f.kits.install('policy-kit')
  expect(await f.kits.read()).toEqual({ installed: [first] })
  f.employee('employee-two')
  expect(await f.kits.read()).toEqual({ installed: [] })
  await f.kits.uninstall('policy-kit')
  f.employee('employee-one')
  expect(await f.kits.read()).toEqual({ installed: [first] })
  f.version('2')
  const second = await f.kits.install('policy-kit')
  expect(second.version).toBe('2')
  expect(await f.kits.read()).toEqual({ installed: [second] })
  f.prepare.mockRejectedValueOnce(new Error('Resource permission revoked'))
  expect(await f.kits.uninstall('policy-kit')).toEqual({ id: 'policy-kit' })
  expect(await f.kits.read()).toEqual({ installed: [] })
  expect(f.prepare).toHaveBeenCalledTimes(2)
})

it('serializes task content preparation, uninstall and reinstall without losing other resources', async () => {
  const f = await fixture()
  await f.kits.install('policy-kit')
  f.prepare.mockClear()
  let release!: (content: TaskContent) => void
  const deferred = new Promise<TaskContent>((resolve) => { release = resolve })
  f.prepare.mockReturnValueOnce(deferred)
  const first = f.kits.prepare('policy-kit')
  await vi.waitFor(() => { expect(f.prepare).toHaveBeenCalledOnce() })
  const remove = f.kits.uninstall('policy-kit')
  const second = f.kits.install('report-kit')
  release({ identity: { id: 'policy-kit', version: '1', sha256: 'a'.repeat(64) },
    connectorRefs: [], knowledgeBaseRefs: [], plugins: [] })
  await first
  await remove
  const installed = await second
  expect(await f.kits.read()).toEqual({ installed: [installed] })
  await f.kits.install('policy-kit')
  expect((await f.kits.read()).installed.map(entry => entry.id)).toEqual(['policy-kit', 'report-kit'])
})

it('requires the current employee installation and never installs while preparing task content', async () => {
  const f = await fixture()
  await expect(f.kits.prepare('policy-kit')).rejects.toMatchObject({ code: 'KIT_NOT_INSTALLED', retryable: false,
    resources: [{ kind: 'expert-kit', id: 'policy-kit' }] })
  expect(f.prepare).not.toHaveBeenCalled()
  expect(await readdir(f.root)).toEqual([])
  const installed = await f.kits.install('policy-kit')
  const original = await readFile(f.path(), 'utf8')
  vi.mocked(rename).mockClear()
  expect((await f.kits.prepare('policy-kit')).identity).toEqual(installed)
  expect(vi.mocked(rename)).not.toHaveBeenCalled()
  expect(await readFile(f.path(), 'utf8')).toBe(original)
  f.employee('employee-two')
  await expect(f.kits.prepare('policy-kit')).rejects.toMatchObject({ code: 'KIT_NOT_INSTALLED' })
  f.employee('employee-one')
  await f.kits.uninstall('policy-kit')
  f.prepare.mockClear()
  await expect(f.kits.prepare('policy-kit')).rejects.toMatchObject({ code: 'KIT_NOT_INSTALLED' })
  expect(f.prepare).not.toHaveBeenCalled()
  expect(await f.kits.read()).toEqual({ installed: [] })
})

it('requires an explicit install for a new version or hash and retains the committed installation', async () => {
  const f = await fixture()
  const installed = await f.kits.install('policy-kit')
  const original = await readFile(f.path(), 'utf8')
  f.version('2')
  await expect(f.kits.prepare('policy-kit')).rejects.toMatchObject({ code: 'KIT_INSTALLED_VERSION_CHANGED', retryable: false,
    resources: [{ kind: 'expert-kit', id: 'policy-kit' }] })
  const prepared = f.prepare.getMockImplementation()!
  f.prepare.mockImplementationOnce(async (id, signal) => ({ ...await prepared(id, signal),
    identity: { ...installed, sha256: 'c'.repeat(64) } }))
  await expect(f.kits.prepare('policy-kit')).rejects.toMatchObject({ code: 'KIT_INSTALLED_VERSION_CHANGED' })
  expect(await readFile(f.path(), 'utf8')).toBe(original)
  const updated = await f.kits.install('policy-kit')
  expect(updated.version).toBe('2')
  expect((await f.kits.prepare('policy-kit')).identity).toEqual(updated)
  expect(await f.kits.read()).toEqual({ installed: [updated] })
})

it('orders installation, preparation and uninstall so a later selection cannot restore membership', async () => {
  const f = await fixture()
  let release!: (content: TaskContent) => void
  f.prepare.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
  const installation = f.kits.install('policy-kit')
  await vi.waitFor(() => { expect(f.prepare).toHaveBeenCalledOnce() })
  const selection = f.kits.prepare('policy-kit')
  const removal = f.kits.uninstall('policy-kit')
  const rejected = expect(f.kits.prepare('policy-kit')).rejects.toMatchObject({ code: 'KIT_NOT_INSTALLED' })
  release({ identity: { id: 'policy-kit', version: '1', sha256: 'a'.repeat(64) },
    connectorRefs: [], knowledgeBaseRefs: [], plugins: [] })
  await installation
  await selection
  await removal
  await rejected
  expect(f.prepare).toHaveBeenCalledTimes(2)
  expect(await f.kits.read()).toEqual({ installed: [] })
})

it('rejects account changes and cancellation during task preparation without mutating the installation', async () => {
  const f = await fixture()
  const installed = await f.kits.install('policy-kit')
  const original = await readFile(f.path(), 'utf8')
  const prepare = f.prepare.getMockImplementation()!
  f.prepare.mockImplementationOnce(async (id, signal) => {
    f.employee('employee-two')
    return prepare(id, signal)
  })
  await expect(f.kits.prepare('policy-kit')).rejects.toThrow('Employee changed')
  expect(await f.kits.read()).toEqual({ installed: [] })
  f.employee('employee-one')
  const controller = new AbortController()
  f.prepare.mockImplementationOnce(async (id, signal) => {
    controller.abort(new Error('Cancel task preparation'))
    return prepare(id, signal)
  })
  await expect(f.kits.prepare('policy-kit', controller.signal)).rejects.toThrow('Cancel task preparation')
  expect(await readFile(f.path(), 'utf8')).toBe(original)
  expect(await f.kits.read()).toEqual({ installed: [installed] })
})

it('preserves committed records after validation, persistence or cancellation fails and removes temporary files', async () => {
  const f = await fixture()
  const original = await f.kits.install('policy-kit')
  f.prepare.mockRejectedValueOnce(new Error('Missing packaged skill'))
  await expect(f.kits.install('report-kit')).rejects.toThrow('Missing packaged skill')
  vi.mocked(rename).mockRejectedValueOnce(new Error('Disk write failed'))
  await expect(f.kits.uninstall('policy-kit')).rejects.toThrow('Disk write failed')
  f.version('2')
  vi.mocked(rename).mockRejectedValueOnce(new Error('Disk write failed'))
  await expect(f.kits.install('policy-kit')).rejects.toThrow('Disk write failed')
  const controller = new AbortController()
  controller.abort(new Error('Cancelled'))
  await expect(f.kits.install('report-kit', controller.signal)).rejects.toThrow('Cancelled')
  expect(await f.kits.read()).toEqual({ installed: [original] })
  expect(JSON.parse(await readFile(f.path(), 'utf8'))).toEqual([original])
  expect((await readdir(f.root)).filter(file => file.endsWith('.tmp'))).toEqual([])
})

it('rejects cancellation and employee changes during content preparation without committing to either employee', async () => {
  const f = await fixture()
  const original = f.prepare.getMockImplementation()!
  f.prepare.mockImplementationOnce(async (id, signal) => {
    f.employee('employee-two')
    return original(id, signal)
  })
  await expect(f.kits.install('policy-kit')).rejects.toThrow('Employee changed')
  expect(await f.kits.read()).toEqual({ installed: [] })
  f.employee('employee-one')
  expect(await f.kits.read()).toEqual({ installed: [] })
  const controller = new AbortController()
  f.prepare.mockImplementationOnce(async (id, signal) => {
    controller.abort(new Error('Cancel content'))
    return original(id, signal)
  })
  await expect(f.kits.install('policy-kit', controller.signal)).rejects.toThrow('Cancel content')
  expect(await f.kits.read()).toEqual({ installed: [] })
})

it('waits for in-flight work on plugin release and rejects queued and subsequent requests', async () => {
  const f = await fixture()
  let release!: (content: TaskContent) => void
  f.prepare.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
  const pending = f.kits.install('policy-kit')
  const rejected = expect(pending).rejects.toThrow('disposed')
  await vi.waitFor(() => { expect(f.prepare).toHaveBeenCalledOnce() })
  const queued = expect(f.kits.read()).rejects.toThrow('disposed')
  let released = false
  const disposal = f.ctx.fiber.dispose().then(() => { released = true })
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  expect(released).toBe(false)
  release({ identity: { id: 'policy-kit', version: '1', sha256: 'a'.repeat(64) },
    connectorRefs: [], knowledgeBaseRefs: [], plugins: [] })
  await rejected
  await queued
  await disposal
  expect(await readdir(f.root)).toEqual([])
  await expect(f.kits.install('policy-kit')).rejects.toThrow('disposed')
})
