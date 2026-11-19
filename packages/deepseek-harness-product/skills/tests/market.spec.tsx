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
import { resolveContentCategory } from '@deepseek-harness/product/content-categories'
import { RemoteMock, ok } from '@deepseek-ai/dsh-remote-mock'
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as Skills from '../src/client.ts'
import { zh, en } from '../src/client-locales.ts'
import { repositoryLocales } from '../src/repository-ui.ts'
import { destinationLocales } from '../src/destination-picker.ts'
import type { ManagerSnapshot, SectionProps, SkillMethod, SkillOutput } from '../src/client-types.ts'
import type { RootView, SkillView } from '../src/types.ts'

afterEach(() => { cleanup(); document.querySelector('base')?.remove(); vi.unstubAllGlobals() })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function uploadFile(name: string, content: string) {
  const bytes = new TextEncoder().encode(content)
  return Object.assign(new File([bytes], name), { arrayBuffer: vi.fn().mockResolvedValue(bytes.buffer) })
}

function controlledDrop(kind: 'file' | 'directory', file: File, directoryName = 'older-skill') {
  const pending = deferred<{ succeed: () => void; fail: ErrorCallback }>()
  const fileEntry = {
    isFile: true,
    file(onFile: FileCallback, onError: ErrorCallback) {
      if (kind === 'file') pending.resolve({ succeed: () => { onFile(file) }, fail: onError })
      else onFile(file)
    },
  }
  let firstBatch = true
  const readEntries = vi.fn((onEntries: FileSystemEntriesCallback, onError: ErrorCallback) => {
    if (!firstBatch) { onEntries([]); return }
    firstBatch = false
    pending.resolve({ succeed: () => { onEntries([fileEntry as FileSystemFileEntry]) }, fail: onError })
  })
  const directoryEntry = { isFile: false, isDirectory: true, name: directoryName, createReader: () => ({ readEntries }) }
  return {
    dataTransfer: { items: [{ webkitGetAsEntry: () => kind === 'file' ? fileEntry : directoryEntry }] },
    pending: pending.promise,
    readEntries,
  }
}

function dropFile(file: File, read = vi.fn()): FileSystemEntry {
  return { isFile: true, isDirectory: false, name: file.name,
    file(onFile: FileCallback) { read(); onFile(file) } } as FileSystemFileEntry
}

function dropDirectory(name: string, children: FileSystemEntry[], read = vi.fn()): FileSystemEntry {
  return { isFile: false, isDirectory: true, name, createReader() {
    let cursor = 0
    return { readEntries(onEntries: FileSystemEntriesCallback) {
      read()
      const batch = children.slice(cursor, cursor + 100)
      cursor += batch.length
      onEntries(batch)
    } }
  } } as FileSystemDirectoryEntry
}

it.each(['files', 'directories', 'depth', 'bytes'] as const)('stops enumerating a dropped skill directory at the %s limit and permits a fresh selection', async (limit) => {
  const { data, mock } = await setup(true)
  data.writeDestinations.push({ key: 'dsh', path: '/skills/dsh', label: 'DSH skills', available: true })
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  const form = within(screen.getByRole('dialog', { name: '导入技能' }))
  const zone = form.getByText('拖拽技能到此处').parentElement!
  const read = vi.fn()
  const extra = vi.fn()
  let children: FileSystemEntry[]
  if (limit === 'files') children = Array.from({ length: 1001 }, (_, index) =>
    dropFile(uploadFile(index === 0 ? 'SKILL.md' : `${index}.txt`, 'content'), read))
  else if (limit === 'directories') children = Array.from({ length: 1001 }, (_, index) => dropDirectory(`d${index}`, [], read))
  else if (limit === 'depth') {
    let nested = dropFile(uploadFile('SKILL.md', 'content'), extra)
    for (let index = 0; index < 65; index++) nested = dropDirectory('d', [nested], read)
    children = [nested]
  } else {
    children = [32 << 20, 32 << 20, 1].map((size, index) => {
      const file = uploadFile(index === 0 ? 'SKILL.md' : `${index}.txt`, '')
      Object.defineProperty(file, 'size', { value: size })
      return dropFile(file, read)
    })
    children.push(dropFile(uploadFile('unread.txt', ''), extra))
  }
  fireEvent.drop(zone, { dataTransfer: { items: [{ webkitGetAsEntry: () => dropDirectory('skill', children) }] } })
  const alert = await form.findByRole('alert')
  expect(alert.textContent).toContain(limit === 'depth' ? '非法路径' : limit === 'bytes' ? '字节' : '1000')
  expect(read.mock.calls.length).toBeLessThanOrEqual(limit === 'files' ? 1000 : limit === 'directories' ? 2000 : limit === 'depth' ? 128 : 3)
  expect(extra).not.toHaveBeenCalled()
  expect(mock.remote.skillsManager.uploadSkill).not.toHaveBeenCalled()
  expect({ limit, notice: alert.textContent, readCalls: read.mock.calls.length }).toMatchSnapshot()
  const input = screen.getByRole('dialog').querySelector('input[type="file"][accept]')!
  fireEvent.change(input, { target: { files: [uploadFile('repaired.zip', 'content')] } })
  expect(form.queryByRole('alert')).toBeNull()
  expect(form.getByText('repaired.zip')).toBeDefined()
  expect(form.getByRole('button', { name: '安装' })).toHaveProperty('disabled', false)
})

it('retains skill import highlighting while dragging between its description and file choices', async () => {
  await setup(true)
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  const dialog = screen.getByRole('dialog', { name: '导入技能' }), form = within(dialog)
  const caption = form.getByText('拖拽技能到此处'), zone = caption.parentElement!
  const folder = form.getByRole('button', { name: zh['btn.folder.pick'] })
  const file = form.getByRole('button', { name: zh['btn.file.pick'] })
  file.focus()
  fireEvent.dragOver(caption)
  expect(zone.classList.contains('dssm-dropzone-active')).toBe(true)
  fireEvent(caption, new MouseEvent('dragleave', { bubbles: true, relatedTarget: folder }))
  expect(zone.classList.contains('dssm-dropzone-active')).toBe(true)
  fireEvent(folder, new MouseEvent('dragleave', { bubbles: true, relatedTarget: file }))
  expect(zone.classList.contains('dssm-dropzone-active')).toBe(true)
  expect(document.activeElement).toBe(file)
  expect(screen.getByRole('dialog', { name: '导入技能' })).toBe(dialog)
  fireEvent(file, new MouseEvent('dragleave', { bubbles: true, relatedTarget: dialog }))
  expect(zone.classList.contains('dssm-dropzone-active')).toBe(false)
  fireEvent.dragOver(caption)
  fireEvent(zone, new MouseEvent('dragleave', { bubbles: true }))
  expect(zone.classList.contains('dssm-dropzone-active')).toBe(false)
})

it('accepts exactly 1000 dropped files across directory batches without reading their contents before installation', async () => {
  await setup(true)
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  const form = within(screen.getByRole('dialog', { name: '导入技能' }))
  const reads = vi.fn()
  const files = Array.from({ length: 1000 }, (_, index) => uploadFile(index === 0 ? 'SKILL.md' : `${index}.txt`, 'content'))
  const directory = dropDirectory('skill', files.map(file => dropFile(file)), reads)
  fireEvent.drop(form.getByText('拖拽技能到此处').parentElement!, {
    dataTransfer: { items: [{ webkitGetAsEntry: () => directory }] },
  })
  await form.findByText('skill')
  expect(form.queryByRole('alert')).toBeNull()
  expect(reads).toHaveBeenCalledTimes(11)
  for (const file of files) expect(file.arrayBuffer).not.toHaveBeenCalled()
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
  const directory = await mkdtemp(join(tmpdir(), 'skills-page-loader-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const locale = new LocaleRuntime(ctx)
  ctx.effect(() => locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' }))
  locale.setLocale(activeLocale)
  ctx.provide('locale', locale)
  const startSession = vi.fn()
  ctx.reflect.provide('uiWorkspace', { startSession })
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
  const changeLocale = (next: Parameters<LocaleRuntime['setLocale']>[0]) => {
    locale.setLocale(next)
    view.rerender(createElement(entry.component as ComponentType<Pick<SectionProps, 't'>>, pageProps))
  }
  return { data, mock, view, requests, signalFor, startSession, changeLocale }
}

it.each(['zh', 'en'] as const)('retains each skill source search selection without moving tab focus (%s)', async (language) => {
  await setup(true, true, skill('个人技能'), undefined, language)
  const text = language === 'zh' ? zh : en
  await screen.findByText('共享技能')
  const search = screen.getByRole<HTMLInputElement>('textbox', { name: text.search })
  const stats = document.querySelector('.dssm-summary')
  const market = screen.getByRole('tab', { name: text['scope.market'] })
  const mine = screen.getByRole('tab', { name: text['scope.mine'] })
  search.focus()
  fireEvent.change(search, { target: { value: '共享' } })
  search.setSelectionRange(0, 1, 'backward')
  mine.focus(); fireEvent.click(mine)
  expect(screen.getByRole('textbox', { name: text.search })).toBe(search)
  search.focus()
  fireEvent.change(search, { target: { value: '个人技能' } })
  search.setSelectionRange(1, 3, 'forward')
  market.focus(); fireEvent.click(market)
  expect(document.querySelector('.dssm-summary')).toBe(stats)
  expect(document.activeElement).toBe(market)
  search.focus()
  expect([search.value, search.selectionStart, search.selectionEnd, search.selectionDirection]).toEqual(['共享', 0, 1, 'backward'])
  mine.focus(); fireEvent.click(mine)
  expect(document.activeElement).toBe(mine)
  search.focus()
  expect([search.value, search.selectionStart, search.selectionEnd, search.selectionDirection]).toEqual(['个人技能', 1, 3, 'forward'])
  mine.focus()
  search.setSelectionRange(0, search.value.length)
  search.focus()
  expect([search.selectionStart, search.selectionEnd]).toEqual([0, search.value.length])
})

it('retranslates a workspace failure without repeating the read or losing the current tab', async () => {
  const { mock, changeLocale } = await setup(false)
  await screen.findByText(zh['empty.company'])
  mock.unary('skillsManager/listWorkspaces', () => ({ ok: false, error: new RemoteError('skills/operation', 'Registry unavailable', {
    code: 'error.workspace.registryUnavailable',
  }) }))
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('tab', { name: '项目技能' }))
  expect((await screen.findByRole('alert')).textContent).toContain(zh['error.workspace.registryUnavailable'])
  act(() => { changeLocale('en') })
  expect(screen.getByRole('alert').textContent).toContain(en['error.workspace.registryUnavailable'])
  expect(screen.getByRole('tab', { name: 'Project skills' }).getAttribute('aria-selected')).toBe('true')
  expect(mock.remote.skillsManager.listWorkspaces).toHaveBeenCalledOnce()
  act(() => { changeLocale('zh') })
  expect(screen.getByRole('alert').textContent).toContain(zh['error.workspace.registryUnavailable'])
})

it.each(['success', 'failure'] as const)('retains the current locale and confirmed state after a pending skill toggle %s', async (outcome) => {
  const { data, mock, changeLocale, view } = await setup(true)
  const pending = deferred<undefined>()
  mock.unary('skillsManager/setSkillEnabled', async () => {
    await pending.promise
    if (outcome === 'success') data.roots[0].skills[0].managerEnabled = false
    return outcome === 'success' ? ok({}) : { ok: false, error: new RemoteError('skills/operation', 'Permission changed', {
      code: 'error.proto.forbidden',
    }) }
  })
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('switch', { name: '启停技能 共享技能' }))
  act(() => { changeLocale('en') })
  await act(async () => { pending.resolve(undefined); await pending.promise })
  await waitFor(() => { expect(screen.getByRole('switch', { name: 'Toggle skill 共享技能' })).toHaveProperty('disabled', false) })
  const message = (dictionary: typeof zh | typeof en) => dictionary['error.action'].replace('{error}', dictionary['error.proto.forbidden'])
  if (outcome === 'failure') expect(await screen.findByText(message(en))).toBeDefined()
  else expect(view.container.querySelector('.dssm-feedback')).toBeNull()
  act(() => { changeLocale('zh') })
  if (outcome === 'failure') expect(screen.getByText(message(zh))).toBeDefined()
  else expect(view.container.querySelector('.dssm-feedback')).toBeNull()
  expect(screen.getByRole('switch', { name: '启停技能 共享技能' }).getAttribute('aria-checked')).toBe(String(outcome === 'failure'))
  expect(mock.remote.skillsManager.setSkillEnabled).toHaveBeenCalledOnce()
})

it('retranslates a failed import and preserves the selected archive without uploading it again', async () => {
  const { data, mock, changeLocale } = await setup(true)
  data.writeDestinations.push({ key: 'dsh', path: '/skills/dsh', label: 'DSH skills', available: true })
  mock.unary('skillsManager/uploadSkill', () => ok({ imported: [], skipped: [], failed: [{ source: '/import/broken-skill',
    error: 'Duplicate name', code: 'error.import.duplicateName', params: { name: 'broken-skill' } }] }))
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  const dialog = screen.getByRole('dialog', { name: '导入技能' })
  const input = dialog.querySelector('input[type="file"][accept]')
  if (!input) throw new Error('Missing import input')
  fireEvent.change(input, { target: { files: [uploadFile('skills.zip', 'Selected archive')] } })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '安装' })) })
  act(() => { changeLocale('en') })
  const feedback = within(screen.getByRole('dialog', { name: en['import.title'] })).getByRole('alert')
  expect(feedback.textContent).toContain(en['result.importEmpty'])
  expect(feedback.textContent).toContain('Fix the failed items and retry')
  expect(feedback.textContent).toMatchSnapshot()
  expect(screen.getByText('skills.zip')).toBeDefined()
  expect(mock.remote.skillsManager.uploadSkill).toHaveBeenCalledOnce()
})

it('shows incomplete restore recovery without claiming success or consuming the trash row', async () => {
  const { data, mock } = await setup(false)
  data.trash.push({ id: '1794105400000-00000000-0000-0000-0000-000000000001', name: 'audit-orders',
    deletedAt: '2026-11-08T02:00:00.000Z', root: { key: 'dsh', scope: 'user', label: 'DSH' }, entries: ['audit-orders'] })
  mock.unary('skillsManager/restoreTrash', () => ({ ok: false, error: new RemoteError('skills/operation', 'Recovery incomplete', {
    code: 'error.trash.restoreRollbackFailed', params: { path: '/skills-manager/trash/item' },
  }) }))
  await screen.findByText(zh['empty.company'])
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('tab', { name: /回收站/ }))
  fireEvent.click(screen.getByRole('button', { name: zh['btn.restore'] }))
  const notice = await screen.findByText(/恢复未完成/)
  expect(notice.textContent).toContain(zh['error.trash.restoreRollbackFailed'].replace('{path}', '/skills-manager/trash/item'))
  expect(screen.getByText('audit-orders')).toBeDefined()
  expect(screen.getByText(/恢复未完成/).textContent).toMatchSnapshot()
})

it.each(['restore', 'delete'] as const)('does not offer a completed trash %s again after its directory refresh fails', async (operation) => {
  const { data, mock, requests, changeLocale } = await setup(false)
  const item = { id: '1794105400000-00000000-0000-0000-000000000002', name: 'audit-orders',
    deletedAt: '2026-11-08T02:00:00.000Z', root: { key: 'dsh', scope: 'user', label: 'DSH' }, entries: ['audit-orders'] }
  data.trash.push(item)
  await screen.findByText(zh['empty.company'])
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.mine'] }))
  fireEvent.click(screen.getByRole('tab', { name: /回收站/ }))
  await screen.findByRole('group', { name: item.name })
  mock.unary('skillsManager/readState', () => ({ ok: false, error: new RemoteError('skills/operation', 'Directory unavailable', {
    code: 'error.proto.forbidden',
  }) }))
  mock.unary('skillsManager/restoreTrash', () => ok({ id: item.id, name: item.name, root: item.root }))
  mock.unary('skillsManager/deleteTrash', () => ok({ id: item.id, name: item.name }))
  fireEvent.click(screen.getByRole('button', { name: zh[operation === 'restore' ? 'btn.restore' : 'btn.delete.forever'] }))
  if (operation === 'delete') fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh['btn.delete.forever'] }))
  const success = operation === 'restore' ? 'result.restored' : 'result.deleted'
  await screen.findByText(zh[success].replace('{name}', item.name))
  await screen.findByText(zh['error.proto.forbidden'], { exact: false })
  expect(screen.queryByRole('group', { name: item.name })).toBeNull()
  const notice = screen.getByRole('alert')
  expect(notice.textContent).toContain(zh['error.proto.forbidden'])
  expect(notice.textContent).toMatchSnapshot('Directory refresh failure after a committed operation')
  const reads = requests('readState').length
  act(() => { changeLocale('en') })
  expect(screen.getByRole('alert').textContent).toContain(en['error.proto.forbidden'])
  expect(screen.getByText(en[success].replace('{name}', item.name))).toBeTruthy()
  expect(requests('readState')).toHaveLength(reads)
  const retry = deferred<ManagerSnapshot>()
  mock.unary('skillsManager/readState', async () => ok(await retry.promise))
  const retryButton = within(screen.getByRole('alert')).getByRole('button')
  act(() => { fireEvent.click(retryButton); fireEvent.click(retryButton) })
  expect(requests('readState')).toHaveLength(reads + 1)
  expect(screen.queryByRole('group', { name: item.name })).toBeNull()
  expect(within(screen.getByRole('alert')).getByRole('button').getAttribute('aria-disabled')).toBe('true')
  await act(async () => { retry.resolve({ ...data, trash: [] }) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText(en['trash.empty'])).toBeTruthy()
  expect(mock.remote.skillsManager.restoreTrash).toHaveBeenCalledTimes(operation === 'restore' ? 1 : 0)
  expect(mock.remote.skillsManager.deleteTrash).toHaveBeenCalledTimes(operation === 'delete' ? 1 : 0)
})

it.each((['trash', 'delete', 'restore'] as const).flatMap(operation => [false, true].map(elsewhere => ({ operation, elsewhere }))))(
  'recovers skill $operation focus after removing its row without changing another draft (elsewhere=$elsewhere)', async ({ operation, elsewhere }) => {
    const { data, mock, requests } = await setup(false, true, skill('audit-orders'))
    const reply = deferred<undefined>()
    onTestFinished(() => { reply.resolve(undefined) })
    const item = { id: '1794105400000-00000000-0000-000000000004', name: 'audit-orders',
      deletedAt: '2026-11-08T02:00:00.000Z', root: { key: 'dsh', scope: 'user', label: 'DSH' }, entries: ['audit-orders'] }
    data.trash.push(item)
    await screen.findByText(zh['empty.company'])
    fireEvent.click(screen.getByRole('tab', { name: zh['scope.mine'] }))
    const method = operation === 'trash' ? 'trashSkill' : operation === 'delete' ? 'deleteTrash' : 'restoreTrash'
    mock.unary(`skillsManager/${method}`, async () => {
      await reply.promise
      if (operation === 'trash') data.roots.find(value => value.key === 'dsh')!.skills = []
      else data.trash = []
      return ok(item)
    })
    if (operation === 'trash') {
      fireEvent.click(screen.getByRole('button', { name: /DSH/, expanded: false }))
      fireEvent.change(screen.getByRole('textbox', { name: zh.search }), { target: { value: 'audit' } })
      fireEvent.click(screen.getByRole('button', { name: zh['btn.more'] }))
      fireEvent.click(screen.getByRole('menuitem', { name: zh['btn.trash'] }))
    } else {
      fireEvent.click(screen.getByRole('tab', { name: /回收站/ }))
      const trigger = await screen.findByRole('button', { name: zh[operation === 'delete' ? 'btn.delete.forever' : 'btn.restore'] })
      trigger.focus(); fireEvent.click(trigger)
    }
    const search = screen.queryByRole<HTMLInputElement>('textbox', { name: zh.search })
    search?.setSelectionRange(1, 3)
    const target = search ?? document.getElementById('dssm-library-panel')
    if (operation !== 'restore') {
      const confirm = within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', {
        name: zh[operation === 'trash' ? 'btn.trash' : 'btn.delete.forever'],
      })
      confirm.focus(); fireEvent.click(confirm)
    }
    render(<input aria-label="Other draft" defaultValue="Unsubmitted" />)
    const other = screen.getByRole<HTMLInputElement>('textbox', { name: 'Other draft' })
    other.setSelectionRange(2, 5)
    if (elsewhere) other.focus()
    await act(async () => { reply.resolve(undefined) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(elsewhere ? other : target)
    if (search) {
      expect(screen.getByRole('textbox', { name: zh.search })).toBe(search)
      expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['audit', 1, 3])
    }
    expect([other.value, other.selectionStart, other.selectionEnd]).toEqual(['Unsubmitted', 2, 5])
    expect(requests(method)).toHaveLength(1)
  },
)

it.each(['trash', 'delete'] as const)('keeps a failed skill %s confirmation visible during retry and closes only after completion', async (operation) => {
  const { data, mock, requests } = await setup(false)
  const item = { id: '1794105400000-00000000-0000-000000000003', name: 'audit-orders',
    deletedAt: '2026-11-08T02:00:00.000Z', root: { key: 'dsh', scope: 'user', label: 'DSH' }, entries: ['audit-orders'] }
  data.trash.push(item)
  await screen.findByText(zh['empty.company'])
  const marketTab = screen.getByRole('tab', { name: zh['scope.market'] })
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.mine'] }))
  if (operation === 'delete') {
    fireEvent.click(screen.getByRole('tab', { name: /回收站/ }))
    fireEvent.click(await screen.findByRole('button', { name: zh['btn.delete.forever'] }))
  } else {
    fireEvent.click(screen.getByRole('button', { name: /DSH/, expanded: false }))
    fireEvent.click(screen.getByRole('button', { name: zh['btn.more'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['btn.trash'] }))
  }
  const method = operation === 'trash' ? 'trashSkill' : 'deleteTrash'
  const action = zh[operation === 'trash' ? 'btn.trash' : 'btn.delete.forever']
  const failure = { ok: false as const, error: new RemoteError('skills/operation', 'Write unavailable', { code: 'error.proto.forbidden' }) }
  if (operation === 'trash') mock.unary('skillsManager/trashSkill', () => failure)
  else mock.unary('skillsManager/deleteTrash', () => failure)
  const dialog = screen.getByRole('dialog')
  const feedback = dialog.querySelector('.dssm-write-feedback')
  expect(feedback?.textContent).toBe('')
  fireEvent.click(within(dialog).getByRole('button', { name: action }))
  const notice = await within(dialog).findByRole('alert')
  expect(notice.closest('.dssm-write-feedback')).toBe(feedback)
  expect(notice.textContent).toContain(zh['error.proto.forbidden'])
  expect(document.querySelectorAll('.dssm-feedback')).toHaveLength(1)
  const retry = deferred<undefined>()
  if (operation === 'trash') mock.unary('skillsManager/trashSkill', async () => {
    await retry.promise
    return ok({ id: item.id, name: item.name, deletedAt: item.deletedAt, root: item.root })
  })
  else mock.unary('skillsManager/deleteTrash', async () => {
    await retry.promise
    return ok({ id: item.id, name: item.name })
  })
  const confirm = within(dialog).getByRole('button', { name: action })
  const cancel = within(dialog).getByRole('button', { name: zh['btn.cancel'] })
  const close = within(dialog).getByRole('button', { name: zh['btn.close'] })
  confirm.focus()
  try {
    act(() => {
      fireEvent.click(confirm); fireEvent.click(confirm); fireEvent.click(cancel); fireEvent.click(close); fireEvent.click(marketTab)
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(marketTab.getAttribute('aria-selected')).toBe('false')
    expect(within(dialog).getByRole('alert')).toBe(notice)
    expect(notice.closest('.dssm-write-feedback')).toBe(feedback)
    expect(within(dialog).getByRole('button', { name: action })).toBe(confirm)
    expect(confirm.getAttribute('aria-busy')).toBe('true')
    expect(confirm.classList.contains('product-control-pending')).toBe(true)
    expect(cancel.classList.contains('product-control-pending')).toBe(true)
    expect(cancel).toHaveProperty('disabled', false)
    expect(cancel.getAttribute('aria-disabled')).toBe('true')
    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(confirm)
    expect(cancel.getAttribute('aria-busy')).not.toBe('true')
    await waitFor(() => { expect(requests(method)).toHaveLength(2) })
    expect({ operation, notice: notice.textContent, action: confirm.textContent,
      busy: confirm.getAttribute('aria-busy'), cancelDisabled: cancel.hasAttribute('disabled') }).toMatchSnapshot()
    await act(async () => { retry.resolve(undefined); await retry.promise })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(document.querySelectorAll('.dssm-feedback')).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()
  } finally {
    await act(async () => { retry.resolve(undefined); await retry.promise })
  }
})

it.each(['failure', 'partial'] as const)('keeps import %s feedback, selection and action controls stable during a slow retry', async (outcome) => {
  const { data, mock, requests } = await setup(false)
  data.writeDestinations.push({ key: 'dsh', path: '/skills/dsh', label: 'DSH skills', available: true })
  await screen.findByText(zh['empty.company'])
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.mine'] }))
  fireEvent.click(screen.getByRole('button', { name: zh['import.title'] }))
  const dialog = screen.getByRole('dialog')
  const form = within(dialog)
  fireEvent.change(dialog.querySelector('input[type="file"][accept]')!, { target: { files: [uploadFile('skill.zip', 'content')] } })
  const feedback = dialog.querySelector('.dssm-write-feedback')
  expect(feedback?.textContent).toBe('')
  mock.unary('skillsManager/uploadSkill', () => outcome === 'failure'
    ? { ok: false, error: new RemoteError('skills/operation', 'Import unavailable', { code: 'error.proto.forbidden' }) }
    : ok({ imported: [{ name: 'ready-skill', overwritten: false, warnings: [] }], skipped: [],
      failed: [{ source: '/temporary/import/broken-skill', error: 'Duplicate name', code: 'error.import.duplicateName', params: { name: 'broken-skill' } }] }))
  fireEvent.click(form.getByRole('button', { name: zh['btn.import.now'] }))
  const notice = await form.findByRole('alert')
  expect(notice.closest('.dssm-write-feedback')).toBe(feedback)
  const pending = deferred<SkillOutput<'uploadSkill'>>()
  mock.unary('skillsManager/uploadSkill', async () => ok(await pending.promise))
  const confirm = form.getByRole('button', { name: zh['btn.import.now'] })
  const cancel = form.getByRole('button', { name: zh['btn.cancel'] })
  const pick = form.getByRole('button', { name: zh['btn.file.pick'] })
  const nativePicker = vi.spyOn(dialog.querySelector<HTMLInputElement>('input[type="file"][accept]')!, 'click')
  confirm.focus()
  try {
    act(() => { fireEvent.click(confirm); fireEvent.click(pick); fireEvent.click(cancel); fireEvent.click(confirm) })
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(form.getByRole('alert')).toBe(notice)
    expect(notice.closest('.dssm-write-feedback')).toBe(feedback)
    expect(form.getByText('skill.zip')).toBeTruthy()
    expect(form.getByRole('button', { name: zh['btn.import.now'] })).toBe(confirm)
    expect(confirm.getAttribute('aria-busy')).toBe('true')
    expect(confirm.classList.contains('product-control-pending')).toBe(true)
    expect(cancel.classList.contains('product-control-pending')).toBe(true)
    expect(cancel).toHaveProperty('disabled', false)
    expect(cancel.getAttribute('aria-disabled')).toBe('true')
    expect(nativePicker).not.toHaveBeenCalled()
    await waitFor(() => { expect(requests('uploadSkill')).toHaveLength(2) })
    expect({ outcome, notice: notice.textContent, action: confirm.textContent, busy: confirm.getAttribute('aria-busy'),
      cancelDisabled: cancel.hasAttribute('disabled'), cancelUnavailable: cancel.getAttribute('aria-disabled'),
      focused: document.activeElement?.textContent }).toMatchSnapshot()
    await act(async () => { pending.resolve({ imported: [{ name: 'skill', overwritten: false, warnings: [] }], skipped: [], failed: [] }); await pending.promise })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  } finally {
    await act(async () => { pending.resolve({ imported: [], skipped: [], failed: [] }); await pending.promise })
  }
})

it('retains partial import feedback and its scroll position while refreshing the directory after a retry', async () => {
  const { data, mock } = await setup(false)
  data.writeDestinations.push({ key: 'dsh', path: '/skills/dsh', label: 'DSH skills', available: true })
  await screen.findByText(zh['empty.company'])
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.mine'] }))
  fireEvent.click(screen.getByRole('button', { name: zh['import.title'] }))
  const dialog = screen.getByRole('dialog'), form = within(dialog)
  fireEvent.change(dialog.querySelector('input[type="file"][accept]')!, { target: { files: [uploadFile('skill.zip', 'content')] } })
  const partial: SkillOutput<'uploadSkill'> = { imported: [{ name: 'ready-skill', overwritten: false, warnings: [] }], skipped: [],
    failed: [{ source: '/temporary/import/broken-skill', error: 'Duplicate name', code: 'error.import.duplicateName', params: { name: 'broken-skill' } }] }
  mock.unary('skillsManager/uploadSkill', () => ok(partial))
  const confirm = form.getByRole('button', { name: zh['btn.import.now'] })
  fireEvent.click(confirm)
  const notice = await form.findByRole('alert')
  await waitFor(() => { expect(confirm.getAttribute('aria-busy')).toBe('false') })
  const feedback = notice.closest<HTMLElement>('.dssm-write-feedback')!
  feedback.scrollTop = 40
  const readback = deferred<undefined>()
  const reading = vi.fn()
  mock.unary('skillsManager/readState', async () => { reading(); await readback.promise; return ok(data) })
  onTestFinished(async () => { readback.resolve(undefined); await readback.promise })
  confirm.focus()
  fireEvent.click(confirm)
  await waitFor(() => { expect(reading).toHaveBeenCalledOnce() })
  expect(form.queryByRole('alert')).toBe(notice)
  expect(feedback.scrollTop).toBe(40)
  expect(document.activeElement).toBe(confirm)
  expect(confirm.getAttribute('aria-busy')).toBe('true')
  await act(async () => { readback.resolve(undefined); await readback.promise })
  await waitFor(() => { expect(confirm.getAttribute('aria-busy')).toBe('false') })
  expect(form.getByRole('alert')).toBe(notice)
  expect(feedback.scrollTop).toBe(40)
  expect(form.getByText('skill.zip')).toBeTruthy()
  expect(mock.remote.skillsManager.uploadSkill).toHaveBeenCalledTimes(2)
})

it('retains the skill refresh focus and rejects repeated activation until the directory read settles', async () => {
  const { data, mock, view } = await setup(true)
  await screen.findByText('共享技能')
  const read = deferred<undefined>()
  onTestFinished(() => { view.unmount(); read.resolve(undefined) })
  mock.unary('skillsManager/readState', async () => { await read.promise; return ok(data) })
  const refresh = screen.getByRole('button', { name: zh['btn.refresh'] })
  const glyph = refresh.querySelector('svg')
  const reads = mock.remote.skillsManager.readState.mock.calls.length
  refresh.focus()
  act(() => { refresh.click(); refresh.click() })
  expect(refresh.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(refresh)
  expect(refresh.querySelector('svg')).toBe(glyph)
  expect(mock.remote.skillsManager.readState).toHaveBeenCalledTimes(reads + 1)
  fireEvent.click(refresh)
  expect(mock.remote.skillsManager.readState).toHaveBeenCalledTimes(reads + 1)
  await act(async () => { read.resolve(undefined); await read.promise })
  await waitFor(() => { expect(refresh.getAttribute('aria-disabled')).toBe('false') })
  expect(document.activeElement).toBe(refresh)
  expect(screen.getByRole('button', { name: zh['btn.refresh'] })).toBe(refresh)
})

it('hides an invalidated market directory until a retry succeeds and preserves its search', async () => {
  const { data, mock, requests } = await setup(true)
  await screen.findByText('共享技能')
  await act(async () => {})
  fireEvent.change(screen.getByRole('textbox', { name: zh.search }), { target: { value: '共享' } })
  mock.unary('skillsManager/readState', () => ({ ok: false, error: new RemoteError('skills/operation', 'Directory unavailable', {
    code: 'error.proto.forbidden',
  }) }))
  fireEvent.click(screen.getByRole('button', { name: zh['btn.refresh'] }))
  await screen.findByRole('alert')
  expect(screen.queryByText('共享技能')).toBeNull()
  expect(screen.queryByRole('switch', { name: zh['market.source'] })).toBeNull()
  expect([...document.querySelectorAll('.dssm-stat strong')].map(node => node.textContent)).toEqual(['—', '—', '—'])
  expect(screen.queryByText(zh['empty.company'])).toBeNull()
  const reads = requests('readState').length
  const retry = deferred<ManagerSnapshot>()
  mock.unary('skillsManager/readState', async () => ok(await retry.promise))
  const retryButton = within(screen.getByRole('alert')).getByRole('button')
  const notice = screen.getByRole('alert')
  retryButton.focus()
  act(() => { fireEvent.click(retryButton); fireEvent.click(retryButton) })
  expect(requests('readState')).toHaveLength(reads + 1)
  expect(screen.queryByText('共享技能')).toBeNull()
  expect(screen.getByRole('alert')).toBe(notice)
  expect(within(notice).getByRole('button')).toBe(retryButton)
  expect(retryButton.classList.contains('product-control-pending')).toBe(true)
  expect(retryButton.getAttribute('aria-busy')).toBe('true')
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  expect({ message: notice.textContent, canRetry: retryButton.getAttribute('aria-disabled') !== 'true',
    loadingIndicator: screen.queryByRole('status', { name: zh.loading }) !== null }).toMatchSnapshot('Pending directory retry')
  await act(async () => { retry.reject(new Error('Still unavailable')) })
  expect(screen.queryByText('共享技能')).toBeNull()
  expect(retryButton).toHaveProperty('disabled', false)
  mock.unary('skillsManager/readState', () => ok(data))
  fireEvent.click(retryButton)
  await screen.findByText('共享技能')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: zh.search }).value).toBe('共享')
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: zh.search }))
  expect(screen.getByRole('switch', { name: zh['market.source'] })).toBeTruthy()
})

it.each(['listWorkspaces', 'readWorkspace'] as const)('keeps a failed project %s read visible until its refresh succeeds', async (method) => {
  const { data, mock, view } = await setup(true)
  await screen.findByText('共享技能')
  const workspaces = { items: [{ name: '项目', available: true, registeredPaths: ['/workspace'] }] }
  mock.unary('skillsManager/listWorkspaces', () => ok(workspaces))
  mock.unary(`skillsManager/${method}`, () => ({ ok: false,
    error: new RemoteError('skills/operation', 'Workspace unavailable', { code: 'error.workspace.registryUnavailable' }) }))
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.mine'] }))
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.project'] }))
  const panel = await screen.findByRole('tabpanel', { name: zh['scope.project'] })
  const notice = await within(panel).findByRole('alert')
  const pending = deferred<SkillOutput<typeof method>>()
  const result = method === 'listWorkspaces' ? workspaces : { ...data, roots: [root('dsh', [skill('项目技能')])] }
  onTestFinished(() => { view.unmount(); pending.resolve(result) })
  mock.unary(`skillsManager/${method}`, async () => ok(await pending.promise))
  if (method === 'listWorkspaces') mock.unary('skillsManager/readWorkspace', () => ok({ ...data, roots: [root('dsh', [skill('项目技能')])] }))
  const refresh = screen.getByRole('button', { name: zh['btn.refresh'] })
  const glyph = refresh.querySelector('svg')
  fireEvent.click(refresh)
  expect(within(panel).getByRole('alert')).toBe(notice)
  expect(within(panel).queryByText(zh['workspace.noSkills'])).toBeNull()
  expect(within(panel).queryByText(zh['project.empty'])).toBeNull()
  expect(within(panel).queryByRole('status')).toBeNull()
  expect(refresh.getAttribute('aria-disabled')).toBe('true')
  expect(refresh.classList.contains('product-control-pending')).toBe(true)
  expect(refresh.getAttribute('aria-busy')).toBe('true')
  expect(refresh.querySelector('svg')).toBe(glyph)
  expect(notice.textContent).toMatchSnapshot('Retained project read failure')
  await act(async () => { pending.resolve(result); await pending.promise })
  await within(panel).findByText('项目技能')
  expect(within(panel).queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: zh['btn.refresh'] })).toBe(refresh)
  await waitFor(() => { expect(refresh).toHaveProperty('disabled', false) })
})

it.each(['success', 'failure', 'cancel'] as const)('retains the import destination retry and starts one workspace read until %s', async (outcome) => {
  const { data, mock, view, requests } = await setup(true)
  await screen.findByText('共享技能')
  data.writeDestinations.push({ key: 'dsh', path: '/skills', label: 'DSH skills', available: true })
  mock.unary('skillsManager/listWorkspaces', () => { throw new Error('Workspace unavailable') })
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.mine'] }))
  fireEvent.click(screen.getByRole('button', { name: zh['import.global'] }))
  const form = within(screen.getByRole('dialog'))
  const labels = destinationLocales.zh
  fireEvent.click(form.getByRole('button', { name: labels['dest.scope'] }))
  fireEvent.click(screen.getByRole('menuitem', { name: labels['dest.scope.workspace'] }))
  const notice = await form.findByRole('alert')
  const pending = deferred<SkillOutput<'listWorkspaces'>>()
  const result = { items: [{ name: '验收工作区', registeredPaths: ['/workspace'], available: true, skillCount: 0 }] }
  onTestFinished(() => { view.unmount(); pending.resolve(result) })
  mock.unary('skillsManager/listWorkspaces', async () => ok(await pending.promise))
  const retry = form.getByRole<HTMLButtonElement>('button', { name: labels['dest.retry'] })
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(mock.remote.skillsManager.listWorkspaces).toHaveBeenCalledTimes(2)
  const signal = requests('listWorkspaces').at(-1)?.[3]
  expect(signal?.aborted).toBe(false)
  expect(document.activeElement).toBe(retry)
  expect(form.getByRole('alert')).toBe(notice)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(retry.getAttribute('aria-busy')).toBe('true')
  fireEvent.click(retry)
  expect(mock.remote.skillsManager.listWorkspaces).toHaveBeenCalledTimes(2)
  if (outcome === 'cancel') view.unmount()
  await act(async () => {
    if (outcome === 'failure') pending.reject(new Error('Still unavailable'))
    else pending.resolve(result)
  })
  if (outcome === 'success') expect(form.queryByRole('alert')).toBeNull()
  else if (outcome === 'failure') {
    expect(form.getByRole('alert')).toBe(notice)
    expect(document.activeElement).toBe(retry)
    expect(retry.getAttribute('aria-disabled')).toBe('false')
  } else {
    expect(signal?.aborted).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
  }
  expect(mock.remote.skillsManager.uploadSkill).not.toHaveBeenCalled()
})

it('offers a cancellable retry after the initial skill directory read fails', async () => {
  const first = deferred<undefined>()
  const { mock, requests, view } = await setup(false, true, skill('个人技能'), first.promise)
  await act(async () => { first.reject(new Error('Directory unavailable')) })
  const notice = await screen.findByRole('alert')
  expect(screen.queryByText(zh['empty.company'])).toBeNull()
  expect([...document.querySelectorAll('.dssm-stat strong')].map(node => node.textContent)).toEqual(['—', '—', '—'])
  const pending = deferred<ManagerSnapshot>()
  mock.unary('skillsManager/readState', async () => ok(await pending.promise))
  fireEvent.click(within(notice).getByRole('button', { name: zh['btn.retry'] }))
  const signal = requests('readState').at(-1)?.[3]
  expect(signal?.aborted).toBe(false)
  view.unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => { pending.reject(new Error('Abandoned retry')) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('retains focus moved away from a skill directory retry', async () => {
  const { data, mock, view } = await setup(true)
  await screen.findByText('共享技能')
  await act(async () => {})
  mock.unary('skillsManager/readState', () => { throw new Error('Directory unavailable') })
  fireEvent.click(screen.getByRole('button', { name: zh['btn.refresh'] }))
  const notice = await screen.findByRole('alert')
  const pending = deferred<ManagerSnapshot>()
  onTestFinished(() => { view.unmount(); pending.resolve(data) })
  mock.unary('skillsManager/readState', async () => ok(await pending.promise))
  const retry = within(notice).getByRole('button', { name: zh['btn.retry'] })
  retry.focus()
  fireEvent.click(retry)
  const create = screen.getByRole('button', { name: zh['btn.create'] })
  create.focus()
  const focus = vi.spyOn(create, 'focus')
  await act(async () => { pending.resolve(data); await pending.promise })
  expect(await screen.findByText('共享技能')).toBeTruthy()
  expect(document.activeElement).toBe(create)
  expect(focus).not.toHaveBeenCalled()
})

it.each(['trash', 'repositories'] as const)('recovers a directory retry on the %s page without a skill search box', async (scope) => {
  const { data, mock, view } = await setup(true)
  await screen.findByText('共享技能')
  await act(async () => {})
  mock.unary('skillsManager/listRepositories', () => ok({ repositories: [], installRoots: [],
    catalogInstalls: [], catalogCopies: [], catalogWarnings: [] }))
  mock.unary('skillsManager/readState', () => { throw new Error('Directory unavailable') })
  fireEvent.click(screen.getByRole('button', { name: zh['btn.refresh'] }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.mine'] }))
  fireEvent.click(screen.getByRole('tab', { name: scope === 'trash' ? zh['scope.trash'] : repositoryLocales.zh['scope.repositories'] }))
  const retry = await screen.findByRole('button', { name: zh['btn.retry'] })
  const pending = deferred<ManagerSnapshot>()
  onTestFinished(() => { view.unmount(); pending.resolve(data) })
  mock.unary('skillsManager/readState', async () => ok(await pending.promise))
  retry.focus()
  fireEvent.click(retry)
  const panel = screen.getByRole('tabpanel', { name: zh['scope.mine'] })
  const focus = vi.spyOn(panel, 'focus')
  await act(async () => { pending.resolve(data); await pending.promise })
  await waitFor(() => { expect(screen.queryByRole('button', { name: zh['btn.retry'] })).toBeNull() })
  expect(document.activeElement).toBe(panel)
  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
})

it('marks the retained directory retry busy while entering Trash rereads a failed directory', async () => {
  const { data, mock, view } = await setup(true)
  await screen.findByText('共享技能')
  await act(async () => {})
  mock.unary('skillsManager/readState', () => { throw new Error('Directory unavailable') })
  fireEvent.click(screen.getByRole('button', { name: zh['btn.refresh'] }))
  const notice = await screen.findByRole('alert')
  const retry = within(notice).getByRole('button', { name: zh['btn.retry'] })
  const pending = deferred<ManagerSnapshot>()
  onTestFinished(() => { view.unmount(); pending.resolve(data) })
  mock.unary('skillsManager/readState', async () => ok(await pending.promise))
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.mine'] }))
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.trash'] }))
  const reads = mock.remote.skillsManager.readState.mock.calls.length
  expect(screen.getByRole('alert')).toBe(notice)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(retry)
  expect(mock.remote.skillsManager.readState).toHaveBeenCalledTimes(reads)
  await act(async () => { pending.resolve(data); await pending.promise })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
})

it('keeps an independently refreshed project usable when the global skill directory cannot be read', async () => {
  const { data, mock } = await setup(true)
  await screen.findByText('共享技能')
  mock.unary('skillsManager/listWorkspaces', () => ok({ items: [{ name: '项目', available: true, registeredPaths: ['/workspace'] }] }))
  mock.unary('skillsManager/readWorkspace', () => ok({ ...data, roots: [root('dsh', [skill('项目技能')])] }))
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.mine'] }))
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.project'] }))
  const project = await screen.findByRole('tabpanel', { name: zh['scope.project'] })
  await within(project).findByText('项目技能')
  mock.unary('skillsManager/readState', () => ({ ok: false, error: new RemoteError('skills/operation', 'Directory unavailable', {
    code: 'error.proto.forbidden',
  }) }))
  fireEvent.click(screen.getByRole('button', { name: zh['btn.refresh'] }))
  await screen.findByRole('alert')
  await waitFor(() => { expect(project.getAttribute('aria-busy')).toBe('false') })
  expect(within(project).getByText('项目技能')).toBeTruthy()
  expect(within(project).getByRole('switch', { name: '启停技能 项目技能' })).toHaveProperty('disabled', false)
})

it.each(['success', 'failure'] as const)('cancels a departed repository list and accepts the reopened list before its late %s', async (outcome) => {
  const { mock, requests } = await setup(false)
  await screen.findByText(zh['empty.company'])
  const previous = deferred<SkillOutput<'listRepositories'>>()
  const current = deferred<SkillOutput<'listRepositories'>>()
  const result: SkillOutput<'listRepositories'> = { repositories: [{ id: 'current', owner: 'company', name: 'current-skills',
    ref: '', subdirectory: '', commit: 'revision', refreshedAt: null, error: null, skills: [] }],
  installRoots: [], catalogInstalls: [], catalogCopies: [], catalogWarnings: [] }
  onTestFinished(async () => {
    previous.resolve(result); current.resolve(result)
    await Promise.allSettled([previous.promise, current.promise])
  })
  let reads = 0
  mock.unary('skillsManager/listRepositories', async () => ok(await (++reads === 1 ? previous.promise : current.promise)))
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.mine'] }))
  fireEvent.click(screen.getByRole('tab', { name: repositoryLocales.zh['scope.repositories'] }))
  await waitFor(() => { expect(requests('listRepositories')).toHaveLength(1) })
  const firstSignal = requests('listRepositories')[0]?.[3]
  expect(firstSignal?.aborted).toBe(false)
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.user'] }))
  expect(firstSignal?.aborted).toBe(true)
  fireEvent.click(screen.getByRole('tab', { name: repositoryLocales.zh['scope.repositories'] }))
  await waitFor(() => { expect(requests('listRepositories')).toHaveLength(2) })
  const latestSignal = requests('listRepositories')[1]?.[3]
  expect(latestSignal?.aborted).toBe(false)
  await act(async () => { current.resolve(result); await current.promise })
  await screen.findByRole('button', { name: /company\/current-skills/ })
  await act(async () => {
    if (outcome === 'failure') previous.reject(new Error('Departed repository read failed'))
    else previous.resolve({ ...result, repositories: result.repositories.map(repo => ({ ...repo, name: 'obsolete-skills' })) })
    await previous.promise.catch(() => undefined)
  })
  expect(screen.queryByText(/obsolete-skills/)).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: repositoryLocales.zh['repo.add'] }).disabled).toBe(false)
  expect({ current: screen.getByRole('button', { name: /company\/current-skills/ }).textContent,
    previousCancelled: firstSignal?.aborted, reads: requests('listRepositories').length }).toMatchInlineSnapshot(`
      {
        "current": "company/current-skills0默认分支",
        "previousCancelled": true,
        "reads": 2,
      }
    `)
})

it.each([
  { outcome: 'add', message: 'repo.addSuccess' },
  { outcome: 'remove', message: 'repo.removeSuccess' },
  { outcome: 'scan-failed', message: 'repo.addScanWarning' },
  { outcome: 'add-read-failed', message: 'repo.addRefreshWarning' },
  { outcome: 'remove-read-failed', message: 'repo.removeRefreshWarning' },
] as const)('reports a committed repository operation through the loaded skill page: $outcome', async ({ outcome, message }) => {
  const { mock, changeLocale } = await setup(false)
  const repo = { id: 'repo', owner: 'company', name: 'skills', ref: '', subdirectory: '', commit: null, refreshedAt: null, error: null, skills: [] }
  const added = { ...repo, id: 'new', name: 'new-skills' }
  let repositories: SkillOutput<'listRepositories'>['repositories'] = [repo]
  mock.unary('skillsManager/listRepositories', () => ok({ repositories, installRoots: [], catalogInstalls: [], catalogCopies: [], catalogWarnings: [] }))
  mock.unary('skillsManager/addRepository', () => { repositories = [repo, added]; return ok(added) })
  mock.unary('skillsManager/removeRepository', () => { repositories = []; return ok({ id: repo.id }) })
  mock.unary('skillsManager/refreshRepository', () => outcome === 'scan-failed' ? {
    ok: false, error: new RemoteError('skills/operation', 'Scan unavailable', { code: 'error.repo.network', error: 'Scan unavailable' }),
  } : ok(added))
  await screen.findByText(zh['empty.company'])
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.mine'] }))
  fireEvent.click(screen.getByRole('tab', { name: repositoryLocales.zh['scope.repositories'] }))
  await waitFor(() => { expect(screen.getByRole('button', { name: repositoryLocales.zh['repo.add'] })).toHaveProperty('disabled', false) })
  if (outcome.endsWith('read-failed')) mock.unary('skillsManager/listRepositories', () => ({ ok: false,
    error: new RemoteError('skills/operation', 'List unavailable', { code: 'error.repo.state', error: 'List unavailable' }),
  }))
  const removing = outcome.startsWith('remove')
  if (removing) {
    fireEvent.click(screen.getByRole('button', { name: repositoryLocales.zh['repo.manage'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: repositoryLocales.zh['repo.remove'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: repositoryLocales.zh['repo.removeConfirm'] }))
  } else {
    fireEvent.click(screen.getByRole('button', { name: repositoryLocales.zh['repo.add'] }))
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('textbox', { name: repositoryLocales.zh['repo.url'] }), { target: { value: 'company/new-skills' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: repositoryLocales.zh['repo.save'] }))
  }
  await waitFor(() => { expect(screen.getByRole('button', { name: repositoryLocales.zh['repo.add'] })).toHaveProperty('disabled', false) })
  const notice = () => [...new Set(screen.getAllByRole('status').map(node => node.textContent))]
  const chinese = notice()
  expect(chinese[0]).toContain(repositoryLocales.zh[message])
  act(() => { changeLocale('en') })
  expect({ zh: chinese, en: notice() }).toMatchSnapshot()
  expect(mock.remote.skillsManager.addRepository.mock.calls).toHaveLength(removing ? 0 : 1)
  expect(mock.remote.skillsManager.removeRepository.mock.calls).toHaveLength(removing ? 1 : 0)
  expect(mock.remote.skillsManager.refreshRepository.mock.calls).toHaveLength(removing ? 0 : 1)
})

it.each(['zh', 'en'] as const)('shows retained repository files when update recovery fails in %s', async (activeLocale) => {
  const { mock } = await setup(false, true, skill('个人技能'), undefined, activeLocale)
  const copy = repositoryLocales[activeLocale], dictionary = activeLocale === 'zh' ? zh : en
  mock.unary('skillsManager/listRepositories', () => ok({ repositories: [{ id: 'repo', owner: 'company', name: 'skills',
    ref: '', subdirectory: '', commit: 'revision', refreshedAt: null, error: null, skills: [{ path: 'skills/orders', name: 'orders',
      description: 'Order audit', valid: true, documentHash: 'hash', status: 'available', installations: [{ installedRoot: 'dsh',
        tracked: true, status: 'installed', updateAvailable: true, canRollback: true, canUninstall: true }] }] }],
  installRoots: [{ key: 'dsh', path: '/skills', label: 'DSH', available: true }], catalogInstalls: [], catalogCopies: [], catalogWarnings: [],
  } satisfies SkillOutput<'listRepositories'>))
  mock.unary('skillsManager/previewUpdate', () => ok({ token: 'current', commit: 'new', localModified: false,
    changes: [{ path: 'SKILL.md', kind: 'modified' }], rollback: false }))
  const path = '/skills-manager/repository-backups'
  mock.unary('skillsManager/updateRepository', () => ({ ok: false, error: new RemoteError('skills/operation', 'Recovery incomplete', {
    code: 'error.repo.restoreRollbackFailed', params: { path },
  }) }))
  await screen.findByText(dictionary['empty.company'])
  fireEvent.click(screen.getByRole('tab', { name: dictionary['scope.mine'] }))
  fireEvent.click(screen.getByRole('tab', { name: copy['scope.repositories'] }))
  fireEvent.click(await screen.findByRole('button', { name: /company\/skills/, expanded: false }))
  fireEvent.click(await screen.findByRole('button', { name: copy['repo.review'] }))
  fireEvent.click(await screen.findByRole('button', { name: copy['repo.confirmUpdate'] }))
  const notice = await screen.findByRole('alert')
  expect(notice.textContent).toContain(copy['error.repo.restoreRollbackFailed'].replace('{path}', path))
  expect(notice.textContent).toMatchSnapshot()
  expect(screen.getByRole('dialog')).toBeDefined()
  expect(mock.remote.skillsManager.updateRepository).toHaveBeenCalledOnce()
})

it('offers predefined business categories before either catalog contains skills and assigns one without a separate category form', async () => {
  const { data, mock, requests, changeLocale } = await setup(false)
  await screen.findByText(zh['empty.company'])
  const categories = () => within(screen.getByRole('group', { name: zh['category.filter'] }))
  expect(categories().getByRole('button', { name: '订单与售后' })).toBeDefined()
  expect(categories().getByRole('button', { name: '企业协作' })).toBeDefined()
  fireEvent.click(categories().getByRole('button', { name: '财务与对账' }))
  expect(categories().getByRole('button', { name: '财务与对账' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  mock.unary('skillsManager/assignCategory', () => ok({ root: 'dsh', name: '个人技能', categoryId: 'finance' }))
  fireEvent.click(screen.getByRole('button', { name: /DSH/, expanded: false }))
  fireEvent.click(await screen.findByRole('button', { name: '更多' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '归入财务与对账' }))
  await waitFor(() => { expect(requests('assignCategory')).toHaveLength(1) })
  expect(requests('assignCategory')[0]?.[2]).toMatchObject({ args: { target: { root: 'dsh', name: '个人技能', categoryId: 'finance' } } })
  expect(data.roots.find(root => root.key === 'dsh')?.categories).toEqual([])
  const category = resolveContentCategory('finance')
  await screen.findByText(zh['category.assigned'].replace('{name}', '个人技能').replace('{category}', category.zh))
  act(() => { changeLocale('en') })
  expect(screen.getByText(en['category.assigned'].replace('{name}', '个人技能').replace('{category}', category.en))).toBeDefined()
  act(() => { changeLocale('ja') })
  expect(screen.getByText(en['category.assigned'].replace('{name}', '个人技能').replace('{category}', category.en))).toBeDefined()
  expect(within(screen.getByRole('group', { name: en['category.filter'] })).getByRole('button', { name: category.en })).toBeDefined()
  act(() => { changeLocale('zh') })
  expect(screen.getByText(zh['category.assigned'].replace('{name}', '个人技能').replace('{category}', category.zh))).toBeDefined()
  expect(requests('assignCategory')).toHaveLength(1)
})

it('filters market and personal skills by category together with search and enablement, preserving independent selections', async () => {
  const { data } = await setup(true)
  const company = data.roots[0], personal = data.roots[1]
  company.categories = [{ id: 'docs1', name: '企业协作' }, { id: 'data1', name: 'analytics' }]
  company.skills = [{ ...skill('market-docs'), categoryId: 'docs1' }, { ...skill('market-data'), categoryId: 'data1', managerEnabled: false }, skill('market-loose')]
  personal.categories = [{ id: 'localdocs', name: '企业协作' }]
  personal.skills = [{ ...skill('local-docs'), categoryId: 'localdocs' }, skill('local-loose')]
  await screen.findByText('market-docs')
  const categories = () => within(screen.getByRole('group', { name: '技能分类' }))
  fireEvent.click(categories().getByRole('button', { name: '数据与经营分析' }))
  expect(screen.getByText('market-data')).toBeTruthy()
  expect(screen.queryByText('market-docs')).toBeNull()
  expect(screen.queryByText('market-loose')).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: '搜索' }), { target: { value: 'missing' } })
  expect(screen.getByText('没有匹配的技能。')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: '搜索' }), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: '启用状态' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '已启用' }))
  expect(screen.getByText('没有匹配的技能。')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(categories().getByRole('button', { name: '企业协作' }))
  expect(screen.getByText('local-docs')).toBeTruthy()
  expect(screen.queryByText('local-loose')).toBeNull()
  fireEvent.click(categories().getByRole('button', { name: '其他' }))
  expect(screen.getByText('local-loose')).toBeTruthy()
  expect(screen.queryByText('local-docs')).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: '市场' }))
  expect(categories().getByRole('button', { name: '数据与经营分析' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByText('没有匹配的技能。')).toBeTruthy()
  expect(categories().getAllByRole('button').map(button => ({ label: button.textContent, selected: button.getAttribute('aria-pressed') }))).toMatchInlineSnapshot(`
    [
      {
        "label": "全部分类",
        "selected": "false",
      },
      {
        "label": "订单与售后",
        "selected": "false",
      },
      {
        "label": "商品与刊登",
        "selected": "false",
      },
      {
        "label": "采购与供应链",
        "selected": "false",
      },
      {
        "label": "库存与仓储",
        "selected": "false",
      },
      {
        "label": "物流与履约",
        "selected": "false",
      },
      {
        "label": "财务与对账",
        "selected": "false",
      },
      {
        "label": "平台与店铺",
        "selected": "false",
      },
      {
        "label": "运营与增长",
        "selected": "false",
      },
      {
        "label": "数据与经营分析",
        "selected": "true",
      },
      {
        "label": "产品与设计",
        "selected": "false",
      },
      {
        "label": "研发与集成",
        "selected": "false",
      },
      {
        "label": "测试与运维",
        "selected": "false",
      },
      {
        "label": "实施与客户支持",
        "selected": "false",
      },
      {
        "label": "企业协作",
        "selected": "false",
      },
      {
        "label": "其他",
        "selected": "false",
      },
    ]
  `)
})

it.each(['zh', 'en'] as const)('keeps market and personal category filters identical and groups imported labels without losing skills (%s)', async (locale) => {
  const { data, requests } = await setup(false, true, skill('personal'), undefined, locale)
  const group = () => within(screen.getByRole('group', { name: locale === 'zh' ? '技能分类' : 'Skill categories' }))
  const labels = () => group().getAllByRole('button').map(button => button.textContent)
  const select = (name: string) => fireEvent.click(group().getByRole('button', { name }))
  const product = locale === 'zh' ? '产品与设计' : 'Product & Design'
  const other = locale === 'zh' ? '其他' : 'Other'
  for (const source of data.roots) {
    source.categories = [{ id: 'id', name: 'product' }, { id: 'zh', name: '产品与设计' }, { id: 'en', name: 'Product & Design' }, { id: 'custom', name: 'shared' }]
    source.skills = ['id', 'zh', 'en', 'custom'].map(categoryId => ({ ...skill(`${source.key}-${categoryId}`), categoryId }))
    source.skills.push(skill(`${source.key}-loose`), { ...skill(`${source.key}-missing`), categoryId: 'missing' })
  }
  await screen.findByText('company-id')
  const market = labels()
  expect(market).not.toContain('product')
  expect(market).not.toContain('shared')
  expect(market).not.toContain(locale === 'zh' ? '未分类' : 'Uncategorized')
  for (const source of ['company', 'dsh']) {
    if (source === 'dsh') fireEvent.click(screen.getByRole('tab', { name: locale === 'zh' ? '我的' : 'Mine' }))
    expect(labels()).toEqual(market)
    select(product)
    for (const id of ['id', 'zh', 'en']) expect(await screen.findByText(`${source}-${id}`)).toBeTruthy()
    expect(screen.queryByText(`${source}-custom`)).toBeNull()
    expect(screen.queryByText(`${source}-loose`)).toBeNull()
    expect(screen.queryByText(`${source}-missing`)).toBeNull()
    select(other)
    for (const id of ['custom', 'loose', 'missing']) expect(await screen.findByText(`${source}-${id}`)).toBeTruthy()
    expect(screen.queryByText(`${source}-id`)).toBeNull()
  }
  expect(document.querySelector('.dssm-cat')).toBeNull()
  for (const label of ['shared', '未分类', 'product']) expect(screen.queryByText(label, { exact: true })).toBeNull()
  expect(screen.queryByRole('button', { name: locale === 'zh' ? '新建分类' : 'New category' })).toBeNull()
  fireEvent.click(screen.getAllByRole('button', { name: locale === 'zh' ? '更多' : 'More' })[0])
  const dictionary = locale === 'zh' ? zh : en
  const assignment = dictionary['category.assign']
  const menu = screen.getAllByRole('menuitem').map(item => item.textContent)
  const expected = market.slice(1).map(label => assignment.replace('{name}', label))
  expect(menu).toEqual([dictionary['btn.detail'], ...expected, dictionary['btn.trash']])
  expect({ categories: market, assignments: expected, nestedCategories: document.querySelectorAll('.dssm-cat').length }).toMatchSnapshot()
  expect(requests('assignCategory')).toHaveLength(0)
})

it('shows the source empty state after expanding a local source with no skills', async () => {
  const { data } = await setup(false, false)
  data.roots[0].skills = []
  await screen.findByText(zh['empty.company'])
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: /DSH/, expanded: false }))
  expect(screen.getByText(zh['empty.source'])).toBeTruthy()
})

it('starts an AI skill conversation from both catalogs without a manual form or direct write', async () => {
  const { startSession, mock } = await setup(true)
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('button', { name: '创建技能' }))
  expect(startSession).toHaveBeenCalledWith(undefined, { prompt: zh['creation.prompt'], whenDraftExists: 'append' })
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '创建技能' }))
  expect(startSession).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(mock.remote.skillsManager.createSkill).not.toHaveBeenCalled()
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
    install.focus()
    fireEvent.click(install)
    await waitFor(() => { expect(readFile).toHaveBeenCalledTimes(1) })
    expect(install).toHaveProperty('disabled', false)
    expect(install.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(install)
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
    expect(install).toHaveProperty('disabled', false)
    expect(install.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(install)
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

it.each(['error.upload.zipInvalid', 'error.upload.pathConflict'] as const)(
  'keeps rejected uploads selected and explains how to repair %s', async (code) => {
    const { data, mock } = await setup(true)
    data.writeDestinations.push({ key: 'dsh', path: '/skills/dsh', label: 'DSH skills', available: true })
    mock.unary('skillsManager/uploadSkill', () => ({ ok: false, error: new RemoteError('skills/operation', 'Upload rejected', {
      code, error: 'Upload rejected', params: { path: 'assets' },
    }) }))
    await screen.findByText('共享技能')
    fireEvent.click(screen.getByRole('tab', { name: '我的' }))
    fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
    const dialog = screen.getByRole('dialog', { name: '导入技能' }), form = within(dialog)
    const input = dialog.querySelector('input[type="file"][accept]')
    if (!input) throw new Error('Missing import file input')
    fireEvent.change(input, { target: { files: [uploadFile('repaired-skill.zip', 'Selected archive.')] } })
    const install = form.getByRole<HTMLButtonElement>('button', { name: '安装' })
    fireEvent.click(install)
    const failure = await screen.findByRole('alert')
    expect({ message: failure.textContent, selected: form.getByText('repaired-skill.zip').textContent,
      canRetry: !install.disabled }).toMatchSnapshot()
    expect(mock.remote.skillsManager.uploadSkill).toHaveBeenCalledTimes(1)
    mock.unary('skillsManager/uploadSkill', () => ok({ imported: [{ name: 'repaired-skill', overwritten: false, warnings: [] }], skipped: [], failed: [] }))
    fireEvent.click(install)
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '导入技能' })).toBeNull() })
    expect(screen.getByText('导入完成：repaired-skill')).toBeTruthy()
    expect(mock.remote.skillsManager.uploadSkill).toHaveBeenCalledTimes(2)
  },
)

it.each([
  ['file', 'success'], ['file', 'failure'], ['directory', 'success'], ['directory', 'failure'],
] as const)('keeps a reopened import selection after an older %s drop completes with %s', async (kind, outcome) => {
  const { data, mock } = await setup(true)
  data.writeDestinations.push({ key: 'dsh', path: '/skills/dsh', label: 'DSH skills', available: true })
  mock.unary('skillsManager/uploadSkill', () => ok({ imported: [{ name: 'current-skill', overwritten: false, warnings: [] }], skipped: [], failed: [] }))
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  const older = controlledDrop(kind, uploadFile(kind === 'file' ? 'older-skill.zip' : 'SKILL.md', 'older upload'))
  const firstDialog = screen.getByRole('dialog', { name: '导入技能' })
  const firstDropZone = within(firstDialog).getByText('拖拽技能到此处').parentElement
  if (!firstDropZone) throw new Error('Missing import drop zone')
  fireEvent.drop(firstDropZone, { dataTransfer: older.dataTransfer })
  const finishOlder = await older.pending
  fireEvent.click(within(firstDialog).getByRole('button', { name: '取消' }))
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  const dialog = screen.getByRole('dialog', { name: '导入技能' })
  const form = within(dialog)
  const input = dialog.querySelector('input[type="file"][accept]')
  if (!input) throw new Error('Missing import file input')
  fireEvent.change(input, { target: { files: [uploadFile('current-skill.zip', 'current upload')] } })
  await act(async () => {
    if (outcome === 'success') finishOlder.succeed()
    else finishOlder.fail(new DOMException('Older drop unavailable'))
  })
  expect(form.getByText('current-skill.zip')).toBeTruthy()
  expect(form.queryByRole('alert')).toBeNull()
  if (kind === 'directory') expect(older.readEntries).toHaveBeenCalledTimes(1)
  fireEvent.click(form.getByRole('button', { name: '安装' }))
  await waitFor(() => { expect(mock.remote.skillsManager.uploadSkill).toHaveBeenCalledExactlyOnceWith({
    request: { name: 'current-skill.zip', zip: Buffer.from('current upload').toString('base64'), root: 'dsh' },
  }) })
})

it.each(['success', 'failure'] as const)('keeps the latest drop when an older drop finishes later with %s', async (outcome) => {
  const { data, mock } = await setup(true)
  data.writeDestinations.push({ key: 'dsh', path: '/skills/dsh', label: 'DSH skills', available: true })
  mock.unary('skillsManager/uploadSkill', () => ok({ imported: [{ name: 'current-skill', overwritten: false, warnings: [] }], skipped: [], failed: [] }))
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  const dialog = screen.getByRole('dialog', { name: '导入技能' })
  const form = within(dialog)
  const dropZone = form.getByText('拖拽技能到此处').parentElement
  if (!dropZone) throw new Error('Missing import drop zone')
  const older = controlledDrop('file', uploadFile('older-skill.zip', 'older upload'))
  const current = controlledDrop('directory', uploadFile('SKILL.md', 'current upload'), 'current-skill')
  fireEvent.drop(dropZone, { dataTransfer: older.dataTransfer })
  const finishOlder = await older.pending
  fireEvent.drop(dropZone, { dataTransfer: current.dataTransfer })
  const finishCurrent = await current.pending
  await act(async () => { finishCurrent.succeed() })
  expect(form.getByText('current-skill')).toBeTruthy()
  await act(async () => {
    if (outcome === 'success') finishOlder.succeed()
    else finishOlder.fail(new DOMException('Older drop unavailable'))
  })
  expect(form.getByText('current-skill')).toBeTruthy()
  expect(form.queryByRole('alert')).toBeNull()
  fireEvent.click(form.getByRole('button', { name: '安装' }))
  await waitFor(() => { expect(mock.remote.skillsManager.uploadSkill).toHaveBeenCalledExactlyOnceWith({
    request: { name: 'current-skill', entries: [{ path: 'current-skill/SKILL.md', data: Buffer.from('current upload').toString('base64') }], root: 'dsh' },
  }) })
})

it('does not restore a removed import selection when a pending drop finishes', async () => {
  const { data, mock } = await setup(true)
  data.writeDestinations.push({ key: 'dsh', path: '/skills/dsh', label: 'DSH skills', available: true })
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  const dialog = screen.getByRole('dialog', { name: '导入技能' })
  const form = within(dialog)
  const input = dialog.querySelector('input[type="file"][accept]')
  const dropZone = form.getByText('拖拽技能到此处').parentElement
  if (!input || !dropZone) throw new Error('Missing import controls')
  fireEvent.change(input, { target: { files: [uploadFile('current-skill.zip', 'current upload')] } })
  const pending = controlledDrop('file', uploadFile('older-skill.zip', 'older upload'))
  fireEvent.drop(dropZone, { dataTransfer: pending.dataTransfer })
  const finishDrop = await pending.pending
  fireEvent.click(form.getByRole('button', { name: '移除所选内容' }))
  await act(async () => { finishDrop.succeed() })
  expect(form.queryByText('older-skill.zip')).toBeNull()
  expect(form.queryByText('current-skill.zip')).toBeNull()
  expect(form.getByRole('button', { name: '安装' })).toHaveProperty('disabled', true)
  expect(mock.remote.skillsManager.uploadSkill).not.toHaveBeenCalled()
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

it('does not read remaining files or upload prepared content after the skills page is removed', async () => {
  const { data, mock, view } = await setup(true)
  data.writeDestinations.push({ key: 'dsh', path: '/skills/dsh', label: 'DSH skills', available: true })
  const reading = deferred<ArrayBuffer>()
  const bytes = new TextEncoder().encode('---\nname: acceptance-skill\ndescription: Acceptance fixture\n---\nUse temporary data.')
  const readFile = vi.fn(() => reading.promise)
  const file = Object.assign(new File([bytes], 'SKILL.md'), { arrayBuffer: readFile, _dssmPath: 'acceptance-skill/SKILL.md' })
  const reference = Object.assign(uploadFile('中文资料.md', '资料正文'), { _dssmPath: 'acceptance-skill/references/中文资料.md' })
  mock.unary('skillsManager/uploadSkill', () => ok({ imported: [], skipped: [], failed: [] }))
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  const dialog = screen.getByRole('dialog', { name: '导入技能' })
  const input = dialog.querySelector('input[type="file"][accept]')
  if (!input) throw new Error('Missing import file input')
  fireEvent.change(input, { target: { files: [file, reference] } })
  try {
    fireEvent.click(within(dialog).getByRole('button', { name: '安装' }))
    await waitFor(() => { expect(readFile).toHaveBeenCalledTimes(1) })
    view.unmount()
    const reads = mock.remote.skillsManager.readState.mock.calls.length
    await act(async () => { reading.resolve(bytes.buffer); await reading.promise })
    expect(reference.arrayBuffer).not.toHaveBeenCalled()
    expect(mock.remote.skillsManager.uploadSkill).not.toHaveBeenCalled()
    expect(mock.remote.skillsManager.readState).toHaveBeenCalledTimes(reads)
  } finally {
    await act(async () => { reading.resolve(bytes.buffer); await reading.promise })
  }
})

it.each([
  { locale: 'zh', partial: true }, { locale: 'en', partial: true },
  { locale: 'zh', partial: false }, { locale: 'en', partial: false },
] as const)('reports import failures and retains the selection for repair ($locale, partial=$partial)', async ({ locale, partial }) => {
  const { data, mock } = await setup(true, true, undefined, undefined, locale)
  data.writeDestinations.push({ key: 'dsh', path: '/skills/dsh', label: 'DSH skills', available: true })
  mock.unary('skillsManager/uploadSkill', () => ok({
    imported: partial ? [{ name: 'ready-skill', overwritten: false, warnings: [] }] : [],
    skipped: partial ? [{ name: 'existing-skill', source: '/temporary/import/existing-skill' }] : [],
    failed: [{ source: '/temporary/import/broken-skill', error: 'Duplicate name', code: 'error.import.duplicateName', params: { name: 'broken-skill' } }],
  }))
  const dictionary = locale === 'zh' ? zh : en
  await screen.findByText('共享技能')
  fireEvent.click(screen.getByRole('tab', { name: dictionary['scope.mine'] }))
  fireEvent.click(screen.getByRole('button', { name: dictionary['import.title'] }))
  const dialog = screen.getByRole('dialog', { name: dictionary['import.title'] })
  const input = dialog.querySelector('input[type="file"][accept]')
  if (!input) throw new Error('Missing import file input')
  fireEvent.change(input, { target: { files: [uploadFile('skills.zip', 'Selected archive')] } })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: dictionary['btn.import.now'] })) })
  expect(screen.getByRole('dialog', { name: dictionary['import.title'] })).toBe(dialog)
  const feedback = within(dialog).getByRole('alert')
  if (partial) {
    expect(feedback.textContent).toContain('ready-skill')
    expect(feedback.textContent).toContain('existing-skill')
  } else expect(feedback.textContent).toContain(dictionary['result.importEmpty'])
  expect(feedback.textContent).toContain('broken-skill')
  expect(feedback.textContent).toContain(locale === 'zh' ? '请修复失败项后重试' : 'Fix the failed items and retry')
  expect(feedback.textContent).not.toContain('/temporary/import')
  expect(within(dialog).getByText('skills.zip')).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: dictionary['btn.import.now'] })).toHaveProperty('disabled', false)
  expect(feedback.textContent).toMatchSnapshot()
  mock.unary('skillsManager/uploadSkill', () => ok({
    imported: [{ name: 'broken-skill', overwritten: false, warnings: [] }], skipped: [], failed: [],
  }))
  fireEvent.click(within(dialog).getByRole('button', { name: dictionary['btn.import.now'] }))
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: dictionary['import.title'] })).toBeNull() })
  expect(mock.remote.skillsManager.uploadSkill).toHaveBeenCalledTimes(2)
})

it('shows published company skills in Market and preserves local, project, repository and trash views in Mine', async () => {
  await setup(true)
  await screen.findByText('共享技能')
  expect(screen.queryByText('个人技能')).toBeNull()
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['市场', '我的'])
  expect(screen.getByRole('button', { name: '创建技能' })).toBeTruthy()
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

it.each(['market', 'source', 'skill'] as const)('writes the %s switch once, refreshes its state and preserves expanded content', async (target) => {
  const { data, mock, requests, view, startSession } = await setup(true)
  const source = data.roots.find(item => item.key === 'dsh')!
  source.categories.push({ id: 'finance1', name: 'Finance' })
  source.skills[0].categoryId = 'finance1'
  const pending = deferred<undefined>()
  const method = target === 'skill' ? 'setSkillEnabled' : 'setSourceEnabled'
  const label = target === 'market' ? '使用市场技能' : target === 'source' ? '启停来源 DSH' : '启停技能 个人技能'
  const scope = target === 'market' ? { root: 'company' } : target === 'skill' ? { root: 'dsh', name: '个人技能' } : { root: 'dsh' }
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
  }
  try {
    const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: label })
    const row = screen.getByText(target === 'market' ? '共享技能' : '个人技能')
    const create = screen.getByRole('button', { name: zh['btn.create'] })
    const refresh = screen.getByRole('button', { name: zh['btn.refresh'] })
    const changes: MutationRecord[] = []
    const observer = new MutationObserver(records => changes.push(...records))
    observer.observe(create, { attributes: true, childList: true, subtree: true })
    observer.observe(refresh, { attributes: true, childList: true, subtree: true })
    onTestFinished(() => { observer.disconnect() })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.disabled).toBe(false)
    expect(toggle.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('true')
    expect(create).toHaveProperty('disabled', false)
    expect(refresh).toHaveProperty('disabled', false)
    fireEvent.click(create)
    expect(startSession).toHaveBeenCalledOnce()
    expect(screen.getByText(target === 'market' ? '共享技能' : '个人技能')).toBe(row)
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(requests(method)).toEqual([
        ['/api', `skillsManager/${method}`, { args: { target: scope, enabled: false } }, expect.any(AbortSignal)],
      ])
    })
    await act(async () => { pending.resolve(undefined); await pending.promise })
    await waitFor(() => { expect(toggle.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('false') })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: label })).toBe(toggle)
    expect(screen.getByText(target === 'market' ? '共享技能' : '个人技能')).toBe(row)
    expect(view.container.querySelector('.dssm-feedback')).toBeNull()
    expect(screen.getByRole('button', { name: zh['btn.create'] })).toBe(create)
    expect(screen.getByRole('button', { name: zh['btn.refresh'] })).toBe(refresh)
    expect([...changes, ...observer.takeRecords()]).toEqual([])
    if (target !== 'market') {
      expect(screen.getByRole('button', { name: /DSH/, expanded: true })).toBeTruthy()
    }
  } finally {
    pending.resolve(undefined)
    await pending.promise
  }
})

it.each((['market', 'mine', 'project'] as const).flatMap(scope => [false, true].map(elsewhere => ({ scope, elsewhere }))))(
  'recovers the removed $scope skill toggle focus without taking focus elsewhere ($elsewhere)', async ({ scope, elsewhere }) => {
    const { data, mock, view } = await setup(true)
    const pending = deferred<undefined>()
    const current = data.roots.find(root => root.key === (scope === 'market' ? 'company' : 'dsh'))!.skills[0]
    mock.unary('skillsManager/listWorkspaces', () => ok({ items: [{ name: '项目', available: true, registeredPaths: ['/workspace'] }] }))
    mock.unary('skillsManager/readWorkspace', () => ok({ ...data, roots: [data.roots[1]] }))
    mock.unary('skillsManager/setSkillEnabled', async () => {
      await pending.promise
      current.managerEnabled = false
      return ok({})
    })
    onTestFinished(() => { view.unmount(); pending.resolve(undefined) })
    await screen.findByText('共享技能')
    if (scope !== 'market') fireEvent.click(screen.getByRole('tab', { name: '我的' }))
    if (scope === 'project') {
      fireEvent.click(screen.getByRole('tab', { name: '项目技能' }))
      await screen.findByText(current.name)
    }
    fireEvent.click(screen.getByRole('button', { name: zh['filter.status'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh['status.enabled'] }))
    const search = screen.getByRole<HTMLInputElement>('textbox', { name: zh.search })
    fireEvent.change(search, { target: { value: '技能' } })
    const toggle = screen.getByRole('switch', { name: `${zh['skill.toggle']} ${current.name}` })
    toggle.focus(); fireEvent.click(toggle)
    expect(toggle).toHaveProperty('disabled', false)
    expect(toggle.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('true')
    if (elsewhere) { search.focus(); search.setSelectionRange(0, 1) }
    await act(async () => { pending.resolve(undefined); await pending.promise })
    await waitFor(() => { expect(toggle.isConnected).toBe(false) })
    expect(document.activeElement).toBe(search)
    expect(search.value).toBe('技能')
    if (elsewhere) expect([search.selectionStart, search.selectionEnd]).toEqual([0, 1])
    expect(mock.remote.skillsManager.setSkillEnabled).toHaveBeenCalledOnce()
    expect(screen.getByText(zh['empty.search'])).toBeTruthy()
    expect({ scope, elsewhere, focused: document.activeElement?.getAttribute('aria-label'), query: search.value,
      selection: [search.selectionStart, search.selectionEnd] }).toMatchSnapshot()
  },
)

it('keeps skill details available during a toggle without letting the read release its write lock', async () => {
  const { mock, signalFor } = await setup(true)
  await screen.findByText('共享技能')
  const write = deferred<undefined>()
  const read = deferred<SkillOutput<'readDetail'>>()
  mock.unary('skillsManager/setSkillEnabled', async () => { await write.promise; return ok({}) })
  mock.unary('skillsManager/readDetail', async () => ok(await read.promise))
  const toggle = screen.getByRole('switch', { name: '启停技能 共享技能' })
  try {
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: zh['btn.more'] }))
    expect(screen.getByRole('menuitem', { name: zh['btn.detail'] }).getAttribute('aria-disabled')).not.toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: zh['btn.detail'] }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: zh['btn.close'] }))
    expect(signalFor('readDetail').aborted).toBe(true)
    expect(toggle).toHaveProperty('disabled', false)
    expect(toggle.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('true')
    await act(async () => { write.resolve(undefined); await write.promise })
    await waitFor(() => { expect(toggle.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('false') })
  } finally {
    await act(async () => {
      write.resolve(undefined); read.reject(new Error('Test released'))
      await Promise.allSettled([write.promise, read.promise])
    })
  }
})

it('refreshes the catalog during a pending toggle without releasing its write lock', async () => {
  const { data, mock } = await setup(false)
  await screen.findByText(zh['empty.company'])
  await waitFor(() => { expect(mock.remote.skillsManager.readState).toHaveBeenCalledTimes(2) })
  const write = deferred<undefined>()
  mock.unary('skillsManager/setSourceEnabled', async () => {
    await write.promise
    data.roots[0].enabled = false
    return ok({})
  })
  const toggle = screen.getByRole('switch', { name: zh['market.source'] })
  const refresh = screen.getByRole('button', { name: zh['btn.refresh'] })
  try {
    fireEvent.click(toggle)
    fireEvent.click(refresh)
    await waitFor(() => { expect(mock.remote.skillsManager.readState).toHaveBeenCalledTimes(3) })
    await waitFor(() => { expect(refresh).toHaveProperty('disabled', false) })
    expect(toggle).toHaveProperty('disabled', false)
    expect(toggle.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: zh['btn.create'] })).toHaveProperty('disabled', false)
    await act(async () => { write.resolve(undefined); await write.promise })
    await waitFor(() => { expect(toggle.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('false') })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(mock.remote.skillsManager.setSourceEnabled).toHaveBeenCalledOnce()
  } finally {
    await act(async () => { write.resolve(undefined); await write.promise })
  }
})

it('keeps the filtered empty market mounted through consecutive toggle writes and directory reads', async () => {
  const { data, mock, view } = await setup(false)
  await screen.findByText(zh['empty.company'])
  await waitFor(() => { expect(mock.remote.skillsManager.readState).toHaveBeenCalledTimes(2) })
  await waitFor(() => { expect(screen.getByRole('button', { name: zh['btn.refresh'] })).toHaveProperty('disabled', false) })
  const category = within(screen.getByRole('group', { name: zh['category.filter'] })).getByRole('button', { name: '库存与仓储' })
  fireEvent.click(category)
  const empty = screen.getByText(zh['empty.search'])
  const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: zh['market.source'] })
  for (const enabled of [false, true]) {
    const write = deferred<undefined>()
    const read = deferred<undefined>()
    mock.unary('skillsManager/setSourceEnabled', async () => {
      await write.promise
      data.roots[0].enabled = enabled
      return ok({})
    })
    mock.unary('skillsManager/readState', async () => { await read.promise; return ok(data) })
    try {
      fireEvent.click(toggle)
      expect(toggle.disabled).toBe(false)
      expect(toggle.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('true')
      expect(screen.getByText(zh['empty.search'])).toBe(empty)
      expect(view.container.querySelector('.dssm-feedback')).toBeNull()
      await act(async () => { write.resolve(undefined); await write.promise })
      expect(toggle.disabled).toBe(false)
      expect(toggle.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('true')
      expect(screen.getByText(zh['empty.search'])).toBe(empty)
      expect(view.container.querySelector('.dssm-feedback')).toBeNull()
      await act(async () => { read.resolve(undefined); await read.promise })
      await waitFor(() => { expect(toggle.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('false') })
      expect(toggle.getAttribute('aria-checked')).toBe(String(enabled))
      expect(screen.getByRole('switch', { name: zh['market.source'] })).toBe(toggle)
      expect(screen.getByText(zh['empty.search'])).toBe(empty)
      expect(category.getAttribute('aria-pressed')).toBe('true')
      expect(view.container.querySelector('.dssm-feedback')).toBeNull()
      expect(screen.queryByRole('status')).toBeNull()
    } finally {
      await act(async () => { write.resolve(undefined); read.resolve(undefined); await Promise.all([write.promise, read.promise]) })
    }
  }
  expect(mock.remote.skillsManager.setSourceEnabled).toHaveBeenCalledTimes(2)
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
    expect(toggle.disabled).toBe(false)
    expect(toggle.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('true')
    await act(async () => { pending.resolve(undefined); await pending.promise })
    const message = await screen.findByText(/操作失败：/)
    await waitFor(() => { expect(toggle.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('false') })
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

it('retains a switch failure while retrying once and clears it after the catalog confirms success', async () => {
  const { data, mock } = await setup(true)
  const write = deferred<undefined>()
  const read = deferred<undefined>()
  onTestFinished(() => { write.resolve(undefined); read.resolve(undefined) })
  let attempts = 0
  mock.unary('skillsManager/setSkillEnabled', async () => {
    if (++attempts === 1) return { ok: false, error: new RemoteError('skills/operation', 'Permission changed', {
      code: 'error.proto.forbidden', error: 'forbidden',
    }) }
    await write.promise
    return ok({})
  })
  await screen.findByText('共享技能')
  const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: '启停技能 共享技能' })
  fireEvent.click(toggle)
  const error = await screen.findByText(/操作失败：/)
  await waitFor(() => { expect(toggle.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('false') })
  mock.unary('skillsManager/readState', async () => { await read.promise; return ok(data) })
  act(() => { toggle.click(); toggle.click() })
  expect(screen.getByText(/操作失败：/)).toBe(error)
  expect(toggle.disabled).toBe(false)
  expect(toggle.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('true')
  const region = toggle.closest('[aria-busy]')!
  expect(region.getAttribute('aria-busy')).toBe('true')
  expect(mock.remote.skillsManager.setSkillEnabled).toHaveBeenCalledTimes(2)
  expect({ error: error.textContent, disabled: toggle.disabled, busy: region.getAttribute('aria-busy') }).toMatchSnapshot()
  await act(async () => { write.resolve(undefined) })
  expect(toggle.disabled).toBe(false)
  expect(toggle.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('true')
  await act(async () => { read.resolve(undefined) })
  await waitFor(() => { expect(toggle.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('false') })
  expect(screen.queryByText(/操作失败：/)).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})

it('reports a rejected category assignment without discarding skill rows', async () => {
  const { data, mock, requests } = await setup(false, false)
  const source = data.roots[0]
  source.categories.push({ id: 'imported', name: 'shared' })
  source.skills[0].categoryId = 'imported'
  source.skills.push(skill('other-skill'))
  mock.unary('skillsManager/assignCategory', () => ({ ok: false,
    error: new RemoteError('skills/operation', 'Permission changed', { code: 'error.proto.forbidden', error: 'forbidden' }) }))
  await screen.findByText('市场暂无技能，审核发布后会展示在这里。')
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: /DSH/, expanded: false }))
  fireEvent.click(screen.getAllByRole('button', { name: '更多' })[0])
  fireEvent.click(screen.getByRole('menuitem', { name: '归入财务与对账' }))
  await screen.findByText('操作失败：仅本机所有者可管理技能')
  await waitFor(() => { expect(screen.getByRole('button', { name: '刷新' })).toHaveProperty('disabled', false) })
  expect(requests('assignCategory')).toHaveLength(1)
  expect(requests('assignCategory')[0][2]).toEqual({ args: { target: { root: 'dsh', name: '个人技能', categoryId: 'finance' } } })
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
  const workspaceGlyph = workspace.querySelector('svg')
  fireEvent.click(workspace)
  expect(screen.getByRole('menu')).toBeTruthy()
  refreshing = true
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(screen.queryByRole('menu')).toBeNull()
  expect(workspace).toHaveProperty('disabled', false)
  expect(workspace.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(workspace)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(workspace.classList.contains('product-control-pending')).toBe(true)
  expect(workspace.getAttribute('aria-busy')).toBe('true')
  expect(workspace.querySelector('svg')).toBe(workspaceGlyph)
  expect(workspace.getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByRole('tabpanel', { name: /项目技能/ })).toBe(panel)
  expect(panel.textContent).toBe(content)
  expect(panel.getAttribute('aria-busy')).toBe('true')
  expect(screen.queryByText('正在读取工作区技能…')).toBeNull()
  await act(async () => { finish(); await gate })
  await waitFor(() => { expect(panel.getAttribute('aria-busy')).toBe('false') })
  expect(panel.textContent).toBe(content)
  expect(workspace).toHaveProperty('disabled', false)
  expect(workspace.classList.contains('product-control-pending')).toBe(false)
  expect(workspace.getAttribute('aria-busy')).toBe('false')
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

const detailSources = ['company', 'user', 'project'] as const
async function failedSkillDetail(source: typeof detailSources[number], locale: 'zh' | 'en' = 'zh') {
  const harness = await setup(true, true, skill('个人技能'), undefined, locale)
  const dictionary = locale === 'zh' ? zh : en
  await screen.findByText('共享技能')
  if (source !== 'company') {
    fireEvent.click(screen.getByRole('tab', { name: dictionary['scope.mine'] }))
    if (source === 'project') {
      harness.mock.unary('skillsManager/listWorkspaces', () => ok({ items: [{ name: '验收项目', path: '/workspace',
        registeredPaths: ['/workspace'], available: true, skillCount: 1 }] }))
      harness.mock.unary('skillsManager/readWorkspace', () => ok({ ...harness.data, roots: [root('dsh', [skill('项目验收技能')])] }))
      fireEvent.click(screen.getByRole('tab', { name: dictionary['scope.project'] }))
      await screen.findByText('项目验收技能')
    } else fireEvent.click(screen.getByRole('button', { name: /DSH/, expanded: false }))
  }
  harness.mock.unary('skillsManager/readDetail', () => { throw new Error('Detail unavailable') })
  const trigger = screen.getByRole('button', { name: dictionary['btn.more'] })
  trigger.focus()
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: dictionary['btn.detail'] }))
  const notice = await screen.findByRole('alert')
  return { ...harness, dictionary, trigger, notice }
}

it.each(detailSources.flatMap(source => (['zh', 'en'] as const).map(locale => ({ source, locale }))))(
  'retains the $source skill detail and its error through one read retry ($locale)', async ({ source, locale }) => {
    const { mock, view, dictionary, trigger, notice, requests } = await failedSkillDetail(source, locale)
    const dialog = screen.getByRole('dialog')
    expect(notice.closest('[role="dialog"]')).toBe(dialog)
    expect(notice.textContent).toBe(dictionary['error.action'].replace('{error}', dictionary['error.remoteUnavailable']))
    const pending = deferred<SkillOutput<'readDetail'>>()
    const detail: SkillOutput<'readDetail'> = { name: 'orders', declaredName: 'orders', description: '',
      path: '/skills/orders/SKILL.md', diagnostics: [], body: '# Recovered instructions' }
    onTestFinished(async () => { view.unmount(); pending.resolve(detail); await pending.promise.catch(() => undefined) })
    mock.unary('skillsManager/readDetail', async () => ok(await pending.promise))
    const retry = within(dialog).getByRole<HTMLButtonElement>('button', { name: dictionary['btn.retry'] })
    retry.focus()
    act(() => { retry.click(); retry.click() })
    expect(mock.remote.skillsManager.readDetail).toHaveBeenCalledTimes(2)
    expect(requests('readDetail')[1]?.[2]).toEqual(requests('readDetail')[0]?.[2])
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(screen.getAllByRole('alert')).toEqual([notice])
    expect(within(dialog).getByRole('button', { name: dictionary['btn.retry'] })).toBe(retry)
    expect(retry.disabled).toBe(false)
    expect(retry.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(retry)
    expect(retry.getAttribute('aria-busy')).toBe('true')
    expect(retry.classList.contains('product-control-pending')).toBe(true)
    expect(within(dialog).queryByRole('status')).toBeNull()
    expect({ error: notice.textContent, retry: retry.textContent, busy: retry.getAttribute('aria-busy') }).toMatchSnapshot()
    await act(async () => { pending.resolve(detail); await pending.promise })
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: dictionary['btn.retry'] })).toBeNull()
    expect(within(dialog).getByRole('textbox', { name: dictionary['detail.body'] })).toHaveProperty('value', detail.body)
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: dictionary['detail.body'] }))
    fireEvent.click(within(dialog).getByRole('button', { name: dictionary['btn.close'] }))
    expect(document.activeElement).toBe(trigger)
    expect(screen.queryByRole('alert')).toBeNull()
  },
)

it.each(detailSources)('retains focus moved away from the %s skill detail retry', async (source) => {
  const { mock, view, dictionary } = await failedSkillDetail(source)
  const pending = deferred<SkillOutput<'readDetail'>>()
  const detail: SkillOutput<'readDetail'> = { name: 'orders', declaredName: 'orders', description: '',
    path: '/skills/orders/SKILL.md', diagnostics: [], body: 'Recovered instructions' }
  onTestFinished(() => { view.unmount(); pending.resolve(detail) })
  mock.unary('skillsManager/readDetail', async () => ok(await pending.promise))
  const dialog = screen.getByRole('dialog')
  const retry = within(dialog).getByRole('button', { name: dictionary['btn.retry'] })
  retry.focus()
  fireEvent.click(retry)
  const close = within(dialog).getByRole('button', { name: dictionary['btn.close'] })
  close.focus()
  const focus = vi.spyOn(close, 'focus')
  await act(async () => { pending.resolve(detail); await pending.promise })
  expect(document.activeElement).toBe(close)
  expect(focus).not.toHaveBeenCalled()
  expect(within(dialog).queryByRole('button', { name: dictionary['btn.retry'] })).toBeNull()
})

it.each(['success', 'failure'] as const)('cancels a dismissed skill detail retry before its late %s', async (outcome) => {
  const { mock, view, requests } = await failedSkillDetail('company')
  const dialog = screen.getByRole('dialog')
  const pending = deferred<SkillOutput<'readDetail'>>()
  const detail: SkillOutput<'readDetail'> = { name: 'orders', declaredName: 'orders', description: '',
    path: '/skills/orders/SKILL.md', diagnostics: [], body: 'Dismissed instructions' }
  onTestFinished(async () => { view.unmount(); pending.resolve(detail); await pending.promise.catch(() => undefined) })
  mock.unary('skillsManager/readDetail', async () => ok(await pending.promise))
  fireEvent.click(within(dialog).getByRole('button', { name: zh['btn.retry'] }))
  const signal = requests('readDetail')[1]?.[3]
  expect(signal?.aborted).toBe(false)
  fireEvent.click(within(dialog).getByRole('button', { name: zh['btn.close'] }))
  expect(signal?.aborted).toBe(true)
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.mine'] }))
  fireEvent.click(screen.getByRole('button', { name: zh['import.global'] }))
  const next = screen.getByRole('dialog', { name: zh['import.title'] })
  await act(async () => {
    if (outcome === 'failure') pending.reject(new Error('Dismissed detail failed'))
    else pending.resolve(detail)
    await pending.promise.catch(() => undefined)
  })
  expect(screen.getByRole('dialog')).toBe(next)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByText(/Dismissed/)).toBeNull()
  expect(mock.remote.skillsManager.readDetail).toHaveBeenCalledTimes(2)
})

it('keeps the skill-specific diagnostic when a detail retry confirms the file is missing', async () => {
  const { mock, notice } = await failedSkillDetail('company')
  const dialog = screen.getByRole('dialog')
  mock.unary('skillsManager/readDetail', () => ({ ok: false, error: new RemoteError('skills/operation', 'Missing file', {
    code: 'error.skill.notFound', params: { name: '共享技能' },
  }) }))
  fireEvent.click(within(dialog).getByRole('button', { name: zh['btn.retry'] }))
  await waitFor(() => { expect(notice.textContent).toBe('操作失败：技能不存在: 共享技能') })
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(screen.getAllByRole('alert')).toEqual([notice])
  expect({ error: notice.textContent, retry: within(dialog).getByRole('button', { name: zh['btn.retry'] }).textContent }).toMatchSnapshot()
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
    expect((await within(screen.getByRole('dialog')).findByRole('status')).textContent).toBe(locale === 'zh' ? '已复制' : 'Copied')
    expect(screen.getByRole('button', { name: locale === 'zh' ? '复制正文' : 'Copy body' })).toBe(copy)
    expect(writeText).toHaveBeenLastCalledWith(body)
    fireEvent.click(screen.getByRole('button', { name: locale === 'zh' ? '关闭' : 'Close' }))
  }
  expect(writeText).toHaveBeenCalledTimes(2)
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

it('reports a workspace destination failure during import and retries inside the same dialog', async () => {
  const { data, mock } = await setup(true)
  data.writeDestinations.push({ key: 'dsh', path: '/skills/dsh', label: 'DSH skills', available: true })
  await screen.findByText('共享技能')
  mock.unary('skillsManager/listWorkspaces', () => ({ ok: false, error: new RemoteError('skills/operation', 'Workspace registry unavailable', {
    code: 'error.workspace.registryUnavailable', error: 'Workspace registry unavailable',
  }) }))
  fireEvent.click(screen.getByRole('tab', { name: '我的' }))
  fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
  const dialog = screen.getByRole('dialog', { name: '导入技能' })
  const form = within(dialog)
  fireEvent.click(form.getByRole('button', { name: '范围' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '指定工作区' }))
  expect((await form.findByRole('alert')).textContent).toContain('无法读取工作区登记，请重试。')
  expect(form.queryByText('还没有已登记的工作区。请先在侧栏添加，再回到这里选择。')).toBeNull()
  expect(form.getByRole('button', { name: '安装' })).toHaveProperty('disabled', true)
  mock.unary('skillsManager/listWorkspaces', () => ok({ items: [{ name: '恢复的项目', path: '/workspace', registeredPaths: ['/workspace'], available: true, skillCount: 0 }] }))
  fireEvent.click(form.getByRole('button', { name: '重试' }))
  await waitFor(() => { expect(form.getByRole('button', { name: '工作区' })).toHaveProperty('disabled', false) })
  fireEvent.click(form.getByRole('button', { name: '工作区' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '恢复的项目' }))
  expect(form.queryByRole('alert')).toBeNull()
  expect(form.getByRole('button', { name: '工作区' }).textContent).toBe('恢复的项目')
  expect(mock.remote.skillsManager.listWorkspaces).toHaveBeenCalledTimes(2)
  expect(mock.remote.skillsManager.uploadSkill).not.toHaveBeenCalled()
})

it('cancels a dismissed detail without blocking AI creation or surfacing the stale error', async () => {
  const { mock, signalFor, startSession } = await setup(true)
  await screen.findByText('共享技能')
  const pending = deferred<SkillOutput<'readDetail'>>()
  mock.unary('skillsManager/readDetail', async () => ok(await pending.promise))
  try {
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '查看详情' }))
    const signal = signalFor('readDetail')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(signal?.aborted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '创建技能' }))
    await act(async () => { pending.reject(new Error('Old detail failed')); await pending.promise.catch(() => {}) })
    expect(startSession).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText(/Old detail failed/)).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: '导入技能' }))
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

it.each(['listWorkspaces', 'readWorkspace'] as const)('retains confirmed project skills through a failed %s refresh and retry', async (method) => {
  const { data, mock, requests } = await setup(true)
  await screen.findByText('共享技能')
  const listed = { items: [{ name: '项目', available: true, registeredPaths: ['/workspace'] }] }
  const project = { ...data, roots: [root('dsh', [skill('项目审核技能')])] }
  mock.unary('skillsManager/listWorkspaces', () => ok(listed))
  mock.unary('skillsManager/readWorkspace', () => ok(project))
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.mine'] }))
  fireEvent.click(screen.getByRole('tab', { name: zh['scope.project'] }))
  const name = await screen.findByText('项目审核技能')
  const row = name.closest('.dssm-skill-row')
  const toggle = screen.getByRole('switch', { name: '启停技能 项目审核技能' })
  const search = screen.getByRole<HTMLInputElement>('textbox', { name: zh.search })
  fireEvent.change(search, { target: { value: '项目' } })
  search.setSelectionRange(0, 1)
  mock.unary(`skillsManager/${method}`, () => ({ ok: false, error: new RemoteError('skills/operation', 'Workspace unavailable', {
    code: 'error.workspace.registryUnavailable',
  }) }))
  const refresh = screen.getByRole('button', { name: zh['btn.refresh'] })
  refresh.focus(); fireEvent.click(refresh)
  const notice = await screen.findByRole('alert')
  expect(screen.getByText('项目审核技能').closest('.dssm-skill-row')).toBe(row)
  expect(screen.getByRole('switch', { name: '启停技能 项目审核技能' })).toBe(toggle)
  expect(screen.getByRole('textbox', { name: zh.search })).toBe(search)
  expect([search.selectionStart, search.selectionEnd]).toEqual([0, 1])
  expect(document.activeElement).toBe(refresh)
  const retry = deferred<SkillOutput<typeof method>>()
  mock.unary(`skillsManager/${method}`, async () => ok(await retry.promise))
  const reads = requests(method).length
  fireEvent.click(refresh); fireEvent.click(refresh)
  await waitFor(() => { expect(requests(method)).toHaveLength(reads + 1) })
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.getByText('项目审核技能').closest('.dssm-skill-row')).toBe(row)
  expect(document.activeElement).toBe(refresh)
  await act(async () => { retry.resolve(method === 'listWorkspaces' ? listed : project); await retry.promise })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(screen.getByText('项目审核技能').closest('.dssm-skill-row')).toBe(row)
  expect(screen.getByRole('switch', { name: '启停技能 项目审核技能' })).toBe(toggle)
  expect([search.selectionStart, search.selectionEnd]).toEqual([0, 1])
  expect(document.activeElement).toBe(refresh)
})

it.each(['market', 'source', 'skill'] as const)('keeps %s toggle progress local and preserves focus during failure and retry', async (target) => {
  const { data, mock, view } = await setup(true)
  const source = data.roots.find(item => item.key === (target === 'market' ? 'company' : 'dsh'))!
  source.skills.push(skill('第二技能'))
  await screen.findByText('共享技能')
  await waitFor(() => { expect(mock.remote.skillsManager.readState).toHaveBeenCalledTimes(2) })
  if (target !== 'market') {
    fireEvent.click(screen.getByRole('tab', { name: '我的' }))
    fireEvent.click(screen.getByRole('button', { name: /DSH/, expanded: false }))
  } else fireEvent.click(screen.getByRole('button', { name: zh['btn.refresh'] }))
  await screen.findByText('第二技能')
  const response = deferred<undefined>(), retry = deferred<undefined>(), refreshed = deferred<undefined>()
  onTestFinished(() => { response.resolve(undefined); retry.resolve(undefined); refreshed.resolve(undefined) })
  const method = target === 'skill' ? 'setSkillEnabled' : 'setSourceEnabled'
  let attempts = 0
  mock.unary(`skillsManager/${method}`, async () => {
    if (++attempts === 1) { await response.promise; throw new Error('Settings offline') }
    await retry.promise
    if (target === 'skill') source.skills[0].managerEnabled = false
    else source.enabled = false
    return ok({})
  })
  const label = target === 'market' ? zh['market.source'] : target === 'source' ? '启停来源 DSH' : '启停技能 个人技能'
  const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: label })
  const neighbor = screen.getByRole<HTMLButtonElement>('switch', { name: '启停技能 第二技能' })
  const search = screen.getByRole<HTMLInputElement>('textbox', { name: zh.search })
  fireEvent.change(search, { target: { value: '技能' } })
  search.setSelectionRange(0, 1)
  const feedback = view.container.querySelector('.dssm-directory-feedback')!
  expect(feedback.textContent).toBe('')
  toggle.focus(); fireEvent.click(toggle)
  expect(toggle.disabled).toBe(false)
  expect(toggle.closest('[aria-busy]')?.getAttribute('aria-busy')).toBe('true')
  expect(neighbor.disabled).toBe(false)
  expect(neighbor.closest('[aria-busy]')?.getAttribute('aria-busy')).toBe('false')
  fireEvent.click(toggle); fireEvent.click(neighbor)
  expect(attempts).toBe(1)
  await act(async () => { response.resolve(undefined); await response.promise })
  const error = await screen.findByText(/操作失败：/)
  expect(document.activeElement).toBe(toggle)
  expect(view.container.querySelector('.dssm-directory-feedback')).toBe(feedback)
  expect(feedback.contains(error)).toBe(true)
  mock.unary('skillsManager/readState', async () => { await refreshed.promise; return ok(data) })
  fireEvent.click(toggle)
  expect(screen.getByText(/操作失败：/)).toBe(error)
  expect(toggle.disabled).toBe(false)
  await act(async () => { retry.resolve(undefined); await retry.promise })
  expect(toggle.closest('[aria-busy]')?.getAttribute('aria-busy')).toBe('true')
  expect(document.activeElement).toBe(toggle)
  await act(async () => { refreshed.resolve(undefined); await refreshed.promise })
  await waitFor(() => { expect(toggle.closest('[aria-busy]')?.getAttribute('aria-busy')).toBe('false') })
  expect(screen.queryByText(/操作失败：/)).toBeNull()
  expect(screen.getByRole('switch', { name: label })).toBe(toggle)
  expect(document.activeElement).toBe(toggle)
  expect(screen.getByRole('textbox', { name: zh.search })).toBe(search)
  expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['技能', 0, 1])
  expect(view.container.querySelector('.dssm-directory-feedback')).toBe(feedback)
  expect(feedback.textContent).toBe('')
  expect(attempts).toBe(2)
})
