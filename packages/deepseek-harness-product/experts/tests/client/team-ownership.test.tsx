// @vitest-environment jsdom
/** Expert-team views follow the native store and their current mounted operations. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createExpertClientState } from '../../src/client/client-state.ts'
import { TeamMenu } from '../../src/client/team-composer.tsx'
import { TeamsPanel, type TeamRemote } from '../../src/client/team-ui.tsx'
import { TEST_TEAMS } from '../../src/fixtures/teams.ts'
import type { TeamSnapshot } from '../../src/team-contract.ts'

const team = { ...TEST_TEAMS[0], name: 'Original team' }
const original: TeamSnapshot = { teams: [team], enabledTeams: [team.id],
  enabledExperts: team.members.map(member => member.expertSlug), revision: 1 }
const current: TeamSnapshot = { ...original, teams: [{ ...team, name: 'Current team' }], revision: 3 }

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function fixture() {
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected mutation'))
  const getTeams = vi.fn<TeamRemote['getTeams']>().mockResolvedValue({ ok: true, value: original })
  const setTeamEnabled = vi.fn<TeamRemote['setTeamEnabled']>().mockResolvedValue({ ok: true, value: original })
  const remote: TeamRemote = { getTeams, setTeamEnabled, getCatalog: async () => ({ ok: true,
    value: { experts: [], enabled: original.enabledExperts, revision: 1 } }), getCustomExpert: unused,
  saveCustomExpert: unused, deleteCustomExpert: unused, exportTeam: unused, saveTeam: unused, deleteTeam: unused }
  const cache = createExpertClientState(remote)
  cache.catalog.accept({ experts: team.members.map(member => ({ slug: member.expertSlug, name: member.expertSlug,
    nameEn: member.expertSlug, description: 'Review', descriptionEn: 'Review', division: 'engineering',
    divisionZh: '研发', emoji: '🔎', custom: false })), enabled: original.enabledExperts, revision: 1 })
  cache.teams.accept(original)
  return { remote, cache, getTeams, setTeamEnabled }
}

it('keeps the committed store snapshot when an earlier query continuation resumes', async () => {
  const value = fixture()
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['getTeams']>>>()
  value.getTeams.mockReturnValueOnce(response.promise)
  const query = value.cache.teams.refresh()
  const commit = query.then(() => value.cache.teams.accept(current))
  render(<TeamMenu {...value} onSelected={vi.fn()} />)
  await act(async () => { response.resolve({ ok: true, value: original }); await commit; await query })
  expect(value.cache.teams.getSnapshot()).toBe(current)
  expect(screen.queryByText('Original team')).toBeNull()
  expect(screen.getByText('Current team')).toBeTruthy()
})

it.each(['unmount', 'replace'] as const)('does not close a later menu when insertion finishes after %s', async (change) => {
  const value = fixture()
  const insertion = Promise.withResolvers<boolean>()
  const insert = vi.fn(() => insertion.promise)
  const onSelected = vi.fn()
  const menu = render(<TeamMenu {...value} prepareSelect={() => insert} onSelected={onSelected} />)
  const button = screen.getByText(team.name).closest('button')
  if (!button) throw new Error('Team choice missing')
  fireEvent.click(button)
  expect(insert).toHaveBeenCalledOnce()
  if (change === 'unmount') menu.unmount()
  else {
    const next = fixture()
    next.cache.teams.accept(current)
    next.getTeams.mockResolvedValue({ ok: true, value: current })
    menu.rerender(<TeamMenu {...next} prepareSelect={() => insert} onSelected={onSelected} />)
  }
  await act(async () => { insertion.resolve(true); await insertion.promise })
  expect(onSelected).not.toHaveBeenCalled()
})

it('does not render an outdated mutation receipt over a newer store commit', async () => {
  const value = fixture()
  const mutation = Promise.withResolvers<Awaited<ReturnType<TeamRemote['setTeamEnabled']>>>()
  value.setTeamEnabled.mockReturnValueOnce(mutation.promise)
  render(<TeamsPanel {...value} />)
  await act(async () => { await Promise.resolve() })
  fireEvent.click(screen.getByRole('switch'))
  expect(value.setTeamEnabled).toHaveBeenCalledOnce()
  act(() => { value.cache.teams.accept(current) })
  await act(async () => { mutation.resolve({ ok: true, value: { ...original, enabledTeams: [], revision: 2 } }); await mutation.promise })
  expect(value.cache.teams.getSnapshot()).toBe(current)
  expect(screen.queryByText('Original team')).toBeNull()
  expect(screen.getByText('Current team')).toBeTruthy()
  expect(screen.getByRole('switch')).toBeTruthy()
  expect({ name: screen.getByText('Current team').textContent, enabled: screen.getByRole('switch').getAttribute('aria-checked') })
    .toMatchInlineSnapshot(`
      {
        "enabled": "true",
        "name": "Current team",
      }
    `)
})

it.each(['unmount', 'replace'] as const)('does not publish a save from the previous panel after %s', async (change) => {
  const value = fixture()
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['saveTeam']>>>()
  const save = vi.fn<TeamRemote['saveTeam']>().mockReturnValue(response.promise)
  value.remote.saveTeam = save
  const onSaved = vi.fn()
  const panel = render(<TeamsPanel {...value} onSaved={onSaved} />)
  await act(async () => { await Promise.resolve() })
  fireEvent.click(screen.getByRole('button', { name: '编辑专家团' }))
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  expect(save).toHaveBeenCalledOnce()
  if (change === 'unmount') panel.unmount()
  else {
    const next = fixture()
    next.cache.teams.accept(current)
    next.getTeams.mockResolvedValue({ ok: true, value: current })
    panel.rerender(<TeamsPanel {...next} onSaved={onSaved} />)
  }
  await act(async () => { response.resolve({ ok: true, value: { ...original, revision: 2 } }); await response.promise })
  expect(onSaved).not.toHaveBeenCalled()
  expect(value.cache.teams.getSnapshot()?.revision).toBe(1)
})
