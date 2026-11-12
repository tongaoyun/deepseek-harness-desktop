/** Personal teams retain their exact company expert package across catalog updates. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { CompanyContentSync } from '../../desktop/src/company-content-sync.ts'
import { contentIndex, encoded, expertFiles, versionRef } from '../../product/tests/content-fixtures.ts'
import * as Experts from '../src/index.ts'
import type { AgencyPersonaSource } from '../src/index.ts'

it('reads a personal team’s pinned company instructions and resources after the company publishes a new version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinned-company-expert-'))
  const ctx = new Context()
  const original = { ...expertFiles('orders', 'Original {{literal}}. Read references/订单.md.'),
    'experts/orders/references/订单.md': encoded('Original reference'),
    'experts/orders/assets/template.bin': Buffer.from([0, 255]).toString('base64') }
  const updated = expertFiles('orders', 'Updated instructions')
  const oldRef = versionRef('experts/orders', original), nextRef = versionRef('experts/orders', updated)
  let current = contentIndex('1.0.0', [oldRef])
  const sync = new CompanyContentSync({ root: join(root, 'cache'), employeeId: 'employee', refreshIntervalMs: 0,
    load: async () => current,
    loadResource: async ref => ({ ...ref, files: ref.sha256 === oldRef.sha256 ? original : updated }) })
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { await sync.close(); await rm(root, { recursive: true, force: true }) }
  })
  await sync.prepare()
  await sync.refresh()
  current = contentIndex('2.0.0', [nextRef])
  await sync.refresh()
  ctx.provide('companyContent', { read: async () => sync.read(), refresh: () => sync.refresh(),
    forSession: (sessionId: string, signal?: AbortSignal) => sync.pin({ sessionId, started: false }, signal),
    expertVersion: (slug: string, sha256: string, signal?: AbortSignal) => sync.expertVersion(slug, sha256, signal) })
  ctx.provide('subagents', { getProvider: () => undefined })
  ctx.provide('settings', { configure: () => () => {}, describe: () => [{ ns: 'agency-agents', revision: 0 }] })
  ctx.provide('webServer', {})
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, prompt: SystemPrompt, tools: Tools, experts: Experts })
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify(['prompt', 'tools', 'experts'].map(name => ({ name: `cordis:${name}`,
    ...name === 'experts' ? { config: { divisions: [], personalContentClaimed: true,
      personalLibraries: { [createHash('sha256').update('employee').digest('hex')]: { enabled: ['orders'] } } } } : {} }))))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const personas = ctx.get(Experts.AGENCY_PERSONA_SERVICE) as AgencyPersonaSource | undefined
  if (!personas) throw new Error('Expert persona source did not load')
  const signal = new AbortController().signal
  const pinned = await personas.getPrompt('orders', 'specialized', 'en', 'new-task', signal, oldRef.sha256)
  expect(pinned.prompt).toContain('Original {{literal}}')
  expect(pinned.prompt).not.toContain('Updated instructions')
  const resourceRoot = await sync.expertVersion('orders', oldRef.sha256, signal)
  expect(pinned.prompt).toContain(resourceRoot)
  expect(await readFile(join(resourceRoot, 'references/订单.md'), 'utf8')).toBe('Original reference')
  expect(await readFile(join(resourceRoot, 'assets/template.bin'))).toEqual(Buffer.from([0, 255]))
  expect((await personas.getPrompt('orders', 'specialized', 'en', 'new-task', signal)).prompt).toContain('Updated instructions')
  expect(sync.read().version).toBe('2.0.0')
  expect({ pinnedInstructions: pinned.prompt.includes('Original {{literal}}'),
    latestInstructions: (await personas.getPrompt('orders', 'specialized', 'en', 'new-task', signal)).prompt.includes('Updated instructions'),
    reference: await readFile(join(resourceRoot, 'references/订单.md'), 'utf8'),
    templateBytes: [...await readFile(join(resourceRoot, 'assets/template.bin'))],
    catalogVersion: sync.read().version }).toMatchInlineSnapshot(`
      {
        "catalogVersion": "2.0.0",
        "latestInstructions": true,
        "pinnedInstructions": true,
        "reference": "Original reference",
        "templateBytes": [
          0,
          255,
        ],
      }
    `)
})
