import { mkdtemp, readFile, rm, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { contentDigest } from '@deepseek-harness/product/company-content'
import { installCompanyContent } from '../src/company-content.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'company-content-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}
function release(body = 'first') {
  const files = { 'skills/company-orders/SKILL.md': Buffer.from(`---\nname: company-orders\ndescription: orders\n---\n${body}`).toString('base64') }
  return { version: '1.0.0', sha256: contentDigest(files), files }
}

it('keeps installed content immutable across updates and isolates employees', async () => {
  const root = await fixture(), signal = new AbortController().signal
  const first = await installCompanyContent(root, 'employee-a', release(), signal)
  const next = await installCompanyContent(root, 'employee-a', release('second'), signal)
  const other = await installCompanyContent(root, 'employee-b', release(), signal)
  expect(first.skillsRoot).not.toEqual(next.skillsRoot)
  expect(first.skillsRoot).not.toEqual(other.skillsRoot)
  expect(await readFile(join(first.skillsRoot, 'company-orders/SKILL.md'), 'utf8')).toContain('first')
  expect(await installCompanyContent(root, 'employee-a', release(), signal)).toEqual(first)
})

it('does not publish partial or cancelled content and rejects damaged caches', async () => {
  const root = await fixture(), controller = new AbortController()
  controller.abort()
  await expect(installCompanyContent(root, 'a', release(), controller.signal)).rejects.toThrow()
  expect(await readdir(root)).toEqual([])
  const first = await installCompanyContent(root, 'a', release(), new AbortController().signal)
  await writeFile(join(first.skillsRoot, 'company-orders/SKILL.md'), 'damaged')
  await expect(installCompanyContent(root, 'a', release(), new AbortController().signal)).rejects.toThrow('损坏')
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
  await writeFile(join(first.skillsRoot, 'company-orders/extra.md'), 'unexpected')
  await expect(installCompanyContent(root, 'same', release(), signal)).rejects.toThrow('损坏')
  await rm(join(first.skillsRoot, 'company-orders/extra.md'))
  const original = join(first.skillsRoot, 'company-orders')
  const other = join(root, 'other')
  const { rename } = await import('node:fs/promises')
  await rename(original, other)
  await symlink(other, original, 'dir')
  await expect(installCompanyContent(root, 'same', release(), signal)).rejects.toThrow('不安全')
})
