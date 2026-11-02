// @vitest-environment jsdom
/** Expert picker keyboard ownership follows the native modal layer. */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import { AgentsButton } from '../../src/client/index.ts'
import { createExpertClientState } from '../../src/client/client-state.ts'
import { zh } from '../../src/client/locales.ts'
import { TEST_TEAMS } from '../../src/fixtures/teams.ts'

afterEach(cleanup)

async function fixture() {
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected mutation'))
  const team = TEST_TEAMS[0]
  const catalog = { experts: [], enabled: [], revision: 1 }
  const teams = { teams: [team], enabledTeams: [team.id], enabledExperts: [], revision: 1 }
  const remote: React.ComponentProps<typeof AgentsButton>['remote'] = {
    getCatalog: async () => ({ ok: true, value: catalog }),
    getTeams: async () => ({ ok: true, value: teams }),
    setEnabled: unused, getPrompt: unused, getCustomExpert: unused,
    saveCustomExpert: unused, deleteCustomExpert: unused,
    exportTeam: unused, saveTeam: unused, deleteTeam: unused, setTeamEnabled: unused,
  }
  const cache = createExpertClientState(remote)
  onTestFinished(() => { cache.catalog.dispose(); cache.teams.dispose() })
  cache.catalog.accept(catalog); cache.teams.accept(teams)
  const dictionary: Readonly<Record<string, string>> = zh
  render(<><AgentsButton remote={remote} cache={cache} getActive={() => 'zh'} t={key => dictionary[key] ?? key} /><button>Outside</button></>)
  const trigger = screen.getByRole('button', { name: zh['settings.nav'] })
  trigger.focus()
  await act(async () => { fireEvent.click(trigger); await cache.catalog.refresh() })
  return { trigger, cache, team }
}

it.each([
  { name: 'Control', ctrlKey: true }, { name: 'Alt', altKey: true },
  { name: 'Meta', metaKey: true }, { name: 'Shift', shiftKey: true }, { name: 'repeat', repeat: true },
])('preserves the expert picker on $name Escape and restores its trigger on plain Escape', async (key) => {
  const { trigger } = await fixture()
  const search = screen.getByRole('searchbox')
  expect(document.activeElement).toBe(search)
  fireEvent.keyDown(search, { key: 'Escape', ...key })
  expect(screen.queryByRole('dialog')).not.toBeNull()
  fireEvent.keyDown(search, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('keeps composition and its closing Escape inside the expert search', async () => {
  await fixture()
  const search = screen.getByRole('searchbox')
  fireEvent.compositionStart(search)
  fireEvent.keyDown(search, { key: 'Escape', isComposing: false })
  expect(screen.queryByRole('dialog')).not.toBeNull()
  fireEvent.compositionEnd(search)
  fireEvent.keyDown(search, { key: 'Escape', isComposing: false })
  expect(screen.queryByRole('dialog')).not.toBeNull()
  fireEvent.keyUp(search, { key: 'Escape' })
  fireEvent.keyDown(search, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps Tab inside the expert picker', async () => {
  await fixture()
  const picker = screen.getByRole('dialog')
  const first = within(picker).getByRole('tab', { name: '专家' })
  first.focus()
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
  expect(document.activeElement).toBe(first)
})

it('preserves the picker when nested team details consume Escape', async () => {
  const { trigger, cache, team } = await fixture()
  const picker = screen.getByRole('dialog')
  await act(async () => { fireEvent.click(within(picker).getByRole('tab', { name: '专家团' })); await cache.teams.refresh() })
  expect(document.activeElement).toBe(screen.getByRole('textbox'))
  fireEvent.click(screen.getByRole('button', { name: `查看${team.name}详情` }))
  const details = screen.getAllByRole('dialog').find(dialog => dialog !== picker)
  if (!details) throw new Error('Expected team details')
  fireEvent.keyDown(details, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBe(picker)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('returns pointer-opened selection focus to the invoking composer', async () => {
  const { trigger, cache } = await fixture()
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
  const composer = render(<input aria-label="Composer" />).getByRole('textbox')
  composer.focus()
  expect(fireEvent.mouseDown(trigger)).toBe(false)
  await act(async () => { fireEvent.click(trigger); await cache.catalog.refresh() })
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
  expect(document.activeElement).toBe(composer)
})
