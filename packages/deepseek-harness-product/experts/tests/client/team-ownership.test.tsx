// @vitest-environment jsdom
/** Expert-team views follow the native store and their current mounted operations. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createExpertClientState } from '../../src/client/client-state.ts'
import { TeamMenu } from '../../src/client/team-composer.tsx'
import { TeamsPanel, type TeamRemote } from '../../src/client/team-ui.tsx'
import { TEST_TEAMS } from '../../src/fixtures/teams.ts'
import type { TeamSnapshot } from '../../src/team-contract.ts'
import { useTeamDirectory } from '../../src/client/team-directory.ts'

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

it.each(['menu', 'panel'] as const)('keeps the %s retry error and selection until the directory recovers', async (kind) => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  value.getTeams.mockRejectedValue(new Error('Team directory unavailable'))
  render(kind === 'menu' ? <TeamMenu {...value} onSelected={vi.fn()} /> : <TeamsPanel {...value} />)
  expect((await screen.findByRole('alert')).textContent).toContain('Team directory unavailable')
  const search = screen.getByRole<HTMLInputElement>('textbox', { name: '搜索专家团' })
  fireEvent.change(search, { target: { value: 'team' } })
  const retry = Promise.withResolvers<Awaited<ReturnType<TeamRemote['getTeams']>>>()
  value.getTeams.mockReturnValueOnce(retry.promise)
  try {
    fireEvent.click(screen.getByRole('button', { name: kind === 'menu' ? '刷新' : '刷新重试' }))
    await act(async () => { retry.reject(new Error('Team directory still unavailable')); await retry.promise.catch(() => {}) })
    expect(screen.getByRole('alert').textContent).toContain('Team directory still unavailable')
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

it('closes a committed team editor when the follow-up directory read fails and retries only the read', async () => {
  const value = fixture()
  onTestFinished(() => { value.cache.catalog.dispose(); value.cache.teams.dispose() })
  const response = Promise.withResolvers<Awaited<ReturnType<TeamRemote['saveTeam']>>>()
  const save = vi.fn<TeamRemote['saveTeam']>().mockReturnValueOnce(response.promise)
  value.remote.saveTeam = save
  const onSaved = vi.fn()
  render(<TeamsPanel {...value} onSaved={onSaved} />)
  await act(async () => { await Promise.resolve() })
  fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '编辑专家团' }))
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  expect(save).toHaveBeenCalledOnce()
  act(() => { value.cache.teams.accept({ ...current, revision: 1 }) })
  value.getTeams.mockRejectedValueOnce(new Error('Directory unavailable after commit'))
  await act(async () => { response.resolve({ ok: true, value: { ...original, revision: 2 } }); await response.promise })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('专家团配置已保存')
  expect(screen.getByRole('alert').textContent).toContain('Directory unavailable after commit')
  expect(onSaved).toHaveBeenCalledOnce()
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
  value.getTeams.mockResolvedValueOnce({ ok: true, value: current })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: kind === 'menu' ? '刷新' : '刷新重试' })) })
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
