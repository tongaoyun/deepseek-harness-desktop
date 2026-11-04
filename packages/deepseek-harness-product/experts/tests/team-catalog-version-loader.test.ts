/** Team snapshots use experts and team definitions from one immutable company release. */
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
import { contentIndex, encoded, teamFixture, versionRef } from '../../product/tests/content-fixtures.ts'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import * as Experts from '../src/index.ts'
import Remote from '../src/remote.ts'
import { readCompanyTeams } from '../src/company-teams.ts'

it.each(['refresh', 'cancel', 'failure'] as const)('keeps team definitions and enabled members coherent across a company %s', async (action) => {
  const root = await mkdtemp(join(tmpdir(), 'team-catalog-version-'))
  const ctx = new Context()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const requests: Promise<unknown>[] = []
  onTestFinished(async () => {
    release.resolve(undefined)
    try { await Promise.all(requests) }
    finally {
      try { await ctx.fiber.dispose() }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  const signal = new AbortController().signal
  const install = async (version: string, id: string) => {
    const value = await teamFixture(version, 'Literal instructions {{literal}} ' + version)
    const files = { ...value.files }
    delete files['teams/orders.json']
    const document = { ...value.document, id }
    const teamFiles = { [`teams/${id}.json`]: encoded(JSON.stringify(document)) }
    const experts = value.index.resources.filter(ref => ref.resourceKey.startsWith('experts/'))
    const team = versionRef('teams/' + id, teamFiles, Object.fromEntries(experts.map(ref => [ref.resourceKey, ref.sha256])))
    Object.assign(files, teamFiles, { 'catalog.json': encoded(JSON.stringify(contentIndex(version, [...experts, team], experts))) })
    const installed = await installCompanyContent(join(root, 'cache'), 'employee',
      { version, sha256: contentDigest(files), files }, signal)
    const shared = await readCompanyTeams(installed.expertsRoot)
    return { installed, shared }
  }
  const first = await install('1.0.0', 'orders'), second = await install('2.0.0', 'shipping')
  let current = first.installed, armed = false, blocked = false
  ctx.provide('companyContent', {
    read: async () => {
      const captured = current
      if (armed && !blocked) {
        blocked = true
        entered.resolve(undefined)
        await release.promise
        if (action === 'failure') throw Object.assign(new Error('Content source unavailable'), { code: 'EIO' })
      }
      return captured
    },
    forSession: async () => current, refresh: async () => undefined,
  } satisfies CompanyContentSource)
  ctx.provide('subagents', { getProvider: () => undefined })
  ctx.provide('settings', { configure: () => () => {}, describe: () => [{ ns: 'agency-agents', revision: 0 }] })
  ctx.provide('webServer', {})
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, prompt: SystemPrompt, tools: Tools,
    experts: Experts, remote: Remote, typert: Typert, access: Access, gateway: Gateway })
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify(['prompt', 'tools', 'typert', 'access', 'gateway', 'remote', 'experts']
    .map(name => ({ name: `cordis:${name}`, ...name === 'experts' ? { config: { personalContentClaimed: true,
      personalLibraries: { [createHash('sha256').update('employee').digest('hex')]: {
        enabled: [...first.shared.experts.keys(), ...second.shared.experts.keys()],
        enabledTeams: [first.shared.teams[0].id, second.shared.teams[0].id],
      } },
    } } : {} }))))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const invoke = (requestSignal = signal) => ctx.typertGateway.invoke({ namespace: 'agencyAgents', method: 'getTeams',
    args: {}, peer, signal: requestSignal })
  const expected = (shared: typeof first.shared) => ({ teams: shared.teams, enabledExperts: [...shared.experts.keys()], revision: 0 })
  expect(await invoke()).toMatchObject(expected(first.shared))
  armed = true
  const controller = new AbortController()
  const pending = invoke(controller.signal)
  const outcome = pending.then(value => ({ value }), (error: unknown) => ({ error }))
  requests.push(outcome)
  await entered.promise
  current = second.installed
  if (action === 'cancel') controller.abort(new Error('Team catalog cancelled'))
  release.resolve(undefined)
  const result = await outcome
  if (action === 'refresh') expect(result).toMatchObject({ value: expected(first.shared) })
  else expect(result).toHaveProperty('error')
  expect(await invoke()).toMatchObject(expected(second.shared))
})
