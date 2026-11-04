import { teamFixture } from '../../product/tests/content-fixtures.ts'
import { createHash } from 'node:crypto'
/** Filesystem failures must not publish or permanently poison the company's expert catalog. */
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
import { installCompanyContent, restoreCompanyContent } from '../../desktop/src/company-content.ts'
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Experts from '../src/index.ts'
import Remote from '../src/remote.ts'
import { AGENCY_LIBRARY_SERVICE, type AgencyExpertLibrary } from '../src/expert-library.ts'
import { catalogSnapshotSchema } from '../src/expert-contract.ts'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, readdir: vi.fn(fs.readdir), open: vi.fn(fs.open), readFile: vi.fn(fs.readFile) }
})

it.each(['root', 'metadata', 'team'] as const)('recovers the same company release after a %s I/O failure without returning a partial catalog', async (operation) => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'expert-catalog-loader-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally {
      vi.mocked(readdir).mockImplementation(fs.readdir)
      vi.mocked(open).mockImplementation(fs.open)
      vi.mocked(readFile).mockImplementation(fs.readFile)
      await rm(root, { recursive: true, force: true })
    }
  })
  const { files } = await teamFixture()
  const signal = new AbortController().signal
  const cache = join(root, 'cache')
  const installed = await installCompanyContent(cache, 'employee', { version: '1.0.0', sha256: contentDigest(files), files }, signal)
  const refresh = vi.fn(async () => { await restoreCompanyContent(cache, 'employee', installed.version, installed.sha256, signal) })
  ctx.provide('companyContent', {
    read: async () => installed, forSession: async () => installed, refresh,
  } satisfies CompanyContentSource)
  ctx.provide('subagents', { getProvider: () => undefined })
  ctx.provide('settings', { configure: () => () => {}, describe: () => [{ ns: 'agency-agents', revision: 0 }] })
  ctx.provide('webServer', {})
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, prompt: SystemPrompt, tools: Tools,
    experts: Experts, remote: Remote, typert: Typert, access: Access, gateway: Gateway })
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify(['prompt', 'tools', 'typert', 'access', 'gateway', 'remote', 'experts']
    .map(name => ({ name: `cordis:${name}`, ...name === 'experts' ? { config: { divisions: [], personalContentClaimed: true, personalLibraries: { [createHash('sha256').update('employee').digest('hex')]: { enabled: [] } } } } : {} }))))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const invoke = (refreshCompany: boolean) => ctx.typertGateway.invoke({ namespace: 'agencyAgents', method: 'getCatalog',
    args: { refreshCompany }, peer, signal })
  const failure = Object.assign(new Error('Private employee catalog path'), { code: 'EIO' })
  let failing = true
  const directory = installed.expertsRoot
  vi.mocked(readdir).mockImplementation(async (...args) => {
    if (failing && operation === 'root' && args[0] === directory) throw failure
    return fs.readdir(...args)
  })
  vi.mocked(open).mockImplementation(async (...args) => {
    if (failing && operation === 'metadata' && args[0] === join(installed.expertsRoot, 'member-1/manifest.json')) throw failure
    return fs.open(...args)
  })
  vi.mocked(readFile).mockImplementation(async (...args) => {
    if (failing && (operation === 'team' && args[0] === join(installed.expertsRoot, '../teams/orders.json') || operation === 'metadata' && args[0] === join(installed.expertsRoot, 'member-1/manifest.json'))) throw failure
    return fs.readFile(...args)
  })

  const first = await invoke(false).then(() => undefined, (error: unknown) => error)
  expect.soft(first).toBeInstanceOf(Error)
  const library = ctx.get(AGENCY_LIBRARY_SERVICE) as AgencyExpertLibrary | undefined
  if (!library) throw new Error('Expert library did not load')
  await expect.soft(library.catalog()).rejects.toMatchObject({ code: 'CATALOG_READ_FAILED', cause: failure })
  failing = false
  const recovered = catalogSnapshotSchema.parse(await invoke(true))
  expect(recovered.experts.filter(value => !value.teamMember).map(value => value.slug).sort()).toEqual(['member-1', 'member-2'])
  const members = recovered.experts.filter(value => value.teamMember)
  expect(members).toHaveLength(2)
  expect(new Set(members.map(value => value.slug)).size).toBe(2)
  expect(members.every(value => /^team-member-[a-f0-9]{64}$/u.test(value.slug))).toBe(true)
  expect(refresh).toHaveBeenCalledOnce()
  expect(first instanceof Error ? first.message : 'Unexpected catalog success').toMatchInlineSnapshot('"Could not read the expert catalog. Refresh and try again."')
  failing = true
  expect(catalogSnapshotSchema.parse(await invoke(false))).toEqual(recovered)
  const entry = [...ctx.loader.entries()].find(value => value.options.name === 'cordis:experts')
  if (!entry?.fiber) throw new Error('Expert plugin did not load')
  await entry.fiber.dispose()
  expect(ctx.get(AGENCY_LIBRARY_SERVICE)).toBeUndefined()
  expect(ctx.tools.get('list_experts')).toBeUndefined()
})
