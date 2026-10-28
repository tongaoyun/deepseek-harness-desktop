// @vitest-environment jsdom
import { RemoteMock, ok } from '@deepseek-ai/dsh-remote-mock'
import { Modal as NativeModal } from '@deepseek-ai/dsh-client-ui-primitives'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
let remoteMock: RemoteMock
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, type ComponentType } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import * as Skills from '../src/client.ts'
import type { ManagerSnapshot, SectionProps } from '../src/client-types.ts'
import type { RootView, SkillView } from '../src/types.ts'

afterEach(() => { cleanup(); document.querySelector('base')?.remove(); vi.unstubAllGlobals() })

it.each([
  { name: 'IME', init: { isComposing: true } },
  { name: 'legacy IME', init: { keyCode: 229 } },
  { name: 'modified shortcut', init: { ctrlKey: true } },
  { name: 'held key', init: { repeat: true } },
  { name: 'Shift shortcut', init: { shiftKey: true } },
])('preserves the skill draft when Escape belongs to $name', async ({ init }) => {
  await setup(false)
  await screen.findByText('市场暂无技能，审核发布后会展示在这里。')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '创建技能' }))
  const dialog = screen.getByRole('dialog', { name: '创建技能' })
  const body = dialog.querySelector('textarea')
  if (!body) throw new Error('Skill body missing')
  fireEvent.change(body, { target: { value: 'Keep this draft' } })
  fireEvent.keyDown(body, { key: 'Escape', ...init })
  expect(screen.getByRole('dialog', { name: '创建技能' })).toBe(dialog)
  expect(body.value).toBe('Keep this draft')
})

it('keeps an IME closing Escape in the draft, then restores focus after a separate dismissal', async () => {
  await setup(false)
  await screen.findByText('市场暂无技能，审核发布后会展示在这里。')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  const trigger = screen.getByRole('button', { name: '创建技能' })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name: '创建技能' })
  const body = dialog.querySelector('textarea')
  if (!body) throw new Error('Skill body missing')
  body.focus()
  fireEvent.change(body, { target: { value: '输入技能说明' } })
  fireEvent.compositionStart(body)
  fireEvent.compositionEnd(body)
  fireEvent.keyDown(body, { key: 'Escape' })
  expect({ title: screen.getByRole('dialog').getAttribute('aria-label'), body: body.value }).toMatchInlineSnapshot(`
    {
      "body": "输入技能说明",
      "title": "创建技能",
    }
  `)
  fireEvent.keyUp(body, { key: 'Escape' })
  fireEvent.keyDown(body, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('lets a foreground native dialog own Escape before the skill editor', async () => {
  await setup(false)
  await screen.findByText('市场暂无技能，审核发布后会展示在这里。')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '创建技能' }))
  const dialog = screen.getByRole('dialog', { name: '创建技能' })
  const close = vi.fn()
  const foreground = render(createElement(NativeModal, { open: true, title: 'Foreground', closeLabel: 'Close foreground', onClose: close }))
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Foreground' }), { key: 'Escape' })
  expect(close).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('dialog', { name: '创建技能' })).toBe(dialog)
  foreground.unmount()
  fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('dismisses a destination menu before its skill editor', async () => {
  await setup(false)
  await screen.findByText('市场暂无技能，审核发布后会展示在这里。')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '创建技能' }))
  const dialog = screen.getByRole('dialog', { name: '创建技能' })
  const trigger = within(dialog).getByRole('combobox', { name: '范围' })
  trigger.focus()
  fireEvent.click(trigger)
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.getByRole('dialog', { name: '创建技能' })).toBe(dialog)
  expect(document.activeElement).toBe(trigger)
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['zh', 'en'] as const)('shows a workspace registry failure instead of an empty project directory (%s)', async (locale) => {
  await setup(false, false, skill('audit-orders'), undefined, locale)
  await screen.findByText(locale === 'zh' ? '市场暂无技能，审核发布后会展示在这里。' : 'No skills in the marketplace yet. Approved publications will appear here.')
  remoteMock.unary('skillsManager/listWorkspaces', () => ({ ok: false, error: new RemoteError('skills/operation', 'Could not read registered workspaces', {
    code: 'error.workspace.registryUnavailable', error: 'Could not read registered workspaces',
  }) }))
  fireEvent.click(screen.getByRole('tab', { name: locale === 'zh' ? '我的' : 'Mine' }))
  fireEvent.click(screen.getByRole('tab', { name: locale === 'zh' ? '项目技能' : 'Project skills' }))
  const alert = await screen.findByRole('alert')
  expect({ locale, message: alert.textContent }).toMatchSnapshot()
  const emptyMessage = locale === 'zh' ? '还没有已登记的工作区。请先在侧栏添加工作区。' : 'No registered workspaces yet. Add one in the sidebar first.'
  expect(screen.queryByText(emptyMessage)).toBeNull()
  remoteMock.unary('skillsManager/listWorkspaces', () => ok({ items: [] }))
  fireEvent.click(screen.getByRole('button', { name: locale === 'zh' ? '刷新' : 'Refresh' }))
  await screen.findByText(emptyMessage)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['focus', 'time'] as const)('keeps a native file selection active across %s until the picker reports completion', async (event) => {
  await setup(false)
  await screen.findByText('市场暂无技能，审核发布后会展示在这里。')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  const input = document.querySelector<HTMLInputElement>('input[type="file"]:not([multiple])')
  if (!input) throw new Error('File input missing')
  const open = vi.spyOn(input, 'click').mockImplementation(() => {})
  vi.useFakeTimers()
  try {
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }))
    if (event === 'focus') fireEvent(window, new Event('focus'))
    await act(async () => { await vi.advanceTimersByTimeAsync(event === 'focus' ? 0 : 30_000) })
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }))
    expect(open).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers(); open.mockRestore() }
})

it.each(['选择文件', '选择文件夹'])('allows another %s immediately after the native cancel event', async (label) => {
  await setup(false)
  await screen.findByText('市场暂无技能，审核发布后会展示在这里。')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  const input = document.querySelector<HTMLInputElement>(label === '选择文件'
    ? 'input[type="file"]:not([multiple])' : 'input[type="file"][multiple]')
  if (!input) throw new Error('File input missing')
  const open = vi.spyOn(input, 'click').mockImplementation(() => {})
  try {
    fireEvent.click(screen.getByRole('button', { name: label }))
    fireEvent(input, new Event('cancel', { bubbles: false }))
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(open).toHaveBeenCalledTimes(2)
  } finally { open.mockRestore() }
})

it('reports a failed native picker and allows a retry without losing the import form', async () => {
  await setup(false)
  await screen.findByText('市场暂无技能，审核发布后会展示在这里。')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  const input = document.querySelector<HTMLInputElement>('input[type="file"]:not([multiple])')
  if (!input) throw new Error('File input missing')
  const open = vi.spyOn(input, 'click').mockImplementationOnce(() => { throw new DOMException('Picker unavailable', 'InvalidStateError') }).mockImplementation(() => {})
  try {
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }))
    expect({ message: screen.getByRole('alert').textContent, installDisabled: screen.getByRole<HTMLButtonElement>('button', { name: '安装' }).disabled }).toMatchInlineSnapshot(`
      {
        "installDisabled": true,
        "message": "无法打开文件选择器：Picker unavailable。请重试或拖拽技能到导入区。",
      }
    `)
    fireEvent.click(screen.getByRole('button', { name: '选择文件' }))
    expect(open).toHaveBeenCalledTimes(2)
  } finally { open.mockRestore() }
})

function skill(name: string): SkillView {
  return { name, declaredName: name, description: `${name}说明`, kind: 'directory', path: `/skills/${name}`,
    modelInvocable: true, userInvocable: true, invocationPolicyValid: true, hasFrontmatter: true, loadable: true,
    diagnostics: [], managerEnabled: true, managerOverride: null, effectiveModelInvocable: true, effectiveUserInvocable: true }
}
function root(key: string, skills: SkillView[]): RootView {
  return { key, path: `/skills/${key}`, label: key, rank: 0, mutable: key !== 'company', native: true, toggleable: true,
    exists: true, truncated: false, enabled: true, skills, categories: [] }
}
async function setup(shared: boolean, includeCompany = true, personal = skill('个人技能'), gate?: Promise<void>, activeLocale: 'zh' | 'en' = 'zh') {
  const data: ManagerSnapshot = { roots: [...(includeCompany ? [root('company', shared ? [skill('共享技能')] : [])] : []), root('dsh', [personal])],
    writeDestinations: [], projects: [], summary: { total: 2, enabled: 2, disabled: 0, issues: 0 }, trash: [], warnings: [] }
  remoteMock = RemoteMock.create()
  remoteMock.unary('skillsManager/readState', async () => { await gate; return ok(data) })
  remoteMock.unary('skillsManager/listWorkspaces', async () => { await gate; return ok({ items: [] }) })
  remoteMock.unary('skillsManager/setSkillEnabled', () => ok({}))
  remoteMock.unary('skillsManager/createCategory', () => ok({}))

  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const locale = new LocaleRuntime(ctx)
  locale.setLocale(activeLocale)
  ctx.provide('locale', locale)
  ctx.provide('remote', Object.assign(remoteMock.remote, { $mount: async () => () => {} }))
  slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' } } }, (props: PropsRenderSlots<'main'>) => { void props.renderSlot; return null })
  await ctx.plugin(Skills).await()
  const entry = slots.entries('main').find(item => item.options.key === 'deepseek-harness-skills')
  if (!entry) throw new Error('Missing skills page registration')
  render(createElement(entry.component as ComponentType<Pick<SectionProps, 't'>>, { t: (key: string, params?: object) => locale.bind('skills-manager')(key, { ...params }) }))
  return data
}

it.each(['zh', 'en'] as const)('copies the exact skill body from company and local details (%s)', async (locale) => {
  await setup(true, true, skill('个人技能'), undefined, locale)
  await screen.findByText('共享技能')
  const body = '  # Orders\r\n\r\nKeep whitespace.\n'
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  remoteMock.unary('skillsManager/readDetail', () => ok({ name: 'orders', declaredName: 'orders', description: '',
    path: '/skills/orders/SKILL.md', diagnostics: [], body }))
  for (const local of [false, true]) {
    if (local) {
      fireEvent.click(screen.getByRole('tab', { name: locale === 'zh' ? '我的' : 'Mine' }))
      fireEvent.click(screen.getByRole('button', { name: /DSH/, expanded: false }))
    }
    fireEvent.click(screen.getByRole('button', { name: locale === 'zh' ? '更多' : 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: locale === 'zh' ? '查看详情' : 'View details' }))
    const copy = await screen.findByRole('button', { name: locale === 'zh' ? '复制正文' : 'Copy body' })
    expect(screen.getByRole('dialog').classList.contains('dssm-modal-wide')).toBe(true)
    const reader = screen.getByRole<HTMLTextAreaElement>('textbox', { name: locale === 'zh' ? '正文' : 'Body' })
    expect(reader.rows).toBe(16)
    if (!local) expect({ action: copy.textContent, bodyLabel: reader.getAttribute('aria-label'),
      readOnly: reader.readOnly, rows: reader.rows }).toMatchSnapshot()
    fireEvent.click(copy)
    await screen.findByRole('button', { name: locale === 'zh' ? '已复制' : 'Copied' })
    expect(writeText).toHaveBeenLastCalledWith(body)
    fireEvent.click(screen.getByRole('button', { name: locale === 'zh' ? '关闭' : 'Close' }))
  }
  expect(writeText).toHaveBeenCalledTimes(2)
})

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
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Skills must use native Remote') }))
  await setup(true)
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('tab', { name: '项目技能' }))
  await screen.findByText('还没有已登记的工作区。请先在侧栏添加工作区。')
  expect(remoteMock.remote.skillsManager.readState).toHaveBeenCalled()
  expect(remoteMock.remote.skillsManager.listWorkspaces).toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
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
      expect(remoteMock.remote.skillsManager.setSkillEnabled).toHaveBeenCalledWith({ root: 'dsh', name: 'audit-orders' }, false, undefined)
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
  await setup(true)
  await screen.findByText('共享技能')
  const entries = [{ name: '项目', available: true, registeredPaths: ['/workspace'] }]
  let refreshing = false
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  remoteMock.unary('skillsManager/listWorkspaces', async () => { if (refreshing) await gate; return ok({ items: entries }) })
  remoteMock.unary('skillsManager/readWorkspace', async () => { if (refreshing) await gate; return ok({ roots: empty ? [] : [root('dsh', [skill('项目技能')])] }) })

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

it.each(['zh', 'en'] as const)('submits a category with Enter but keeps IME composition in the input (%s)', async (locale) => {
  await setup(false, false, skill('audit-orders'), undefined, locale)
  await screen.findByText(locale === 'zh' ? '市场暂无技能，审核发布后会展示在这里。' : 'No skills in the marketplace yet. Approved publications will appear here.')
  fireEvent.click(screen.getByRole('tab', { name: locale === 'zh' ? '我的' : 'Mine' }))
  fireEvent.click(screen.getByRole('button', { name: locale === 'zh' ? '新建分类' : 'New category' }))
  const input = screen.getByRole('textbox', { name: locale === 'zh' ? '分类名称' : 'Category name' })
  fireEvent.change(input, { target: { value: 'Finance' } })
  const requests = () => remoteMock.remote.skillsManager.createCategory.mock.calls
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(requests()).toHaveLength(0)
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => { expect(requests()).toHaveLength(1) })
  const inputData = requests()[0][0]
  const saved = { root: inputData.root, name: inputData.name }
  expect(saved).toMatchObject({ root: 'dsh', name: 'Finance' })
  expect({ inputLabel: input.getAttribute('aria-label'), saved }).toMatchSnapshot()
})

it('reloads the original project after a scoped skill mutation', async () => {
  await setup(true)
  await screen.findByText('共享技能')
  const entries = [{ name: '项目', available: true, registeredPaths: ['/workspace'] }]
  let enabled = true
  remoteMock.unary('skillsManager/listWorkspaces', () => ok({ items: entries }))
  remoteMock.unary('skillsManager/readWorkspace', () => ok({ roots: [root('dsh', [{ ...skill('项目技能'),
    managerEnabled: enabled, managerOverride: enabled, effectiveModelInvocable: enabled, effectiveUserInvocable: enabled }])] }))
  remoteMock.unary('skillsManager/setSkillEnabled', (_target: { root: string }, next: boolean) => { enabled = next; return ok({}) })
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('tab', { name: /项目技能/ }))
  const panel = await screen.findByRole('tabpanel', { name: /项目技能/ })
  await waitFor(() => { expect(panel.getAttribute('aria-busy')).toBe('false') })
  const toggle = screen.getByRole('switch', { name: '启停技能 项目技能' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle)
  await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('false') })
  expect(remoteMock.remote.skillsManager.setSkillEnabled.mock.calls[0][0]).toMatchObject({ root: 'dsh', name: '项目技能', workspace: '/workspace' })
  expect(remoteMock.remote.skillsManager.readWorkspace.mock.calls).toHaveLength(2)
})
