import { mkdtemp, readFile, rm, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { contentDigest } from '@deepseek-harness/product/company-content'
import { installCompanyContent, restoreCompanyContent } from '../src/company-content.ts'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, rename: vi.fn(fs.rename), readFile: vi.fn(fs.readFile) }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'company-content-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}
function release(body = 'first') {
  const files = { 'skills/orders/SKILL.md': Buffer.from(`---\nname: orders\ndescription: orders\n---\n${body}`).toString('base64') }
  return { version: '1.0.0', sha256: contentDigest(files), files }
}

it('keeps installed content immutable across updates and isolates employees', async () => {
  const root = await fixture(), signal = new AbortController().signal
  const first = await installCompanyContent(root, 'employee-a', release(), signal)
  const next = await installCompanyContent(root, 'employee-a', release('second'), signal)
  const other = await installCompanyContent(root, 'employee-b', release(), signal)
  expect(first.skillsRoot).not.toEqual(next.skillsRoot)
  expect(first.skillsRoot).not.toEqual(other.skillsRoot)
  expect(await readFile(join(first.skillsRoot, 'orders/SKILL.md'), 'utf8')).toContain('first')
  expect(await installCompanyContent(root, 'employee-a', release(), signal)).toEqual(first)
})

it('does not publish partial or cancelled content and rejects damaged caches', async () => {
  const root = await fixture(), controller = new AbortController()
  controller.abort()
  await expect(installCompanyContent(root, 'a', release(), controller.signal)).rejects.toThrow()
  expect(await readdir(root)).toEqual([])
  const first = await installCompanyContent(root, 'a', release(), new AbortController().signal)
  await writeFile(join(first.skillsRoot, 'orders/SKILL.md'), 'damaged')
  await expect(installCompanyContent(root, 'a', release(), new AbortController().signal)).rejects.toThrow('损坏')
})

it('rejects directory case aliases before creating employee content on disk', async () => {
  const root = await fixture()
  const files = { ...release().files, 'skills/orders/Assets/one.txt': Buffer.from('one').toString('base64'),
    'skills/orders/assets/two.txt': Buffer.from('two').toString('base64') }
  await expect(installCompanyContent(root, 'employee-a', { version: '1.0.0', sha256: contentDigest(files), files },
    new AbortController().signal)).rejects.toThrow('目录大小写冲突')
  expect(await readdir(root)).toEqual([])
})

it('rejects symlink cache roots', async () => {
  const root = await fixture(), target = await fixture()
  const link = join(root, 'link')
  await symlink(target, link, 'dir')
  await expect(installCompanyContent(link, 'a', release(), new AbortController().signal)).rejects.toThrow('不安全')
})

it('joins concurrent installs and rejects unexpected files and intermediate links', async () => {
  const root = await fixture(), signal = new AbortController().signal
  const [first, second] = await Promise.all([
    installCompanyContent(root, 'same', release(), signal), installCompanyContent(root, 'same', release(), signal),
  ])
  expect(first).toEqual(second)
  await writeFile(join(first.skillsRoot, 'orders/extra.md'), 'unexpected')
  await expect(installCompanyContent(root, 'same', release(), signal)).rejects.toThrow('损坏')
  await rm(join(first.skillsRoot, 'orders/extra.md'))
  const original = join(first.skillsRoot, 'orders')
  const other = join(root, 'other')
  const { rename } = await import('node:fs/promises')
  await rename(original, other)
  await symlink(other, original, 'dir')
  await expect(installCompanyContent(root, 'same', release(), signal)).rejects.toThrow('不安全')
})

it('verifies the winning directory after a Windows rename collision and cleans staging on permission failure', async () => {
  const root = await fixture(), signal = new AbortController().signal
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(rename).mockImplementationOnce(async (source, target) => {
    await fs.rename(source, target)
    throw Object.assign(new Error('Destination exists'), { code: 'EPERM' })
  })
  const installed = await installCompanyContent(root, 'windows-race', release(), signal)
  expect(await readFile(join(installed.skillsRoot, 'orders/SKILL.md'), 'utf8')).toContain('first')
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 'EPERM' }))
  await expect(installCompanyContent(root, 'windows-race', release('new'), signal)).rejects.toThrow()
  const [employee] = await readdir(root)
  expect(await readdir(join(root, employee!))).toEqual([release().sha256])
})

it('reads each cache file once per check and still detects later changes', async () => {
  const root = await fixture(), signal = new AbortController().signal
  const value = release()
  const installed = await installCompanyContent(root, 'a', value, signal)
  for (let check = 0; check < 2; check++) {
    vi.mocked(readFile).mockClear()
    expect(await restoreCompanyContent(root, 'a', value.version, value.sha256, signal)).toEqual(installed)
    expect(readFile).toHaveBeenCalledTimes(2)
  }
  await writeFile(join(installed.skillsRoot, 'orders/SKILL.md'), 'changed')
  await expect(restoreCompanyContent(root, 'a', value.version, value.sha256, signal)).rejects.toThrow('损坏')
})

it('reuses identical content under a new version without rewriting the immutable cache', async () => {
  const root = await fixture(), signal = new AbortController().signal
  const value = release()
  const first = await installCompanyContent(root, 'a', value, signal)
  const next = await installCompanyContent(root, 'a', { ...value, version: '2.0.0' }, signal)
  expect(next).toEqual({ ...first, version: '2.0.0' })
  expect(await restoreCompanyContent(root, 'a', next.version, next.sha256, signal)).toEqual(next)
})

it('restores the entire team file from its immutable release without replacing old content', async () => {
  const root = await fixture(), signal = new AbortController().signal
  const document = await readFile(new URL('../../experts/tests/fixtures/team.json', import.meta.url), 'utf8')
  const files = { 'teams/orders.json': Buffer.from(document).toString('base64') }
  const first = await installCompanyContent(root, 'alice', { version: '1.0.0', sha256: contentDigest(files), files }, signal)
  const updated = { 'teams/orders.json': Buffer.from(document.replaceAll('固定成员说明', '新版成员说明')).toString('base64') }
  const latest = await installCompanyContent(root, 'alice', { version: '2.0.0', sha256: contentDigest(updated), files: updated }, signal)
  expect(first.expertsRoot).not.toBe(latest.expertsRoot)
  expect(await restoreCompanyContent(root, 'alice', first.version, first.sha256, signal)).toEqual(first)
  expect(await readFile(join(first.expertsRoot, '..', 'teams/orders.json'), 'utf8')).toBe(document)
})
