// @vitest-environment jsdom
/** Expert picker read waiters, selections and keyboard ownership follow their mounted lifetime. */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { AgentsButton, buildExpertMentionLexicon } from '../../src/client/index.ts'
import { createExpertClientState } from '../../src/client/client-state.ts'
import { zh } from '../../src/client/locales.ts'
import { TEST_TEAMS } from '../../src/fixtures/teams.ts'

afterEach(cleanup)

it.each([false, true])('keeps a failed expert choice stable through a locked retry with inserted=%s', async (inserted) => {
  const { trigger, cache, remote, view, dictionary } = await fixture(false)
  const catalog = { experts: [reviewer], enabled: [], revision: 1 }
  cache.catalog.accept(catalog)
  const read = vi.spyOn(remote, 'getCatalog').mockResolvedValue({ ok: true, value: catalog })
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.setEnabled>>>()
  const write = vi.spyOn(remote, 'setEnabled').mockRejectedValueOnce(new Error('Enable unavailable')).mockReturnValueOnce(pending.promise)
  const insert = vi.fn(() => inserted)
  view.rerender(<AgentsButton remote={remote} cache={cache} insertReference={insert} getActive={() => 'zh'} t={key => dictionary[key] ?? key} />)
  onTestFinished(() => { pending.resolve({ ok: true, value: { enabled: [reviewer.slug], revision: 2 } }) })
  await act(async () => { fireEvent.click(trigger); await cache.catalog.refresh() })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'reviewer' } })
  const choice = screen.getByRole<HTMLButtonElement>('button', { name: /评审专家/ })
  await act(async () => { fireEvent.click(choice) })
  const notice = await screen.findByRole('alert')
  choice.focus()
  await act(async () => { choice.click(); choice.click() })
  expect(write).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.getByRole('button', { name: /评审专家/ })).toBe(choice)
  expect(choice.disabled).toBe(false)
  expect(choice.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(choice)
  expect(screen.queryByRole('status')).toBeNull()
  expect({ error: notice.textContent, choice: choice.textContent, unavailable: choice.getAttribute('aria-disabled') }).toMatchSnapshot()
  await act(async () => { pending.resolve({ ok: true, value: { enabled: [reviewer.slug], revision: 2 } }) })
  expect(insert).toHaveBeenCalledOnce()
  if (!inserted) {
    expect(screen.getByRole('button', { name: /评审专家/ })).toBe(choice)
    expect(choice.getAttribute('aria-disabled')).toBe('false')
  } else {
    expect(screen.queryByRole('dialog')).toBeNull()
    const reopen = Promise.withResolvers<Awaited<ReturnType<typeof remote.getCatalog>>>()
    read.mockReturnValueOnce(reopen.promise)
    fireEvent.click(trigger)
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { reopen.resolve({ ok: true, value: { ...catalog, enabled: [reviewer.slug], revision: 2 } }) })
  }
})

async function fixture(open = true) {
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected mutation'))
  const team = TEST_TEAMS[0]
  const catalog = { experts: [], enabled: [], revision: 1 }
  const teams = { teams: [team], enabledTeams: [team.id], enabledExperts: [], revision: 1 }
  const remote: React.ComponentProps<typeof AgentsButton>['remote'] = {
    getCatalog: async () => ({ ok: true, value: catalog }),
    getTeams: async () => ({ ok: true, value: teams }),
    setEnabled: unused, getPrompt: unused, importExpert: async () => { throw new Error('Unexpected package import') }, exportExpert: async () => { throw new Error('Unexpected package export') }, getCustomExpert: unused,
    saveCustomExpert: unused, deleteCustomExpert: unused,
    exportTeam: unused, saveTeam: unused, deleteTeam: unused, setTeamEnabled: unused,
  }
  const cache = createExpertClientState(remote)
  onTestFinished(() => { cache.catalog.dispose(); cache.teams.dispose() })
  cache.catalog.accept(catalog); cache.teams.accept(teams)
  const dictionary: Readonly<Record<string, string>> = zh
  const view = render(<><AgentsButton remote={remote} cache={cache} getActive={() => 'zh'} t={key => dictionary[key] ?? key} /><button>Outside</button></>)
  const trigger = screen.getByRole('button', { name: zh['settings.nav'] })
  trigger.focus()
  if (open) await act(async () => { fireEvent.click(trigger); await cache.catalog.refresh() })
  return { trigger, cache, team, remote, view, dictionary }
}

it('reopens a dismissed picker during the shared catalog read and reports its current failure', async () => {
  const { trigger, cache, remote } = await fixture(false)
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.getCatalog>>>()
  const read = vi.spyOn(remote, 'getCatalog').mockReturnValue(pending.promise)
  onTestFinished(async () => {
    pending.resolve({ ok: true, value: { experts: [], enabled: [], revision: 1 } })
    await pending.promise.catch(() => undefined)
  })
  fireEvent.click(trigger)
  expect(screen.getByRole('dialog')).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(trigger)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(read).toHaveBeenCalledOnce()
  await act(async () => { pending.reject(new Error('Catalog unavailable')); await pending.promise.catch(() => undefined) })
  expect(screen.getByRole('alert').textContent).toContain('Catalog unavailable')
  expect({ expanded: trigger.getAttribute('aria-expanded'), notice: screen.getByRole('alert').textContent,
    retryDisabled: screen.getByRole<HTMLButtonElement>('button', { name: zh['btn.refresh'] }).disabled }).toMatchInlineSnapshot(`
    {
      "expanded": "true",
      "notice": "Catalog unavailable刷新",
      "retryDisabled": false,
    }
  `)
  read.mockResolvedValue({ ok: true, value: { experts: [], enabled: [], revision: 2 } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['btn.refresh'] })); await cache.catalog.refresh() })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(read).toHaveBeenCalledTimes(2)
})

it.each([false, true])('returns recovered expert directory focus to search only when its refresh owns focus (elsewhere=%s)', async (elsewhere) => {
  const { trigger, cache, remote, view } = await fixture(false)
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.getCatalog>>>()
  const read = vi.spyOn(remote, 'getCatalog').mockRejectedValueOnce(new Error('Directory unavailable')).mockReturnValueOnce(pending.promise)
  onTestFinished(() => { view.unmount(); pending.resolve({ ok: true, value: { experts: [], enabled: [], revision: 2 } }) })
  await act(async () => { fireEvent.click(trigger) })
  await screen.findByRole('alert')
  const refresh = screen.getByRole<HTMLButtonElement>('button', { name: zh['btn.refresh'] })
  const search = screen.getByRole('searchbox')
  const tab = screen.getByRole('tab', { name: '专家团' })
  refresh.focus()
  act(() => { refresh.click(); refresh.click() })
  expect(read).toHaveBeenCalledTimes(2)
  expect(document.activeElement).toBe(refresh)
  if (elsewhere) tab.focus()
  await act(async () => { pending.resolve({ ok: true, value: { experts: [], enabled: [], revision: 2 } }) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(document.activeElement).toBe(elsewhere ? tab : search)
  expect(cache.catalog.getSnapshot().revision).toBe(2)
})

const reviewer = { slug: 'reviewer', name: '评审专家', nameEn: 'Reviewer', description: '检查代码',
  descriptionEn: 'Review code', emoji: '🔎', division: 'engineering', divisionZh: '研发', custom: false }

it.each((['removed', 'disabled'] as const).flatMap(change => [false, true].map(elsewhere => ({ change, elsewhere }))))(
  'returns a vanished expert choice to search without taking another control (change=$change, elsewhere=$elsewhere)', async ({ change, elsewhere }) => {
    const { trigger, cache, remote } = await fixture(false)
    const write = vi.spyOn(remote, 'setEnabled')
    const catalog = { experts: [reviewer], enabled: [reviewer.slug], revision: 1 }
    cache.catalog.accept(catalog)
    vi.spyOn(remote, 'getCatalog').mockResolvedValue({ ok: true, value: catalog })
    await act(async () => { fireEvent.click(trigger); await cache.catalog.refresh() })
    const search = screen.getByRole<HTMLInputElement>('searchbox')
    const query = change === 'removed' ? 'reviewer' : ''
    fireEvent.change(search, { target: { value: query } })
    search.setSelectionRange(1, 3)
    const selection = [search.selectionStart, search.selectionEnd]
    const choice = screen.getByRole('button', { name: reviewer.name })
    const other = screen.getByRole('tab', { name: '专家团' })
    act(() => { choice.focus() })
    if (elsewhere) other.focus()
    act(() => { cache.catalog.accept({ ...catalog, experts: change === 'removed' ? [] : catalog.experts, enabled: [], revision: 2 }) })
    expect(choice.isConnected).toBe(false)
    expect(document.activeElement).toBe(elsewhere ? other : search)
    expect(screen.getByRole('searchbox')).toBe(search)
    expect(search.value).toBe(query)
    expect([search.selectionStart, search.selectionEnd]).toEqual(selection)
    expect(write).not.toHaveBeenCalled()
  },
)

it.each([false, true])('keeps an expert choice and its focus when its category changes (elsewhere=%s)', async (elsewhere) => {
  const { trigger, cache, remote } = await fixture(false)
  const catalog = { experts: [reviewer], enabled: [reviewer.slug], revision: 1 }
  cache.catalog.accept(catalog)
  vi.spyOn(remote, 'getCatalog').mockResolvedValue({ ok: true, value: catalog })
  await act(async () => { fireEvent.click(trigger); await cache.catalog.refresh() })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: 'reviewer' } })
  search.setSelectionRange(1, 3)
  const choice = screen.getByRole('button', { name: reviewer.name })
  const other = screen.getByRole('tab', { name: '专家团' })
  act(() => { choice.focus() })
  if (elsewhere) other.focus()
  act(() => { cache.catalog.accept({ ...catalog, experts: [{ ...reviewer, division: 'specialized', divisionZh: '其他' }], revision: 2 }) })
  expect(screen.getByRole('button', { name: reviewer.name })).toBe(choice)
  expect(document.activeElement).toBe(elsewhere ? other : choice)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['reviewer', 1, 3])
})

it.each(['available', 'failed'] as const)('does not revive an expert that becomes conflicted during enable when the follow-up read is %s', async (state) => {
  const { trigger, cache, remote, view, dictionary } = await fixture(false)
  const catalog = { experts: [reviewer], enabled: [], revision: 1 }
  cache.catalog.accept(catalog)
  const read = vi.spyOn(remote, 'getCatalog').mockResolvedValue({ ok: true, value: catalog })
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.setEnabled>>>()
  const write = vi.spyOn(remote, 'setEnabled').mockReturnValueOnce(pending.promise)
  const insert = vi.fn(() => true)
  view.rerender(<AgentsButton remote={remote} cache={cache} insertReference={insert} getActive={() => 'zh'} t={key => dictionary[key] ?? key} />)
  await act(async () => { fireEvent.click(trigger); await cache.catalog.refresh() })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'reviewer' } })
  fireEvent.click(screen.getByRole('button', { name: /评审专家/ }))
  await waitFor(() => { expect(write).toHaveBeenCalledOnce() })
  const latest = { experts: [{ ...reviewer, conflict: true }], enabled: [], revision: 2 }
  act(() => { cache.catalog.accept(latest) })
  if (state === 'failed') read.mockRejectedValueOnce(new Error('Directory unavailable after enable'))
  else read.mockResolvedValueOnce({ ok: true, value: latest })
  await act(async () => { pending.resolve({ ok: true, value: { enabled: [reviewer.slug], revision: 2 } }); await pending.promise })
  expect(insert).not.toHaveBeenCalled()
  expect(cache.catalog.getSnapshot().enabled.has(reviewer.slug)).toBe(false)
  expect(buildExpertMentionLexicon(cache.catalog.getSnapshot().experts, cache.catalog.getSnapshot().enabled, 'zh')).toEqual([])
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain(zh['custom.unavailable'])
})

it.each(['available', 'removed', 'failed'] as const)('handles a picker selection during background refresh after the directory settles as %s', async (state) => {
  const { trigger, cache, remote, view, dictionary } = await fixture(false)
  cache.catalog.accept({ experts: [reviewer], enabled: [], revision: 1 })
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.getCatalog>>>()
  const read = vi.spyOn(remote, 'getCatalog').mockReturnValue(pending.promise)
  const write = vi.spyOn(remote, 'setEnabled').mockResolvedValue({ ok: true, value: { enabled: [reviewer.slug], revision: 3 } })
  const insert = vi.fn(() => true)
  const nextInsert = vi.fn(() => true)
  let currentInsert = insert
  const prepareInsertion = vi.fn(() => currentInsert)
  view.rerender(<><AgentsButton remote={remote} cache={cache} prepareInsertion={prepareInsertion} getActive={() => 'zh'} t={key => dictionary[key] ?? key} /><button>Outside</button></>)
  onTestFinished(async () => {
    pending.resolve({ ok: true, value: { experts: [], enabled: [], revision: 2 } })
    await pending.promise.catch(() => undefined)
  })
  fireEvent.click(trigger)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'reviewer' } })
  const choice = screen.getByRole<HTMLButtonElement>('button', { name: /评审专家/ })
  expect(choice.disabled).toBe(false)
  fireEvent.click(choice)
  fireEvent.click(choice)
  currentInsert = nextInsert
  expect(prepareInsertion).toHaveBeenCalledOnce()
  expect(write).not.toHaveBeenCalled()
  expect(insert).not.toHaveBeenCalled()
  await act(async () => {
    if (state === 'failed') pending.reject(new Error('Catalog unavailable'))
    else pending.resolve({ ok: true, value: { experts: state === 'available' ? [reviewer] : [], enabled: [], revision: 2 } })
    await pending.promise.catch(() => undefined)
  })
  expect(read).toHaveBeenCalledOnce()
  if (state !== 'available') {
    expect((await screen.findByRole('alert')).textContent).toContain(state === 'removed' ? zh['custom.unavailable'] : 'Catalog unavailable')
    expect(write).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
    if (state === 'failed') {
      await act(async () => { fireEvent.click(choice) })
      expect(write).not.toHaveBeenCalled()
      expect(insert).not.toHaveBeenCalled()
      expect(screen.getByRole('alert').textContent).toContain('Catalog unavailable')
      read.mockResolvedValue({ ok: true, value: { experts: [reviewer], enabled: [], revision: 2 } })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['btn.refresh'] })); await cache.catalog.refresh() })
      expect(screen.queryByRole('alert')).toBeNull()
      expect(read).toHaveBeenCalledTimes(2)
    }
  } else {
    await waitFor(() => { expect(write).toHaveBeenCalledOnce(); expect(insert).toHaveBeenCalledOnce() })
    expect(write.mock.calls[0]?.slice(0, 2)).toEqual([[reviewer.slug], 2])
    expect(screen.queryByRole('dialog')).toBeNull()
  }
  expect(nextInsert).not.toHaveBeenCalled()
})

it.each(['close', 'unmount'] as const)('does not enable or insert an expert after %s while waiting for the catalog', async (exit) => {
  const { trigger, cache, remote, view, dictionary } = await fixture(false)
  cache.catalog.accept({ experts: [reviewer], enabled: [], revision: 1 })
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.getCatalog>>>()
  const read = vi.spyOn(remote, 'getCatalog').mockReturnValue(pending.promise)
  const write = vi.spyOn(remote, 'setEnabled')
  const insert = vi.fn(() => true)
  view.rerender(<><AgentsButton remote={remote} cache={cache} insertReference={insert} getActive={() => 'zh'} t={key => dictionary[key] ?? key} /><button>Outside</button></>)
  onTestFinished(async () => {
    pending.resolve({ ok: true, value: { experts: [reviewer], enabled: [], revision: 2 } })
    await pending.promise
  })
  fireEvent.click(trigger)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'reviewer' } })
  fireEvent.click(screen.getByRole('button', { name: /评审专家/ }))
  if (exit === 'close') fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
  else view.unmount()
  await act(async () => {
    pending.resolve({ ok: true, value: { experts: [reviewer], enabled: [], revision: 2 } })
    await pending.promise
  })
  expect(read).toHaveBeenCalledOnce()
  expect(write).not.toHaveBeenCalled()
  expect(insert).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('completes a dispatched enable once after closing without inserting into a later editor', async () => {
  const { trigger, cache, remote, view, dictionary } = await fixture(false)
  const catalog = { experts: [reviewer], enabled: [], revision: 2 }
  cache.catalog.accept(catalog)
  vi.spyOn(remote, 'getCatalog').mockResolvedValue({ ok: true, value: catalog })
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.setEnabled>>>()
  const write = vi.spyOn(remote, 'setEnabled').mockReturnValue(pending.promise)
  const insert = vi.fn(() => true)
  view.rerender(<><AgentsButton remote={remote} cache={cache} insertReference={insert} getActive={() => 'zh'} t={key => dictionary[key] ?? key} /><button>Outside</button></>)
  onTestFinished(async () => {
    pending.resolve({ ok: true, value: { enabled: [reviewer.slug], revision: 3 } })
    await pending.promise
  })
  await act(async () => { fireEvent.click(trigger); await cache.catalog.refresh() })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'reviewer' } })
  const choice = screen.getByRole('button', { name: /评审专家/ })
  fireEvent.click(choice)
  await waitFor(() => { expect(write).toHaveBeenCalledOnce() })
  fireEvent.click(choice)
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
  await act(async () => {
    pending.resolve({ ok: true, value: { enabled: [reviewer.slug], revision: 3 } })
    await pending.promise
  })
  expect(cache.catalog.getSnapshot().enabled.has(reviewer.slug)).toBe(true)
  expect(write).toHaveBeenCalledOnce()
  expect(insert).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

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
