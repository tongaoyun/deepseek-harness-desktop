/** Immutable packages, personal conversion and binary resource round trips. */
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zipSync } from 'fflate'
import { importPackageFiles, addPackageResources, base64ByteLength, draftPackageFiles } from '../src/client/package-files.ts'
import { contentDigest } from '@deepseek-harness/product/company-content'
import { ExpertPackageStore, expertPackageFiles } from '../src/expert-packages.ts'
import { importExpertPackage } from '../src/package-transfer.ts'
import { migratePersonalExperts } from '../src/personal-migration.ts'
import { readAgencySettings, personalSettingsDocument } from '../src/settings.ts'
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

it('imports a complete ZIP and selected directory with identical Chinese names and binary templates', async () => {
  const files = expertPackageFiles('order-expert', draft)
  const entries = Object.fromEntries(Object.entries(files).map(([path, encoded]) => [path.replace('experts/', ''), new Uint8Array(Buffer.from(encoded, 'base64'))]))
  const zip = new File([new Uint8Array(zipSync(entries))], 'order-expert.zip')
  const list = (files: File[]) => Object.assign(files, { item: (index: number) => files[index] ?? null })
  expect(await importPackageFiles(list([zip]))).toEqual(files)
  const directory = Object.entries(entries).map(([path, bytes]) => {
    const file = new File([new Uint8Array(bytes)], path.split('/').at(-1)!)
    Object.defineProperty(file, 'webkitRelativePath', { value: path })
    return file
  })
  expect(await importPackageFiles(list(directory))).toEqual(files)
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
