// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ComponentType } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import * as Skills from '../src/client.ts'
import type { ManagerSnapshot, SectionProps } from '../src/client-types.ts'
import type { RootView, SkillView } from '../src/types.ts'

afterEach(() => { cleanup(); document.querySelector('base')?.remove(); vi.unstubAllGlobals() })

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function skill(name: string): SkillView {
  return { name, declaredName: name, description: `${name}说明`, kind: 'directory', path: `/skills/${name}`,
    modelInvocable: true, userInvocable: true, invocationPolicyValid: true, hasFrontmatter: true, loadable: true,
    diagnostics: [], managerEnabled: true, managerOverride: null, effectiveModelInvocable: true, effectiveUserInvocable: true }
}
function root(key: string, skills: SkillView[]): RootView {
  return { key, path: `/skills/${key}`, label: key, rank: 0, mutable: key !== 'company', native: true, toggleable: true,
    exists: true, truncated: false, enabled: true, skills, categories: [] }
}
async function setup(shared: boolean, includeCompany = true, personal = skill('个人技能'), gate?: Promise<void>) {
  const data: ManagerSnapshot = { roots: [...(includeCompany ? [root('company', shared ? [skill('共享技能')] : [])] : []), root('dsh', [personal])],
    writeDestinations: [], projects: [], summary: { total: 2, enabled: 2, disabled: 0, issues: 0 }, trash: [], warnings: [] }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { await gate; return new Response(JSON.stringify({ ok: true, data: url.endsWith('/workspaces') ? { items: [] } : data }), { headers: { 'content-type': 'application/json' } }) }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' } } }, (props: PropsRenderSlots<'main'>) => { void props.renderSlot; return null })
  await ctx.plugin(Skills).await()
  const entry = slots.entries('main').find(item => item.options.key === 'deepseek-harness-skills')
  if (!entry) throw new Error('Missing skills page registration')
  render(createElement(entry.component as ComponentType<SectionProps>, { t: (key: string, params?: object) => locale.bind('skills-manager')(key, { ...params }) }))
  return data
}

it('shows published company skills in Market and preserves local, project, repository and trash views in Mine', async () => {
  await setup(true)
  await screen.findByText('共享技能')
  expect(screen.queryByText('个人技能')).toBeNull()
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['市场', '我的'])
  expect(screen.queryByRole('button', { name: '创建技能' })).toBeNull()
  expect(screen.queryByRole('button', { name: '导入技能' })).toBeNull()
  expect(screen.queryByRole('button', { name: '新建分类' })).toBeNull()
  expect(screen.queryByRole('switch', { name: '启停来源 市场' })).toBeNull()
  expect(screen.getByRole('switch', { name: '使用市场技能' })).toBeTruthy()
  expect(screen.getByRole('switch', { name: '启停技能 共享技能' })).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  expect(screen.queryByText('共享技能')).toBeNull()
  expect(screen.getByRole('button', { name: '创建技能' }).textContent).toBe('创建技能')
  expect(screen.getByRole('button', { name: '导入技能' }).textContent).toBe('导入技能')
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toMatchInlineSnapshot(`
    [
      "市场",
      "我的",
      "本机技能",
      "项目技能",
      "发现技能",
      "回收站",
    ]
  `)
  fireEvent.click(screen.getByRole('button', { name: /DSH/, expanded: false }))
  expect(screen.getByText('个人技能')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: '市场' }))
  expect(screen.getByText('共享技能')).toBeTruthy()
  expect(screen.queryByText('个人技能')).toBeNull()
})

it.each([true, false])('shows a publication empty state with company root present=%s', async (includeCompany) => {
  await setup(false, includeCompany)
  await screen.findByText('市场暂无技能，审核发布后会展示在这里。')
  fireEvent.change(screen.getByRole('textbox', { name: '搜索' }), { target: { value: '不存在' } })
  expect(screen.getByText('没有匹配的技能。')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '搜索' }).value).toBe('')
  fireEvent.click(screen.getByRole('tab', { name: '市场' }))
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '搜索' }).value).toBe('不存在')
})

it('loads the embedded skills page through a reverse-proxy path prefix', async () => {
  const base = document.createElement('base')
  base.href = 'https://harness.test/traefik/harness/'
  document.head.appendChild(base)
  await setup(true)
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('tab', { name: '项目技能' }))
  await screen.findByText('还没有已登记的工作区。请先在侧栏添加工作区。')
  const urls = vi.mocked(fetch).mock.calls.map(([url]) => requestUrl(url))
  expect(urls).toContain('https://harness.test/traefik/harness/api/dsh-skills-manager/state')
  expect(urls).toContain('https://harness.test/traefik/harness/api/dsh-skills-manager/workspaces')
  expect(urls.every(url => url.startsWith('https://harness.test/traefik/harness/api/dsh-skills-manager/'))).toBe(true)
})

it.each([true, false])('only permits revocation for a broken skill with recorded enablement=%s', async (recorded) => {
  const broken: SkillView = { ...skill('audit-orders'), loadable: false, enabled: recorded,
    managerOverride: recorded, managerEnabled: recorded, hasFrontmatter: false, invocationPolicyValid: false }
  await setup(false, true, broken)
  await screen.findByText('市场暂无技能，审核发布后会展示在这里。')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: /DSH/, expanded: false }))
  const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: '启停技能 audit-orders' })
  expect(toggle.disabled).toBe(!recorded)
  if (recorded) {
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([url, options]) =>
        requestUrl(url).endsWith('/api/dsh-skills-manager/disable') && options?.body === JSON.stringify({ root: 'dsh', name: 'audit-orders' }))).toBe(true)
    })
  }
})

it.each([
  ['shadowed', true], ['shadowed', false], ['unloadable', true], ['unloadable', false],
] as const)('filters %s skills by their enablement switch (%s), with the cause shown on the row', async (condition, enabled) => {
  const personal: SkillView = { ...skill('audit-orders'), enabled, managerOverride: enabled,
    ...(condition === 'shadowed' ? { shadowedBy: { root: 'codex', name: 'audit-orders' } } : { loadable: false }) }
  await setup(false, true, personal)
  await screen.findByText('市场暂无技能，审核发布后会展示在这里。')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  expect(screen.getByRole('tabpanel', { name: '我的' }).textContent).toContain(`${enabled ? 1 : 0} 个已启用`)
  expect(screen.getByRole('tabpanel', { name: '我的' }).textContent).toContain(`${enabled ? 0 : 1} 个已停用`)
  fireEvent.click(screen.getByRole('combobox', { name: '启用状态' }))
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['全部状态', '已启用', '已停用'])
  fireEvent.click(screen.getByRole('menuitem', { name: enabled ? '已启用' : '已停用' }))
  expect(screen.getByText('audit-orders')).toBeTruthy()
  expect(screen.getByText(condition === 'shadowed' ? '同名技能优先使用 codex 中的版本' : '技能内容无法加载，请查看详情中的具体原因。')).toBeTruthy()
  fireEvent.click(screen.getByRole('combobox', { name: '启用状态' }))
  fireEvent.click(screen.getByRole('menuitem', { name: enabled ? '已停用' : '已启用' }))
  expect(screen.queryByText('audit-orders')).toBeNull()
})


it('shows unknown skill counts and an accessible indicator while the initial read is pending', async () => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  await setup(true, true, skill('个人技能'), gate)
  expect([...document.querySelectorAll('.dssm-stat strong')].map(node => node.textContent)).toEqual(['—', '—', '—'])
  expect(screen.getByRole('status', { name: '正在加载技能…' }).textContent).toBe('')
  expect(screen.queryByText('正在加载技能…')).toBeNull()
  expect(screen.queryByText('市场暂无技能，审核发布后会展示在这里。')).toBeNull()
  await act(async () => { finish(); await gate })
  await screen.findByText('共享技能')
  expect([...document.querySelectorAll('.dssm-stat strong')].map(node => node.textContent)).toEqual(['1', '1', '0'])
})

it.each([false, true])('preserves loaded project skills and empty results while refreshing (empty: %s)', async (empty) => {
  const data = await setup(true)
  await screen.findByText('共享技能')
  const entries = [{ name: '项目', available: true, registeredPaths: ['/workspace'] }]
  let refreshing = false
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = requestUrl(input)
    if (refreshing && (url.endsWith('/workspaces') || url.endsWith('/workspace-skills'))) await gate
    return new Response(JSON.stringify({ ok: true, data: url.endsWith('/workspaces') ? { items: entries }
      : url.endsWith('/workspace-skills') ? { roots: empty ? [] : [root('dsh', [skill('项目技能')])] } : data }))
  })
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('tab', { name: /项目技能/ }))
  const text = empty ? '这个工作区还没有技能。' : '项目技能'
  // The nonempty row and the confirmed empty state both survive a refresh.
  const panel = await screen.findByRole('tabpanel', { name: /项目技能/ })
  await waitFor(() => { expect(panel.getAttribute('aria-busy')).toBe('false') })
  const content = panel.textContent
  expect(content).toContain(text)
  refreshing = true
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(screen.getByRole('tabpanel', { name: /项目技能/ })).toBe(panel)
  expect(panel.textContent).toBe(content)
  expect(panel.getAttribute('aria-busy')).toBe('true')
  expect(screen.queryByText('正在读取工作区技能…')).toBeNull()
  await act(async () => { finish(); await gate })
  await waitFor(() => { expect(panel.getAttribute('aria-busy')).toBe('false') })
  expect(panel.textContent).toBe(content)
})
