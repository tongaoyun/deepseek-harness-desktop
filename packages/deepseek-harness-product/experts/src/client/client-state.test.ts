/** Expert queries follow plugin ownership and committed-write ordering. */
import { expect, it, vi } from 'vitest'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CatalogSnapshot } from '../expert-contract.ts'
import type { TeamSnapshot } from '../team-contract.ts'
import { createExpertClientState } from './client-state.ts'
import type { AgencyCatalogRemote, AgencyTeamsRemote } from './remote.ts'

const catalog: CatalogSnapshot = { experts: [], enabled: [], revision: 2 }
const teams: TeamSnapshot = { teams: [], enabledTeams: [], enabledExperts: [], revision: 2 }
function fixture() {
  const getCatalog = vi.fn<AgencyCatalogRemote['getCatalog']>().mockResolvedValue({ ok: true, value: catalog })
  const getTeams = vi.fn<AgencyTeamsRemote['getTeams']>().mockResolvedValue({ ok: true, value: teams })
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected mutation'))
  const remote: AgencyCatalogRemote & Pick<AgencyTeamsRemote, 'getTeams'> = {
    getCatalog, getTeams, getCustomExpert: unused, saveCustomExpert: unused, deleteCustomExpert: unused,
  }
  return { remote, getCatalog, getTeams, ...createExpertClientState(remote) }
}

it('keeps separate plugin instances independent even when they use the same Remote', () => {
  const first = fixture()
  const second = createExpertClientState(first.remote)
  first.catalog.accept(catalog)
  first.teams.accept(teams)
  expect(second.catalog.getSnapshot().revision).toBe(-1)
  expect(second.teams.getSnapshot()).toBeNull()
})

it('coalesces explicit company refreshes and runs them even if the preceding local read fails', async () => {
  const state = fixture()
  const local = Promise.withResolvers<RemoteResult<CatalogSnapshot>>()
  state.getCatalog.mockReturnValueOnce(local.promise)
  const read = state.catalog.refresh()
  const rejected = expect(read).rejects.toThrow('Offline')
  const company = state.catalog.refresh(true)
  expect(state.catalog.refresh(true)).toBe(company)
  expect(state.catalog.refresh()).toBe(company)
  local.reject(new Error('Offline'))
  await rejected
  expect((await company).revision).toBe(2)
  expect(state.getCatalog.mock.calls).toEqual([[false, expect.any(AbortSignal)], [true, expect.any(AbortSignal)]])
})

it.each(['result', 'rejection'] as const)('a superseded team %s cannot hide a successful write', async (kind) => {
  const state = fixture()
  const reply = Promise.withResolvers<RemoteResult<TeamSnapshot>>()
  state.getTeams.mockReturnValueOnce(reply.promise)
  const read = state.teams.refresh()
  const saved = { ...teams, enabledTeams: ['new-team'], revision: 4 }
  state.teams.accept(saved)
  if (kind === 'result') reply.resolve({ ok: false, error: new RemoteError('gateway/internal', 'Old failure', {}) })
  else reply.reject(new Error('Old failure'))
  expect(await read).toEqual(saved)
  expect(state.teams.getSnapshot()).toEqual(saved)
})

it.each(['success', 'failure'] as const)('reset clears old Host data and fences late %s before accepting revision zero', async (kind) => {
  const state = fixture()
  const oldCatalog = Promise.withResolvers<RemoteResult<CatalogSnapshot>>()
  const oldTeams = Promise.withResolvers<RemoteResult<TeamSnapshot>>()
  state.catalog.accept(catalog)
  state.teams.accept(teams)
  state.getCatalog.mockReturnValueOnce(oldCatalog.promise)
  state.getTeams.mockReturnValueOnce(oldTeams.promise)
  const catalogRead = state.catalog.refresh()
  const teamsRead = state.teams.refresh()
  const catalogAborted = expect(catalogRead).rejects.toHaveProperty('name', 'AbortError')
  const teamsAborted = expect(teamsRead).rejects.toHaveProperty('name', 'AbortError')
  state.catalog.reset()
  state.teams.reset()
  expect(state.catalog.getSnapshot().revision).toBe(-1)
  expect(state.teams.getSnapshot()).toBeNull()
  state.getCatalog.mockResolvedValueOnce({ ok: true, value: { ...catalog, revision: 0 } })
  state.getTeams.mockResolvedValueOnce({ ok: true, value: { ...teams, revision: 0 } })
  await Promise.all([state.catalog.refresh(), state.teams.refresh()])
  if (kind === 'success') {
    oldCatalog.resolve({ ok: true, value: catalog })
    oldTeams.resolve({ ok: true, value: teams })
  } else {
    oldCatalog.reject(new Error('Disconnected'))
    oldTeams.reject(new Error('Disconnected'))
  }
  await Promise.all([catalogAborted, teamsAborted])
  expect(state.catalog.getSnapshot().revision).toBe(0)
  expect(state.teams.getSnapshot()?.revision).toBe(0)
})

it('contains observer failures and releases every subscription on disposal', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const state = fixture()
    const observeCatalog = vi.fn()
    const observeTeams = vi.fn()
    state.catalog.subscribe(() => { throw new Error('Broken observer') })
    state.catalog.subscribe(observeCatalog)
    state.teams.subscribe(() => { throw new Error('Broken observer') })
    state.teams.subscribe(observeTeams)
    state.catalog.accept(catalog)
    state.teams.accept(teams)
    expect(observeCatalog).toHaveBeenCalledTimes(1)
    expect(observeTeams).toHaveBeenCalledTimes(1)
    state.catalog.dispose()
    state.teams.dispose()
    state.catalog.reset()
    state.teams.reset()
    state.catalog.accept(catalog)
    expect(observeCatalog).toHaveBeenCalledTimes(1)
    expect(observeTeams).toHaveBeenCalledTimes(1)
    expect(() => state.teams.accept(teams)).toThrow()
    expect(() => state.catalog.refresh()).toThrow()
    expect(() => state.teams.refresh()).toThrow()
    expect(log).toHaveBeenCalledTimes(2)
  } finally { log.mockRestore() }
})

it('disposal fences pending reads and prevents starting new requests', async () => {
  const state = fixture()
  const reply = Promise.withResolvers<RemoteResult<CatalogSnapshot>>()
  state.getCatalog.mockReturnValueOnce(reply.promise)
  const read = state.catalog.refresh()
  const aborted = expect(read).rejects.toHaveProperty('name', 'AbortError')
  state.catalog.dispose()
  state.teams.dispose()
  reply.resolve({ ok: true, value: catalog })
  await aborted
  expect(state.catalog.getSnapshot().revision).toBe(-1)
  expect(() => state.catalog.refresh()).toThrow()
  expect(() => state.teams.refresh()).toThrow()
  expect(state.getCatalog).toHaveBeenCalledTimes(1)
  expect(state.getTeams).not.toHaveBeenCalled()
})

it('keeps structured Remote failures available to the caller', async () => {
  const state = fixture()
  const error = new RemoteError('gateway/internal', 'Offline', {})
  state.getCatalog.mockResolvedValueOnce({ ok: false, error })
  state.getTeams.mockResolvedValueOnce({ ok: false, error })
  await expect(state.catalog.refresh()).rejects.toBe(error)
  await expect(state.teams.refresh()).rejects.toBe(error)
})

it('cancels a company refresh queued for the previous Host without starting another request', async () => {
  const state = fixture()
  const reply = Promise.withResolvers<RemoteResult<CatalogSnapshot>>()
  state.getCatalog.mockReturnValueOnce(reply.promise)
  const read = state.catalog.refresh()
  const company = state.catalog.refresh(true)
  const aborted = [expect(read).rejects.toHaveProperty('name', 'AbortError'), expect(company).rejects.toHaveProperty('name', 'AbortError')]
  state.catalog.reset()
  reply.resolve({ ok: true, value: catalog })
  await Promise.all(aborted)
  expect(state.getCatalog.mock.calls).toEqual([[false, expect.any(AbortSignal)]])
  expect((await state.catalog.refresh()).revision).toBe(2)
})

it('replaces execution metadata from each complete Host receipt', async () => {
  const state = fixture()
  const engine: NonNullable<TeamSnapshot['engine']> = { state: 'enabled', mode: 'native', reason: 'Available', recommendation: '' }
  state.teams.accept({ ...teams, engine })
  state.teams.accept({ ...teams, revision: 3 })
  expect(state.teams.getSnapshot()?.engine).toBeUndefined()
  state.getTeams.mockResolvedValueOnce({ ok: true, value: { ...teams, revision: 3 } })
  await state.teams.refresh()
  expect(state.teams.getSnapshot()?.engine).toBeUndefined()
})
