// @vitest-environment jsdom
/** Expert-team views follow the native store and their current mounted operations. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Suspense, startTransition, useLayoutEffect } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createExpertClientState } from '../../src/client/client-state.ts'
import { TeamMenu } from '../../src/client/team-composer.tsx'
import { TeamDetails, TeamsPanel, type TeamRemote } from '../../src/client/team-ui.tsx'
import { TEST_TEAMS } from '../../src/fixtures/teams.ts'
import type { TeamSnapshot } from '../../src/team-contract.ts'
import { useTeamDirectory } from '../../src/client/team-directory.ts'
import { TeamLocaleContext } from '../../src/client/team-locale.ts'
import { Modal } from '../../src/client/plugin-ui.ts'

const team = { ...TEST_TEAMS[0], name: 'Original team' }
const original: TeamSnapshot = { teams: [team], enabledTeams: [team.id],
  enabledExperts: team.members.map(member => member.expertSlug), revision: 1 }
const current: TeamSnapshot = { ...original, teams: [{ ...team, name: 'Current team' }], revision: 3 }

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function fixture() {
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected mutation'))
  const getTeams = vi.fn<TeamRemote['getTeams']>().mockResolvedValue({ ok: true, value: original })
  const setTeamEnabled = vi.fn<TeamRemote['setTeamEnabled']>().mockResolvedValue({ ok: true, value: original })
  const catalog = { experts: team.members.map(member => ({ slug: member.expertSlug, name: member.expertSlug,
    nameEn: member.expertSlug, description: 'Review', descriptionEn: 'Review', division: 'engineering',
    divisionZh: '研发', emoji: '🔎', custom: false })), enabled: original.enabledExperts, revision: 1 }
  const getCatalog = vi.fn<TeamRemote['getCatalog']>().mockResolvedValue({ ok: true, value: catalog })
  const remote: TeamRemote = { getTeams, setTeamEnabled, getCatalog, importExpert: async () => { throw new Error('Unexpected package import') }, exportExpert: async () => { throw new Error('Unexpected package export') }, getCustomExpert: unused,
    saveCustomExpert: unused, deleteCustomExpert: unused, exportTeam: unused, saveTeam: unused, deleteTeam: unused }
  const cache = createExpertClientState(remote)
  cache.catalog.accept(catalog)
  cache.teams.accept(original)
  return { remote, cache, getTeams, getCatalog, setTeamEnabled }
}

it.each(['success', 'failure'] as const)('keeps committed team refresh callbacks through a suspended render ending in %s', async (outcome) => {
  const value = fixture()
  const suspended = Promise.withResolvers<undefined>()
  const rendering = vi.fn()
  const committed = { onStart: vi.fn(), onSuccess: vi.fn(), onError: vi.fn() }
  const candidate = { onStart: vi.fn(), onSuccess: vi.fn(), onError: vi.fn() }
  function Directory({ next = false, pending = false }: { next?: boolean; pending?: boolean }) {
    const callbacks = next ? candidate : committed
    const directory = useTeamDirectory({ ...value, ...callbacks })
    if (pending) { rendering(); throw suspended.promise }
    return <button onClick={() => { void directory.refresh() }}>Refresh directory</button>
  }
  const view = render(<Suspense><Directory /></Suspense>)
  onTestFinished(() => { view.unmount(); suspended.resolve(undefined); value.cache.catalog.dispose(); value.cache.teams.dispose() })
  await waitFor(() => { expect(committed.onSuccess).toHaveBeenCalledOnce() })
  Object.values(committed).forEach(callback => callback.mockClear())
  const refresh = screen.getByRole('button', { name: 'Refresh directory' })
  refresh.focus()
  act(() => { startTransition(() => { view.rerender(<Suspense><Directory next pending /></Suspense>) }) })
  expect(rendering).toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Refresh directory' })).toBe(refresh)
  if (outcome === 'failure') value.getTeams.mockRejectedValueOnce(new Error('Directory offline'))
  await act(async () => { fireEvent.click(refresh) })
  expect(committed.onStart).toHaveBeenCalledOnce()
  expect(committed.onSuccess).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0)
  expect(committed.onError).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 0)
  for (const callback of Object.values(candidate)) expect(callback).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(refresh)
  if (outcome === 'failure') {
    await act(async () => { fireEvent.click(refresh) })
    expect(committed.onSuccess).toHaveBeenCalledOnce()
    expect(committed.onStart).toHaveBeenCalledTimes(2)
  }
  view.rerender(<Suspense><Directory next /></Suspense>)
  await act(async () => { fireEvent.click(refresh) })
  expect(candidate.onStart).toHaveBeenCalledOnce()
  expect(candidate.onSuccess).toHaveBeenCalledOnce()
  expect(candidate.onError).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Refresh directory' })).toBe(refresh)
  expect(document.activeElement).toBe(refresh)
})

it.each([false, true])('recovers a cleared scrollable team read error without taking another control (elsewhere=%s)', async (elsewhere) => {
  const value = fixture()
  value.getTeams.mockRejectedValueOnce(new Error('Team directory unavailable'))
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['getTeams']>>>()
  const view = render(<><TeamsPanel {...value} /><button>Other action</button></>)
  onTestFinished(() => {
    view.unmount(); response.resolve({ ok: true, value: original }); value.cache.catalog.dispose(); value.cache.teams.dispose()
  })
  const alert = await screen.findByRole('alert')
  const region = screen.getByRole('region', { name: 'Team directory unavailable' })
  const search = screen.getByRole<HTMLInputElement>('textbox', { name: '搜索专家团' })
  fireEvent.change(search, { target: { value: 'team' } })
  search.setSelectionRange(1, 3)
  value.getTeams.mockReturnValueOnce(response.promise)
  const refresh = screen.getByRole('button', { name: '刷新重试' })
  fireEvent.click(refresh); fireEvent.click(refresh)
  await waitFor(() => { expect(value.getTeams).toHaveBeenCalledTimes(2) })
  expect(screen.getByRole('alert')).toBe(alert)
  region.focus()
  const other = screen.getByRole('button', { name: 'Other action' })
  if (elsewhere) other.focus()
  await act(async () => { response.resolve({ ok: true, value: original }) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(document.activeElement).toBe(elsewhere ? other : search)
  expect(screen.getByRole('textbox', { name: '搜索专家团' })).toBe(search)
  expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['team', 1, 3])
  expect({ errorRemoved: !region.isConnected, searchRetained: search.isConnected,
    focused: document.activeElement === search ? 'search' : 'other', query: search.value }).toMatchSnapshot()
})

it.each([false, true])('captures team close focus from the committed detail callback (commit=%s)', async (commit) => {
  const suspended = Promise.withResolvers<undefined>()
  const rendering = vi.fn(), committed = vi.fn(), candidate = vi.fn()
  function Gate({ pending }: { pending: boolean }) {
    if (pending) { rendering(); throw suspended.promise }
    return null
  }
  function Detail({ next = false, pending = false }: { next?: boolean; pending?: boolean }) {
    return <><TeamDetails team={team} experts={[]} close={() => {}} captureCloseFocus={next ? candidate : committed} />
      <Gate pending={pending} /></>
  }
  const view = render(<Suspense><Detail /></Suspense>)
  onTestFinished(() => { view.unmount(); suspended.resolve(undefined) })
  const dialog = screen.getByRole('dialog')
  within(dialog).getAllByRole('button')[0].focus()
  act(() => { startTransition(() => { view.rerender(<Suspense><Detail next pending /></Suspense>) }) })
  expect(rendering).toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBe(dialog)
  if (commit) view.rerender(<Suspense><Detail next /></Suspense>)
  view.unmount()
  expect(committed).toHaveBeenCalledTimes(commit ? 0 : 1)
  expect(candidate).toHaveBeenCalledTimes(commit ? 1 : 0)
})

it.each((['menu', 'panel'] as const).flatMap(kind => (['zh', 'en'] as const)
  .flatMap(locale => [false, true].map(elsewhere => ({ kind, locale, elsewhere })))))(
  'recovers a $kind detail removed with its team without taking another draft ($locale, elsewhere=$elsewhere)', async ({ kind, locale, elsewhere }) => {
    const value = fixture()
    const view = render(<><TeamLocaleContext.Provider value={locale}>
      {kind === 'menu' ? <Modal open title="Team picker" closeLabel="Close picker" onClose={() => {}}>
        <TeamMenu {...value} onSelected={vi.fn()} /></Modal> : <TeamsPanel {...value} />}
    </TeamLocaleContext.Provider><input aria-label="Other draft" defaultValue="Unsubmitted" /></>)
    onTestFinished(() => { view.unmount(); value.cache.catalog.dispose(); value.cache.teams.dispose() })
    await act(async () => { await value.cache.teams.refresh() })
    const label = locale === 'zh' ? '搜索专家团' : 'Search teams'
    const search = screen.getByRole<HTMLInputElement>('textbox', { name: label })
    fireEvent.change(search, { target: { value: 'team' } })
    search.setSelectionRange(1, 3)
    const trigger = screen.getByRole('button', { name: kind === 'menu'
      ? locale === 'zh' ? '查看Original team详情' : 'View Original team details'
      : locale === 'zh' ? '查看详情' : 'View details' })
    act(() => { trigger.focus() })
    fireEvent.click(trigger)
    const detailName = locale === 'zh' ? 'Original team详情' : 'Original team details'
    const details = screen.getByRole('dialog', { name: detailName })
    act(() => { within(details).getByRole('button', { name: locale === 'zh' ? '关闭' : 'Close' }).focus() })
    const other = screen.getByRole<HTMLInputElement>('textbox', { name: 'Other draft' })
    other.setSelectionRange(2, 5)
    if (elsewhere) other.focus()
    act(() => { value.cache.teams.accept({ ...original, teams: [], enabledTeams: [], revision: 2 }) })
    expect(screen.queryByRole('dialog', { name: detailName })).toBeNull()
    expect(trigger.isConnected).toBe(false)
    expect(document.activeElement).toBe(elsewhere ? other : search)
    expect(screen.getByRole('textbox', { name: label })).toBe(search)
    expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['team', 1, 3])
    expect([other.value, other.selectionStart, other.selectionEnd]).toEqual(['Unsubmitted', 2, 5])
    expect(value.setTeamEnabled).not.toHaveBeenCalled()
  },
)

it.each((['choice', 'details'] as const).flatMap(action => (['removed', 'disabled'] as const)
  .flatMap(change => [false, true].map(elsewhere => ({ action, change, elsewhere })))))(
  'returns a vanished team $action to search without taking another control (change=$change, elsewhere=$elsewhere)', async ({ action, change, elsewhere }) => {
    const value = fixture()
    const view = render(<><TeamMenu {...value} onSelected={() => {}} /><button>Other action</button></>)
    onTestFinished(() => { view.unmount(); value.cache.catalog.dispose(); value.cache.teams.dispose() })
    await act(async () => { await value.cache.teams.refresh() })
    const search = screen.getByRole<HTMLInputElement>('textbox', { name: '搜索专家团' })
    const query = change === 'removed' ? 'team' : ''
    fireEvent.change(search, { target: { value: query } })
    search.setSelectionRange(1, 3)
    const selection = [search.selectionStart, search.selectionEnd]
    const choice = screen.getByRole('button', { name: action === 'choice' ? /^Original team/ : '查看Original team详情' })
    const other = screen.getByRole('button', { name: 'Other action' })
    act(() => { choice.focus() })
    if (elsewhere) other.focus()
    act(() => { value.cache.teams.accept({ ...original, teams: change === 'removed' ? [] : original.teams, enabledTeams: [], revision: 2 }) })
    expect(choice.isConnected).toBe(false)
    expect(document.activeElement).toBe(elsewhere ? other : search)
    expect(screen.getByRole('textbox', { name: '搜索专家团' })).toBe(search)
    expect(search.value).toBe(query)
    expect([search.selectionStart, search.selectionEnd]).toEqual(selection)
    expect(value.setTeamEnabled).not.toHaveBeenCalled()
  },
)

it.each((['card', 'details'] as const).flatMap(source => [false, true].map(elsewhere => ({ source, elsewhere }))))(
  'returns deleted team focus from $source to the current search without changing its draft (elsewhere=$elsewhere)', async ({ source, elsewhere }) => {
    const value = fixture()
    const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['deleteTeam']>>>()
    const remove = vi.fn<TeamRemote['deleteTeam']>().mockReturnValueOnce(response.promise)
    value.remote.deleteTeam = remove
    const view = render(<TeamsPanel {...value} />)
    onTestFinished(() => {
      view.unmount(); response.resolve({ ok: true, value: original }); value.cache.catalog.dispose(); value.cache.teams.dispose()
    })
    await act(async () => { await value.cache.teams.refresh() })
    const search = screen.getByRole<HTMLInputElement>('textbox', { name: '搜索专家团' })
    fireEvent.change(search, { target: { value: 'team' } })
    search.setSelectionRange(1, 3)
    render(<input aria-label="Other draft" defaultValue="Unsubmitted" />)
    const other = screen.getByRole<HTMLInputElement>('textbox', { name: 'Other draft' })
    other.setSelectionRange(2, 5)
    if (source === 'details') fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
    const trigger = source === 'details' ? within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', { name: '删除专家团' })
      : screen.getByRole<HTMLButtonElement>('button', { name: '删除专家团' })
    trigger.focus(); fireEvent.click(trigger)
    const confirm = within(screen.getByRole('dialog', { name: '删除专家团？' })).getByRole<HTMLButtonElement>('button', { name: '确认删除' })
    confirm.focus(); fireEvent.click(confirm)
    if (elsewhere) other.focus()
    await act(async () => { response.resolve({ ok: true, value: { ...original, teams: [], enabledTeams: [], revision: 2 } }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger.isConnected).toBe(false)
    expect(document.activeElement).toBe(elsewhere ? other : search)
    expect(screen.getByRole('textbox', { name: '搜索专家团' })).toBe(search)
    expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['team', 1, 3])
    expect([other.value, other.selectionStart, other.selectionEnd]).toEqual(['Unsubmitted', 2, 5])
    expect(remove).toHaveBeenCalledOnce()
  },
)

it.each((['menu', 'panel'] as const).flatMap(kind => (['empty', 'populated'] as const)
  .flatMap(result => [false, true].map(elsewhere => ({ kind, result, elsewhere })))))(
  'returns recovered $kind team directory focus after a $result result only when its refresh owns focus (elsewhere=$elsewhere)', async ({ kind, result, elsewhere }) => {
    const value = fixture()
    const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['getTeams']>>>()
    value.getTeams.mockRejectedValueOnce(new Error('Team directory unavailable')).mockReturnValueOnce(response.promise)
    const view = render(<>{kind === 'menu' ? <TeamMenu {...value} onSelected={() => {}} /> : <TeamsPanel {...value} />}<button>Other action</button></>)
    onTestFinished(() => {
      view.unmount(); response.resolve({ ok: true, value: current }); value.cache.catalog.dispose(); value.cache.teams.dispose()
    })
    await screen.findByRole('alert')
    const refresh = screen.getByRole<HTMLButtonElement>('button', { name: kind === 'menu' ? '刷新' : '刷新重试' })
    const search = screen.getByRole('textbox', { name: '搜索专家团' })
    const other = screen.getByRole('button', { name: 'Other action' })
    refresh.focus()
    await act(async () => { refresh.click(); refresh.click() })
    expect(value.getTeams).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(refresh)
    if (elsewhere) other.focus()
    await act(async () => { response.resolve({ ok: true, value: result === 'empty' ? { ...current, teams: [], enabledTeams: [] } : current }) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(elsewhere ? other : search)
    if (!elsewhere) expect({ focus: document.activeElement?.getAttribute('aria-label'), errors: screen.queryAllByRole('alert').length }).toMatchSnapshot()
  })

it.each((['menu', 'panel'] as const).flatMap(kind => [false, true].map(elsewhere => ({ kind, elsewhere }))))(
  'returns recovered $kind team detail focus to its title without taking another control (elsewhere=$elsewhere)', async ({ kind, elsewhere }) => {
    const value = fixture()
    const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['getTeams']>>>()
    const insert = vi.fn().mockRejectedValueOnce(new Error('Draft unavailable'))
    const view = render(kind === 'menu' ? <TeamMenu {...value} prepareSelect={() => insert} onSelected={() => {}} />
      : <TeamsPanel {...value} prepareSelect={() => insert} />)
    onTestFinished(() => {
      view.unmount(); response.resolve({ ok: true, value: original }); value.cache.catalog.dispose(); value.cache.teams.dispose()
    })
    await act(async () => { await value.cache.teams.refresh() })
    fireEvent.click(screen.getByRole('button', { name: kind === 'menu' ? '查看Original team详情' : '查看详情' }))
    const dialog = screen.getByRole('dialog')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '召唤专家团' })) })
    const notice = within(dialog).getByRole('alert')
    const retry = within(dialog).getByRole<HTMLButtonElement>('button', { name: kind === 'menu' ? '刷新' : '刷新重试' })
    const other = within(dialog).getByRole<HTMLButtonElement>('button', { name: '关闭' })
    const reads = value.getTeams.mock.calls.length
    value.getTeams.mockReturnValueOnce(response.promise)
    retry.focus()
    await act(async () => { retry.click(); retry.click() })
    expect(value.getTeams).toHaveBeenCalledTimes(reads + 1)
    expect(within(dialog).getByRole('alert')).toBe(notice)
    expect(document.activeElement).toBe(retry)
    if (elsewhere) other.focus()
    await act(async () => { response.resolve({ ok: true, value: original }) })
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(elsewhere ? other : within(dialog).getByRole('heading', { name: team.name }))
    expect(insert).toHaveBeenCalledOnce()
    if (!elsewhere) expect({ title: document.activeElement?.textContent, errors: within(dialog).queryAllByRole('alert').length }).toMatchSnapshot()
  },
)

it.each(['company', 'custom'] as const)('returns focus to the %s team search after clearing an empty filter', async (source) => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  await act(async () => { render(<TeamsPanel {...value} source={source} />) })
  const search = screen.getByRole('textbox', { name: '搜索专家团' })
  fireEvent.change(search, { target: { value: 'no-matching-fixture' } })
  const clear = screen.getByRole('button', { name: '清除筛选' })
  clear.focus()
  fireEvent.click(clear)
  expect(document.activeElement).toBe(search)
  expect(screen.getByRole('textbox', { name: '搜索专家团' })).toBe(search)
  expect(search).toHaveProperty('value', '')
})

it('keeps AI team creation available throughout a team toggle', async () => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['setTeamEnabled']>>>()
  value.setTeamEnabled.mockReturnValueOnce(response.promise)
  const startCreation = vi.fn()
  await act(async () => { render(<TeamsPanel {...value} startCreation={startCreation} />) })
  const create = screen.getByRole('button', { name: '通过对话创建专家团' })
  const changes: MutationRecord[] = []
  const observer = new MutationObserver(records => changes.push(...records))
  observer.observe(create, { attributes: true, childList: true, subtree: true })
  try {
    fireEvent.click(screen.getByRole('switch'))
    expect(screen.getByRole('switch')).toHaveProperty('disabled', false)
    expect(screen.getByRole('switch').parentElement?.getAttribute('aria-disabled')).toBe('true')
    expect(create).toHaveProperty('disabled', false)
    fireEvent.click(create)
    expect(startCreation).toHaveBeenCalledOnce()
    await act(async () => { response.resolve({ ok: true, value: { ...original, enabledTeams: [], revision: 2 } }); await response.promise })
    expect(screen.getByRole('button', { name: '通过对话创建专家团' })).toBe(create)
    expect([...changes, ...observer.takeRecords()]).toEqual([])
  } finally {
    observer.disconnect()
    await act(async () => { response.resolve({ ok: true, value: { ...original, enabledTeams: [], revision: 2 } }); await response.promise })
  }
})

it.each(['delete', 'enable', 'menu-enable'] as const)('keeps the %s team confirmation and failure through one locked retry', async (kind) => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const directory = kind === 'delete' ? original : { ...original, enabledExperts: [], enabledTeams: kind === 'enable' ? [] : original.enabledTeams }
  value.cache.teams.accept(directory)
  value.getTeams.mockResolvedValue({ ok: true, value: directory })
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['deleteTeam']>>>()
  const deleteTeam = vi.fn<TeamRemote['deleteTeam']>()
  const mutation = kind === 'delete' ? deleteTeam : value.setTeamEnabled
  mutation.mockRejectedValueOnce(new Error('Temporary team write failure')).mockReturnValueOnce(response.promise)
  if (kind === 'delete') value.remote.deleteTeam = deleteTeam
  const insert = vi.fn(() => true), onSelected = vi.fn()
  await act(async () => {
    render(kind === 'menu-enable' ? <TeamMenu {...value} prepareSelect={() => insert} onSelected={onSelected} />
      : <TeamsPanel {...value} />)
  })
  fireEvent.click(screen.getByRole(kind === 'enable' ? 'switch' : 'button', {
    name: kind === 'delete' ? '删除专家团' : kind === 'menu-enable' ? /^Original team/ : undefined,
  }))
  const dialog = screen.getByRole('dialog')
  const submit = within(dialog).getByRole('button', { name: kind === 'delete' ? '确认删除' : '启用团队及所需成员' })
  submit.focus()
  await act(async () => { fireEvent.click(submit) })
  expect(document.activeElement).toBe(submit)
  const error = within(dialog).getByRole('alert')
  expect(error.textContent).toContain('Temporary team write failure')
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  const cancel = within(dialog).getByRole('button', { name: '取消' })
  act(() => {
    fireEvent.click(submit); fireEvent.click(submit); fireEvent.click(cancel)
    fireEvent.keyDown(window, { key: 'Escape' })
  })
  expect(mutation).toHaveBeenCalledTimes(2)
  expect(submit.isConnected).toBe(true)
  expect(dialog.isConnected).toBe(true)
  expect(within(dialog).getByRole('alert')).toBe(error)
  expect(submit.classList.contains('product-control-pending')).toBe(true)
  expect(submit.getAttribute('aria-busy')).toBe('true')
  expect(cancel.classList.contains('product-control-pending')).toBe(true)
  expect(submit).toHaveProperty('disabled', false)
  expect(submit.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(submit)
  const pendingLabel = within(submit).getByText('正在处理…')
  expect(pendingLabel.getAttribute('aria-hidden')).toBe('false')
  expect({ kind, error: error.textContent, submit: pendingLabel.textContent, busy: submit.getAttribute('aria-busy'),
    focused: document.activeElement?.querySelector('[aria-hidden="false"]')?.textContent }).toMatchSnapshot()
  await act(async () => {
    response.resolve({ ok: true, value: { ...original, ...(kind === 'delete' ? { teams: [], enabledTeams: [] } : {}), revision: 2 } })
    await response.promise
  })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(insert).toHaveBeenCalledTimes(kind === 'menu-enable' ? 1 : 0)
  expect(onSelected).toHaveBeenCalledTimes(kind === 'menu-enable' ? 1 : 0)
})

it.each((['menu', 'panel'] as const).flatMap(kind => (['example', 'summon'] as const).map(action => ({ kind, action }))))(
  'keeps $kind team $action failures and focus in the detail dialog through one locked retry', async ({ kind, action }) => {
    const value = fixture()
    onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
    const response = Promise.withResolvers<boolean>()
    const insert = vi.fn<() => Promise<boolean>>().mockRejectedValueOnce(new Error('Draft unavailable')).mockReturnValueOnce(response.promise)
    const onSelected = vi.fn()
    await act(async () => {
      render(kind === 'menu' ? <TeamMenu {...value} prepareSelect={() => insert} onSelected={onSelected} />
        : <TeamsPanel {...value} prepareSelect={() => insert} />)
    })
    fireEvent.click(screen.getByRole('button', { name: kind === 'menu' ? '查看Original team详情' : '查看详情' }))
    const dialog = screen.getByRole('dialog')
    const example = team.examples[0]
    if (example === undefined) throw new Error('Team example fixture missing')
    const choice = within(dialog).getByRole<HTMLButtonElement>('button', { name: action === 'example' ? `“${example}”` : '召唤专家团' })
    choice.focus()
    await act(async () => { fireEvent.click(choice) })
    const error = within(dialog).getByRole('alert')
    expect(error.textContent).toContain('Draft unavailable')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    const other = within(dialog).getByRole<HTMLButtonElement>('button', { name: action === 'example' ? '召唤专家团' : `“${example}”` })
    act(() => {
      fireEvent.click(choice); fireEvent.click(choice); fireEvent.click(other)
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(insert).toHaveBeenCalledTimes(2)
    expect(within(dialog).getByRole('alert')).toBe(error)
    expect(choice.isConnected).toBe(true)
    expect(choice.getAttribute('aria-busy')).toBe('true')
    expect(choice.classList.contains('product-control-pending')).toBe(true)
    expect(choice.disabled).toBe(false)
    expect(choice.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(choice)
    expect(other.getAttribute('aria-busy')).toBe('false')
    expect(other.classList.contains('product-control-pending')).toBe(true)
    expect({ kind, error: error.textContent, example: choice.textContent, busy: choice.getAttribute('aria-busy'),
      otherBusy: other.getAttribute('aria-busy'), focused: document.activeElement?.textContent }).toMatchSnapshot()
    await act(async () => { response.resolve(true); await response.promise })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(value.setTeamEnabled).not.toHaveBeenCalled()
    expect(onSelected).toHaveBeenCalledTimes(kind === 'menu' ? 1 : 0)
  })

it.each(['menu', 'panel'] as const)('retries a failed %s insertion after confirmed enable without writing the team again', async (kind) => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const directory = { ...original, enabledExperts: [] }
  value.cache.teams.accept(directory)
  value.getTeams.mockResolvedValue({ ok: true, value: directory })
  value.setTeamEnabled.mockResolvedValueOnce({ ok: true, value: { ...original, revision: 2 } })
  const insert = vi.fn<() => Promise<boolean>>().mockRejectedValueOnce(new Error('Draft unavailable')).mockResolvedValueOnce(true)
  const onSelected = vi.fn()
  await act(async () => {
    render(kind === 'menu' ? <TeamMenu {...value} prepareSelect={() => insert} onSelected={onSelected} />
      : <TeamsPanel {...value} prepareSelect={() => insert} />)
  })
  fireEvent.click(screen.getByRole('button', { name: kind === 'menu' ? '查看Original team详情' : '查看详情' }))
  const details = screen.getByRole('dialog')
  const summon = within(details).getByRole('button', { name: '召唤专家团' })
  fireEvent.click(summon)
  const confirm = screen.getAllByRole('dialog').find(dialog => dialog !== details)
  if (!confirm) throw new Error('Enable confirmation missing')
  await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: '启用团队及所需成员' })) })
  expect(confirm.isConnected).toBe(false)
  expect(within(details).getByRole('alert').textContent).toContain('Draft unavailable')
  await act(async () => { fireEvent.click(summon) })
  expect(insert).toHaveBeenCalledTimes(2)
  expect(value.setTeamEnabled).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(onSelected).toHaveBeenCalledTimes(kind === 'menu' ? 1 : 0)
})

it.each([
  { locale: 'zh' as const, name: '团'.repeat(40), existing: [], expected: '团'.repeat(38) + '副本' },
  { locale: 'en' as const, name: 'T'.repeat(40), existing: [], expected: 'T'.repeat(35) + ' copy' },
  { locale: 'zh' as const, name: 'A'.repeat(37) + '🚀', existing: [], expected: 'A'.repeat(37) + '副本' },
  { locale: 'zh' as const, name: 'QA', existing: [' qa副本 ', 'QA副本 2'], expected: 'QA副本 3' },
])('saves a usable $locale company-team copy named $expected', async ({ locale, name, existing, expected }) => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const source = { ...team, name, company: true }
  const directory = { ...original, teams: [source, ...existing.map((name, index) => ({ ...team, id: `existing-${index}`, name }))] }
  value.cache.teams.accept(directory)
  value.getTeams.mockResolvedValue({ ok: true, value: directory })
  const save = vi.fn<TeamRemote['saveTeam']>().mockResolvedValue({ ok: true, value: { ...directory, revision: 2 } })
  value.remote.saveTeam = save
  await act(async () => { render(<TeamLocaleContext.Provider value={locale}><TeamsPanel {...value} source="company" /></TeamLocaleContext.Provider>) })
  fireEvent.click(screen.getByRole('button', { name: locale === 'zh' ? '查看详情' : 'View details' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: locale === 'zh' ? '复制并自定义' : 'Copy and customize' }))
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: locale === 'zh' ? '团队名称' : 'Team name' })
  expect(input.value).toBe(expected)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: locale === 'zh' ? '保存' : 'Save' })) })
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: expected }), false, original.revision, expect.any(AbortSignal))
  expect(save.mock.calls[0]?.[0].id).toBeUndefined()
  expect(source.name).toBe(name)
  expect({ name: input.value, enabled: save.mock.calls[0]?.[1] }).toMatchSnapshot()
})

it.each(['menu', 'panel'] as const)('does not insert a team after its pending %s enable crosses a directory reset', async (kind) => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const disabled = { ...original, enabledExperts: [] }
  value.cache.teams.accept(disabled)
  value.getTeams.mockResolvedValue({ ok: true, value: disabled })
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['setTeamEnabled']>>>()
  value.setTeamEnabled.mockReturnValueOnce(response.promise)
  const insert = vi.fn(() => true)
  const selected = vi.fn()
  await act(async () => {
    render(kind === 'menu' ? <TeamMenu {...value} prepareSelect={() => insert} onSelected={selected} />
      : <TeamsPanel {...value} prepareSelect={() => insert} />)
  })
  if (kind === 'panel') fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
  fireEvent.click(screen.getByRole('button', { name: kind === 'menu' ? /^Original team/ : '召唤专家团' }))
  fireEvent.click(screen.getByRole('button', { name: '启用团队及所需成员' }))
  const catalog = value.cache.catalog.getSnapshot()
  const next = { ...original, revision: 0 }
  value.getTeams.mockResolvedValue({ ok: true, value: next })
  await act(async () => {
    value.cache.teams.reset(); value.cache.catalog.reset()
    value.cache.teams.accept(next)
    value.cache.catalog.accept({ experts: [...catalog.experts], enabled: [...catalog.enabled], revision: 0 })
  })
  expect(screen.getByRole('button', { name: kind === 'menu' ? /^Original team/ : '召唤专家团' })).toHaveProperty('disabled', false)
  await act(async () => { response.resolve({ ok: true, value: { ...original, revision: 2 } }); await response.promise })
  expect(insert).not.toHaveBeenCalled()
  expect(selected).not.toHaveBeenCalled()
  expect(value.cache.teams.getSnapshot()?.revision).toBe(0)
  expect(value.setTeamEnabled.mock.calls[0]?.[3]?.aborted).toBe(true)
})

it('does not report a cancelled company refresh over a reconnected team directory', async () => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const company = { ...original, teams: [{ ...team, company: true }] }
  value.cache.teams.accept(company)
  value.getTeams.mockResolvedValue({ ok: true, value: company })
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['getCatalog']>>>()
  value.getCatalog.mockReturnValueOnce(response.promise)
  await act(async () => { render(<TeamsPanel {...value} source="company" active />) })
  const catalog = value.cache.catalog.getSnapshot()
  await act(async () => {
    value.cache.catalog.reset(); value.cache.teams.reset()
    value.cache.catalog.accept({ experts: [...catalog.experts], enabled: [...catalog.enabled], revision: 0 })
    value.cache.teams.accept({ ...current, teams: current.teams.map(team => ({ ...team, company: true })), revision: 0 })
  })
  await act(async () => {
    response.resolve({ ok: true, value: { experts: [...catalog.experts], enabled: [...catalog.enabled], revision: 9 } })
    await response.promise
  })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText('Current team')).toBeTruthy()
  expect(value.cache.catalog.getSnapshot().revision).toBe(0)
})

it.each(['menu', 'panel'] as const)('inserts a team once during repeated selection in the %s and releases the operation after failure', async (kind) => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const pending = Promise.withResolvers<boolean>()
  const insert = vi.fn(() => pending.promise)
  const selected = vi.fn()
  await act(async () => {
    render(kind === 'menu' ? <TeamMenu {...value} prepareSelect={() => insert} onSelected={selected} />
      : <TeamsPanel {...value} prepareSelect={() => insert} />)
  })
  if (kind === 'panel') fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
  const choice = screen.getByRole('button', { name: kind === 'menu' ? /^Original team/ : '召唤专家团' })
  act(() => { fireEvent.click(choice); fireEvent.click(choice) })
  expect(insert).toHaveBeenCalledOnce()
  expect(choice).toHaveProperty('disabled', false)
  expect(choice.getAttribute('aria-disabled')).toBe('true')
  await act(async () => { pending.reject(new Error('Draft unavailable')); await pending.promise.catch(() => undefined) })
  expect(screen.getByRole('alert').textContent).toContain('Draft unavailable')
  insert.mockResolvedValueOnce(true)
  await act(async () => { fireEvent.click(choice) })
  expect(insert).toHaveBeenCalledTimes(2)
  if (kind === 'menu') expect(selected).toHaveBeenCalledOnce()
})

it.each((['menu', 'panel'] as const).flatMap(kind => [true, false].map(enabled => ({ kind, enabled })) ))(
  'requires repairing fixed member versions before a $kind selection with enabled=$enabled', async ({ kind, enabled }) => {
    const value = fixture()
    onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
    const broken = structuredClone(team)
    broken.members[0].expertVersion = 'reselect-required'
    const directory = { ...original, teams: [broken], enabledTeams: enabled ? [team.id] : [] }
    value.cache.teams.accept(directory)
    value.getTeams.mockResolvedValue({ ok: true, value: directory })
    const insert = vi.fn(async () => true), prepareSelect = vi.fn(() => insert), selected = vi.fn()
    await act(async () => {
      render(kind === 'menu' ? <TeamMenu {...value} prepareSelect={prepareSelect} onSelected={selected} />
        : <TeamsPanel {...value} prepareSelect={prepareSelect} />)
    })
    if (kind === 'menu') {
      if (!enabled) fireEvent.change(screen.getByRole('textbox', { name: '搜索专家团' }), { target: { value: team.name } })
      fireEvent.click(screen.getByRole('button', { name: /^Original team/ }))
    } else {
      fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '召唤专家团' }))
    }
    expect(screen.getByRole('alert').textContent).toContain('团队成员需要重新选择并保存。')
    expect(screen.queryByRole('button', { name: '启用团队及所需成员' })).toBeNull()
    expect(prepareSelect).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
    expect(selected).not.toHaveBeenCalled()
    expect(value.setTeamEnabled).not.toHaveBeenCalled()
  },
)

it('keeps a replacement menu operation reserved when an earlier insertion finishes', async () => {
  const first = fixture(), next = fixture()
  onTestFinished(() => {
    for (const value of [first, next]) { value.cache.catalog.dispose(); value.cache.teams.dispose() }
  })
  const earlier = Promise.withResolvers<boolean>(), later = Promise.withResolvers<boolean>()
  const insert = vi.fn(() => later.promise).mockReturnValueOnce(earlier.promise)
  const selected = vi.fn()
  const view = render(<TeamMenu {...first} prepareSelect={() => insert} onSelected={selected} />)
  fireEvent.click(screen.getByRole('button', { name: /^Original team/ }))
  await act(async () => { view.rerender(<TeamMenu {...next} prepareSelect={() => insert} onSelected={selected} />) })
  fireEvent.click(screen.getByRole('button', { name: /^Original team/ }))
  expect(insert).toHaveBeenCalledTimes(2)
  await act(async () => { earlier.resolve(true); await earlier.promise })
  expect(selected).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '查看Original team详情' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '召唤专家团' })) })
  expect(insert).toHaveBeenCalledTimes(2)
  await act(async () => { later.resolve(true); await later.promise })
  expect(selected).toHaveBeenCalledOnce()
})

it('enables a team without resolving a chat insertion target', async () => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const disabled = { ...original, enabledTeams: [], enabledExperts: [] }
  value.cache.teams.accept(disabled)
  value.getTeams.mockResolvedValue({ ok: true, value: disabled })
  const prepareSelect = vi.fn(() => { throw new Error('Chat input is not mounted') })
  await act(async () => { render(<TeamsPanel {...value} prepareSelect={prepareSelect} />) })
  fireEvent.click(screen.getByRole('switch'))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '启用团队及所需成员' })) })
  expect(value.setTeamEnabled).toHaveBeenCalledWith(team.id, true, original.revision, expect.any(AbortSignal))
  expect(prepareSelect).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['initial', 'retry'] as const)('refreshes initialized member data during the %s team-menu read', async (phase) => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const originalMember = value.cache.catalog.getSnapshot().experts[0]
  if (!originalMember) throw new Error('Team member fixture missing')
  const member = { ...originalMember, slug: 'company-current-member', name: 'Current member', nameEn: 'Current member' }
  const updated = { ...team, members: team.members.map((entry, index) => index === 0 ? { ...entry, expertSlug: member.slug } : entry) }
  const next = { ...original, teams: [updated], enabledExperts: updated.members.map(entry => entry.expertSlug) }
  value.getTeams.mockResolvedValue({ ok: true, value: next })
  if (phase === 'retry') value.getTeams.mockRejectedValueOnce(new Error('Team directory unavailable'))
  value.getCatalog.mockResolvedValue({ ok: true, value: { experts: [member, ...value.cache.catalog.getSnapshot().experts.slice(1)],
    enabled: next.enabledExperts, revision: original.revision } })
  const insert = vi.fn(() => true)
  const selected = vi.fn()
  await act(async () => { render(<TeamMenu {...value} prepareSelect={() => insert} onSelected={selected} />) })
  if (phase === 'retry') {
    expect(screen.getByRole('alert').textContent).toContain('Team directory unavailable')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新' })) })
  }
  const choice = screen.getByText(team.name).closest('button')
  if (!choice) throw new Error('Team choice missing')
  await act(async () => { fireEvent.click(choice) })
  expect(insert).toHaveBeenCalledWith(updated, undefined)
  expect(selected).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(value.cache.catalog.getSnapshot().experts).toContainEqual(expect.objectContaining({ slug: member.slug }))
})

it.each([
  { change: 'unmount', outcome: 'success' }, { change: 'unmount', outcome: 'failure' },
  { change: 'replace', outcome: 'success' }, { change: 'replace', outcome: 'failure' },
] as const)('does not deliver $outcome member refresh callbacks to the previous view after $change', async ({ change, outcome }) => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['getCatalog']>>>()
  value.getCatalog.mockReturnValue(response.promise)
  const onSuccess = vi.fn()
  const onError = vi.fn()
  function Directory(props: Parameters<typeof useTeamDirectory>[0]) {
    useTeamDirectory(props)
    return null
  }
  const view = render(<Directory {...value} onSuccess={onSuccess} onError={onError} />)
  await act(async () => { await value.cache.teams.refresh() })
  expect(value.getCatalog).toHaveBeenCalledOnce()
  const nextSuccess = vi.fn()
  const nextError = vi.fn()
  if (change === 'unmount') view.unmount()
  else view.rerender(<Directory {...value} remote={{ ...value.remote }} onSuccess={nextSuccess} onError={nextError} />)
  await act(async () => {
    if (outcome === 'success') response.resolve({ ok: true, value: { experts: [], enabled: [], revision: 2 } })
    else response.reject(new Error('Member directory unavailable'))
    await response.promise.catch(() => {})
  })
  expect(onSuccess).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
  expect(nextSuccess).toHaveBeenCalledTimes(change === 'replace' && outcome === 'success' ? 1 : 0)
  expect(nextError).toHaveBeenCalledTimes(change === 'replace' && outcome === 'failure' ? 1 : 0)
})

it('shows the first team directory failure without an idle or retry loading placeholder', async () => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  value.cache.teams.reset()
  value.getTeams.mockRejectedValueOnce(new Error('Team directory unavailable'))
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['getTeams']>>>()
  onTestFinished(() => { response.resolve({ ok: true, value: original }) })
  render(<TeamMenu {...value} onSelected={vi.fn()} />)
  const notice = await screen.findByRole('alert')
  expect(screen.queryByText('正在加载…')).toBeNull()
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: '刷新' })
  value.getTeams.mockReturnValueOnce(response.promise)
  retry.focus()
  await act(async () => { retry.click(); retry.click() })
  expect(value.getTeams).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.queryByText('正在加载…')).toBeNull()
  expect(document.activeElement).toBe(retry)
  expect({ notice: notice.textContent, loading: screen.queryByText('正在加载…') !== null }).toMatchSnapshot()
  await act(async () => { response.resolve({ ok: true, value: original }) })
  expect(await screen.findByText('Original team')).not.toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each((['menu', 'panel'] as const).flatMap(kind => (['success', 'failure'] as const)
  .flatMap(outcome => [false, true].map(repeated => ({ kind, outcome, repeated })))))(
  'retains a newer $kind selection failure when an earlier directory read ends with $outcome (repeated=$repeated)', async ({ kind, outcome, repeated }) => {
    const value = fixture(), read = Promise.withResolvers<Awaited<ReturnType<TeamRemote['getTeams']>>>()
    onTestFinished(() => { read.resolve({ ok: true, value: original }); value.cache.catalog.dispose(); value.cache.teams.dispose() })
    const selectionError = kind === 'menu' ? '无法插入团队，请确认当前聊天草稿后重试。'
      : '团队已启用，但无法写入当前聊天草稿。请关闭设置后，在聊天的专家团入口选择。'
    if (repeated) value.getTeams.mockRejectedValueOnce(new Error(selectionError))
    else value.getTeams.mockReturnValueOnce(read.promise)
    const insert = vi.fn(async () => false), selected = vi.fn()
    render(kind === 'menu' ? <TeamMenu {...value} prepareSelect={() => insert} onSelected={selected} />
      : <TeamsPanel {...value} prepareSelect={() => insert} />)
    const search = screen.getByRole<HTMLInputElement>('textbox', { name: '搜索专家团' })
    if (repeated) {
      await screen.findByRole('alert')
      value.getTeams.mockReturnValueOnce(read.promise)
      fireEvent.click(screen.getByRole('button', { name: kind === 'menu' ? '刷新' : '刷新重试' }))
    }
    fireEvent.change(search, { target: { value: 'team' } })
    search.focus(); search.setSelectionRange(1, 3)
    if (kind === 'menu') fireEvent.click(screen.getByRole('button', { name: /^Original team/ }))
    else {
      fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '召唤专家团' }))
    }
    const error = await screen.findByRole('alert'), text = error.textContent
    const retry = screen.getByRole('button', { name: kind === 'menu' ? '刷新' : '刷新重试' })
    retry.focus()
    await act(async () => {
      if (outcome === 'success') read.resolve({ ok: true, value: original })
      else read.reject(new Error('Older directory read failed'))
      await read.promise.catch(() => {})
    })
    expect(screen.getByRole('alert')).toBe(error)
    expect(error.textContent).toBe(text)
    expect(screen.getByRole('button', { name: kind === 'menu' ? '刷新' : '刷新重试' })).toBe(retry)
    expect(document.activeElement).toBe(retry)
    expect(screen.getByRole('textbox', { name: '搜索专家团' })).toBe(search)
    expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['team', 1, 3])
    if (!repeated && outcome === 'success') expect({ error: error.textContent, retry: retry.textContent,
      busy: retry.getAttribute('aria-busy'), query: search.value }).toMatchSnapshot()
    await act(async () => { fireEvent.click(retry); await value.cache.teams.refresh() })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(value.getTeams).toHaveBeenCalledTimes(repeated ? 3 : 2)
    expect(insert).toHaveBeenCalledOnce()
    expect(selected).not.toHaveBeenCalled()
    expect(value.setTeamEnabled).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(kind === 'menu' ? search : screen.getByRole('heading', { name: team.name }))
  },
)

it.each(['success', 'failure'] as const)('retains a newer selection error when the active member catalog refresh ends with %s', async (outcome) => {
  const value = fixture(), read = Promise.withResolvers<Awaited<ReturnType<TeamRemote['getCatalog']>>>()
  onTestFinished(() => {
    read.resolve({ ok: true, value: { experts: [], enabled: [], revision: 1 } })
    value.cache.catalog.dispose(); value.cache.teams.dispose()
  })
  const insert = vi.fn(async () => false)
  const view = render(<TeamsPanel {...value} prepareSelect={() => insert} source="custom" active={false} />)
  await act(async () => { await value.cache.teams.refresh() })
  value.getCatalog.mockReturnValueOnce(read.promise)
  view.rerender(<TeamsPanel {...value} prepareSelect={() => insert} source="custom" active />)
  fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '召唤专家团' }))
  const error = await screen.findByRole('alert'), text = error.textContent
  const retry = screen.getByRole('button', { name: '刷新重试' })
  retry.focus()
  await act(async () => {
    if (outcome === 'success') read.resolve(await value.getCatalog(false))
    else read.reject(new Error('Earlier member refresh failed'))
    await read.promise.catch(() => {})
  })
  expect(screen.getByRole('alert')).toBe(error)
  expect(error.textContent).toBe(text)
  expect(document.activeElement).toBe(retry)
  await act(async () => { fireEvent.click(retry) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(insert).toHaveBeenCalledOnce()
})

it.each(['menu', 'panel'] as const)('reports the new %s directory failure after replacing a connection with an existing error', async (kind) => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  value.getTeams.mockRejectedValueOnce(new Error('Previous connection failed'))
  const props = { ...value, onSelected: vi.fn() }
  const view = render(kind === 'menu' ? <TeamMenu {...props} /> : <TeamsPanel {...props} />)
  expect((await screen.findByRole('alert')).textContent).toContain('Previous connection failed')
  value.getTeams.mockRejectedValueOnce(new Error('Current connection failed'))
  const remote = { ...value.remote }
  await act(async () => { view.rerender(kind === 'menu' ? <TeamMenu {...props} remote={remote} /> : <TeamsPanel {...props} remote={remote} />) })
  expect(screen.getByRole('alert').textContent).toContain('Current connection failed')
  expect(value.getTeams).toHaveBeenCalledTimes(2)
})

it.each(['menu', 'panel'] as const)('keeps the %s retry error and selection until the directory recovers', async (kind) => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  value.getTeams.mockRejectedValue(new Error('Team directory unavailable'))
  render(kind === 'menu' ? <TeamMenu {...value} onSelected={vi.fn()} /> : <TeamsPanel {...value} />)
  const error = await screen.findByRole('alert')
  expect(error.textContent).toContain('Team directory unavailable')
  const search = screen.getByRole<HTMLInputElement>('textbox', { name: '搜索专家团' })
  fireEvent.change(search, { target: { value: 'team' } })
  const retry = Promise.withResolvers<Awaited<ReturnType<TeamRemote['getTeams']>>>()
  value.getTeams.mockReturnValueOnce(retry.promise)
  try {
    const refresh = screen.getByRole<HTMLButtonElement>('button', { name: kind === 'menu' ? '刷新' : '刷新重试' })
    act(() => { refresh.focus(); refresh.click(); refresh.click() })
    await waitFor(() => { expect(value.getTeams).toHaveBeenCalledTimes(2) })
    expect(screen.getByRole('alert')).toBe(error)
    expect(refresh.isConnected).toBe(true)
    expect(refresh.disabled).toBe(false)
    expect(document.activeElement).toBe(refresh)
    expect(refresh.getAttribute('aria-disabled')).toBe('true')
    expect(refresh.getAttribute('aria-busy')).toBe('true')
    expect({ query: search.value, error: error.textContent, label: refresh.textContent, busy: refresh.getAttribute('aria-busy') }).toMatchSnapshot()
    await act(async () => { retry.reject(new Error('Team directory still unavailable')); await retry.promise.catch(() => {}) })
    expect(screen.getByRole('alert').textContent).toContain('Team directory still unavailable')
    expect(document.activeElement).toBe(refresh)
    expect(search.value).toBe('team')
    expect(screen.getByText('Original team')).toBeTruthy()
    expect(value.cache.teams.getSnapshot()).toBe(original)
    value.getTeams.mockResolvedValue({ ok: true, value: current })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: kind === 'menu' ? '刷新' : '刷新重试' })) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(search.value).toBe('team')
    expect(screen.getByText('Current team')).toBeTruthy()
    expect(value.cache.teams.getSnapshot()).toBe(current)
  } finally {
    await act(async () => { retry.reject(new Error('Test disposed')); await retry.promise.catch(() => {}) })
  }
})

it('commits only the replacement directory when its mounted store changes', async () => {
  const first = fixture()
  const next = fixture()
  next.cache.teams.accept(current)
  next.getTeams.mockResolvedValue({ ok: true, value: current })
  const replacementCatalog = { experts: next.cache.catalog.getSnapshot().experts.map(expert => ({ ...expert, name: 'Replacement expert' })),
    enabled: original.enabledExperts, revision: 3 }
  next.cache.catalog.accept(replacementCatalog)
  next.getCatalog.mockResolvedValue({ ok: true, value: replacementCatalog })
  const commits: { team: string | undefined; expert: string | undefined }[] = []
  function Directory({ value }: { value: ReturnType<typeof fixture> }) {
    const directory = useTeamDirectory(value)
    useLayoutEffect(() => {
      commits.push({ team: directory.snapshot?.teams[0]?.name, expert: directory.experts[0]?.name })
    })
    return null
  }
  const view = render(<Directory value={first} />)
  await act(async () => { await first.cache.teams.refresh() })
  commits.length = 0
  view.rerender(<Directory value={next} />)
  await act(async () => { await next.cache.teams.refresh() })
  expect(commits.length).toBeGreaterThan(0)
  for (const commit of commits) expect(commit).toEqual({ team: 'Current team', expert: 'Replacement expert' })
  commits.length = 0
  act(() => { first.cache.teams.accept({ ...original, revision: 4 }); first.cache.catalog.reset() })
  expect(commits).toEqual([])
})

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

it('opens refreshed team details for editing with the matching content and revision', async () => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['getTeams']>>>()
  value.getTeams.mockReturnValueOnce(response.promise)
  const save = vi.fn<TeamRemote['saveTeam']>().mockResolvedValue({ ok: true, value: current })
  value.remote.saveTeam = save
  render(<TeamsPanel {...value} />)
  fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
  await act(async () => { response.resolve({ ok: true, value: current }); await response.promise })
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '编辑专家团' }))
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Current team' }), true, current.revision, expect.any(AbortSignal))
})

it.each((['menu', 'panel'] as const).flatMap(kind => [original.revision, current.revision].map(revision => ({ kind, revision }))))(
  'requires a new confirmation when the $kind team changes during a refresh at revision $revision', async ({ kind, revision }) => {
    const value = fixture()
    onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
    const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['getTeams']>>>()
    value.getTeams.mockReturnValueOnce(response.promise)
    const remove = vi.fn<TeamRemote['deleteTeam']>().mockResolvedValue({ ok: true, value: current })
    value.remote.deleteTeam = remove
    const insert = vi.fn(async () => true)
    const selected = vi.fn()
    if (kind === 'menu') value.cache.teams.accept({ ...original, enabledExperts: [] })
    render(kind === 'menu' ? <TeamMenu {...value} prepareSelect={() => insert} onSelected={selected} /> : <TeamsPanel {...value} />)
    if (kind === 'menu') {
      const button = screen.getByText(team.name).closest('button')
      if (!button) throw new Error('Team choice missing')
      fireEvent.click(button)
    } else {
      fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除专家团' }))
    }
    const confirm = screen.getByRole('button', { name: kind === 'menu' ? '启用团队及所需成员' : '确认删除' })
    await act(async () => { response.resolve({ ok: true, value: { ...current, revision } }); await response.promise })
    await act(async () => { fireEvent.click(confirm) })
    expect(value.setTeamEnabled).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
    expect(selected).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('配置已更新')
  },
)

it.each(['menu', 'panel'] as const)('keeps a %s confirmation valid when only execution metadata is refreshed', async (kind) => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['getTeams']>>>()
  value.getTeams.mockReturnValueOnce(response.promise)
  const remove = vi.fn<TeamRemote['deleteTeam']>().mockResolvedValue({ ok: true, value: { ...original, teams: [], revision: 2 } })
  value.remote.deleteTeam = remove
  const insert = vi.fn(async () => true)
  if (kind === 'menu') value.cache.teams.accept({ ...original, enabledExperts: [] })
  render(kind === 'menu' ? <TeamMenu {...value} prepareSelect={() => insert} onSelected={vi.fn()} /> : <TeamsPanel {...value} />)
  if (kind === 'menu') {
    const button = screen.getByText(team.name).closest('button')
    if (!button) throw new Error('Team choice missing')
    fireEvent.click(button)
  } else {
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除专家团' }))
  }
  const unchanged: TeamSnapshot = { ...value.cache.teams.getSnapshot()!,
    engine: { state: 'enabled', mode: 'native', reason: 'Available', recommendation: '' } }
  await act(async () => { response.resolve({ ok: true, value: unchanged }); await response.promise })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: kind === 'menu' ? '启用团队及所需成员' : '确认删除' })) })
  if (kind === 'menu') {
    expect(value.setTeamEnabled).toHaveBeenCalledWith(team.id, true, original.revision, expect.any(AbortSignal))
    expect(insert).toHaveBeenCalledWith(team, undefined)
  } else expect(remove).toHaveBeenCalledWith(team.id, original.revision, expect.any(AbortSignal))
})

it.each(['menu', 'panel'] as const)('retains a focused task example when the %s team directory removes an earlier example', async (kind) => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const retained = '复核订单资料'
  const initial = { ...original, teams: [{ ...team, examples: ['分析客户需求', retained, retained] }] }
  value.cache.teams.accept(initial)
  value.getTeams.mockResolvedValue({ ok: true, value: initial })
  const insert = vi.fn(async () => true)
  await act(async () => {
    render(kind === 'menu' ? <TeamMenu {...value} prepareSelect={() => insert} onSelected={vi.fn()} />
      : <TeamsPanel {...value} prepareSelect={() => insert} />)
  })
  fireEvent.click(screen.getByRole('button', { name: kind === 'menu' ? '查看Original team详情' : '查看详情' }))
  const dialog = within(screen.getByRole('dialog'))
  const example = dialog.getAllByRole('button', { name: `“${retained}”` })[0]
  act(() => { example.focus() })
  const next = { ...initial, teams: [{ ...team, examples: [retained] }], revision: 2 }
  act(() => { value.cache.teams.accept(next) })
  expect(dialog.getByRole('button', { name: `“${retained}”` })).toBe(example)
  expect(document.activeElement).toBe(example)
  expect({ example: example.textContent, focused: document.activeElement === example }).toMatchSnapshot('Refreshed task example')
  await act(async () => { fireEvent.click(example) })
  expect(insert).toHaveBeenCalledWith(next.teams[0], retained)
})

it.each((['menu', 'panel'] as const).flatMap(kind => (['zh', 'en'] as const)
  .flatMap(locale => [false, true].map(elsewhere => ({ kind, locale, elsewhere })))))(
  'returns a removed $kind task example to its detail title without taking another control ($locale, elsewhere=$elsewhere)', async ({ kind, locale, elsewhere }) => {
    const value = fixture()
    const initial = { ...original, teams: [{ ...team, examples: ['Removed example', 'Retained example'] }] }
    value.cache.teams.accept(initial)
    value.getTeams.mockResolvedValue({ ok: true, value: initial })
    const insert = vi.fn(async () => true)
    const view = render(<TeamLocaleContext.Provider value={locale}>
      {kind === 'menu' ? <TeamMenu {...value} prepareSelect={() => insert} onSelected={vi.fn()} />
        : <TeamsPanel {...value} prepareSelect={() => insert} />}
    </TeamLocaleContext.Provider>)
    onTestFinished(() => { view.unmount(); value.cache.catalog.dispose(); value.cache.teams.dispose() })
    await act(async () => { await value.cache.teams.refresh() })
    const search = screen.getByRole<HTMLInputElement>('textbox', { name: locale === 'zh' ? '搜索专家团' : 'Search teams' })
    fireEvent.change(search, { target: { value: 'team' } })
    search.setSelectionRange(1, 3)
    fireEvent.click(screen.getByRole('button', { name: kind === 'menu'
      ? locale === 'zh' ? '查看Original team详情' : 'View Original team details'
      : locale === 'zh' ? '查看详情' : 'View details' }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: locale === 'zh' ? '查看主理人提示词' : 'View coordinator prompt' }))
    const prompt = dialog.getByRole<HTMLTextAreaElement>('textbox', { name: locale === 'zh' ? '主理人提示词正文' : 'Coordinator prompt text' })
    prompt.setSelectionRange(1, 3)
    const example = dialog.getByRole('button', { name: '“Removed example”' })
    act(() => { example.focus() })
    const other = dialog.getByRole('button', { name: locale === 'zh' ? '关闭' : 'Close' })
    if (elsewhere) other.focus()
    act(() => { value.cache.teams.accept({ ...initial, teams: [{ ...initial.teams[0], examples: ['Retained example'] }], revision: 2 }) })
    expect(example.isConnected).toBe(false)
    expect(document.activeElement).toBe(elsewhere ? other : dialog.getByRole('heading', { name: team.name }))
    expect(screen.getByRole('textbox', { name: locale === 'zh' ? '搜索专家团' : 'Search teams' })).toBe(search)
    expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['team', 1, 3])
    expect(dialog.getByRole('textbox', { name: locale === 'zh' ? '主理人提示词正文' : 'Coordinator prompt text' })).toBe(prompt)
    expect([prompt.selectionStart, prompt.selectionEnd]).toEqual([1, 3])
    expect(insert).not.toHaveBeenCalled()
    expect(value.setTeamEnabled).not.toHaveBeenCalled()
  },
)

it('shows each distinct task example once in team details', async () => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const repeated = { ...original, teams: [{ ...team, examples: ['复核订单资料', '复核订单资料'] }] }
  value.cache.teams.accept(repeated)
  value.getTeams.mockResolvedValue({ ok: true, value: repeated })
  await act(async () => { render(<TeamsPanel {...value} />) })
  fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
  expect(within(screen.getByRole('dialog')).getAllByRole('button', { name: '“复核订单资料”' })).toHaveLength(1)
})

it('selects the current team from refreshed compact-menu details', async () => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['getTeams']>>>()
  value.getTeams.mockReturnValueOnce(response.promise)
  const insert = vi.fn(async () => true)
  render(<TeamMenu {...value} prepareSelect={() => insert} onSelected={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '查看Original team详情' }))
  await act(async () => { response.resolve({ ok: true, value: current }); await response.promise })
  await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '召唤专家团' })) })
  expect(insert).toHaveBeenCalledWith(current.teams[0], undefined)
})

it('reports composer preparation failures and allows selecting the team again', async () => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const insert = vi.fn(() => true)
  const prepareSelect = vi.fn(() => insert).mockImplementationOnce(() => { throw new Error('Chat input is unavailable') })
  const selected = vi.fn()
  await act(async () => { render(<TeamMenu {...value} prepareSelect={prepareSelect} onSelected={selected} />) })
  const choice = screen.getByRole('button', { name: /^Original team/ })
  await act(async () => { fireEvent.click(choice) })
  expect(screen.getByRole('alert').textContent).toContain('Chat input is unavailable')
  expect(selected).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(choice) })
  expect(insert).toHaveBeenCalledWith(team, undefined)
  expect(selected).toHaveBeenCalledOnce()
})

it.each((['menu', 'panel'] as const).flatMap(kind => (['renamed', 'disabled', 'removed'] as const)
  .flatMap(update => [1, 2, current.revision].map(revision => ({ kind, update, revision })))))(
  'uses the accepted directory at revision $revision after a $kind enable receipt while the team is $update', async ({ kind, update, revision }) => {
    const value = fixture()
    onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
    value.cache.teams.accept({ ...original, enabledExperts: [] })
    value.getTeams.mockResolvedValue({ ok: true, value: value.cache.teams.getSnapshot()! })
    const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['setTeamEnabled']>>>()
    value.setTeamEnabled.mockReturnValueOnce(response.promise)
    const insert = vi.fn(async () => true)
    const selected = vi.fn()
    render(kind === 'menu' ? <TeamMenu {...value} prepareSelect={() => insert} onSelected={selected} />
      : <TeamsPanel {...value} prepareSelect={() => insert} />)
    await act(async () => { await Promise.resolve() })
    if (kind === 'menu') {
      const button = screen.getByText(team.name).closest('button')
      if (!button) throw new Error('Team choice missing')
      fireEvent.click(button)
    } else {
      fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '召唤专家团' }))
    }
    fireEvent.click(screen.getByRole('button', { name: '启用团队及所需成员' }))
    expect(value.setTeamEnabled).toHaveBeenCalledOnce()
    const latest = { ...current, revision, ...(update === 'disabled' ? { enabledTeams: [] } : update === 'removed' ? { teams: [] } : {}) }
    value.getTeams.mockResolvedValue({ ok: true, value: { ...latest, revision: Math.max(2, revision) } })
    act(() => { value.cache.teams.accept(latest) })
    await act(async () => { response.resolve({ ok: true, value: { ...original, revision: 2 } }); await response.promise })
    if (update === 'renamed') expect(insert).toHaveBeenCalledWith(current.teams[0], undefined)
    else {
      expect(insert).not.toHaveBeenCalled()
      expect(selected).not.toHaveBeenCalled()
    }
  },
)

it('preserves an editable team draft without reporting a cancelled save after Host reset', async () => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['saveTeam']>>>()
  const save = vi.fn<TeamRemote['saveTeam']>().mockReturnValueOnce(response.promise)
  value.remote.saveTeam = save
  const onSaved = vi.fn()
  await act(async () => { render(<TeamsPanel {...value} onSaved={onSaved} />) })
  fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '编辑专家团' }))
  fireEvent.change(screen.getByRole('textbox', { name: '团队名称' }), { target: { value: 'My unsaved draft' } })
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  const catalog = value.cache.catalog.getSnapshot()
  await act(async () => {
    value.cache.teams.reset(); value.cache.catalog.reset()
    value.cache.teams.accept({ ...original, revision: 0 })
    value.cache.catalog.accept({ experts: [...catalog.experts], enabled: [...catalog.enabled], revision: 0 })
  })
  expect(save.mock.calls[0]?.[3]?.aborted).toBe(true)
  await act(async () => { response.resolve({ ok: true, value: { ...original, revision: 9 } }); await response.promise })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('textbox', { name: '团队名称' })).toHaveProperty('value', 'My unsaved draft')
  expect(screen.getByRole('button', { name: '保存修改' })).toHaveProperty('disabled', false)
  expect(onSaved).not.toHaveBeenCalled()
  expect(value.cache.teams.getSnapshot()?.revision).toBe(0)
})

it('closes a committed team editor when the follow-up directory read fails and retries only the read', async () => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['saveTeam']>>>()
  const save = vi.fn<TeamRemote['saveTeam']>().mockReturnValueOnce(response.promise)
  value.remote.saveTeam = save
  const onSaved = vi.fn()
  render(<TeamsPanel {...value} onSaved={onSaved} />)
  await act(async () => { await Promise.resolve() })
  const search = screen.getByRole<HTMLInputElement>('textbox', { name: '搜索专家团' })
  fireEvent.change(search, { target: { value: 'Original' } })
  search.setSelectionRange(1, 3)
  const details = screen.getByRole('button', { name: '查看详情' })
  details.focus()
  fireEvent.click(details)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '编辑专家团' }))
  const action = screen.getByRole('button', { name: '保存修改' })
  action.focus()
  fireEvent.click(action)
  expect(save).toHaveBeenCalledOnce()
  act(() => { value.cache.teams.accept({ ...current, revision: 1 }) })
  value.getTeams.mockRejectedValueOnce(new Error('Directory unavailable after commit'))
  await act(async () => { response.resolve({ ok: true, value: { ...original, revision: 2 } }); await response.promise })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('专家团配置已保存')
  expect(screen.getByRole('alert').textContent).toContain('Directory unavailable after commit')
  expect(onSaved).toHaveBeenCalledOnce()
  expect(screen.getByRole('textbox', { name: '搜索专家团' })).toBe(search)
  expect({ query: search.value, selection: [search.selectionStart, search.selectionEnd],
    focusedSearch: document.activeElement === search, writes: save.mock.calls.length }).toMatchInlineSnapshot(`
      {
        "focusedSearch": true,
        "query": "Original",
        "selection": [
          1,
          3,
        ],
        "writes": 1,
      }
    `)
  value.getTeams.mockResolvedValueOnce({ ok: true, value: current })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新重试' })) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(save).toHaveBeenCalledOnce()
  expect(onSaved).toHaveBeenCalledOnce()
})

it.each(['menu', 'panel'] as const)('stops %s selection when the committed enable needs a directory read that fails', async (kind) => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  value.cache.teams.accept({ ...original, enabledExperts: [] })
  value.getTeams.mockResolvedValue({ ok: true, value: value.cache.teams.getSnapshot()! })
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['setTeamEnabled']>>>()
  value.setTeamEnabled.mockReturnValueOnce(response.promise)
  const insert = vi.fn(async () => true)
  const selected = vi.fn()
  render(kind === 'menu' ? <TeamMenu {...value} prepareSelect={() => insert} onSelected={selected} />
    : <TeamsPanel {...value} prepareSelect={() => insert} />)
  await act(async () => { await Promise.resolve() })
  fireEvent.click(screen.getByRole('button', { name: kind === 'menu' ? '查看Original team详情' : '查看详情' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '召唤专家团' }))
  fireEvent.click(screen.getByRole('button', { name: '启用团队及所需成员' }))
  act(() => { value.cache.teams.accept({ ...current, revision: 1 }) })
  value.getTeams.mockRejectedValueOnce(new Error('Directory unavailable after commit'))
  await act(async () => { response.resolve({ ok: true, value: { ...original, revision: 2 } }); await response.promise })
  expect(insert).not.toHaveBeenCalled()
  expect(selected).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '启用团队及所需成员' })).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('Directory unavailable after commit')
  const refresh = Promise.withResolvers<Awaited<ReturnType<TeamRemote['getTeams']>>>()
  value.getTeams.mockReturnValueOnce(refresh.promise)
  const before = value.getTeams.mock.calls.length
  const error = screen.getByRole('alert')
  const retry = within(screen.getByRole('dialog')).getByRole('button', { name: kind === 'menu' ? '刷新' : '刷新重试' })
  await act(async () => { fireEvent.click(retry); fireEvent.click(retry) })
  expect(value.getTeams).toHaveBeenCalledTimes(before + 1)
  expect(screen.getByRole('alert')).toBe(error)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  await act(async () => { refresh.resolve({ ok: true, value: current }); await refresh.promise })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(value.setTeamEnabled).toHaveBeenCalledOnce()
})

it.each((['menu', 'panel'] as const).flatMap(kind => (['reset', 'removed'] as const).map(update => ({ kind, update }))))(
  'closes $kind details after the directory is $update without reopening them when the team returns', async ({ kind, update }) => {
    const value = fixture()
    onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
    render(kind === 'menu' ? <TeamMenu {...value} onSelected={vi.fn()} /> : <TeamsPanel {...value} />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: kind === 'menu' ? '查看Original team详情' : '查看详情' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    act(() => { if (update === 'reset') value.cache.teams.reset(); else value.cache.teams.accept({ ...current, teams: [] }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { value.cache.teams.accept({ ...original, revision: 4 }) })
    expect(screen.queryByRole('dialog')).toBeNull()
  },
)

it('retains an open editor draft and its reviewed revision when the directory changes', async () => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const save = vi.fn<TeamRemote['saveTeam']>().mockResolvedValue({ ok: true, value: current })
  value.remote.saveTeam = save
  render(<TeamsPanel {...value} />)
  await act(async () => { await Promise.resolve() })
  fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '编辑专家团' }))
  fireEvent.change(screen.getByRole('textbox', { name: '团队名称' }), { target: { value: 'My unsaved draft' } })
  act(() => { value.cache.teams.accept(current) })
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '团队名称' }).value).toBe('My unsaved draft')
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'My unsaved draft' }), true, original.revision, expect.any(AbortSignal))
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

it('keeps team toggle progress local and retains controls through failure and retry', async () => {
  const value = fixture()
  const second = { ...team, id: 'second-team', name: 'Second team' }
  const snapshot = { ...original, teams: [team, second] }
  value.cache.teams.accept(snapshot)
  value.getTeams.mockResolvedValue({ ok: true, value: snapshot })
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['setTeamEnabled']>>>()
  const retried = Promise.withResolvers<Awaited<ReturnType<TeamRemote['setTeamEnabled']>>>()
  value.setTeamEnabled.mockReturnValueOnce(response.promise).mockReturnValueOnce(retried.promise)
  const view = render(<TeamsPanel {...value} />)
  onTestFinished(() => {
    view.unmount(); response.resolve({ ok: true, value: snapshot }); retried.resolve({ ok: true, value: snapshot })
    value.cache.catalog.dispose(); value.cache.teams.dispose()
  })
  await act(async () => { await value.cache.teams.refresh() })
  const search = screen.getByRole<HTMLInputElement>('textbox', { name: '搜索专家团' })
  fireEvent.change(search, { target: { value: 'team' } })
  search.setSelectionRange(1, 3)
  const [toggle, neighbor] = screen.getAllByRole<HTMLButtonElement>('switch')
  const edit = within(neighbor.closest('article')!).getByRole<HTMLButtonElement>('button', { name: '编辑专家团' })
  toggle.focus(); fireEvent.click(toggle)
  expect(value.setTeamEnabled).toHaveBeenCalledOnce()
  expect(toggle.disabled).toBe(false)
  expect(toggle.parentElement?.getAttribute('aria-busy')).toBe('true')
  expect(neighbor.parentElement?.getAttribute('aria-busy')).toBe('false')
  expect(neighbor.disabled).toBe(false)
  expect(edit.disabled).toBe(false)
  expect(edit.getAttribute('aria-disabled')).toBe('true')
  expect(edit.getAttribute('aria-busy')).not.toBe('true')
  fireEvent.click(toggle); fireEvent.click(neighbor); fireEvent.click(edit)
  expect(value.setTeamEnabled).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => { response.reject(new Error('Settings offline')) })
  expect(screen.getByRole('alert').textContent).toContain('Settings offline')
  expect(document.activeElement).toBe(toggle)
  fireEvent.click(toggle)
  expect(value.setTeamEnabled).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('alert').textContent).toContain('Settings offline')
  await act(async () => { retried.resolve({ ok: true, value: { ...snapshot, enabledTeams: [], revision: 2 } }) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(document.activeElement).toBe(toggle)
  expect(screen.getAllByRole('switch')).toEqual([toggle, neighbor])
  expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['team', 1, 3])
})


it.each(['error', 'close'] as const)('retains team detail controls and recovers removed feedback focus from %s', (focus) => {
  const props = { team, experts: [], close: vi.fn(), onSelect: vi.fn(), onRefresh: vi.fn() }
  const view = render(<TeamLocaleContext.Provider value="en"><TeamDetails {...props} /></TeamLocaleContext.Provider>)
  const dialog = screen.getByRole('dialog'), action = screen.getByRole('button', { name: 'Use team' })
  fireEvent.click(screen.getByRole('button', { name: 'View coordinator prompt' }))
  const prompt = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Coordinator prompt text' })
  prompt.setSelectionRange(1, 6)
  view.rerender(<TeamLocaleContext.Provider value="en"><TeamDetails {...props} error="Read the current team and retry." /></TeamLocaleContext.Provider>)
  const alert = screen.getByRole('alert'), retry = screen.getByRole('button', { name: 'Refresh and retry' })
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(screen.getByRole('button', { name: 'Use team' })).toBe(action)
  view.rerender(<TeamLocaleContext.Provider value="en"><TeamDetails {...props} error="Read the current team and retry." busy /></TeamLocaleContext.Provider>)
  retry.focus(); fireEvent.click(retry)
  expect(props.onRefresh).not.toHaveBeenCalled()
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(retry.getAttribute('aria-busy')).toBe('false')
  view.rerender(<TeamLocaleContext.Provider value="en"><TeamDetails {...props} error="Read the current team and retry." /></TeamLocaleContext.Provider>)
  retry.focus(); fireEvent.click(retry)
  expect(props.onRefresh).toHaveBeenCalledOnce()
  view.rerender(<TeamLocaleContext.Provider value="en"><TeamDetails {...props} error="Read the current team and retry." refreshing /></TeamLocaleContext.Provider>)
  fireEvent.click(retry)
  expect(props.onRefresh).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert')).toBe(alert)
  expect(screen.getByRole('button', { name: 'Refresh and retry' })).toBe(retry)
  const target = focus === 'error' ? screen.getByRole('region', { name: 'Read the current team and retry.' }) : screen.getByRole('button', { name: 'Close' })
  target.focus()
  expect(document.activeElement).toBe(target)
  view.rerender(<TeamLocaleContext.Provider value="en"><TeamDetails {...props} /></TeamLocaleContext.Provider>)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(document.activeElement).toBe(focus === 'error' ? screen.getByRole('heading', { name: team.name }) : target)
  expect(screen.getByRole('textbox', { name: 'Coordinator prompt text' })).toBe(prompt)
  expect([prompt.selectionStart, prompt.selectionEnd]).toEqual([1, 6])
  expect(props.onSelect).not.toHaveBeenCalled()
})
