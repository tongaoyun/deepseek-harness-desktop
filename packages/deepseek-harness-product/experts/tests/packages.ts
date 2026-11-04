import { mkdtempSync } from 'node:fs'
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, onTestFinished } from 'vitest'
import { ExpertPackageStore } from '../src/expert-packages.ts'
import { z } from 'zod'
import { companyResourceVersionSchema } from '@deepseek-harness/product/company-content'
const stores = new Map<string, ExpertPackageStore>()
export function testPackageStore(): ExpertPackageStore {
  const id = expect.getState().currentTestName!
  let store = stores.get(id)
  if (!store) {
    const root = mkdtempSync(join(tmpdir(), 'personal-agentspec-'))
    store = new ExpertPackageStore(async () => root); stores.set(id, store)
    onTestFinished(async () => { stores.delete(id); await rm(root, { recursive: true, force: true }) })
  }
  return store
}
export async function writeTestExpert(root: string, id: string, soul: string) {
  await mkdir(join(root, id, 'config'), { recursive: true })
  await writeFile(join(root, id, 'manifest.json'), JSON.stringify({ worker: { suggested_name: id }, description: 'Expert instructions' }))
  await writeFile(join(root, id, 'config/SOUL.md'), soul)
}

/** Convert compact test metadata to an AgentSpec fixture; production never reads Markdown personas. */
export async function writeExpertFixture(path: string, data: string, _encoding?: string) {
  const match = /^(.*)\/([^/]+)\/([^/]+)\.md$/u.exec(path)
  if (!match) { await writeFile(path, data); return }
  const [, root, division, id] = match
  const { parse } = await import('yaml')
  const document = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(data)
  if (!document) throw new Error('Invalid test fixture')
  const metadata = z.object({ name: z.string(), description: z.string() }).parse(parse(document[1]))
  await writeTestExpert(root, id, document[2])
  await writeFile(join(root, id, 'manifest.json'), JSON.stringify({ worker: { suggested_name: id }, description: metadata.description }))
  const { versionRef, expertFiles } = await import('../../product/tests/content-fixtures.ts')
  const ref = versionRef('experts/' + id, expertFiles(id, document[2]))
  ref.name = metadata.name; ref.catalog = { name: metadata.name, division, avatar: '0' }
  let index: { resources: typeof ref[]; dependencies: typeof ref[] } = { resources: [], dependencies: [] }
  try { index = z.object({ resources: z.array(companyResourceVersionSchema), dependencies: z.array(companyResourceVersionSchema) })
    .parse(JSON.parse(await readFile(join(root, '..', 'catalog.json'), 'utf8'))) } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  index.resources = [...index.resources.filter(item => item.resourceKey !== ref.resourceKey), ref]
  await writeFile(join(root, '..', 'catalog.json'), JSON.stringify(index))
  await rm(join(root, division), { recursive: true, force: true })
}

export async function emptyCompanySource() {
  const root = mkdtempSync(join(tmpdir(), 'company-content-fixture-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const { installCompanyContent } = await import('../../desktop/src/company-content.ts')
  const roots = await installCompanyContent(root, 'employee-test', null, new AbortController().signal)
  return { read: async () => roots, forSession: async () => roots, refresh: async () => {} }
}
