/** Company catalog teardown through a file-backed Loader and a delayed external bridge. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CompanyContent } from '../src/company-content.ts'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type { DeepSeekHarnessProductIpc } from '../src/deepseek-harness-product-ipc.ts'

const roots = { version: '1.0.0', sha256: 'a'.repeat(64), skillsRoot: '/skills', expertsRoot: '/experts' }

class FixtureSessionQuery extends SessionQueryEngine {
  override async searchSessions(): Promise<never> { throw new Error('Company content does not search Sessions') }
  override async searchEvents(): Promise<never> { throw new Error('Company content does not search events') }
}

async function fixture(bridge: Pick<DeepSeekHarnessProductIpc, 'invoke'>, settle = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'company-content-loader-'))
  vi.stubEnv('DSH_HOME', root)
  const ctx = new Context()
  onTestFinished(async () => {
    settle()
    try { await ctx.fiber.dispose() }
    finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
  })
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(FixtureSessionQuery)
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include,
    company: { name: 'company-fixture', apply: async (context: Context) => { await context.plugin(CompanyContent, bridge) } },
  })
  const file = join(root, 'cordis.yml')
  await writeFile(file, "- name: 'cordis:company'\n")
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const entry = [...ctx.loader.entries()].find(item => item.options.name === 'cordis:company')
  if (!entry?.fiber) throw new Error('Company fixture did not load')
  return { ctx, company: ctx.companyContent, fiber: entry.fiber }
}

it('joins catalog reads and refreshes on unload and rejects their late successes', async () => {
  const response = Promise.withResolvers<unknown>()
  const controls: AbortSignal[] = []
  const { ctx, company, fiber } = await fixture({
    invoke: async (_method, _payload, signal) => {
      if (!signal) throw new Error('Company catalog operation must have a lifetime')
      controls.push(signal)
      return response.promise
    },
  }, () => { response.resolve(undefined) })
  const read = expect(company.read()).rejects.toThrow('unloaded')
  const refresh = expect(company.refresh()).rejects.toThrow('unloaded')
  await vi.waitFor(() => { expect(controls).toHaveLength(2) })
  let closed = false
  const closing = fiber.dispose().then(() => { closed = true })
  await vi.waitFor(() => { expect(controls.every(signal => signal.aborted)).toBe(true) })
  expect(closed).toBe(false)
  response.resolve(roots)
  await Promise.all([read, refresh, closing])
  expect(closed).toBe(true)
  expect(ctx.get('companyContent')).toBeUndefined()
  await expect(company.read()).rejects.toThrow('unloaded')
  expect(controls).toHaveLength(2)
})

it('keeps a native Session observation for remaining readers and cancels it when the last reader leaves', async () => {
  const gate = Promise.withResolvers<undefined>()
  const invoke = vi.fn<DeepSeekHarnessProductIpc['invoke']>(async () => roots)
  const { ctx, company } = await fixture({ invoke }, () => { gate.resolve(undefined) })
  const sessionId = SessionId('shared-company-session')
  ctx.sessions.create(sessionId)
  const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
  let signal: AbortSignal | undefined
  vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementationOnce(async (id, options) => {
    signal = options?.signal
    await gate.promise
    return observe(id, options)
  })
  const first = new AbortController()
  const second = new AbortController()
  const firstRead = expect(company.forSession(sessionId, first.signal)).rejects.toThrow('First reader stopped')
  const secondRead = expect(company.forSession(sessionId, second.signal)).rejects.toThrow('Second reader stopped')
  await vi.waitFor(() => { expect(signal).toBeDefined() })
  first.abort(new Error('First reader stopped'))
  await firstRead
  expect(signal?.aborted).toBe(false)
  second.abort(new Error('Second reader stopped'))
  await secondRead
  expect(signal?.aborted).toBe(true)
  gate.resolve(undefined)
  await expect(company.forSession(sessionId)).resolves.toEqual(roots)
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(invoke.mock.calls[0]?.[1]).toEqual({ sessionId, started: false })
})

it.each(['observation', 'verification'] as const)(
  'joins pending company %s on Loader unload and rejects explicitly signalled readers', async (phase) => {
    const gate = Promise.withResolvers<undefined>()
    let signal: AbortSignal | undefined
    const invoke = vi.fn<DeepSeekHarnessProductIpc['invoke']>(async (_method, _payload, control) => {
      signal = control
      await gate.promise
      return roots
    })
    const { ctx, company, fiber } = await fixture({ invoke }, () => { gate.resolve(undefined) })
    const sessionId = SessionId('unloaded-company-session')
    ctx.sessions.create(sessionId)
    if (phase === 'observation') {
      const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
      vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementationOnce(async (id, options) => {
        signal = options?.signal
        await gate.promise
        return observe(id, options)
      })
    }
    const caller = new AbortController()
    const read = expect(company.forSession(sessionId, caller.signal)).rejects.toThrow('unloaded')
    await vi.waitFor(() => { expect(signal).toBeDefined() })
    let closed = false
    const closing = fiber.dispose().then(() => { closed = true })
    await vi.waitFor(() => { expect(signal?.aborted).toBe(true) })
    await read
    expect(caller.signal.aborted).toBe(false)
    expect(closed).toBe(false)
    gate.resolve(undefined)
    await closing
    expect(invoke).toHaveBeenCalledTimes(phase === 'observation' ? 0 : 1)
    await expect(company.forSession(sessionId, caller.signal)).rejects.toThrow('unloaded')
    expect({ phase, closed, callerCancelled: caller.signal.aborted,
      mainRequests: invoke.mock.calls.length, serviceAvailable: ctx.get('companyContent') !== undefined }).toMatchSnapshot()
  },
)
