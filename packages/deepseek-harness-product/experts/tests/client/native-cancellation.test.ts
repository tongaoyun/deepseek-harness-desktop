/** Plugin-owned reads cancel through the native Client Remote and transport. */
import { Context } from '@deepseek-ai/cordis'
import Typert from '@deepseek-ai/dsh-typert-registry'
import * as ClientRemote from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createExpertClientState } from '../../src/client/client-state.ts'
import { TYPERT_REMOTE } from '../../src/client/remote.ts'

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Typert)
  type Reply = Awaited<ReturnType<ConnectionHandle['rpc']['call']>>
  const requests: { endpoint: string; signal: AbortSignal; resolve: (reply: Reply) => void }[] = []
  const call = vi.fn<ConnectionHandle['rpc']['call']>((_channel, endpoint, _payload, signal) => {
    if (!signal) throw new Error('Native Remote did not provide a transport signal')
    const reply = Promise.withResolvers<Reply>()
    const abort = () => { reply.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    requests.push({ endpoint, signal, resolve: reply.resolve })
    return reply.promise.finally(() => { signal.removeEventListener('abort', abort) })
  })
  ctx.provide('connection', {
    interactions: 'none', isLoopback: true,
    openWebSocket: () => { throw new Error('Unexpected WebSocket') },
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    reconnect: () => {}, rpc: { call, open: async function* () { throw new Error('Unexpected stream') } },
    registerGenerationSource: () => { throw new Error('Unexpected event source') },
    start: () => { throw new Error('Unexpected connection loop') },
  } satisfies ConnectionHandle)
  await ctx.plugin(ClientRemote)
  await ctx.remote.$mount(TYPERT_REMOTE)
  const state = createExpertClientState(ctx.remote.agencyAgents)
  onTestFinished(() => { state.catalog.dispose(); state.teams.dispose() })
  return { ...state, requests }
}

it.each(['reset', 'dispose'] as const)('%s cancels hanging shared reads and a queued company refresh', async (action) => {
  const state = await fixture()
  const catalog = state.catalog.refresh()
  const company = state.catalog.refresh(true)
  const teams = state.teams.refresh()
  expect(state.catalog.refresh(true)).toBe(company)
  expect(state.teams.refresh()).toBe(teams)
  expect(state.requests.map(request => request.endpoint)).toEqual(['agencyAgents/getCatalog', 'agencyAgents/getTeams'])
  const aborted = [catalog, company, teams].map(read => expect(read).rejects.toHaveProperty('name', 'AbortError'))
  state.catalog[action]()
  state.teams[action]()
  expect(state.requests.every(request => request.signal.aborted)).toBe(true)
  await Promise.all(aborted)
  expect(state.requests).toHaveLength(2)
  expect(state.catalog.getSnapshot().revision).toBe(-1)
  expect(state.teams.getSnapshot()).toBeNull()
  if (action === 'dispose') {
    expect(() => state.catalog.refresh()).toThrow()
    expect(() => state.teams.refresh()).toThrow()
    return
  }
  const nextCatalog = state.catalog.refresh()
  const nextTeams = state.teams.refresh()
  expect(state.requests.slice(2).every(request => !request.signal.aborted)).toBe(true)
  state.requests[2].resolve({ ok: true, value: { experts: [], enabled: [], revision: 0 } })
  state.requests[3].resolve({ ok: true, value: { teams: [], enabledTeams: [], enabledExperts: [], revision: 0 } })
  await Promise.all([nextCatalog, nextTeams])
  // Replies from the disconnected Host cannot republish its newer revision.
  state.requests[0].resolve({ ok: true, value: { experts: [], enabled: [], revision: 8 } })
  state.requests[1].resolve({ ok: true, value: { teams: [], enabledTeams: [], enabledExperts: [], revision: 8 } })
  expect(state.catalog.getSnapshot().revision).toBe(0)
  expect(state.teams.getSnapshot()?.revision).toBe(0)
})
