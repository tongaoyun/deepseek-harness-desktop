// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, type ComponentType } from 'react'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteMock, ok } from '@deepseek-ai/dsh-remote-mock'
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as Skills from '../src/client.ts'
import type { ManagerSnapshot, SectionProps, SkillMethod, SkillOutput } from '../src/client-types.ts'
import type { RootView, SkillView } from '../src/types.ts'

afterEach(() => { cleanup(); document.querySelector('base')?.remove(); vi.unstubAllGlobals() })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
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
async function setup(shared: boolean, includeCompany = true, personal = skill('个人技能'), gate?: Promise<void>, activeLocale: 'zh' | 'en' = 'zh') {
  const data: ManagerSnapshot = { roots: [...(includeCompany ? [root('company', shared ? [skill('共享技能')] : [])] : []), root('dsh', [personal])],
    writeDestinations: [], projects: [], summary: { total: 2, enabled: 2, disabled: 0, issues: 0 }, trash: [], warnings: [] }
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Skills UI must use native Remote') }))
  const mock = RemoteMock.create()
  const call = vi.spyOn(mock.rpc, 'call')
  const requests = (method: SkillMethod) => call.mock.calls.filter(([, endpoint]) => endpoint === `skillsManager/${method}`)
  const signalFor = (method: SkillMethod) => {
    const signal = requests(method)[0]?.[3]
    if (!signal) throw new Error(`Missing cancellation signal for ${method}`)
    return signal
  }
  mock.unary('skillsManager/readState', async () => { await gate; return ok(data) })
  mock.unary('skillsManager/listWorkspaces', () => ok({ items: [] }))
  mock.unary('skillsManager/setSkillEnabled', () => ok({}))
  mock.unary('skillsManager/createCategory', () => ok({}))
  const directory = await mkdtemp(join(tmpdir(), 'skills-page-loader-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const locale = new LocaleRuntime(ctx)
  locale.setLocale(activeLocale)
  ctx.provide('locale', locale)
  installConnection(ctx, { interactions: 'none', transport: { rpc: mock.rpc } })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(Gateway)
  slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' } } }, (props: PropsRenderSlots<'main'>) => { void props.renderSlot; return null })
  ctx.baseUrl = import.meta.url
  await ctx.plugin(Loader).await()
  Object.assign(ctx.loader.builtins, { include: Include, skillsPage: Skills })
  const config = join(directory, 'cordis.yml')
  await writeFile(config, "- name: 'cordis:skillsPage'\n")
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const entry = slots.entries('main').find(item => item.options.key === 'deepseek-harness-skills')
  if (!entry) throw new Error('Missing skills page registration')
  const pageProps: Pick<SectionProps, 't' | 'useSessions'> = {
    useSessions: selector => selector({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
    t: (key: string, params?: object) => locale.bind('skills-manager')(key, { ...params }),
  }
  const view = render(createElement(entry.component as ComponentType<Pick<SectionProps, 't'>>, pageProps))
  return { data, mock, view, requests, signalFor }
}

it.each(['Escape', 'close', 'cancel'] as const)('keeps the creation form intact until its write completes (%s)', async (dismiss) => {
  const { data, mock } = await setup(true)
  data.writeDestinations.push({ key: 'dsh', path: '/skills/dsh', label: 'DSH skills', available: true })
  const pending = deferred<undefined>()
  mock.unary('skillsManager/createSkill', async () => {
    await pending.promise
    return ok({ name: 'acceptance-skill', path: '/skills/dsh/acceptance-skill', root: 'dsh' })
  })
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '创建技能' }))
  const dialog = screen.getByRole('dialog', { name: '创建技能' })
  const form = within(dialog)
  fireEvent.change(form.getByRole('textbox', { name: '名称' }), { target: { value: 'acceptance-skill' } })
  fireEvent.change(form.getByRole('textbox', { name: '简介' }), { target: { value: 'Acceptance fixture' } })
  fireEvent.change(form.getByRole('textbox', { name: '正文（Markdown）' }), { target: { value: 'Use temporary data.' } })
  try {
    fireEvent.click(form.getByRole('button', { name: '创建技能' }))
    await waitFor(() => { expect(mock.remote.skillsManager.createSkill).toHaveBeenCalledTimes(1) })
    if (dismiss === 'Escape') fireEvent.keyDown(dialog, { key: 'Escape' })
    else fireEvent.click(form.getByRole('button', { name: dismiss === 'close' ? '关闭' : '取消' }))
    expect(screen.getByRole('dialog', { name: '创建技能' })).toBe(dialog)
    for (const input of form.getAllByRole('textbox')) expect(input).toHaveProperty('disabled', true)
    expect(form.getByRole('textbox', { name: '名称' })).toHaveProperty('value', 'acceptance-skill')
    expect(form.getByRole('button', { name: '取消' })).toHaveProperty('disabled', true)
    expect(form.getByRole('button', { name: '创建技能' })).toHaveProperty('disabled', true)
    await act(async () => { pending.resolve(undefined); await pending.promise })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '创建技能' })).toBeNull() })
    expect(screen.getByText('已创建技能：acceptance-skill')).toBeTruthy()
  } finally {
    await act(async () => { pending.resolve(undefined); await pending.promise })
  }
})

it('reserves one import through file preparation and keeps its selection until the write completes', async () => {
  const { data, mock } = await setup(true)
  data.writeDestinations.push({ key: 'dsh', path: '/skills/dsh', label: 'DSH skills', available: true })
  const reading = deferred<ArrayBuffer>()
  const writing = deferred<undefined>()
  const bytes = new TextEncoder().encode('---\nname: acceptance-skill\ndescription: Acceptance fixture\n---\nUse temporary data.')
  const readFile = vi.fn(() => reading.promise)
  const file = Object.assign(new File([bytes], 'SKILL.md'), { arrayBuffer: readFile })
  mock.unary('skillsManager/uploadSkill', async () => {
    await writing.promise
    return ok({ imported: [{ name: 'acceptance-skill', overwritten: false, warnings: [] }], skipped: [], failed: [] })
  })
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  const dialog = screen.getByRole('dialog', { name: '导入技能' })
  const form = within(dialog)
  const input = dialog.querySelector('input[type="file"][accept]')
  if (!input) throw new Error('Missing import file input')
  fireEvent.change(input, { target: { files: [file] } })
  const dropRead = deferred<ErrorCallback>()
  const dropZone = form.getByText('拖拽技能到此处').parentElement
  if (!dropZone) throw new Error('Missing import drop zone')
  fireEvent.drop(dropZone, { dataTransfer: { items: [{ webkitGetAsEntry: () => ({
    isFile: true,
    file(_onFile: FileCallback, onError: ErrorCallback) { dropRead.resolve(onError) },
  }) }] } })
  const failDrop = await dropRead.promise
  try {
    const install = form.getByRole('button', { name: '安装' })
    fireEvent.click(install)
    await waitFor(() => { expect(readFile).toHaveBeenCalledTimes(1) })
    expect(install).toHaveProperty('disabled', true)
    fireEvent.click(install)
    fireEvent.click(form.getByRole('button', { name: '关闭' }))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    fireEvent.click(form.getByRole('button', { name: '取消' }))
    fireEvent.click(form.getByRole('button', { name: '移除所选内容' }))
    expect(screen.getByRole('dialog', { name: '导入技能' })).toBe(dialog)
    expect(form.getByText('SKILL.md')).toBeTruthy()
    expect(readFile).toHaveBeenCalledTimes(1)
    await act(async () => { reading.resolve(bytes.buffer); await reading.promise })
    await waitFor(() => { expect(mock.remote.skillsManager.uploadSkill).toHaveBeenCalledTimes(1) })
    await act(async () => { failDrop(new DOMException('Dropped file unavailable')); await Promise.resolve() })
    expect(form.queryByRole('alert')?.textContent).toBeUndefined()
    expect(install).toHaveProperty('disabled', true)
    fireEvent.click(form.getByRole('button', { name: '关闭' }))
    expect(screen.getByRole('dialog', { name: '导入技能' })).toBe(dialog)
    await act(async () => { writing.resolve(undefined); await writing.promise })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '导入技能' })).toBeNull() })
    expect(screen.getByText('导入完成：acceptance-skill')).toBeTruthy()
  } finally {
    await act(async () => {
      reading.resolve(bytes.buffer)
      writing.resolve(undefined)
      await Promise.all([reading.promise, writing.promise])
    })
  }
})

it('shows file preparation failures and permits importing the same selection again', async () => {
  const { data, mock } = await setup(true)
  data.writeDestinations.push({ key: 'dsh', path: '/skills/dsh', label: 'DSH skills', available: true })
  const reading = deferred<ArrayBuffer>()
  const bytes = new TextEncoder().encode('---\nname: acceptance-skill\ndescription: Acceptance fixture\n---\nUse temporary data.')
  const readFile = vi.fn().mockImplementationOnce(() => reading.promise).mockResolvedValue(bytes.buffer)
  const file = Object.assign(new File([bytes], 'SKILL.md'), { arrayBuffer: readFile })
  mock.unary('skillsManager/uploadSkill', () => ok({ imported: [{ name: 'acceptance-skill', overwritten: false, warnings: [] }], skipped: [], failed: [] }))
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  const dialog = screen.getByRole('dialog', { name: '导入技能' })
  const form = within(dialog)
  const input = dialog.querySelector('input[type="file"][accept]')
  if (!input) throw new Error('Missing import file input')
  fireEvent.change(input, { target: { files: [file] } })
  try {
    fireEvent.click(form.getByRole('button', { name: '安装' }))
    await waitFor(() => { expect(readFile).toHaveBeenCalledTimes(1) })
    await act(async () => { reading.reject(new Error('File permission revoked')); await reading.promise.catch(() => {}) })
    expect(await form.findByRole('alert')).toHaveProperty('textContent', '操作失败：File permission revoked')
    expect(form.getByText('SKILL.md')).toBeTruthy()
    expect(form.getByRole('button', { name: '安装' })).toHaveProperty('disabled', false)
    fireEvent.click(form.getByRole('button', { name: '安装' }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '导入技能' })).toBeNull() })
    expect(readFile).toHaveBeenCalledTimes(2)
    expect(mock.remote.skillsManager.uploadSkill).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => { reading.resolve(bytes.buffer); await reading.promise.catch(() => {}) })
  }
})

it('does not upload prepared files after the skills page is removed', async () => {
  const { data, mock, view } = await setup(true)
  data.writeDestinations.push({ key: 'dsh', path: '/skills/dsh', label: 'DSH skills', available: true })
  const reading = deferred<ArrayBuffer>()
  const bytes = new TextEncoder().encode('---\nname: acceptance-skill\ndescription: Acceptance fixture\n---\nUse temporary data.')
  const readFile = vi.fn(() => reading.promise)
  const file = Object.assign(new File([bytes], 'SKILL.md'), { arrayBuffer: readFile })
  mock.unary('skillsManager/uploadSkill', () => ok({ imported: [], skipped: [], failed: [] }))
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  const dialog = screen.getByRole('dialog', { name: '导入技能' })
  const input = dialog.querySelector('input[type="file"][accept]')
  if (!input) throw new Error('Missing import file input')
  fireEvent.change(input, { target: { files: [file] } })
  try {
    fireEvent.click(within(dialog).getByRole('button', { name: '安装' }))
    await waitFor(() => { expect(readFile).toHaveBeenCalledTimes(1) })
    view.unmount()
    const reads = mock.remote.skillsManager.readState.mock.calls.length
    await act(async () => { reading.resolve(bytes.buffer); await reading.promise })
    expect(mock.remote.skillsManager.uploadSkill).not.toHaveBeenCalled()
    expect(mock.remote.skillsManager.readState).toHaveBeenCalledTimes(reads)
  } finally {
    await act(async () => { reading.resolve(bytes.buffer); await reading.promise })
  }
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

it('uses native Remote independently of a reverse-proxy path prefix', async () => {
  const base = document.createElement('base')
  base.href = 'https://harness.test/traefik/harness/'
  document.head.appendChild(base)
  const { mock } = await setup(true)
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('tab', { name: '项目技能' }))
  await screen.findByText('还没有已登记的工作区。请先在侧栏添加工作区。')
  expect(mock.remote.skillsManager.readState).toHaveBeenCalled()
  expect(mock.remote.skillsManager.listWorkspaces).toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it.each([true, false])('only permits revocation for a broken skill with recorded enablement=%s', async (recorded) => {
  const broken: SkillView = { ...skill('audit-orders'), loadable: false, enabled: recorded,
    managerOverride: recorded, managerEnabled: recorded, hasFrontmatter: false, invocationPolicyValid: false }
  const { requests } = await setup(false, true, broken)
  await screen.findByText('市场暂无技能，审核发布后会展示在这里。')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: /DSH/, expanded: false }))
  const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: '启停技能 audit-orders' })
  expect(toggle.disabled).toBe(!recorded)
  if (recorded) {
    fireEvent.click(toggle)
    await waitFor(() => { expect(requests('setSkillEnabled')).toEqual([
      ['/api', 'skillsManager/setSkillEnabled', { args: { target: { root: 'dsh', name: 'audit-orders' }, enabled: false } }, expect.any(AbortSignal)],
    ]) })
  }
})

it.each(['market', 'source', 'skill', 'category'] as const)('writes the %s switch once, refreshes its state and preserves expanded content', async (target) => {
  const { data, mock, requests } = await setup(true)
  const source = data.roots.find(item => item.key === 'dsh')!
  source.categories.push({ id: 'finance1', name: 'Finance' })
  source.skills[0].categoryId = 'finance1'
  const pending = deferred<undefined>()
  const method = target === 'skill' ? 'setSkillEnabled' : target === 'category' ? 'setCategoryEnabled' : 'setSourceEnabled'
  const label = target === 'market' ? '使用市场技能' : target === 'source' ? '启停来源 DSH' : target === 'skill' ? '启停技能 个人技能' : '启停分类 Finance'
  const scope = target === 'market' ? { root: 'company' } : target === 'skill' ? { root: 'dsh', name: '个人技能' } : target === 'category' ? { root: 'dsh', category: 'finance1' } : { root: 'dsh' }
  mock.unary(`skillsManager/${method}`, async () => {
    await pending.promise
    if (target === 'market') data.roots[0].enabled = false
    else if (target === 'source') source.enabled = false
    else source.skills[0].managerEnabled = false
    return ok({})
  })
  await screen.findByText('共享技能')
  if (target !== 'market') {
    fireEvent.click(screen.getByRole('tab', { name: '我的' }))
    fireEvent.click(screen.getByRole('button', { name: /DSH/, expanded: false }))
    fireEvent.click(screen.getByRole('button', { name: /Finance/, expanded: false }))
  }
  try {
    const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: label })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.disabled).toBe(true)
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(requests(method)).toEqual([
        ['/api', `skillsManager/${method}`, { args: { target: scope, enabled: false } }, expect.any(AbortSignal)],
      ])
    })
    await act(async () => { pending.resolve(undefined); await pending.promise })
    await waitFor(() => { expect(toggle.disabled).toBe(false) })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(target === 'market' ? '共享技能' : '个人技能')).toBeTruthy()
    if (target !== 'market') {
      expect(screen.getByRole('button', { name: /DSH/, expanded: true })).toBeTruthy()
      expect(screen.getByRole('button', { name: /Finance/, expanded: true })).toBeTruthy()
    }
  } finally {
    pending.resolve(undefined)
    await pending.promise
  }
})

it('reports a rejected switch write and leaves the previous state available for retry', async () => {
  const { mock } = await setup(true)
  const pending = deferred<undefined>()
  mock.unary('skillsManager/setSkillEnabled', async () => {
    await pending.promise
    return { ok: false, error: new RemoteError('skills/operation', 'Permission changed', { code: 'error.proto.forbidden', error: 'forbidden' }) }
  })
  await screen.findByText('共享技能')
  const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: '启停技能 共享技能' })
  try {
    fireEvent.click(toggle)
    expect(toggle.disabled).toBe(true)
    await act(async () => { pending.resolve(undefined); await pending.promise })
    const message = await screen.findByText(/操作失败：/)
    await waitFor(() => { expect(toggle.disabled).toBe(false) })
    expect({ message: message.textContent, checked: toggle.getAttribute('aria-checked'), disabled: toggle.disabled }).toMatchInlineSnapshot(`
      {
        "checked": "true",
        "disabled": false,
        "message": "操作失败：仅本机所有者可管理技能",
      }
    `)
    expect(mock.remote.skillsManager.setSkillEnabled).toHaveBeenCalledTimes(1)
  } finally {
    pending.resolve(undefined)
    await pending.promise
  }
})

it.each(['menu', 'category drop', 'reorder'] as const)('reports a rejected %s without discarding the skill rows', async (operation) => {
  const { data, mock } = await setup(false, false)
  const source = data.roots[0]
  source.categories.push({ id: 'finance1', name: 'Finance' })
  source.skills.push(skill('other-skill'))
  source.skills.forEach((item) => { item.categoryId = 'finance1' })
  const method = operation === 'reorder' ? 'moveInCategory' : 'assignCategory'
  mock.unary(`skillsManager/${method}`, () => ({ ok: false,
    error: new RemoteError('skills/operation', 'Permission changed', { code: 'error.proto.forbidden', error: 'forbidden' }) }))
  await screen.findByText('市场暂无技能，审核发布后会展示在这里。')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: /DSH/, expanded: false }))
  fireEvent.click(screen.getByRole('button', { name: /Finance/, expanded: false }))
  if (operation === 'menu') {
    fireEvent.click(screen.getAllByRole('button', { name: '更多' })[0])
    fireEvent.click(screen.getByRole('menuitem', { name: '归入未分类' }))
  } else {
    const row = screen.getByText('个人技能').closest('.dssm-skill-row')!
    const dataTransfer = { setData: vi.fn(), getData: () => JSON.stringify({ root: 'dsh', name: '个人技能', currentCategoryId: 'finance1' }) }
    fireEvent.dragStart(row, { dataTransfer })
    const destination = operation === 'reorder'
      ? screen.getByText('other-skill').closest('.dssm-skill-row')!
      : screen.getByRole('button', { name: /未分类/, expanded: false }).closest('.dssm-cat')!
    fireEvent.drop(destination, { dataTransfer, clientY: 1 })
  }
  await screen.findByText('操作失败：仅本机所有者可管理技能')
  await waitFor(() => { expect(screen.getByRole('button', { name: '刷新' })).toHaveProperty('disabled', false) })
  expect(mock.remote.skillsManager[method]).toHaveBeenCalledTimes(1)
  expect(screen.getByText('个人技能')).toBeTruthy()
  expect(screen.getByText('other-skill')).toBeTruthy()
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
  fireEvent.click(screen.getByRole('button', { name: '启用状态' }))
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['全部状态', '已启用', '已停用'])
  fireEvent.click(screen.getByRole('menuitem', { name: enabled ? '已启用' : '已停用' }))
  expect(screen.getByText('audit-orders')).toBeTruthy()
  expect(screen.getByText(condition === 'shadowed' ? '同名技能优先使用 codex 中的版本' : '技能内容无法加载，请查看详情中的具体原因。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '启用状态' }))
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
  const { data, mock } = await setup(true)
  await screen.findByText('共享技能')
  const entries = [{ name: '项目', available: true, registeredPaths: ['/workspace'] }]
  let refreshing = false
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  onTestFinished(async () => { finish(); await gate })
  mock.unary('skillsManager/listWorkspaces', async () => {
    if (refreshing) await gate
    return ok({ items: entries })
  })
  mock.unary('skillsManager/readWorkspace', async () => {
    if (refreshing) await gate
    return ok({ ...data, roots: empty ? [] : [root('dsh', [skill('项目技能')])] })
  })
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('tab', { name: /项目技能/ }))
  const text = empty ? '这个工作区还没有技能。' : '项目技能'
  // The nonempty row and the confirmed empty state both survive a refresh.
  const panel = await screen.findByRole('tabpanel', { name: /项目技能/ })
  await waitFor(() => { expect(panel.getAttribute('aria-busy')).toBe('false') })
  const content = panel.textContent
  expect(content).toContain(text)
  const workspace = screen.getByRole<HTMLButtonElement>('button', { name: '工作区' })
  fireEvent.click(workspace)
  expect(screen.getByRole('menu')).toBeTruthy()
  refreshing = true
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(screen.queryByRole('menu')).toBeNull()
  expect(workspace).toHaveProperty('disabled', true)
  expect(workspace.getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByRole('tabpanel', { name: /项目技能/ })).toBe(panel)
  expect(panel.textContent).toBe(content)
  expect(panel.getAttribute('aria-busy')).toBe('true')
  expect(screen.queryByText('正在读取工作区技能…')).toBeNull()
  await act(async () => { finish(); await gate })
  await waitFor(() => { expect(panel.getAttribute('aria-busy')).toBe('false') })
  expect(panel.textContent).toBe(content)
  expect(workspace).toHaveProperty('disabled', false)
  expect(screen.queryByRole('menu')).toBeNull()
  expect({ selectedWorkspace: workspace.textContent, expanded: workspace.getAttribute('aria-expanded'),
    enabled: !workspace.disabled }).toMatchInlineSnapshot(`
      {
        "enabled": true,
        "expanded": "false",
        "selectedWorkspace": "项目",
      }
    `)
})

it.each(['zh', 'en'] as const)('copies the exact skill body from company and local details (%s)', async (locale) => {
  const { mock } = await setup(true, true, skill('个人技能'), undefined, locale)
  await screen.findByText('共享技能')
  const body = '  # Orders\r\n\r\nKeep whitespace.\n'
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  mock.unary('skillsManager/readDetail', () => ok({ name: 'orders', declaredName: 'orders', description: '',
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


it.each(['zh', 'en'] as const)('submits a category with Enter but keeps IME composition in the input (%s)', async (locale) => {
  const { requests } = await setup(false, false, skill('audit-orders'), undefined, locale)
  await screen.findByText(locale === 'zh' ? '市场暂无技能，审核发布后会展示在这里。' : 'No skills in the marketplace yet. Approved publications will appear here.')
  fireEvent.click(screen.getByRole('tab', { name: locale === 'zh' ? '我的' : 'Mine' }))
  fireEvent.click(screen.getByRole('button', { name: locale === 'zh' ? '新建分类' : 'New category' }))
  const input = screen.getByRole('textbox', { name: locale === 'zh' ? '分类名称' : 'Category name' })
  fireEvent.change(input, { target: { value: 'Finance' } })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(requests('createCategory')).toHaveLength(0)
  fireEvent.compositionStart(input)
  fireEvent.keyDown(input, { key: 'Enter', isComposing: false })
  expect(requests('createCategory')).toHaveLength(0)
  fireEvent.compositionEnd(input)
  fireEvent.keyDown(input, { key: 'Enter', isComposing: false })
  expect(requests('createCategory')).toHaveLength(0)
  fireEvent.keyUp(input, { key: 'Enter' })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => { expect(requests('createCategory')).toHaveLength(1) })
  const saved = requests('createCategory')[0][2]
  expect(saved).toEqual({ args: { target: { root: 'dsh', name: 'Finance' } } })
  expect({ inputLabel: input.getAttribute('aria-label'), saved }).toMatchSnapshot()
})

it.each([
  { name: 'Control', ctrlKey: true }, { name: 'Alt', altKey: true },
  { name: 'Meta', metaKey: true }, { name: 'Shift', shiftKey: true }, { name: 'repeat', repeat: true },
])('does not write a category on $name Enter', async (key) => {
  const { mock } = await setup(false, false)
  await screen.findByText('市场暂无技能，审核发布后会展示在这里。')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '新建分类' }))
  const input = screen.getByRole('textbox', { name: '分类名称' })
  fireEvent.change(input, { target: { value: 'Finance' } })
  fireEvent.keyDown(input, { key: 'Enter', ...key })
  expect(mock.remote.skillsManager.createCategory).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => { expect(mock.remote.skillsManager.createCategory).toHaveBeenCalledTimes(1) })
})

it('releases category composition listeners on close and starts a fresh input lifetime on reopen', async () => {
  const { mock, view } = await setup(false, false)
  await screen.findByText('市场暂无技能，审核发布后会展示在这里。')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  const add = vi.spyOn(document, 'addEventListener')
  const remove = vi.spyOn(document, 'removeEventListener')
  onTestFinished(() => { add.mockRestore(); remove.mockRestore() })
  fireEvent.click(screen.getByRole('button', { name: '新建分类' }))
  const input = screen.getByRole('textbox', { name: '分类名称' })
  fireEvent.compositionStart(input)
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  const subscriptions = add.mock.calls.filter(([name]) => name === 'compositionstart' || name === 'compositionend' || name === 'keyup')
  expect(subscriptions.length).toBeGreaterThan(0)
  for (const call of subscriptions) expect(remove.mock.calls).toContainEqual(call)
  fireEvent.click(screen.getByRole('button', { name: '新建分类' }))
  const next = screen.getByRole('textbox', { name: '分类名称' })
  fireEvent.change(next, { target: { value: 'Finance' } })
  fireEvent.keyDown(next, { key: 'Enter' })
  await waitFor(() => { expect(mock.remote.skillsManager.createCategory).toHaveBeenCalledTimes(1) })
  view.unmount()
  for (const call of add.mock.calls.filter(([name]) => name === 'compositionstart' || name === 'compositionend' || name === 'keyup')) {
    expect(remove.mock.calls).toContainEqual(call)
  }
})

it('renames the selected category only after composition ends and the name changes', async () => {
  const { data, mock, requests } = await setup(false, false)
  const source = data.roots.find(item => item.key === 'dsh')
  if (!source) throw new Error('Expected local skills source')
  source.categories.push({ id: 'finance1', name: 'Finance' })
  mock.unary('skillsManager/renameCategory', () => ok({}))
  await screen.findByText('市场暂无技能，审核发布后会展示在这里。')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: /DSH/, expanded: false }))
  fireEvent.click(screen.getByRole('button', { name: '重命名' }))
  const input = screen.getByRole('textbox', { name: '分类名称' })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(mock.remote.skillsManager.renameCategory).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: 'Orders' } })
  fireEvent.compositionStart(input)
  fireEvent.compositionEnd(input)
  fireEvent.keyDown(input, { key: 'Enter', isComposing: false })
  expect(mock.remote.skillsManager.renameCategory).not.toHaveBeenCalled()
  fireEvent.keyUp(input, { key: 'Enter' })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => { expect(requests('renameCategory')).toEqual([
    ['/api', 'skillsManager/renameCategory', { args: { target: { root: 'dsh', id: 'finance1', name: 'Orders' } } }, expect.any(AbortSignal)],
  ]) })
  expect(mock.remote.skillsManager.createCategory).not.toHaveBeenCalled()
})


it.each(['zh', 'en'] as const)('shows a workspace registry failure instead of an empty project directory (%s)', async (locale) => {
  const { mock } = await setup(false, false, skill('audit-orders'), undefined, locale)
  await screen.findByText(locale === 'zh' ? '市场暂无技能，审核发布后会展示在这里。' : 'No skills in the marketplace yet. Approved publications will appear here.')
  mock.unary('skillsManager/listWorkspaces', () => ({ ok: false, error: new RemoteError('skills/operation', 'Could not read registered workspaces', {
    code: 'error.workspace.registryUnavailable', error: 'Could not read registered workspaces',
  }) }))
  fireEvent.click(screen.getByRole('tab', { name: locale === 'zh' ? '我的' : 'Mine' }))
  fireEvent.click(screen.getByRole('tab', { name: locale === 'zh' ? '项目技能' : 'Project skills' }))
  const alert = await screen.findByRole('alert')
  expect({ locale, message: alert.textContent }).toMatchSnapshot()
  const emptyMessage = locale === 'zh' ? '还没有已登记的工作区。请先在侧栏添加工作区。' : 'No registered workspaces yet. Add one in the sidebar first.'
  expect(screen.queryByText(emptyMessage)).toBeNull()
  mock.unary('skillsManager/listWorkspaces', () => ok({ items: [] }))
  fireEvent.click(screen.getByRole('button', { name: locale === 'zh' ? '刷新' : 'Refresh' }))
  await screen.findByText(emptyMessage)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['创建技能', '导入技能'])('reports a workspace destination failure in %s and retries inside the current dialog', async (name) => {
  const { data, mock } = await setup(true)
  data.writeDestinations.push({ key: 'dsh', path: '/skills/dsh', label: 'DSH skills', available: true })
  await screen.findByText('共享技能')
  mock.unary('skillsManager/listWorkspaces', () => ({ ok: false, error: new RemoteError('skills/operation', 'Workspace registry unavailable', {
    code: 'error.workspace.registryUnavailable', error: 'Workspace registry unavailable',
  }) }))
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name }))
  const dialog = screen.getByRole('dialog', { name })
  const form = within(dialog)
  if (name === '创建技能') {
    fireEvent.change(form.getByRole('textbox', { name: '名称' }), { target: { value: 'keep-my-draft' } })
    fireEvent.change(form.getByRole('textbox', { name: '简介' }), { target: { value: 'Draft description' } })
    fireEvent.change(form.getByRole('textbox', { name: '正文（Markdown）' }), { target: { value: 'Draft body' } })
    expect(form.getByRole('button', { name: '创建技能' })).toHaveProperty('disabled', false)
  }
  fireEvent.click(form.getByRole('button', { name: '范围' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '指定工作区' }))
  expect((await form.findByRole('alert')).textContent).toContain('无法读取工作区登记，请重试。')
  expect(form.queryByText('还没有已登记的工作区。请先在侧栏添加，再回到这里选择。')).toBeNull()
  expect(form.getByRole('button', { name: name === '创建技能' ? '创建技能' : '安装' })).toHaveProperty('disabled', true)
  if (name === '创建技能') {
    expect({ notice: form.getByRole('alert').textContent, workspaceDisabled: form.getByRole<HTMLButtonElement>('button', { name: '工作区' }).disabled }).toMatchInlineSnapshot(`
      {
        "notice": "无法读取工作区列表：无法读取工作区登记，请重试。重试",
        "workspaceDisabled": true,
      }
    `)
    fireEvent.click(form.getByRole('button', { name: '范围' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '用户目录' }))
    expect(form.getByRole('button', { name: '创建技能' })).toHaveProperty('disabled', false)
    expect(form.queryByRole('alert')).toBeNull()
    fireEvent.click(form.getByRole('button', { name: '范围' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '指定工作区' }))
  }
  mock.unary('skillsManager/listWorkspaces', () => ok({ items: [{ name: '恢复的项目', path: '/workspace', registeredPaths: ['/workspace'], available: true, skillCount: 0 }] }))
  fireEvent.click(form.getByRole('button', { name: '重试' }))
  await waitFor(() => { expect(form.getByRole('button', { name: '工作区' })).toHaveProperty('disabled', false) })
  fireEvent.click(form.getByRole('button', { name: '工作区' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '恢复的项目' }))
  expect(form.queryByRole('alert')).toBeNull()
  expect(form.getByRole('button', { name: '工作区' }).textContent).toBe('恢复的项目')
  expect(mock.remote.skillsManager.listWorkspaces).toHaveBeenCalledTimes(2)
  expect(mock.remote.skillsManager.createSkill).not.toHaveBeenCalled()
  expect(mock.remote.skillsManager.uploadSkill).not.toHaveBeenCalled()
  if (name === '创建技能') expect(form.getByRole('textbox', { name: '名称' })).toHaveProperty('value', 'keep-my-draft')
})


it('cancels a dismissed skill detail and allows a new dialog before the old request settles', async () => {
  const { mock, signalFor } = await setup(true)
  await screen.findByText('共享技能')
  const pending = deferred<SkillOutput<'readDetail'>>()
  mock.unary('skillsManager/readDetail', async () => ok(await pending.promise))
  try {
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '查看详情' }))
    const signal = signalFor('readDetail')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(signal?.aborted).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: '我的' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '创建技能' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '创建技能' }))
    fireEvent.change(screen.getByPlaceholderText('例如 code-review-helper'), { target: { value: 'keep-new-skill' } })
    await act(async () => { pending.reject(new Error('Old detail failed')); await pending.promise.catch(() => {}) })
    expect(screen.getByRole('dialog', { name: '创建技能' })).toBeTruthy()
    expect({ dialog: screen.getByRole('heading', { name: '创建技能' }).textContent,
      name: screen.getByPlaceholderText<HTMLInputElement>('例如 code-review-helper').value,
      error: screen.queryByText(/Old detail failed/)?.textContent ?? null }).toMatchInlineSnapshot(`
      {
        "dialog": "创建技能",
        "error": null,
        "name": "keep-new-skill",
      }
    `)
  } finally { pending.reject(new Error('Detail test released')) }
})

it('cancels the initial native catalog read when the skills page is removed', async () => {
  const pending = deferred<undefined>()
  const { view, signalFor } = await setup(true, true, skill('个人技能'), pending.promise)
  try {
    const signal = signalFor('readState')
    view.unmount()
    expect(signal?.aborted).toBe(true)
  } finally { await act(async () => { pending.resolve(undefined); await pending.promise }) }
})

it('cancels native workspace listing when the skills page is removed', async () => {
  const { mock, view, signalFor } = await setup(true)
  await screen.findByText('共享技能')
  const pending = deferred<SkillOutput<'listWorkspaces'>>()
  mock.unary('skillsManager/listWorkspaces', async () => ok(await pending.promise))
  try {
    fireEvent.click(screen.getByRole('tab', { name: '我的' }))
    fireEvent.click(screen.getByRole('button', { name: '创建技能' }))
    const signal = signalFor('listWorkspaces')
    view.unmount()
    expect(signal?.aborted).toBe(true)
  } finally { await act(async () => { pending.resolve({ items: [] }); await pending.promise }) }
})

it('cancels a superseded workspace read and retains the refreshed skill list', async () => {
  const { data, mock, signalFor } = await setup(true)
  await screen.findByText('共享技能')
  const pending = deferred<ManagerSnapshot>()
  mock.unary('skillsManager/listWorkspaces', () => ok({ items: [{ name: '项目', available: true, registeredPaths: ['/workspace'] }] }))
  let reads = 0
  mock.unary('skillsManager/readWorkspace', async () => ok(++reads === 1
    ? await pending.promise
    : { ...data, roots: [root('dsh', [skill('refreshed-skill')])] }))
  try {
    fireEvent.click(screen.getByRole('tab', { name: '我的' }))
    fireEvent.click(screen.getByRole('tab', { name: '项目技能' }))
    await waitFor(() => { expect(mock.remote.skillsManager.readWorkspace).toHaveBeenCalledTimes(1) })
    const signal = signalFor('readWorkspace')
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(signal?.aborted).toBe(true)
    await screen.findByText('refreshed-skill')
    await act(async () => {
      pending.resolve({ ...data, roots: [root('dsh', [skill('stale-skill')])] })
      await pending.promise
    })
    expect(screen.queryByText('stale-skill')).toBeNull()
    expect(screen.getByText('refreshed-skill')).toBeTruthy()
  } finally { pending.resolve(data) }
})
