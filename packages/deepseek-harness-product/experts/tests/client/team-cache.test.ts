/** Mutation receipts preserve concurrent company-directory updates. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { ExpertTeams } from '../../src/client/team-cache.ts'
import type { AgencyTeamsRemote } from '../../src/client/remote.ts'
import { TEST_TEAMS } from '../../src/fixtures/teams.ts'
import type { TeamSnapshot } from '../../src/team-contract.ts'

const original: TeamSnapshot = { teams: [TEST_TEAMS[0]], enabledTeams: [], enabledExperts: [], revision: 1 }
const receipt: TeamSnapshot = { ...original, enabledTeams: [TEST_TEAMS[0].id], revision: 2 }
const updated: TeamSnapshot = { ...receipt, teams: [{ ...TEST_TEAMS[0], name: 'Updated company team' }] }

function fixture() {
  const getTeams = vi.fn<AgencyTeamsRemote['getTeams']>().mockResolvedValue({ ok: true, value: updated })
  const teams = new ExpertTeams({ getTeams })
  onTestFinished(() => { teams.dispose() })
  teams.accept(original)
  return { teams, getTeams }
}

it('accepts a receipt without rereading when its request-start snapshot is still current', async () => {
  const { teams, getTeams } = fixture()
  const pending = Promise.withResolvers<Awaited<ReturnType<AgencyTeamsRemote['getTeams']>>>()
  getTeams.mockReturnValueOnce(pending.promise)
  const reading = teams.refresh()
  expect(await teams.acceptMutation(receipt, original)).toBe(receipt)
  expect(getTeams).toHaveBeenCalledOnce()
  pending.resolve({ ok: true, value: original })
  expect(await reading).toBe(receipt)
  expect(teams.getSnapshot()).toBe(receipt)
})

it.each([2, 3])('preserves a changed directory at revision %s without rereading', async (revision) => {
  const { teams, getTeams } = fixture()
  const current = teams.accept({ ...updated, revision })
  expect(await teams.acceptMutation(receipt, original)).toBe(current)
  expect(teams.getSnapshot()).toBe(current)
  expect(getTeams).not.toHaveBeenCalled()
})

it.each(['before', 'after'] as const)('rereads a changed directory with a lower revision when an older query finishes %s the new read', async (order) => {
  const { teams, getTeams } = fixture()
  teams.accept({ ...updated, revision: 1 })
  const stale = Promise.withResolvers<Awaited<ReturnType<AgencyTeamsRemote['getTeams']>>>()
  const fresh = Promise.withResolvers<Awaited<ReturnType<AgencyTeamsRemote['getTeams']>>>()
  getTeams.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
  const reading = teams.refresh()
  const accepting = teams.acceptMutation(receipt, original)
  expect(getTeams).toHaveBeenCalledTimes(2)
  if (order === 'before') {
    stale.resolve({ ok: true, value: original })
    await reading
    expect(teams.getSnapshot()?.teams[0].name).toBe('Updated company team')
  }
  fresh.resolve({ ok: true, value: updated })
  expect(await accepting).toBe(updated)
  if (order === 'after') {
    stale.resolve({ ok: true, value: original })
    expect(await reading).toBe(updated)
  }
  expect(teams.getSnapshot()).toBe(updated)
})

it('preserves the known directory on a failed post-commit read and allows retry', async () => {
  const { teams, getTeams } = fixture()
  const current = teams.accept({ ...updated, revision: 1 })
  getTeams.mockRejectedValueOnce(new Error('Directory unavailable'))
  await expect(teams.acceptMutation(receipt, original)).rejects.toThrow('Directory unavailable')
  expect(teams.getSnapshot()).toBe(current)
  expect(await teams.refresh()).toBe(updated)
  expect(getTeams).toHaveBeenCalledTimes(2)
})
