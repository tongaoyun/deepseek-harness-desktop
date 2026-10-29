// @vitest-environment jsdom
import { createExpertClientState } from '../src/client/client-state.ts'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { AgencySettingsPanel } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

function setup(shared: boolean, gate?: Promise<void>) {
  const experts = [{ slug: 'personal', name: '个人专家', nameEn: 'Personal', description: '我的说明', descriptionEn: '', emoji: '🧩', division: 'orders', divisionZh: '订单', custom: true },
    ...(shared ? [{ slug: 'shared', name: '共享专家', nameEn: 'Shared', description: '市场说明', descriptionEn: '', emoji: '🧩', division: 'orders', divisionZh: '订单', custom: false, company: true }] : [])]
  const remote: ComponentProps<typeof AgencySettingsPanel>['remote'] = {
    getCatalog: vi.fn(async () => { await gate; return { ok: true as const, value: { experts, enabled: [], revision: 0 } } }),
    getEnabled: async () => ({ ok: true, value: { enabled: [], revision: 0 } }),
    getPrompt: async () => ({ ok: true, value: { prompt: '说明' } }),
    setEnabled: vi.fn(), getCustomExpert: vi.fn(), saveCustomExpert: vi.fn(), deleteCustomExpert: vi.fn(),
    getTeams: async () => { await gate; return { ok: true, value: { teams: [], enabledTeams: [], enabledExperts: [], revision: 0 } } },
  }
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const locale = new LocaleRuntime(ctx)
  locale.register('agency', { zh, en })
  locale.setLocale('zh')
  const cache = createExpertClientState(remote)
  const view = render(<AgencySettingsPanel cache={cache} remote={remote} t={locale.bind('agency')} getActive={() => 'zh'} prepareTeamSelection={() => () => true} />)
  return { remote, cache, ...view }
}

for (const action of ['edit', 'prompt'] as const) {
  it.each(['source', 'view', 'reset', 'unmount'] as const)(`${action} cancels its native read on %s and ignores late success`, async (change) => {
    const { remote, cache, unmount } = setup(true)
    const custom = Promise.withResolvers<Awaited<ReturnType<typeof remote.getCustomExpert>>>()
    const prompt = Promise.withResolvers<Awaited<ReturnType<typeof remote.getPrompt>>>()
    const readCustom = vi.spyOn(remote, 'getCustomExpert').mockReturnValue(custom.promise)
    const readPrompt = vi.spyOn(remote, 'getPrompt').mockReturnValue(prompt.promise)
    await screen.findByText('共享专家')
    fireEvent.click(screen.getByRole('tab', { name: '我的' }))
    fireEvent.click(screen.getByRole('button', { name: zh[action === 'edit' ? 'custom.edit' : 'settings.viewPromptTitle'] }))
    const signal = action === 'edit' ? readCustom.mock.calls[0]?.[1] : readPrompt.mock.calls[0]?.[2]
    if (change === 'source') fireEvent.click(screen.getByRole('tab', { name: '市场' }))
    else if (change === 'view') fireEvent.click(screen.getByRole('tab', { name: /专家团/ }))
    else if (change === 'reset') await act(async () => { cache.catalog.reset() })
    else unmount()
    await act(async () => {
      custom.resolve({ ok: true, value: { slug: 'personal', name: '个人专家', description: '我的说明', division: 'orders', prompt: '迟到的正文' } })
      prompt.resolve({ ok: true, value: { prompt: '迟到的正文' } })
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(signal?.aborted).toBe(true)
    cache.catalog.dispose(); cache.teams.dispose()
  })
}

it('separates marketplace experts from personal experts and exposes expert teams in both sources', async () => {
  setup(true)
  await screen.findByText('共享专家')
  expect(screen.queryByText('个人专家')).toBeNull()
  expect(screen.getByRole('tab', { name: /专家团/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  expect(screen.getByText('个人专家')).toBeTruthy()
  expect(screen.queryByText('共享专家')).toBeNull()
  expect(screen.getByRole('tab', { name: /专家团/ })).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: zh['settings.search'] }), { target: { value: '不存在' } })
  fireEvent.click(screen.getByRole('button', { name: zh['settings.empty.reset'] }))
  expect(screen.getByRole('tab', { name: '我的', selected: true })).toBeTruthy()
  expect(screen.getByText('个人专家')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: /专家团/ }))
  expect(screen.getByRole('tab', { name: /专家团/, selected: true })).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: '市场' }))
  expect(screen.getByRole('tab', { name: /专家团/, selected: true })).toBeTruthy()
  await screen.findByText('审核发布后的专家团会展示在这里。')
  expect(screen.queryByRole('button', { name: '清除筛选' })).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: '搜索专家团' }), { target: { value: '订单' } })
  fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
  expect(screen.getByRole('textbox', { name: '搜索专家团' }).getAttribute('value')).toBe('')
  fireEvent.click(screen.getByRole('tab', { name: /^专家(?!团)/ }))
  expect(screen.getByText('共享专家')).toBeTruthy()
})

it('distinguishes an unpublished marketplace from a filtered empty result', async () => {
  setup(false)
  await screen.findByText(zh['settings.market.empty'])
  expect(screen.queryByRole('button', { name: zh['settings.empty.reset'] })).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: zh['settings.search'] }), { target: { value: '订单' } })
  expect(screen.queryByText(zh['settings.market.empty'])).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh['settings.empty.reset'] }))
  expect(screen.getByRole('tab', { name: '市场', selected: true })).toBeTruthy()
  expect(screen.getByText(zh['settings.market.empty']).textContent).toMatchInlineSnapshot('"市场暂无专家套件，审核发布后会展示在这里。"')
})


it('keeps expert filters in place and does not show zero counts or temporary copy before catalog reads finish', async () => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  setup(true, gate)
  const search = screen.getByRole('textbox', { name: zh['settings.search'] })
  expect(screen.getByRole('status', { name: zh['settings.loading'] }).textContent).toBe('')
  expect(screen.queryByText(zh['settings.loading'])).toBeNull()
  expect(screen.queryByText(zh['settings.market.empty'])).toBeNull()
  const counters = [...document.querySelectorAll('.aag-tab-count strong')]
  expect(counters).toHaveLength(4)
  expect(counters.map(node => node.textContent)).toEqual(['—', '—', '—', '—'])
  await act(async () => { finish(); await gate })
  await screen.findByText('共享专家')
  expect(screen.getByRole('textbox', { name: zh['settings.search'] })).toBe(search)
  expect(counters.map(node => node.textContent)).toEqual(['1', '0', '0', '0'])
})
