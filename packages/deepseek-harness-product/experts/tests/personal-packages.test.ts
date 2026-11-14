/** Immutable packages, personal conversion and binary resource round trips. */
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Zip, ZipPassThrough, zipSync } from 'fflate'
import { importPackageFiles, addPackageResources, base64ByteLength, draftPackageFiles, downloadPackage } from '../src/client/package-files.ts'
import { contentDigest } from '@deepseek-harness/product/company-content'
import { ExpertPackageStore, expertPackageFiles } from '../src/expert-packages.ts'
import { importExpertPackage } from '../src/package-transfer.ts'
import { migratePersonalExperts } from '../src/personal-migration.ts'
import { readAgencySettings, personalSettingsDocument } from '../src/settings.ts'
import { customExpertInputSchema } from '../src/expert-contract.ts'
import { TEST_TEAMS } from '../src/fixtures/teams.ts'
import type { ExpertSettingsStore } from '../src/expert-library.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'expert-package-roundtrip-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return { root, packages: new ExpertPackageStore(async () => root) }
}
const draft = { slug: 'order-expert', name: '订单专家', description: '订单核对', division: 'orders',
  prompt: '\n  Keep {{literal}} unchanged. 中文 🧩\n', agents: 'Follow the employee’s task scope.\n',
  manifest: JSON.stringify({ worker: { suggested_name: 'order-expert' }, description: '订单核对', tags: ['订单'], model: { provider: 'retained-content-only' } }, null, 2),
  resources: { 'references/核对说明.md': Buffer.from('核对依据\n').toString('base64'), 'assets/订单模板.bin': Buffer.from([0, 1, 127, 128, 255]).toString('base64') } }

it.each((['bytes', 'files'] as const).flatMap(limit => [false, true].map(overflow => ({ limit, overflow }))))(
  'exports and reimports a complete package at the $limit limit; overflow=$overflow', async ({ limit, overflow }) => {
    const { agents: _agents, resources: _resources, ...base } = draft
    const overhead = Object.values(expertPackageFiles(draft.slug, base)).reduce((sum, encoded) => sum + base64ByteLength(encoded), 0)
    const resources = limit === 'bytes'
      ? { 'assets/中文模板.bin': Buffer.alloc(32 * 1024 * 1024 - overhead).toString('base64') }
      : Object.fromEntries(Array.from({ length: 2046 }, (_, index) => [`assets/template-${index}.bin`, 'AA==']))
    const input = { ...base, resources }
    const original = expertPackageFiles(draft.slug, input)
    const edited = overflow ? { ...input, ...(limit === 'bytes' ? { prompt: input.prompt + 'x' } : { agents: 'Optional rules' }) } : input
    const files = draftPackageFiles(edited)
    const anchor = { href: '', download: '', click: vi.fn() }
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:expert-package-test')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.stubGlobal('document', { createElement: () => anchor })
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.runOnlyPendingTimers(); vi.useRealTimers(); vi.unstubAllGlobals()
      create.mockRestore(); revoke.mockRestore()
    })
    if (overflow) {
      expect(() => expertPackageFiles(draft.slug, edited)).toThrow()
      expect(() => { downloadPackage(files) }).toThrow('custom.packageTooLarge')
      expect(create).not.toHaveBeenCalled()
      expect(anchor.click).not.toHaveBeenCalled()
    } else {
      downloadPackage(files)
      expect(anchor.click).toHaveBeenCalledOnce()
      expect(anchor.download).toBe(draft.slug + '.zip')
      const blob = create.mock.calls[0]?.[0]
      if (!(blob instanceof Blob)) throw new Error('Expected a complete ZIP download')
      const archive = new File([await blob.arrayBuffer()], anchor.download)
      expect(await importPackageFiles([archive], new AbortController().signal)).toEqual(original)
      vi.runOnlyPendingTimers()
      expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:expert-package-test')
    }
  }, 10_000,
)

it.each(['prompt', 'agents'] as const)('round trips %s at the UTF-8 byte limit and rejects one additional byte', async (field) => {
  const text = '中'.repeat(43_690) + 'ab'
  expect(Buffer.byteLength(text)).toBe(128 * 1024)
  const input = { ...draft, [field]: text }
  const expected = expertPackageFiles(draft.slug, input)
  expect(draftPackageFiles(input)).toEqual(expected)
  const { packages } = await fixture()
  const reference = await packages.save(draft.slug, input)
  expect(await packages.readFiles(draft.slug, reference.packageSha256)).toEqual(expected)
  const oversized = { ...input, [field]: text + 'x' }
  expect(customExpertInputSchema.safeParse(oversized).success).toBe(false)
  expect(() => expertPackageFiles(draft.slug, oversized)).toThrow()
  expect(() => draftPackageFiles(oversized)).toThrow('custom.instructionsInvalid')
  const attachment = new File(['template'], 'template.txt')
  const read = vi.spyOn(attachment, 'arrayBuffer')
  await expect(addPackageResources(oversized, [attachment], new AbortController().signal))
    .rejects.toMatchObject({ key: 'custom.instructionsInvalid' })
  expect(read).not.toHaveBeenCalled()
})

it.each(['prompt', 'agents'] as const)('rejects NUL in %s without altering valid binary resources', (field) => {
  const input = { ...draft, [field]: 'instructions\0hidden' }
  expect(customExpertInputSchema.safeParse(input).success).toBe(false)
  expect(() => expertPackageFiles(draft.slug, input)).toThrow()
  expect(() => draftPackageFiles(input)).toThrow('custom.instructionsInvalid')
  expect(Buffer.from(draftPackageFiles(draft)['experts/order-expert/assets/订单模板.bin'], 'base64'))
    .toEqual(Buffer.from([0, 1, 127, 128, 255]))
})

it('rejects manifest metadata that exceeds its UTF-8 limit before encoding a draft package', () => {
  const input = { ...draft, manifest: JSON.stringify({ ...JSON.parse(draft.manifest), note: '中'.repeat(44_000) }) }
  expect(input.manifest.length).toBeLessThan(128 * 1024)
  expect(Buffer.byteLength(input.manifest)).toBeGreaterThan(128 * 1024)
  expect(customExpertInputSchema.safeParse(input).success).toBe(false)
  expect(() => expertPackageFiles(draft.slug, input)).toThrow()
  expect(() => draftPackageFiles(input)).toThrow('custom.packageInvalid')
})

it.each(['zip', 'json', 'utf8'] as const)('reports a damaged %s package with a stable validation key', async (kind) => {
  const content = kind === 'utf8' ? new Uint8Array([0xff]) : new TextEncoder().encode('{broken manifest')
  const bytes = kind === 'zip' ? new Uint8Array([0, 1, 2]) : zipSync({ 'manifest.json': content })
  const importing = importPackageFiles([new File([new Uint8Array(bytes)], 'expert.zip')], new AbortController().signal)
  await expect(importing).rejects.toMatchObject({ key: 'custom.packageInvalid' })
  await expect(importing).rejects.toHaveProperty('cause')
})

it.each([2048, 2049])('applies the same complete-package file limit to a ZIP containing %i files', async (count) => {
  const entries: Record<string, Uint8Array> = {
    'expert/manifest.json': new TextEncoder().encode(JSON.stringify({ worker: { suggested_name: 'expert' } })),
    'expert/config/SOUL.md': new TextEncoder().encode('Review the evidence.'),
  }
  for (let index = 2; index < count; index++) entries[`expert/assets/${index}.txt`] = new Uint8Array()
  const zip = new File([new Uint8Array(zipSync(entries))], 'expert.zip')
  const importing = importPackageFiles([zip], new AbortController().signal)
  if (count === 2048) expect(Object.keys(await importing)).toHaveLength(count)
  else await expect(importing).rejects.toMatchObject({ key: 'custom.packageTooLarge' })
})

it('preserves literal instructions, manifest fields, Unicode filenames and binary bytes across import and immutable export', async () => {
  const { root, packages } = await fixture()
  const files = expertPackageFiles('order-expert', draft)
  const imported = importExpertPackage(files)
  const ref = await packages.save('order-expert', imported)
  expect(ref.packageSha256).toBe(contentDigest(files))
  expect(await packages.readFiles('order-expert', ref.packageSha256)).toEqual(files)
  const read = await packages.read({ ...draft, emoji: '🧩', avatar: 0, ...ref })
  expect(read.prompt).toBe(draft.prompt)
  expect(read.manifest).toBe(draft.manifest)
  expect(read.resources).toEqual(draft.resources)
  expect(await packages.prompt({ ...draft, emoji: '🧩', avatar: 0, ...ref })).toContain(draft.prompt)
  const source = join(root, 'order-expert', ref.packageSha256, 'config/SOUL.md')
  await writeFile(source, 'Changed outside the editor')
  await expect(packages.readFiles('order-expert', ref.packageSha256)).rejects.toThrow()
})

it.each([
  { name: 'long Unicode text', description: '  ' + '核对中文资料与业务依据'.repeat(18) + '  ' },
  { name: 'whitespace at truncation', description: 'Read orders '.repeat(30) },
  { name: 'short padded text', description: '  Short description  ' },
])('preserves a full AgentSpec description until the imported display summary is explicitly edited: $name', async ({ description }) => {
  const { packages } = await fixture()
  const manifest = JSON.stringify({ ...JSON.parse(draft.manifest), description }, null, 2)
  const files = { ...expertPackageFiles('order-expert', draft), 'experts/order-expert/manifest.json': Buffer.from(manifest).toString('base64') }
  const imported = importExpertPackage(files)
  expect(imported.description).toBe(description.trim().slice(0, 160).trim())
  expect(draftPackageFiles(imported)).toEqual(files)
  const ref = await packages.save('order-expert', imported)
  expect(await packages.readFiles('order-expert', ref.packageSha256)).toEqual(files)
  const edited = { ...imported, description: '更新后的简介' }
  const updated = expertPackageFiles('order-expert', edited)
  expect(draftPackageFiles(edited)).toEqual(updated)
  expect(JSON.parse(Buffer.from(updated['experts/order-expert/manifest.json'], 'base64').toString())).toEqual({ ...JSON.parse(manifest), description: edited.description })
})

it.each(['directories-first', 'directories-last'] as const)('imports a complete ZIP and selected directory with identical Chinese names and binary templates: %s', async (order) => {
  const files = expertPackageFiles('order-expert', draft)
  const entries = Object.fromEntries(Object.entries(files).map(([path, encoded]) => [path.replace('experts/', ''), new Uint8Array(Buffer.from(encoded, 'base64'))]))
  const directories = Object.fromEntries(['order-expert/', 'order-expert/config/', 'order-expert/references/', 'order-expert/assets/']
    .map(path => [path, new Uint8Array()]))
  const archive = order === 'directories-first' ? { ...directories, ...entries } : { ...entries, ...directories }
  const zip = new File([new Uint8Array(zipSync(archive))], 'order-expert.zip')
  const list = (files: File[]) => Object.assign(files, { item: (index: number) => files[index] ?? null })
  expect(await importPackageFiles(list([zip]), new AbortController().signal)).toEqual(files)
  const directory = Object.entries(entries).map(([path, bytes]) => {
    const file = new File([new Uint8Array(bytes)], path.split('/').at(-1)!)
    Object.defineProperty(file, 'webkitRelativePath', { value: path })
    return file
  })
  expect(await importPackageFiles(list(directory), new AbortController().signal)).toEqual(files)
})

it.each([
  { directory: 'order-expert/References/', file: 'order-expert/references/核对说明.md' },
  { directory: 'order-expert/assets/template/', file: 'order-expert/assets/template' },
  { directory: 'order-expert/CON/' },
  { directory: 'order-expert/../' },
  { directory: 'order-expert/assets/目录 /' },
])('rejects unsafe or conflicting explicit ZIP directories: $directory', async ({ directory, file }) => {
  const entries = Object.entries(expertPackageFiles('order-expert', draft)).map(([path, encoded]) =>
    [path.replace('experts/', ''), new Uint8Array(Buffer.from(encoded, 'base64'))] as const)
  if (file) entries.push([file, new Uint8Array([0, 255])])
  for (const order of ['directory-first', 'directory-last']) {
    const explicit = [directory, new Uint8Array()] as const
    const archive = Object.fromEntries(order === 'directory-first' ? [explicit, ...entries] : [...entries, explicit])
    await expect(importPackageFiles([new File([new Uint8Array(zipSync(archive))], 'expert.zip')],
      new AbortController().signal)).rejects.toMatchObject({ key: 'custom.packageInvalid' })
  }
})

it.each(['zip', 'directory'] as const)('does not silently drop a root resource named __proto__ during %s import', async (kind) => {
  const files = { ...expertPackageFiles('order-expert', draft), 'experts/order-expert/__proto__': 'AAE=' }
  const entries = Object.fromEntries(Object.entries(files).map(([path, value]) =>
    [path.slice('experts/order-expert/'.length), new Uint8Array(Buffer.from(value, 'base64'))]))
  if (kind === 'zip') {
    const chunks: Uint8Array<ArrayBuffer>[] = []
    const archive = new Zip((error, chunk) => {
      if (error) throw error
      chunks.push(new Uint8Array(chunk))
    })
    for (const [path, bytes] of Object.entries(entries)) {
      const file = new ZipPassThrough(path)
      archive.add(file); file.push(bytes, true)
    }
    archive.end()
    await expect(importPackageFiles([new File(chunks, 'expert.zip')],
      new AbortController().signal)).rejects.toThrow('custom.packageInvalid')
  } else {
    const selection = Object.entries(entries).map(([path, bytes]) => new File([new Uint8Array(bytes)], path))
    expect(await importPackageFiles(selection, new AbortController().signal)).toEqual(files)
  }
})

it.each([
  '订单?.md', 'template*.xlsx', '"模板".txt', '<订单>.md', '订单|库存.md', 'template.xlsx ', 'NUL.txt', 'file.',
])('rejects a nonportable attachment batch before reading or changing the draft: %s', async (name) => {
  const input = structuredClone(draft)
  const selection = [new File(['valid'], 'first.txt'), new File(['invalid'], name)]
  const reads = selection.map(file => vi.spyOn(file, 'arrayBuffer'))
  await expect(addPackageResources(input, selection, new AbortController().signal)).rejects.toThrow('custom.packageInvalid')
  for (const read of reads) expect(read).not.toHaveBeenCalled()
  expect(input).toEqual(draft)
})

it.each(['references/订单?.md', 'assets/目录 /模板.xlsx', 'assets/目录*/说明.md', 'assets/template.xlsx '])(
  'rejects nonportable resources during ZIP import, directory import and personal save: %s', async (path) => {
    const { root, packages } = await fixture()
    const input = { ...draft, resources: { ...draft.resources, [path]: 'AA==' } }
    await expect(packages.save('order-expert', input)).rejects.toThrow('非法路径')
    expect(await readdir(root)).toEqual([])
    const files = { ...expertPackageFiles('order-expert', draft), [`experts/order-expert/${path}`]: 'AA==' }
    const entries = Object.fromEntries(Object.entries(files).map(([name, value]) =>
      [name.slice('experts/'.length), new Uint8Array(Buffer.from(value, 'base64'))]))
    await expect(importPackageFiles([new File([new Uint8Array(zipSync(entries))], 'order-expert.zip')],
      new AbortController().signal)).rejects.toThrow('custom.packageInvalid')
    const selection = Object.entries(entries).map(([name, bytes]) => {
      const file = new File([new Uint8Array(bytes)], name.split('/').at(-1)!)
      Object.defineProperty(file, 'webkitRelativePath', { value: name })
      return file
    })
    const reads = selection.map(file => vi.spyOn(file, 'arrayBuffer'))
    await expect(importPackageFiles(selection, new AbortController().signal)).rejects.toThrow('custom.packageInvalid')
    for (const read of reads) expect(read).not.toHaveBeenCalled()
  },
)

it.each(['订单 模板.xlsx', 'caf\u00e9.xlsx', 'cafe\u0301.xlsx'])('round trips an unambiguous attachment through immutable personal storage: %s', async (name) => {
  const { packages } = await fixture()
  const resources = await addPackageResources(draft, [new File([new Uint8Array([0, 255])], name)],
    new AbortController().signal)
  const input = { ...draft, resources }
  const ref = await packages.save('order-expert', input)
  expect(await packages.readFiles('order-expert', ref.packageSha256)).toEqual(expertPackageFiles('order-expert', input))
})

it.each(['.package-index.json', '.PACKAGE-INDEX.JSON', '.package-index.json/one.txt', '.PACKAGE-INDEX.JSON/one.txt'])(
  'rejects attachments shadowing private package metadata before creating a version: %s', async (path) => {
    const { root, packages } = await fixture()
    await expect(packages.save(draft.slug, { ...draft, resources: { ...draft.resources, [path]: 'AA==' } }))
      .rejects.toThrow('附件路径与专家说明冲突')
    expect(await readdir(root)).toEqual([])
  },
)

it.each(['same-name', 'case-alias', 'oversized-shadowed'] as const)(
  'rejects ambiguous attachment selections before reading either file: %s', async (kind) => {
    const first = new File(['first'], 'template.bin')
    if (kind === 'oversized-shadowed') Object.defineProperty(first, 'size', { value: 32 * 1024 * 1024 })
    const second = new File(['second'], kind === 'case-alias' ? 'Template.bin' : first.name)
    const reads = [first, second].map(file => vi.spyOn(file, 'arrayBuffer'))
    const input = structuredClone(draft)
    await expect(addPackageResources(input, [first, second], new AbortController().signal)).rejects.toThrow('custom.packageInvalid')
    for (const read of reads) expect(read).not.toHaveBeenCalled()
    expect(input).toEqual(draft)
  },
)

it.each([
  { name: 'templates', path: 'assets/templates/订单.xlsx' },
  { name: 'templates', path: 'assets/Templates/订单.xlsx' },
  { name: 'a'.repeat(225) + '.bin', path: 'references/说明.md' },
])('rejects attachments that cannot coexist in the complete package: $path / $name', async ({ name, path }) => {
  const input = { ...draft, resources: { ...draft.resources, [path]: 'AA==' } }
  const before = structuredClone(input)
  const file = new File(['replacement'], name), read = vi.spyOn(file, 'arrayBuffer')
  await expect(addPackageResources(input, [file], new AbortController().signal)).rejects.toThrow('custom.packageInvalid')
  expect(read).not.toHaveBeenCalled()
  expect(input).toEqual(before)
})

it.each(['file-directory', 'directory-case'] as const)('rejects conflicting directory selections before reading any file: %s', async (kind) => {
  const paths = kind === 'file-directory' ? ['order-expert/assets/templates', 'order-expert/assets/templates/订单.xlsx']
    : ['order-expert/assets/Templates/first.xlsx', 'order-expert/assets/templates/second.xlsx']
  const files = paths.map((path) => {
    const file = new File(['unused'], path.split('/').at(-1)!)
    Object.defineProperty(file, 'webkitRelativePath', { value: path })
    return file
  })
  const reads = files.map(file => vi.spyOn(file, 'arrayBuffer'))
  await expect(importPackageFiles(files, new AbortController().signal)).rejects.toThrow('custom.packageInvalid')
  for (const read of reads) expect(read).not.toHaveBeenCalled()
})

const conflictingPackages: readonly { name: string; resources: Record<string, string>; beforeRead: boolean }[] = [
  { name: 'Unicode directory aliases', resources: { 'assets/caf\u00e9/one.txt': 'AA==', 'assets/cafe\u0301/two.txt': 'AQ==' }, beforeRead: true },
  { name: 'private index file alias', resources: { '.PACKAGE-INDEX.JSON': 'AA==' }, beforeRead: false },
  { name: 'private index directory alias', resources: { '.PACKAGE-INDEX.JSON/one.txt': 'AA==' }, beforeRead: false },
]
it.each(conflictingPackages.flatMap(value => (['zip', 'directory'] as const).map(kind => ({ ...value, kind }))))(
  'rejects $name before importing or saving an expert package via $kind', async ({ kind, resources, beforeRead }) => {
    const { root, packages } = await fixture()
    const input = { ...draft, resources: { ...draft.resources, ...resources } }
    const files = { ...expertPackageFiles(draft.slug, draft),
      ...Object.fromEntries(Object.entries(input.resources).map(([path, value]) => [`experts/${draft.slug}/${path}`, value])) }
    const entries = Object.fromEntries(Object.entries(files).map(([path, value]) =>
      [path.slice('experts/'.length), new Uint8Array(Buffer.from(value, 'base64'))]))
    const selection = kind === 'zip' ? [new File([new Uint8Array(zipSync(entries))], 'order-expert.zip')]
      : Object.entries(entries).map(([path, value]) => {
        const file = new File([new Uint8Array(value)], path.split('/').at(-1)!)
        Object.defineProperty(file, 'webkitRelativePath', { value: path })
        return file
      })
    const reads = selection.map(file => vi.spyOn(file, 'arrayBuffer'))
    await expect(importPackageFiles(selection, new AbortController().signal)).rejects.toThrow('custom.packageInvalid')
    if (kind === 'directory' && beforeRead) for (const read of reads) expect(read).not.toHaveBeenCalled()
    await expect(packages.save(draft.slug, input)).rejects.toThrow()
    expect(await readdir(root)).toEqual([])
  },
)

it.each(['zip', 'directory'] as const)('keeps nested template manifests as resources during %s import', async (kind) => {
  const { packages } = await fixture()
  const input = { ...draft, resources: { ...draft.resources,
    'assets/项目模板/manifest.json': Buffer.from('{"template":true}').toString('base64'),
    'references/示例/manifest.json': Buffer.from(draft.manifest).toString('base64'),
  } }
  const files = expertPackageFiles('order-expert', input)
  const entries = Object.fromEntries(Object.entries(files).map(([path, value]) =>
    [path.slice('experts/'.length), new Uint8Array(Buffer.from(value, 'base64'))]))
  const selection = kind === 'zip' ? [new File([new Uint8Array(zipSync(entries))], 'order-expert.zip')]
    : Object.entries(entries).map(([path, value]) => {
      const file = new File([new Uint8Array(value)], path.split('/').at(-1)!)
      Object.defineProperty(file, 'webkitRelativePath', { value: path })
      return file
    })
  const imported = importExpertPackage(await importPackageFiles(selection, new AbortController().signal))
  expect(imported.resources).toEqual(input.resources)
  const ref = await packages.save('order-expert', imported)
  expect(await packages.readFiles('order-expert', ref.packageSha256)).toEqual(files)
  expect(ref.packageSha256).toBe(contentDigest(files))
})

it('rejects sibling AgentSpec packages instead of choosing one and dropping files', async () => {
  const files = { ...expertPackageFiles('order-expert', draft),
    ...expertPackageFiles('another-expert', { ...draft, manifest: undefined }) }
  const entries = Object.fromEntries(Object.entries(files).map(([path, value]) =>
    [path.slice('experts/'.length), new Uint8Array(Buffer.from(value, 'base64'))]))
  await expect(importPackageFiles([new File([new Uint8Array(zipSync(entries))], 'experts.zip')],
    new AbortController().signal)).rejects.toThrow('custom.packageInvalid')
})

it.each([undefined, ''])('preserves absent and empty AGENTS.md separately across a saved package round trip: %s', async (agents) => {
  const { packages } = await fixture()
  const files = expertPackageFiles('order-expert', draft)
  if (agents === undefined) delete files['experts/order-expert/config/AGENTS.md']
  else files['experts/order-expert/config/AGENTS.md'] = ''
  const imported = importExpertPackage(files)
  const ref = await packages.save('order-expert', imported)
  const read = await packages.read({ slug: draft.slug, name: draft.name, description: draft.description,
    division: draft.division, emoji: '🧩', avatar: 0, ...ref })
  expect(read.agents).toBe(agents)
  expect(expertPackageFiles('order-expert', read)).toEqual(files)
  expect(draftPackageFiles(read)).toEqual(files)
  expect(ref.packageSha256).toBe(contentDigest(files))
})

it('rejects symbolic links while reading a fixed personal resource version', async () => {
  const { root, packages } = await fixture()
  const ref = await packages.save('order-expert', draft)
  const source = join(root, 'order-expert', ref.packageSha256, 'assets/订单模板.bin')
  const outside = join(root, 'outside.bin')
  await writeFile(outside, 'private')
  await rm(source); await symlink(outside, source)
  await expect(packages.readFiles('order-expert', ref.packageSha256)).rejects.toThrow()
})

it.each(['file', 'directory', 'link', 'duplicate-index'] as const)(
  'rejects an unrecorded personal package change without altering the saved version: %s', async (change) => {
    const { root, packages } = await fixture()
    const ref = await packages.save('order-expert', draft)
    const directory = join(root, 'order-expert', ref.packageSha256)
    const index = join(directory, '.package-index.json')
    if (change === 'file') await writeFile(join(directory, 'references/unrecorded.md'), 'Unrecorded instructions')
    else if (change === 'directory') await mkdir(join(directory, 'references/unrecorded'))
    else if (change === 'link') await symlink(root, join(directory, 'references/unrecorded'), 'dir')
    else {
      const entries: unknown = JSON.parse(await readFile(index, 'utf8'))
      if (!Array.isArray(entries) || !entries.every((entry: unknown): entry is string => typeof entry === 'string')) {
        throw new Error('Saved package index must contain file paths')
      }
      await writeFile(index, JSON.stringify([...entries, entries[0]]))
    }
    const savedIndex = await readFile(index, 'utf8')
    await expect(packages.readFiles('order-expert', ref.packageSha256)).rejects.toThrow()
    await expect(packages.prompt({ ...draft, ...ref, emoji: '🧩', avatar: 0 })).rejects.toThrow()
    expect(await readFile(index, 'utf8')).toBe(savedIndex)
    expect(await readFile(join(directory, 'config/SOUL.md'), 'utf8')).toBe(draft.prompt)
  },
)

it('rejects a linked expert directory even when all indexed bytes match the fixed version', async () => {
  const { root, packages } = await fixture()
  const ref = await packages.save('order-expert', draft)
  const original = join(root, 'order-expert'), moved = join(root, 'moved')
  await rename(original, moved)
  await symlink(moved, original, 'dir')
  await expect(packages.readFiles('order-expert', ref.packageSha256)).rejects.toThrow()
  expect(await readFile(join(moved, ref.packageSha256, 'config/SOUL.md'), 'utf8')).toBe(draft.prompt)
})

it('converts personal experts once and marks unavailable company members for reselection without changing their identity', async () => {
  const { packages } = await fixture()
  const { manifest: _manifest, ...old } = draft
  let state = readAgencySettings({ enabled: ['order-expert'], customExperts: [old], customTeams: [{ ...TEST_TEAMS[0], members: [
    { expertSlug: 'order-expert', duty: 'Orders', instructions: 'Review orders' },
    { expertSlug: 'retired-company-expert', duty: 'Review', instructions: 'Review evidence' },
  ] }] })
  let revision = 3
  const mutate = vi.fn<ExpertSettingsStore['mutate']>(async (ops, expected) => {
    expect(expected).toBe(revision)
    for (const op of ops) if (op.op === 'set') state = { ...state, [op.path[0]]: op.value }
    revision++
  })
  const store = { read: () => state, revision: () => revision, mutate }
  await migratePersonalExperts(store, packages)
  expect(state.customExperts?.[0]).not.toHaveProperty('prompt')
  const members = state.customTeams![0].members
  expect(members[0].expertSha256).toBe(state.customExperts![0].packageSha256)
  expect(members[1]).toMatchObject({ expertSlug: 'retired-company-expert', expertVersion: 'reselect-required' })
  const persisted = personalSettingsDocument(state)
  expect(persisted).toHaveProperty('customTeams.0.schemaVersion', 1)
  expect(readAgencySettings(persisted)).toEqual(state)
  await migratePersonalExperts(store, packages)
  expect(mutate).toHaveBeenCalledOnce()
})

it('does not replace Settings references after a concurrent conversion conflict', async () => {
  const { packages } = await fixture()
  const state = readAgencySettings({ enabled: [], customExperts: [draft] })
  const before = structuredClone(state)
  const store: ExpertSettingsStore = { read: () => state, revision: () => 1, mutate: async () => { throw new Error('Revision conflict') } }
  await expect(migratePersonalExperts(store, packages)).rejects.toThrow('Revision conflict')
  expect(state).toEqual(before)
})


it('replaces a binary attachment at the exact file-count limit and accounts for base64 padding', async () => {
  const resources = Object.fromEntries(Array.from({ length: 2045 }, (_, index) => [`assets/template-${index}.bin`, 'AA==']))
  const input = { ...draft, resources }
  const next = await addPackageResources(input, [new File([new Uint8Array([128, 255])], 'template-0.bin')], new AbortController().signal)
  expect(next['assets/template-0.bin']).toBe('gP8=')
  expect(Object.keys(draftPackageFiles({ ...input, resources: next }))).toHaveLength(2048)
  expect(base64ByteLength('AA==')).toBe(1)
  expect(base64ByteLength(next['assets/template-0.bin'])).toBe(2)
  await expect(addPackageResources(input, [new File(['x'], 'extra.txt')], new AbortController().signal)).rejects.toThrow('custom.packageTooLarge')
  expect(input.resources['assets/template-0.bin']).toBe('AA==')
})

it('counts attachment replacements against the expert root when templates contain manifests', async () => {
  const input = { ...draft, resources: { 'assets/project/manifest.json': Buffer.from('{}').toString('base64'),
    ...Object.fromEntries(Array.from({ length: 2044 }, (_, index) => [`assets/template-${index}.bin`, 'AA=='])) } }
  const resources = await addPackageResources(input, [new File(['replacement'], 'template-0.bin')], new AbortController().signal)
  expect(Object.keys(draftPackageFiles({ ...input, resources }))).toHaveLength(2048)
  expect(resources['assets/template-0.bin']).toBe(Buffer.from('replacement').toString('base64'))
  expect(resources['assets/project/manifest.json']).toBe(input.resources['assets/project/manifest.json'])
})

it('rejects oversized and conflicting attachments before reading and cancels partial reads without changing the draft', async () => {
  const oversized = new File([], 'large.bin')
  Object.defineProperty(oversized, 'size', { value: 32 * 1024 * 1024 })
  const read = vi.spyOn(oversized, 'arrayBuffer')
  await expect(addPackageResources(draft, [oversized], new AbortController().signal)).rejects.toThrow('custom.packageTooLarge')
  expect(read).not.toHaveBeenCalled()
  await expect(addPackageResources(draft, [new File(['x'], '订单模板.BIN')], new AbortController().signal)).rejects.toThrow('custom.packageInvalid')
  const controller = new AbortController()
  const file = new File(['first'], 'first.txt')
  vi.spyOn(file, 'arrayBuffer').mockImplementation(async () => { controller.abort(new Error('Editor closed')); return new ArrayBuffer(0) })
  const original = structuredClone(draft)
  await expect(addPackageResources(draft, [file], controller.signal)).rejects.toThrow('Editor closed')
  expect(draft).toEqual(original)
})


it.each(['expert.zip', 'SOUL.md'])('does not read a cancelled package selection: %s', async (name) => {
  const controller = new AbortController()
  controller.abort(new Error('Editor closed'))
  const file = new File(['unused'], name)
  const read = vi.spyOn(file, 'arrayBuffer')
  await expect(importPackageFiles([file], controller.signal)).rejects.toThrow('Editor closed')
  expect(read).not.toHaveBeenCalled()
})

it('stops a directory import after the current read when its owner cancels', async () => {
  const controller = new AbortController()
  const pending = Promise.withResolvers<ArrayBuffer>()
  const first = new File(['first'], 'manifest.json')
  vi.spyOn(first, 'arrayBuffer').mockReturnValue(pending.promise)
  const second = new File(['second'], 'SOUL.md')
  const next = vi.spyOn(second, 'arrayBuffer')
  const result = importPackageFiles([first, second], controller.signal)
  const rejected = expect(result).rejects.toThrow('Employee changed')
  controller.abort(new Error('Employee changed'))
  pending.resolve(new ArrayBuffer(0))
  await rejected
  expect(next).not.toHaveBeenCalled()
})

it('does not unpack a ZIP after cancellation during its file read', async () => {
  const controller = new AbortController()
  const pending = Promise.withResolvers<ArrayBuffer>()
  const zip = new File(['unused'], 'expert.zip')
  vi.spyOn(zip, 'arrayBuffer').mockReturnValue(pending.promise)
  const result = importPackageFiles([zip], controller.signal)
  const rejected = expect(result).rejects.toThrow('Editor closed')
  controller.abort(new Error('Editor closed'))
  pending.resolve(new ArrayBuffer(0))
  await rejected
})

it.each(['oversized', 'case-collision', 'unsafe-path'])('validates the complete directory before reading files: %s', async (kind) => {
  const first = new File(['first'], 'manifest.json')
  const second = new File([], kind === 'case-collision' ? 'MANIFEST.JSON' : kind === 'unsafe-path' ? '../outside' : 'large.bin')
  if (kind === 'oversized') Object.defineProperty(second, 'size', { value: 32 * 1024 * 1024 })
  const reads = [first, second].map(file => vi.spyOn(file, 'arrayBuffer'))
  await expect(importPackageFiles([first, second], new AbortController().signal)).rejects.toThrow('custom.package')
  for (const read of reads) expect(read).not.toHaveBeenCalled()
})
