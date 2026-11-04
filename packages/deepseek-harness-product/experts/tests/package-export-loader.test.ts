/** Complete AgentSpec exports retain the selected source and immutable company version. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Access from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { contentDigest } from '@deepseek-harness/product/company-content'
import type { CompanyContentSource } from '@deepseek-harness/product/protocol'
import { installCompanyContent } from '../../desktop/src/company-content.ts'
import { contentIndex, encoded, expertFiles, versionRef } from '../../product/tests/content-fixtures.ts'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Experts from '../src/index.ts'
import Remote from '../src/remote.ts'
import { ExpertPackageStore, expertPackageFiles } from '../src/expert-packages.ts'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, readFile: vi.fn(fs.readFile) }
})

async function fixture() {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'expert-export-loader-'))
  const ctx = new Context()
  const cleanup: Array<() => Promise<void>> = []
  onTestFinished(async () => {
    try { await Promise.all(cleanup.map(finish => finish())) }
    finally {
      try { await ctx.fiber.dispose() }
      finally {
        vi.mocked(readFile).mockImplementation(fs.readFile)
        await rm(root, { recursive: true, force: true })
      }
    }
  })
  const signal = new AbortController().signal
  const makeRelease = async (version: string, name: string) => {
    const files = { ...expertFiles('company-expert', name + ' {{literal}}'),
      'experts/company-expert/assets/中文模板.bin': Buffer.from([0, 128, 255]).toString('base64') }
    const ref = { ...versionRef('experts/company-expert', files), name, catalog: { division: 'engineering', avatar: '7' } }
    const all = { ...files, 'catalog.json': encoded(JSON.stringify(contentIndex(version, [ref]))) }
    const installed = await installCompanyContent(join(root, 'cache'), 'employee',
      { version, sha256: contentDigest(all), files: all }, signal)
    return { files, installed, catalog: { name, division: 'engineering', avatar: '7' } }
  }
  const first = await makeRelease('1.0.0', '公司专家旧版')
  const second = await makeRelease('2.0.0', '公司专家新版')
  const personal = { slug: 'personal-expert', name: '个人专家', description: '个人说明', division: 'specialized', avatar: 5,
    prompt: 'Personal instructions {{literal}}', agents: '', resources: { 'assets/个人模板.bin': encoded('Personal template') } }
  const packages = new ExpertPackageStore(async () => join(first.installed.expertsRoot, '..', '..', 'personal-experts'))
  const personalRef = await packages.save(personal.slug, personal)
  const { prompt: _prompt, agents: _agents, resources: _resources, ...personalMetadata } = personal
  let current = first.installed
  ctx.provide('companyContent', {
    read: async () => current, forSession: async () => current, refresh: async () => undefined,
  } satisfies CompanyContentSource)
  const localFiles = { ...expertFiles('local-expert', 'Local instructions {{literal}}'),
    'experts/local-expert/references/本地资料.md': encoded('Local reference') }
  for (const [path, bytes] of Object.entries(localFiles)) {
    const file = join(root, 'local', path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, Buffer.from(bytes, 'base64'))
  }
  ctx.provide('subagents', { getProvider: () => undefined })
  ctx.provide('settings', { configure: () => () => {}, describe: () => [{ ns: 'agency-agents', revision: 0 }] })
  ctx.provide('webServer', {})
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, prompt: SystemPrompt, tools: Tools,
    experts: Experts, remote: Remote, typert: Typert, access: Access, gateway: Gateway })
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify(['prompt', 'tools', 'typert', 'access', 'gateway', 'remote', 'experts']
    .map(name => ({ name: `cordis:${name}`, ...name === 'experts' ? { config: {
      root: join(root, 'local', 'experts'), personalContentClaimed: true,
      personalLibraries: { [createHash('sha256').update('employee').digest('hex')]: {
        enabled: [], customExperts: [{ ...personalMetadata, ...personalRef }],
      } },
    } } : {} }))))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  return { first, second, localFiles, personalFiles: expertPackageFiles(personal.slug, personal), fs, cleanup,
    update: () => { current = second.installed },
    invoke: (slug: string, requestSignal = signal) => ctx.typertGateway.invoke({ namespace: 'agencyAgents', method: 'exportExpert',
      args: { slug }, peer, signal: requestSignal }),
  }
}

it.each(['local', 'company', 'personal'] as const)('exports complete files from the selected %s source while all catalogs are installed', async (source) => {
  const { invoke, first, localFiles, personalFiles } = await fixture()
  const expected = {
    local: { files: localFiles, catalog: { name: 'local-expert', division: 'specialized', avatar: '0' } },
    company: { files: first.files, catalog: first.catalog },
    personal: { files: personalFiles, catalog: { name: '个人专家', division: 'specialized', avatar: '5' } },
  }
  expect(await invoke(source + '-expert')).toEqual({ resourceKey: 'experts/' + source + '-expert', ...expected[source] })
})

it.each(['refresh', 'cancel'] as const)('retains one export version across a company catalog %s during metadata reads', async (action) => {
  const { invoke, first, second, update, fs, cleanup } = await fixture()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let blocked = false
  vi.mocked(readFile).mockImplementation(async (...args) => {
    if (!blocked && args[0] === join(first.installed.expertsRoot, 'company-expert', 'manifest.json')) {
      blocked = true
      entered.resolve(undefined)
      await release.promise
    }
    return fs.readFile(...args)
  })
  const controller = new AbortController()
  const pending = invoke('company-expert', controller.signal)
  const outcome = pending.then(value => ({ value }), (error: unknown) => ({ error }))
  cleanup.push(async () => { release.resolve(undefined); await outcome })
  await entered.promise
  update()
  if (action === 'cancel') controller.abort(new Error('Export cancelled'))
  release.resolve(undefined)
  const result = await outcome
  if (action === 'cancel') expect(result).toHaveProperty('error')
  else expect(result).toEqual({ value: { resourceKey: 'experts/company-expert', files: first.files, catalog: first.catalog } })
  expect(await invoke('company-expert')).toEqual({ resourceKey: 'experts/company-expert', files: second.files, catalog: second.catalog })
})
