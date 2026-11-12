/** Personal package installation preserves committed files and reports incomplete cleanup. */
import { mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { ExpertPackageStore, expertPackageFiles } from '../src/expert-packages.ts'
import { agencySettingsSchema, createExpertLibrary, type AgencySettings } from '../src/expert-library.ts'
import { MemorySettings } from '../src/settings-memory.ts'
import type { CustomExpertInput, ExpertSummary } from '../src/expert-contract.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm), writeFile: vi.fn(actual.writeFile) }
})
let actual: typeof import('node:fs/promises')
beforeEach(async () => {
  actual = await vi.importActual('node:fs/promises')
  vi.mocked(rename).mockReset().mockImplementation(actual.rename)
  vi.mocked(rm).mockReset().mockImplementation(actual.rm)
  vi.mocked(writeFile).mockReset().mockImplementation(actual.writeFile)
})
const draft = { name: '订单专家', description: '核对订单', division: 'orders', prompt: '保留 {{literal}}，读取附件。',
  resources: { 'references/中文资料.md': Buffer.from('核对资料').toString('base64'),
    'assets/模板.bin': Buffer.from([0, 128, 255]).toString('base64') } }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'expert-package-failures-'))
  onTestFinished(() => actual.rm(root, { recursive: true, force: true }))
  return { root, packages: new ExpertPackageStore(async () => root) }
}

it.each(['company-name', 'company-english-name', 'company-id', 'personal-name', 'personal-rename'] as const)(
  'rejects a %s conflict before writing package files, even when storage is unavailable', async (conflict) => {
    const { root, packages } = await fixture()
    const settings = new MemorySettings()
    settings.register('personal', agencySettingsSchema)
    const store = {
      read: () => settings.get('personal') as AgencySettings,
      revision: () => settings.describe()[0].revision,
      mutate: (ops, revision) => settings.mutate('personal', ops, revision),
    } satisfies Parameters<typeof createExpertLibrary>[1]
    const company: ExpertSummary = { slug: 'company-orders', name: '公司订单专家', nameEn: 'Order Expert',
      description: '核对订单', descriptionEn: '', division: 'orders', divisionZh: '订单', emoji: '🧩', custom: false }
    const library = createExpertLibrary(async () => [company], store, ['orders'], () => 'zh', packages)
    const input: CustomExpertInput = { ...draft, prompt: '这份未保存内容不能写入版本目录。' }
    if (conflict === 'company-name') input.name = ' 公司订单专家 '
    else if (conflict === 'company-english-name') input.name = ' order expert '
    else if (conflict === 'company-id') input.manifest = JSON.stringify({ worker: { suggested_name: company.slug }, description: draft.description })
    else {
      await library.saveCustom(draft, true, store.revision())
      if (conflict === 'personal-rename') {
        await library.saveCustom({ ...draft, name: '待改名专家' }, false, store.revision())
        input.slug = store.read().customExperts?.find(expert => expert.name === '待改名专家')?.slug
        expect(input.slug).toBeDefined()
      }
    }
    const catalog = await library.catalog()
    const paths = await readdir(root, { recursive: true })
    vi.mocked(writeFile).mockClear().mockRejectedValue(new Error('Package disk unavailable'))
    await expect(library.saveCustom(input, false, catalog.revision)).rejects.toThrow('专家名称或标识已被使用')
    expect(writeFile).not.toHaveBeenCalled()
    expect(await readdir(root, { recursive: true })).toEqual(paths)
    expect(await library.catalog()).toEqual(catalog)
  },
)

it('does not clean an already moved staging path after installing a complete package', async () => {
  const { root, packages } = await fixture()
  vi.mocked(rm).mockRejectedValue(new Error('Cleanup unavailable'))
  const reference = await packages.save('order-expert', draft)
  expect(await packages.readFiles('order-expert', reference.packageSha256)).toEqual(expertPackageFiles('order-expert', draft))
  expect(await readdir(join(root, 'order-expert'))).toEqual([reference.packageSha256])
  expect(rm).not.toHaveBeenCalled()
})

it.each(['write', 'rename'] as const)('retains both the %s error and the failed staging cleanup without publishing a partial package', async (phase) => {
  const { root, packages } = await fixture()
  const failure = new Error(`${phase} unavailable`), cleanup = new Error('Cleanup unavailable')
  if (phase === 'write') vi.mocked(writeFile).mockRejectedValueOnce(failure)
  else vi.mocked(rename).mockRejectedValueOnce(failure)
  vi.mocked(rm).mockRejectedValueOnce(cleanup)
  const saving = packages.save('order-expert', draft)
  await expect(saving).rejects.toBeInstanceOf(AggregateError)
  await expect(saving).rejects.toMatchObject({ errors: [failure, cleanup], cause: failure })
  const paths = await readdir(join(root, 'order-expert'))
  expect(paths).toHaveLength(1)
  expect(paths[0]).toMatch(/^\.staging-/u)
  expect(rm).toHaveBeenCalledOnce()
})

it('converges simultaneous identical saves on one complete version and removes the losing staging directory', async () => {
  const { root, packages } = await fixture()
  const references = await Promise.all([packages.save('order-expert', draft), packages.save('order-expert', draft)])
  expect(references[1]).toEqual(references[0])
  expect(await readdir(join(root, 'order-expert'))).toEqual([references[0].packageSha256])
  expect(await packages.readFiles('order-expert', references[0].packageSha256)).toEqual(expertPackageFiles('order-expert', draft))
})
