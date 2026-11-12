// @vitest-environment jsdom
import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Modal as NativeModal } from '@deepseek-ai/dsh-client-ui-primitives'
import { RemoteMock, ok } from '@deepseek-ai/dsh-remote-mock'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { ModalProps, SkillOutput } from '../src/client-types.ts'
import { createDestinationKit } from '../src/destination-picker.ts'
import { createRepositoryUI } from '../src/repository-ui.ts'
import { createSkillApi } from '../src/remote-client.ts'
import { createSourceSelect } from '../src/source-select.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })
const h = React.createElement
const t = (key: string) => key
const translateError = (_t: typeof t, error: unknown) => error instanceof Error ? error.message : String(error)
const SourceSelect = createSourceSelect(React)
const destination = createDestinationKit({ react: React, SourceSelect, translateError })
function Modal(props: ModalProps) { return h(NativeModal, { open: true, ...props }) }
const skill = { path: 'skills/orders', name: 'orders', description: 'Order audit', valid: true, documentHash: 'hash', status: 'available', installations: [] }
const repo: SkillOutput<'listRepositories'>['repositories'][number] = {
  id: 'repo', owner: 'company', name: 'skills', ref: '', subdirectory: '', commit: 'revision', refreshedAt: null, error: null, skills: [skill],
}
const detail: SkillOutput<'readRepository'> = { ...skill, commit: 'revision', body: 'Current instructions' }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
async function setup(installed = false, repositories = [repo], workspaceRead: () => RemoteResult<SkillOutput<'listWorkspaces'>> | Promise<RemoteResult<SkillOutput<'listWorkspaces'>>> = () => ok({ items: [] }), onInstalled?: () => unknown, catalogCopies: SkillOutput<'listRepositories'>['catalogCopies'] = []) {
  const mock = RemoteMock.create()
  mock.unary('skillsManager/listRepositories', () => ok({ repositories: repositories.map(item => ({ ...item, skills: installed ? [{ ...skill, installations: [{ installedRoot: 'dsh', tracked: true, status: 'installed', updateAvailable: true, canRollback: true, canUninstall: true }] }] : item.skills })), installRoots: [{ key: 'dsh', path: '/skills', label: 'DSH', available: true }], catalogInstalls: [], catalogCopies, catalogWarnings: [] } satisfies SkillOutput<'listRepositories'>))
  mock.unary('skillsManager/listWorkspaces', workspaceRead)
  mock.unary('skillsManager/listClawHub', () => ok({ items: [{ ownerHandle: 'company', slug: 'orders', displayName: 'Catalog orders', summary: '' }], nextCursor: null } satisfies SkillOutput<'listClawHub'>))
  const native = createSkillApi(Object.assign(mock.remote, { $mount: async () => async () => {}, $on: () => () => {} }))
  const api = native
  const useRepositoryUI = createRepositoryUI({ react: React, Modal, SourceSelect, destination, api, translateError })
  function Harness({ active = true }: { active?: boolean }) {
    const lifetime = React.useRef(new AbortController())
    React.useEffect(() => {
      lifetime.current = new AbortController()
      return () => { lifetime.current.abort() }
    }, [])
    const { content } = useRepositoryUI({ active, t, onInstalled, getSignal: () => lifetime.current.signal })
    return content
  }
  const view = render(h(React.StrictMode, null, h(Harness)))
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'repo.add' }).disabled).toBe(false) })
  fireEvent.click(await screen.findByRole('button', { name: /company\/skills/, expanded: false }))
  return { mock, view, Harness }
}
function open() { fireEvent.click(screen.getByRole('button', { name: 'repo.detail' })) }
function close() { fireEvent.click(screen.getByRole('button', { name: 'repo.close' })) }

const dialogReads = [
  { kind: 'detail', method: 'readRepository', open: 'repo.detail', value: detail },
  { kind: 'catalog-detail', method: 'readCatalog', open: 'repo.detail',
    value: { name: 'Catalog orders', description: 'Order audit', body: 'Current catalog instructions', origin: 'catalog' } },
  { kind: 'review', method: 'previewUpdate', open: 'repo.review',
    value: { token: 'current', commit: 'new', localModified: false, changes: [{ path: 'SKILL.md', kind: 'modified' }], rollback: false } },
  { kind: 'rollback', method: 'previewUpdate', open: 'repo.rollback',
    value: { token: 'current', commit: 'old', localModified: false, changes: [{ path: 'SKILL.md', kind: 'modified' }], rollback: true } },
] satisfies {
  kind: string
  method: 'readRepository' | 'readCatalog' | 'previewUpdate'
  open: string
  value: SkillOutput<'readRepository' | 'readCatalog' | 'previewUpdate'>
}[]

async function failedDialogRead(read: typeof dialogReads[number]) {
  const { mock, view } = await setup(read.method === 'previewUpdate')
  if (read.kind === 'catalog-detail') {
    fireEvent.click(screen.getByRole('button', { name: 'repo.subsource.clawhub' }))
    await screen.findByText('Catalog orders')
  }
  mock.unary(`skillsManager/${read.method}`, () => { throw new Error('Read unavailable') })
  const trigger = screen.getByRole('button', { name: read.open })
  trigger.focus()
  fireEvent.click(trigger)
  const notice = await screen.findByRole('alert')
  return { mock, view, trigger, notice }
}

it.each(dialogReads)('retains the $kind dialog and error throughout a deduplicated read retry', async (read) => {
  const { mock, view, trigger, notice } = await failedDialogRead(read)
  const dialog = screen.getByRole('dialog')
  expect(notice.closest('[role="dialog"]')).toBe(dialog)
  const pending = deferred<RemoteResult<typeof read.value>>()
  onTestFinished(async () => { view.unmount(); pending.resolve(ok(read.value)); await pending.promise.catch(() => undefined) })
  mock.unary(`skillsManager/${read.method}`, () => pending.promise)
  const retry = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'repo.retry' })
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(mock.remote.skillsManager[read.method]).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(screen.getAllByRole('alert')).toEqual([notice])
  expect(within(dialog).getByRole('button', { name: 'repo.retry' })).toBe(retry)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(screen.queryByRole('status', { name: /repo\.(detail|preview)Loading/ })).toBeNull()
  expect({ error: notice.textContent, retry: retry.textContent, busy: retry.getAttribute('aria-busy') }).toMatchSnapshot()
  await act(async () => { pending.resolve(ok(read.value)); await pending.promise })
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('button', { name: 'repo.retry' })).toBeNull()
  if (read.method === 'previewUpdate') {
    expect(within(dialog).getByRole('button', { name: read.kind === 'rollback' ? 'repo.confirmRollback' : 'repo.confirmUpdate' })).toHaveProperty('disabled', false)
    expect(document.activeElement).toBe(within(dialog).getByRole('region', { name: `repo.${read.kind}` }))
  } else {
    const body = within(dialog).getByRole('textbox', { name: 'detail.body' })
    expect(body).toHaveProperty('value', read.value.body)
    expect(document.activeElement).toBe(body)
  }
  expect(mock.remote.skillsManager.updateRepository).not.toHaveBeenCalled()
  expect(mock.remote.skillsManager.rollbackRepository).not.toHaveBeenCalled()
  expect({ focused: document.activeElement?.getAttribute('aria-label'), tag: document.activeElement?.tagName })
    .toMatchSnapshot('Recovered read focus')
  close()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it.each(dialogReads)('retains focus moved away from the $kind retry before its result arrives', async (read) => {
  const { mock, view } = await failedDialogRead(read)
  const pending = deferred<RemoteResult<typeof read.value>>()
  onTestFinished(() => { view.unmount(); pending.resolve(ok(read.value)) })
  mock.unary(`skillsManager/${read.method}`, () => pending.promise)
  const dialog = screen.getByRole('dialog')
  const retry = within(dialog).getByRole('button', { name: 'repo.retry' })
  retry.focus()
  fireEvent.click(retry)
  const close = within(dialog).getByRole('button', { name: 'repo.close' })
  close.focus()
  const focus = vi.spyOn(close, 'focus')
  await act(async () => { pending.resolve(ok(read.value)); await pending.promise })
  expect(document.activeElement).toBe(close)
  expect(focus).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'repo.retry' })).toBeNull()
})

it.each(dialogReads)('cancels the failed $kind read retry without leaking feedback into a new dialog', async (read) => {
  const { mock, view } = await failedDialogRead(read)
  const pending = deferred<RemoteResult<typeof read.value>>()
  onTestFinished(async () => { view.unmount(); pending.resolve(ok(read.value)); await pending.promise.catch(() => undefined) })
  mock.unary(`skillsManager/${read.method}`, () => pending.promise)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'repo.retry' }))
  const signal = mock.remote.skillsManager[read.method].mock.calls[1][1]
  close()
  expect(signal?.aborted).toBe(true)
  expect(screen.queryByRole('alert')).toBeNull()
  if (read.kind === 'catalog-detail') fireEvent.click(screen.getByRole('button', { name: /repo.subsource.github/ }))
  fireEvent.click(screen.getByRole('button', { name: 'repo.add' }))
  const next = screen.getByRole('dialog', { name: 'repo.add' })
  await act(async () => { pending.reject(new Error('Dismissed retry failed')); await pending.promise.catch(() => undefined) })
  expect(screen.getByRole('dialog')).toBe(next)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(mock.remote.skillsManager[read.method]).toHaveBeenCalledTimes(2)
})

it.each(['toolbar', 'manage'] as const)('keeps the %s refresh button, icon and dimensions stable while scanning', async (entry) => {
  const { mock, view } = await setup()
  const pending = deferred<SkillOutput<'refreshRepository'>>()
  const refreshed = { ...repo, skills: [{ ...skill, body: 'Instructions' }] }
  onTestFinished(async () => { view.unmount(); pending.resolve(refreshed); await pending.promise })
  mock.unary('skillsManager/refreshRepository', async () => ok(await pending.promise))
  if (entry === 'manage') fireEvent.click(screen.getByRole('button', { name: 'repo.manage' }))
  const area = entry === 'manage' ? within(screen.getByRole('dialog')) : screen
  const refresh = area.getByRole<HTMLButtonElement>('button', { name: 'repo.refresh' })
  const glyph = refresh.querySelector('svg')
  const style = refresh.getAttribute('style')
  refresh.focus()
  fireEvent.click(refresh)
  expect(area.getByRole('button', { name: 'repo.refresh' })).toBe(refresh)
  expect(refresh.disabled).toBe(false)
  expect(refresh.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(refresh)
  expect(refresh.classList.contains('product-control-pending')).toBe(true)
  expect(refresh.getAttribute('aria-busy')).toBe('true')
  expect(refresh.querySelector('svg')).toBe(glyph)
  expect(refresh.getAttribute('style')).toBe(style)
  fireEvent.click(refresh)
  expect(mock.remote.skillsManager.refreshRepository).toHaveBeenCalledOnce()
  await act(async () => { pending.resolve(refreshed); await pending.promise })
  await waitFor(() => { expect(refresh.getAttribute('aria-disabled')).toBe('false') })
  expect(area.getByRole('button', { name: 'repo.refresh' })).toBe(refresh)
  expect(refresh.querySelector('svg')).toBe(glyph)
})

it('keeps the toolbar busy through every repository in a refresh batch', async () => {
  const second = { ...repo, id: 'second', name: 'more-skills' }
  const { mock, view } = await setup(false, [repo, second])
  const firstRead = deferred<SkillOutput<'refreshRepository'>>()
  const secondRead = deferred<SkillOutput<'refreshRepository'>>()
  const refreshed = { ...repo, skills: [{ ...skill, body: 'Instructions' }] }
  onTestFinished(async () => {
    view.unmount(); firstRead.resolve(refreshed); secondRead.resolve({ ...refreshed, id: second.id })
    await Promise.all([firstRead.promise, secondRead.promise])
  })
  mock.unary('skillsManager/refreshRepository', async (request: { id: string }) => ok(await (
    request.id === repo.id ? firstRead.promise : secondRead.promise)))
  const refresh = screen.getByRole<HTMLButtonElement>('button', { name: 'repo.refresh' })
  refresh.focus()
  fireEvent.click(refresh)
  expect(refresh.getAttribute('aria-busy')).toBe('true')
  await act(async () => { firstRead.resolve(refreshed); await firstRead.promise })
  await waitFor(() => { expect(mock.remote.skillsManager.refreshRepository).toHaveBeenCalledTimes(2) })
  expect(screen.getByRole('button', { name: 'repo.refresh' })).toBe(refresh)
  expect(refresh.getAttribute('aria-busy')).toBe('true')
  expect(refresh.disabled).toBe(false)
  expect(refresh.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(refresh)
  await act(async () => { secondRead.resolve({ ...refreshed, id: second.id }); await secondRead.promise })
  await waitFor(() => { expect(refresh.getAttribute('aria-disabled')).toBe('false') })
  expect(refresh.getAttribute('aria-busy')).toBe('false')
})

it.each(['toolbar', 'manage'] as const)('blocks conflicting %s actions before a repository scan renders its lock', async (entry) => {
  const { mock, view } = await setup()
  const pending = deferred<SkillOutput<'refreshRepository'>>()
  onTestFinished(async () => { view.unmount(); pending.resolve(repo); await pending.promise })
  mock.unary('skillsManager/refreshRepository', async () => ok(await pending.promise))
  if (entry === 'manage') fireEvent.click(screen.getByRole('button', { name: 'repo.manage' }))
  const dialog = screen.queryByRole('dialog')
  const area = dialog ? within(dialog) : screen
  const refresh = area.getByRole('button', { name: 'repo.refresh' })
  const actions = entry === 'manage'
    ? [area.getByRole('button', { name: 'repo.remove' }), area.getByRole('button', { name: 'repo.close' })]
    : ['repo.add', 'repo.manage', 'repo.detail', 'repo.install'].map(name => area.getByRole('button', { name }))
  act(() => { fireEvent.click(refresh); for (const action of actions) fireEvent.click(action) })
  expect(screen.queryByRole('dialog')).toBe(dialog)
  expect(mock.remote.skillsManager.refreshRepository).toHaveBeenCalledOnce()
  expect(mock.remote.skillsManager.readRepository).not.toHaveBeenCalled()
  expect(mock.remote.skillsManager.removeRepository).not.toHaveBeenCalled()
  await act(async () => { pending.resolve(repo); await pending.promise })
  await waitFor(() => { expect(refresh.getAttribute('aria-disabled')).toBe('false') })
})

it('restarts a repository list after StrictMode cleanup and keeps the current read busy when the old read settles', async () => {
  const { mock, view, Harness } = await setup()
  view.unmount()
  const previous = deferred<SkillOutput<'listRepositories'>>()
  const current = deferred<SkillOutput<'listRepositories'>>()
  const result: SkillOutput<'listRepositories'> = { repositories: [{ ...repo, name: 'current-skills' }],
    installRoots: [{ key: 'dsh', path: '/skills', label: 'DSH', available: true }], catalogInstalls: [], catalogCopies: [], catalogWarnings: [] }
  let reads = 0
  mock.unary('skillsManager/listRepositories', async () => ok(await (++reads === 1 ? previous.promise : current.promise)))
  const workspaceReads = mock.remote.skillsManager.listWorkspaces.mock.calls.length
  const reopened = render(h(React.StrictMode, null, h(Harness)))
  onTestFinished(async () => {
    reopened.unmount(); previous.resolve(result); current.resolve(result)
    await Promise.allSettled([previous.promise, current.promise])
  })
  await waitFor(() => { expect(reads).toBe(2) })
  const previousSignal = mock.remote.skillsManager.listRepositories.mock.calls.at(-2)?.[0]
  const currentSignal = mock.remote.skillsManager.listRepositories.mock.calls.at(-1)?.[0]
  expect(previousSignal?.aborted).toBe(true)
  expect(currentSignal?.aborted).toBe(false)
  await act(async () => { previous.resolve({ ...result, repositories: [{ ...repo, name: 'obsolete-skills' }] }); await previous.promise })
  expect(screen.getByRole('button', { name: 'repo.add' })).toHaveProperty('disabled', true)
  expect(screen.queryByRole('button', { name: /obsolete-skills/ })).toBeNull()
  expect(mock.remote.skillsManager.listWorkspaces.mock.calls).toHaveLength(workspaceReads)
  await act(async () => { current.resolve(result); await current.promise })
  await screen.findByRole('button', { name: /company\/current-skills/ })
  expect(screen.getByRole('button', { name: 'repo.add' })).toHaveProperty('disabled', false)
  expect(mock.remote.skillsManager.listWorkspaces.mock.calls).toHaveLength(workspaceReads + 1)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['github', 'clawhub'] as const)('reports the %s install workspace failure, preserves local installation and retries', async (source) => {
  const { mock } = await setup(false, [repo], () => ({ ok: false, error: new RemoteError('skills/operation', 'Workspace registry unavailable', {
    code: 'error.workspace.registryUnavailable', error: 'Workspace registry unavailable',
  }) }))
  if (source === 'clawhub') fireEvent.click(screen.getByRole('button', { name: 'repo.subsource.clawhub' }))
  fireEvent.click(await screen.findByRole('button', { name: 'repo.install' }))
  const form = within(screen.getByRole('dialog'))
  expect(form.getByRole('button', { name: 'repo.install' })).toHaveProperty('disabled', false)
  fireEvent.click(form.getByRole('button', { name: 'dest.scope' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'dest.scope.workspace' }))
  expect((await form.findByRole('alert')).textContent).toContain('dest.loadFailed')
  expect(form.queryByText('dest.empty')).toBeNull()
  expect(form.getByRole('button', { name: 'repo.install' })).toHaveProperty('disabled', true)
  mock.unary('skillsManager/listWorkspaces', () => ok({ items: [] }))
  fireEvent.click(form.getByRole('button', { name: 'dest.retry' }))
  await form.findByText('dest.empty')
  expect(form.queryByRole('alert')).toBeNull()
  expect(mock.remote.skillsManager.listWorkspaces).toHaveBeenCalledTimes(2)
  expect(mock.remote.skillsManager.installRepository).not.toHaveBeenCalled()
  expect(mock.remote.skillsManager.installCatalog).not.toHaveBeenCalled()
})

it.each(['success', 'failure'] as const)('cancels workspace destination retry after page disposal and ignores its late %s', async (outcome) => {
  const { mock, view } = await setup(false, [repo], () => ({ ok: false, error: new RemoteError('skills/operation', 'Workspace unavailable', {
    code: 'error.workspace.registryUnavailable', error: 'Workspace unavailable',
  }) }))
  fireEvent.click(screen.getByRole('button', { name: 'repo.install' }))
  const form = within(screen.getByRole('dialog'))
  fireEvent.click(form.getByRole('button', { name: 'dest.scope' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'dest.scope.workspace' }))
  await form.findByRole('alert')
  const pending = deferred<SkillOutput<'listWorkspaces'>>()
  onTestFinished(async () => { pending.resolve({ items: [] }); await pending.promise.catch(() => undefined) })
  mock.unary('skillsManager/listWorkspaces', async () => ok(await pending.promise))
  fireEvent.click(form.getByRole('button', { name: 'dest.retry' }))
  const signal = mock.remote.skillsManager.listWorkspaces.mock.calls.at(-1)?.[0]
  expect(signal?.aborted).toBe(false)
  view.unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => {
    if (outcome === 'failure') pending.reject(new Error('Closed workspace retry failed'))
    else pending.resolve({ items: [] })
    await pending.promise.catch(() => undefined)
  })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(mock.remote.skillsManager.installRepository).not.toHaveBeenCalled()
  expect(mock.remote.skillsManager.installCatalog).not.toHaveBeenCalled()
})

it.each(['github', 'clawhub'] as const)('deduplicates consecutive %s workspace retries and permits retrying after failure', async (source) => {
  const failure = { ok: false as const, error: new RemoteError('skills/operation', 'Workspace registry unavailable', {
    code: 'error.workspace.registryUnavailable', error: 'Workspace registry unavailable',
  }) }
  const { mock } = await setup(false, [repo], () => failure)
  if (source === 'clawhub') fireEvent.click(screen.getByRole('button', { name: 'repo.subsource.clawhub' }))
  fireEvent.click(await screen.findByRole('button', { name: 'repo.install' }))
  const form = within(screen.getByRole('dialog'))
  fireEvent.click(form.getByRole('button', { name: 'dest.scope' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'dest.scope.workspace' }))
  await form.findByRole('alert')
  const pending = deferred<RemoteResult<SkillOutput<'listWorkspaces'>>>()
  onTestFinished(async () => { pending.resolve(failure); await pending.promise })
  mock.unary('skillsManager/listWorkspaces', () => pending.promise)
  const retry = form.getByRole('button', { name: 'dest.retry' })
  const alert = form.getByRole('alert')
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(mock.remote.skillsManager.listWorkspaces).toHaveBeenCalledTimes(2)
  expect(form.getByRole('button', { name: 'dest.retry' })).toBe(retry)
  expect(form.getByRole('alert')).toBe(alert)
  expect(retry).toHaveProperty('disabled', false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  await act(async () => { pending.resolve(failure) })
  expect((await form.findByRole('alert')).textContent).toContain('dest.loadFailed')
  expect(form.getByRole('button', { name: 'dest.retry' })).toBe(retry)
  expect(retry).toHaveProperty('disabled', false)
  expect(form.getByRole('button', { name: 'repo.install' })).toHaveProperty('disabled', true)
  mock.unary('skillsManager/listWorkspaces', () => ok({ items: [{ name: 'Current workspace', path: '/current',
    registeredPaths: ['/current'], available: true, skillCount: 0 }] }))
  fireEvent.click(form.getByRole('button', { name: 'dest.retry' }))
  await waitFor(() => { expect(form.getByRole('button', { name: 'dest.workspace' })).toHaveProperty('disabled', false) })
  fireEvent.click(form.getByRole('button', { name: 'dest.workspace' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Current workspace' }))
  expect(form.getByRole('button', { name: 'repo.install' })).toHaveProperty('disabled', false)
  expect(form.queryByRole('alert')).toBeNull()
  expect(mock.remote.skillsManager.listWorkspaces).toHaveBeenCalledTimes(3)
  expect(mock.remote.skillsManager.installRepository).not.toHaveBeenCalled()
  expect(mock.remote.skillsManager.installCatalog).not.toHaveBeenCalled()
})

it.each(['success', 'failure'] as const)('keeps the current workspace destination after a superseded %s', async (outcome) => {
  const { mock, view } = await setup()
  const old = deferred<SkillOutput<'listWorkspaces'>>()
  onTestFinished(async () => { view.unmount(); old.resolve({ items: [] }); await old.promise.catch(() => undefined) })
  mock.unary('skillsManager/refreshRepository', () => ok({ ...repo, skills: [{ ...skill, body: 'Instructions' }] }))
  mock.unary('skillsManager/listWorkspaces', async () => ok(await old.promise))
  fireEvent.click(screen.getByRole('button', { name: 'repo.refresh' }))
  await waitFor(() => { expect(mock.remote.skillsManager.listWorkspaces).toHaveBeenCalledTimes(2) })
  const oldSignal = mock.remote.skillsManager.listWorkspaces.mock.calls.at(-1)?.[0]
  expect(oldSignal?.aborted).toBe(false)
  await waitFor(() => { expect(screen.getByRole('button', { name: 'repo.refresh' })).toHaveProperty('disabled', false) })
  const current = deferred<SkillOutput<'listWorkspaces'>>()
  onTestFinished(async () => { current.resolve({ items: [] }); await current.promise })
  mock.unary('skillsManager/listWorkspaces', async () => ok(await current.promise))
  fireEvent.click(screen.getByRole('button', { name: 'repo.refresh' }))
  await waitFor(() => { expect(mock.remote.skillsManager.listWorkspaces).toHaveBeenCalledTimes(3) })
  expect(oldSignal?.aborted).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'repo.install' }))
  const form = within(screen.getByRole('dialog'))
  fireEvent.click(form.getByRole('button', { name: 'dest.scope' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'dest.scope.workspace' }))
  await act(async () => {
    if (outcome === 'failure') old.reject(new Error('Superseded workspace read failed'))
    else old.resolve({ items: [] })
    await old.promise.catch(() => undefined)
  })
  expect(form.getByRole('button', { name: 'dest.workspace' })).toHaveProperty('disabled', true)
  expect(form.queryByRole('alert')).toBeNull()
  expect(form.queryByText('dest.empty')).toBeNull()
  await act(async () => { current.resolve({ items: [{ name: 'Current workspace', path: '/current',
    registeredPaths: ['/current'], available: true, skillCount: 0 }] }) })
  fireEvent.click(form.getByRole('button', { name: 'dest.workspace' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Current workspace' }))
  expect(form.getByRole('button', { name: 'dest.workspace' })).toHaveProperty('disabled', false)
  expect(form.getByRole('button', { name: 'dest.workspace' }).textContent).toBe('Current workspace')
  expect(form.getByRole('button', { name: 'repo.install' })).toHaveProperty('disabled', false)
  expect(form.queryByRole('alert')).toBeNull()
  expect(form.queryByText('dest.empty')).toBeNull()
})

it.each(['success', 'failure'] as const)('stops a repository refresh batch after page disposal and a late %s, then retries on reopen', async (outcome) => {
  const second = { ...repo, id: 'second', name: 'more-skills' }
  const { mock, view, Harness } = await setup(false, [repo, second])
  const pending = deferred<SkillOutput<'refreshRepository'>>()
  const refreshed: SkillOutput<'refreshRepository'> = { ...repo, skills: [{ ...skill, body: 'Instructions' }] }
  mock.unary('skillsManager/refreshRepository', async () => ok(await pending.promise))
  fireEvent.click(screen.getByRole('button', { name: 'repo.refresh' }))
  expect(mock.remote.skillsManager.refreshRepository).toHaveBeenCalledOnce()
  const signal = mock.remote.skillsManager.refreshRepository.mock.calls[0]?.[1]
  const reads = mock.remote.skillsManager.listRepositories.mock.calls.length
  view.unmount()
  const cancelled = signal?.aborted
  await act(async () => {
    if (outcome === 'failure') pending.reject(new Error('Dismissed refresh failed'))
    else pending.resolve(refreshed)
    await pending.promise.catch(() => undefined)
  })
  expect({ cancelled, refreshes: mock.remote.skillsManager.refreshRepository.mock.calls.length,
    reads: mock.remote.skillsManager.listRepositories.mock.calls.length - reads }).toEqual({ cancelled: true, refreshes: 1, reads: 0 })
  mock.unary('skillsManager/refreshRepository', (request: { id: string }) => ok({ ...refreshed, id: request.id }))
  const reopened = render(h(React.StrictMode, null, h(Harness)))
  onTestFinished(() => { reopened.unmount() })
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'repo.refresh' }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: 'repo.refresh' }))
  await screen.findByText('repo.refreshed')
  expect(mock.remote.skillsManager.refreshRepository.mock.calls.map(call => call[0].id)).toEqual(['repo', 'repo', 'second'])
  expect(mock.remote.skillsManager.refreshRepository.mock.calls.slice(1).every(call => call[1]?.aborted === false)).toBe(true)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('finishes a dispatched repository registration without starting its scan after the page closes', async () => {
  const { mock, view } = await setup()
  const registration = deferred<SkillOutput<'addRepository'>>()
  mock.unary('skillsManager/addRepository', async () => ok(await registration.promise))
  fireEvent.click(screen.getByRole('button', { name: 'repo.add' }))
  fireEvent.change(within(screen.getByRole('dialog')).getByRole('textbox', { name: 'repo.url' }), {
    target: { value: 'company/new-skills' },
  })
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'repo.save' }))
  expect(mock.remote.skillsManager.addRepository).toHaveBeenCalledOnce()
  const reads = mock.remote.skillsManager.listRepositories.mock.calls.length
  view.unmount()
  await act(async () => { registration.resolve({ ...repo, id: 'new', skills: [] }); await registration.promise })
  expect(mock.remote.skillsManager.refreshRepository).not.toHaveBeenCalled()
  expect(mock.remote.skillsManager.listRepositories.mock.calls).toHaveLength(reads)
})

it.each(['add', 'remove'] as const)('keeps a committed repository %s when its list readback fails', async (action) => {
  let hostRefreshes = 0
  const { mock } = await setup(false, [repo], undefined, () => { hostRefreshes++ })
  const added = { ...repo, id: 'new', name: 'new-skills', skills: [] }
  mock.unary('skillsManager/addRepository', () => ok(added))
  mock.unary('skillsManager/refreshRepository', () => ok(added))
  mock.unary('skillsManager/removeRepository', () => ok({ id: repo.id }))
  const reads = mock.remote.skillsManager.listRepositories.mock.calls.length
  mock.unary('skillsManager/listRepositories', () => ({ ok: false, error: new RemoteError('skills/operation', 'List unavailable', {
    code: 'error.repo.state', error: 'List unavailable',
  }) }))
  if (action === 'add') {
    fireEvent.click(screen.getByRole('button', { name: 'repo.add' }))
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('textbox', { name: 'repo.url' }), { target: { value: 'company/new-skills' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'repo.save' }))
  } else {
    fireEvent.click(screen.getByRole('button', { name: 'repo.manage' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'repo.remove' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'repo.removeConfirm' }))
  }
  await waitFor(() => { expect(screen.getByRole('button', { name: 'repo.add' })).toHaveProperty('disabled', false) })
  expect(screen.queryAllByRole('alert')).toEqual([])
  const notice = screen.getAllByRole('status').map(node => node.textContent)
  expect(notice).toContain(`repo.${action}RefreshWarning · company/${action === 'add' ? 'new-skills' : 'skills'}`)
  if (action === 'add') {
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: /company\/new-skills/, expanded: false })).toBeTruthy()
    expect(mock.remote.skillsManager.addRepository).toHaveBeenCalledOnce()
    expect(mock.remote.skillsManager.refreshRepository).toHaveBeenCalledOnce()
  } else {
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'repo.remove' })).toBeNull()
    expect(screen.queryByRole('button', { name: /company\/skills/, expanded: true })).toBeNull()
    expect(mock.remote.skillsManager.removeRepository).toHaveBeenCalledOnce()
  }
  expect(mock.remote.skillsManager.listRepositories.mock.calls).toHaveLength(reads + 1)
  expect(hostRefreshes).toBe(0)
})

it.each(['rejected', 'reported'] as const)('retains a registered repository and permits scan retry after a %s scan failure', async (outcome) => {
  const { mock } = await setup()
  const added = { ...repo, id: 'new', name: 'new-skills', commit: null, skills: [] }
  const failure = { code: 'error.repo.network', error: 'Repository scan unavailable' }
  const registered = { ...added, error: failure }
  mock.unary('skillsManager/addRepository', () => ok(added))
  mock.unary('skillsManager/refreshRepository', () => outcome === 'reported' ? ok(registered) : {
    ok: false, error: new RemoteError('skills/operation', failure.error, failure),
  })
  mock.unary('skillsManager/listRepositories', () => ok({ repositories: [repo, registered], installRoots: [], catalogInstalls: [], catalogCopies: [], catalogWarnings: [] }))
  fireEvent.click(screen.getByRole('button', { name: 'repo.add' }))
  fireEvent.change(within(screen.getByRole('dialog')).getByRole('textbox', { name: 'repo.url' }), { target: { value: 'company/new-skills' } })
  fireEvent.submit(within(screen.getByRole('dialog')).getByRole('textbox', { name: 'repo.url' }).closest('form')!)
  await waitFor(() => { expect(screen.getByRole('button', { name: 'repo.add' })).toHaveProperty('disabled', false) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: /company\/new-skills/, expanded: false })).toBeTruthy()
  expect(screen.getByRole('status', { name: '' }).textContent).toContain('repo.addScanWarning')
  expect(mock.remote.skillsManager.addRepository).toHaveBeenCalledOnce()
  expect(mock.remote.skillsManager.refreshRepository).toHaveBeenCalledOnce()
  mock.unary('skillsManager/refreshRepository', () => ok({ ...added, error: null }))
  fireEvent.click(screen.getByRole('button', { name: 'repo.refresh' }))
  await screen.findByText('repo.refreshed')
  expect(mock.remote.skillsManager.addRepository).toHaveBeenCalledOnce()
  expect(mock.remote.skillsManager.refreshRepository.mock.calls.map(call => call[0].id)).toEqual(['new', 'repo', 'new'])
})

it.each(['add', 'remove'] as const)('keeps a rejected repository %s editable without scanning or rereading the list', async (action) => {
  const { mock } = await setup()
  const failure = { ok: false as const, error: new RemoteError('skills/operation', 'Registration rejected', {
    code: 'error.repo.state', error: 'Registration rejected',
  }) }
  mock.unary('skillsManager/addRepository', () => failure)
  mock.unary('skillsManager/removeRepository', () => failure)
  const reads = mock.remote.skillsManager.listRepositories.mock.calls.length
  if (action === 'add') {
    fireEvent.click(screen.getByRole('button', { name: 'repo.add' }))
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('textbox', { name: 'repo.url' }), { target: { value: 'company/new-skills' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'repo.save' }))
  } else {
    fireEvent.click(screen.getByRole('button', { name: 'repo.manage' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'repo.remove' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'repo.removeConfirm' }))
  }
  await waitFor(() => { expect(screen.getByRole('button', { name: 'repo.add' })).toHaveProperty('disabled', false) })
  expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('Registration rejected')
  expect(screen.getByRole('button', { name: /company\/skills/, expanded: true })).toBeTruthy()
  expect(mock.remote.skillsManager.listRepositories.mock.calls).toHaveLength(reads)
  expect(mock.remote.skillsManager.refreshRepository).not.toHaveBeenCalled()
  expect(screen.queryByText(`repo.${action}Success`)).toBeNull()
})

const searchCatalogs = [
  { source: 'clawhub', method: 'searchClawHub', label: 'repo.catalog.searchClawhub', loading: 'repo.catalog.searchLoading', error: 'repo.catalog.searchError' },
  { source: 'skillsh', method: 'searchSkillsSh', label: 'repo.catalog.searchSkillsh', loading: 'repo.catalog.skillshLoading', error: 'repo.catalog.skillshError' },
] as const
function searchResult(source: 'clawhub' | 'skillsh', name: string): SkillOutput<'searchClawHub'> | SkillOutput<'searchSkillsSh'> {
  return source === 'clawhub'
    ? { results: [{ source: 'clawhub', ownerHandle: 'company', slug: name, displayName: name, summary: 'Catalog instructions' }] }
    : { skills: [{ id: name, source: 'company/skills', skillId: name, name }] }
}
function searchSignal(mock: RemoteMock, source: 'clawhub' | 'skillsh', index: number): AbortSignal | undefined {
  return source === 'clawhub'
    ? mock.remote.skillsManager.searchClawHub.mock.calls[index]?.[2]
    : mock.remote.skillsManager.searchSkillsSh.mock.calls[index]?.[1]
}

it.each(searchCatalogs)('keeps $source search pending while typing and cancels a cleared query without flashing empty results', async (catalog) => {
  const { mock, view } = await setup()
  const pending = deferred<ReturnType<typeof searchResult>>()
  onTestFinished(() => { view.unmount(); pending.resolve(searchResult(catalog.source, 'dismissed-result')) })
  mock.unary(`skillsManager/${catalog.method}`, async () => ok(await pending.promise))
  fireEvent.click(screen.getByRole('button', { name: `repo.subsource.${catalog.source}` }))
  const input = screen.getByRole('textbox', { name: catalog.label })
  input.focus()
  vi.useFakeTimers()
  fireEvent.change(input, { target: { value: 'order' } })
  expect(screen.queryByText(`repo.catalog.${catalog.source === 'clawhub' ? 'searchEmpty' : 'skillshEmpty'}`)).toBeNull()
  const status = screen.getByRole('status', { name: catalog.loading })
  await act(async () => { await vi.advanceTimersByTimeAsync(299) })
  expect(mock.remote.skillsManager[catalog.method]).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: 'orders' } })
  expect(screen.getByRole('status', { name: catalog.loading })).toBe(status)
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  expect(mock.remote.skillsManager[catalog.method]).toHaveBeenCalledOnce()
  expect(mock.remote.skillsManager[catalog.method].mock.calls[0]?.[0]).toBe('orders')
  expect(document.activeElement).toBe(input)
  expect({ pending: status.getAttribute('aria-label'), emptyVisible: screen.queryByText(`repo.catalog.${catalog.source === 'clawhub' ? 'searchEmpty' : 'skillshEmpty'}`) !== null }).toMatchSnapshot()
  fireEvent.change(input, { target: { value: '' } })
  expect(searchSignal(mock, catalog.source, 0)?.aborted).toBe(true)
  expect(screen.queryByRole('status', { name: catalog.loading })).toBeNull()
  await act(async () => { pending.resolve(searchResult(catalog.source, 'dismissed-result')); await pending.promise })
  expect(screen.queryByText('dismissed-result')).toBeNull()
  expect(document.activeElement).toBe(input)
})

it.each(searchCatalogs.flatMap(catalog => (['pending', 'results', 'error'] as const).map(phase => ({ ...catalog, phase }))))(
  'preserves $source $phase search state when only surrounding whitespace changes', async (catalog) => {
    const { mock, view } = await setup()
    const pending = deferred<ReturnType<typeof searchResult>>()
    onTestFinished(() => { view.unmount(); pending.resolve(searchResult(catalog.source, 'retained-result')) })
    mock.unary(`skillsManager/${catalog.method}`, async () => {
      if (catalog.phase === 'error') throw new Error('Search unavailable')
      return ok(await pending.promise)
    })
    fireEvent.click(screen.getByRole('button', { name: `repo.subsource.${catalog.source}` }))
    const input = screen.getByRole('textbox', { name: catalog.label })
    input.focus()
    vi.useFakeTimers()
    fireEvent.change(input, { target: { value: 'orders' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    if (catalog.phase === 'results') await act(async () => { pending.resolve(searchResult(catalog.source, 'retained-result')); await pending.promise })
    const retained = catalog.phase === 'results' ? screen.getByText('retained-result')
      : catalog.phase === 'error' ? screen.getByRole('alert') : screen.getByRole('status', { name: catalog.loading })
    fireEvent.change(input, { target: { value: ' orders ' } })
    expect(searchSignal(mock, catalog.source, 0)?.aborted).toBe(false)
    expect(retained.isConnected).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(mock.remote.skillsManager[catalog.method]).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(input)
    if (catalog.phase === 'pending') {
      await act(async () => { pending.resolve(searchResult(catalog.source, 'retained-result')); await pending.promise })
      expect(screen.getByText('retained-result')).toBeTruthy()
    }
  },
)

it.each(searchCatalogs)('retains the $source search error and retry button while retrying once', async (catalog) => {
  const { mock, view } = await setup()
  mock.unary(`skillsManager/${catalog.method}`, () => { throw new Error('Search unavailable') })
  fireEvent.click(screen.getByRole('button', { name: `repo.subsource.${catalog.source}` }))
  fireEvent.change(screen.getByRole('textbox', { name: catalog.label }), { target: { value: 'orders' } })
  const notice = await screen.findByRole('alert')
  const pending = deferred<ReturnType<typeof searchResult>>()
  onTestFinished(async () => { view.unmount(); pending.resolve(searchResult(catalog.source, 'recovered')); await pending.promise })
  mock.unary(`skillsManager/${catalog.method}`, async () => ok(await pending.promise))
  const retry = within(notice).getByRole<HTMLButtonElement>('button', { name: 'repo.catalog.retry' })
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(mock.remote.skillsManager[catalog.method]).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(within(notice).getByRole('button', { name: 'repo.catalog.retry' })).toBe(retry)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(screen.queryByRole('status', { name: catalog.loading })).toBeNull()
  expect({ error: notice.textContent, action: retry.textContent, busy: retry.getAttribute('aria-busy') }).toMatchSnapshot()
  await act(async () => { pending.resolve(searchResult(catalog.source, 'recovered')); await pending.promise })
  expect(await screen.findByText('recovered')).toBeDefined()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(mock.remote.skillsManager[catalog.method]).toHaveBeenCalledTimes(2)
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: catalog.label }))
})

it.each(searchCatalogs)('retains focus moved away from the $source search retry', async (catalog) => {
  const { mock, view } = await setup()
  mock.unary(`skillsManager/${catalog.method}`, () => { throw new Error('Search unavailable') })
  fireEvent.click(screen.getByRole('button', { name: `repo.subsource.${catalog.source}` }))
  fireEvent.change(screen.getByRole('textbox', { name: catalog.label }), { target: { value: 'orders' } })
  const notice = await screen.findByRole('alert')
  const pending = deferred<ReturnType<typeof searchResult>>()
  onTestFinished(() => { view.unmount(); pending.resolve(searchResult(catalog.source, 'recovered')) })
  mock.unary(`skillsManager/${catalog.method}`, async () => ok(await pending.promise))
  const retry = within(notice).getByRole('button', { name: 'repo.catalog.retry' })
  retry.focus()
  fireEvent.click(retry)
  const other = screen.getByRole('button', { name: /repo.subsource.github/ })
  other.focus()
  const focus = vi.spyOn(other, 'focus')
  await act(async () => { pending.resolve(searchResult(catalog.source, 'recovered')); await pending.promise })
  expect(await screen.findByText('recovered')).toBeTruthy()
  expect(document.activeElement).toBe(other)
  expect(focus).not.toHaveBeenCalled()
})

it('retains the ClawHub ranking error and retry button until its read succeeds', async () => {
  const { mock, view } = await setup()
  mock.unary('skillsManager/listClawHub', () => { throw new Error('Ranking unavailable') })
  fireEvent.click(screen.getByRole('button', { name: 'repo.subsource.clawhub' }))
  const notice = await screen.findByRole('alert')
  const value: SkillOutput<'listClawHub'> = {
    items: [{ ownerHandle: 'company', slug: 'recovered', displayName: 'Recovered ranking', summary: '' }], nextCursor: null,
  }
  const pending = deferred<SkillOutput<'listClawHub'>>()
  onTestFinished(async () => { view.unmount(); pending.resolve(value); await pending.promise })
  mock.unary('skillsManager/listClawHub', async () => ok(await pending.promise))
  const retry = within(notice).getByRole<HTMLButtonElement>('button', { name: 'repo.catalog.retry' })
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(mock.remote.skillsManager.listClawHub).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(within(notice).getByRole('button', { name: 'repo.catalog.retry' })).toBe(retry)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(screen.queryByRole('status', { name: 'repo.catalog.loading' })).toBeNull()
  expect({ error: notice.textContent, action: retry.textContent, busy: retry.getAttribute('aria-busy') }).toMatchSnapshot()
  await act(async () => { pending.resolve(value); await pending.promise })
  expect(await screen.findByText('Recovered ranking')).toBeDefined()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(mock.remote.skillsManager.listClawHub).toHaveBeenCalledTimes(2)
})

const catalogPage = (slug: string, nextCursor: string | null): SkillOutput<'listClawHub'> => ({
  items: [{ ownerHandle: 'company', slug, displayName: slug, summary: 'Catalog skill' }], nextCursor,
})

it.each([false, true])('retains the ClawHub load-more control until the final page: %s', async (final) => {
  const { mock, view } = await setup()
  mock.unary('skillsManager/listClawHub', () => ok(catalogPage('first', 'next')))
  fireEvent.click(screen.getByRole('button', { name: 'repo.subsource.clawhub' }))
  const first = (await screen.findByText('first')).closest('.dssm-repo-row')!
  const more = screen.getByRole<HTMLButtonElement>('button', { name: 'repo.catalog.loadMore' })
  const pending = deferred<SkillOutput<'listClawHub'>>()
  onTestFinished(async () => { view.unmount(); pending.resolve(catalogPage('second', null)); await pending.promise })
  mock.unary('skillsManager/listClawHub', async () => ok(await pending.promise))
  more.focus()
  act(() => { fireEvent.click(more); fireEvent.click(more) })
  expect(mock.remote.skillsManager.listClawHub).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('button', { name: 'repo.catalog.loadMore' })).toBe(more)
  expect(more.disabled).toBe(false)
  expect(more.getAttribute('aria-disabled')).toBe('true')
  expect(more.getAttribute('aria-busy')).toBe('true')
  expect(more.classList.contains('product-control-pending')).toBe(true)
  expect(document.activeElement).toBe(more)
  expect(screen.queryByRole('status', { name: 'repo.catalog.loadingMore' })).toBeNull()
  expect({ label: more.textContent, busy: more.getAttribute('aria-busy'), rows: view.container.querySelectorAll('.dssm-repo-row').length }).toMatchSnapshot()
  await act(async () => { pending.resolve(catalogPage('second', final ? null : 'last')); await pending.promise })
  expect(screen.getByText('first').closest('.dssm-repo-row')).toBe(first)
  const second = screen.getByText('second').closest('.dssm-repo-row')!
  expect(document.activeElement).toBe(final ? within(second).getByRole('button', { name: 'repo.detail' }) : more)
  if (final) expect(more.isConnected).toBe(false)
  else expect(screen.getByRole('button', { name: 'repo.catalog.loadMore' })).toBe(more)
})

it('retains the ClawHub pagination control through failure and retry', async () => {
  const { mock, view } = await setup()
  mock.unary('skillsManager/listClawHub', () => ok(catalogPage('first', 'next')))
  fireEvent.click(screen.getByRole('button', { name: 'repo.subsource.clawhub' }))
  await screen.findByText('first')
  const more = screen.getByRole<HTMLButtonElement>('button', { name: 'repo.catalog.loadMore' })
  mock.unary('skillsManager/listClawHub', () => { throw new Error('Offline') })
  more.focus(); fireEvent.click(more)
  const notice = await screen.findByRole('alert')
  const retry = within(notice).getByRole<HTMLButtonElement>('button', { name: 'repo.catalog.retry' })
  expect(retry).toBe(more)
  expect(document.activeElement).toBe(more)
  const pending = deferred<SkillOutput<'listClawHub'>>()
  onTestFinished(async () => { view.unmount(); pending.resolve(catalogPage('second', 'last')); await pending.promise })
  mock.unary('skillsManager/listClawHub', async () => ok(await pending.promise))
  fireEvent.click(retry)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  await act(async () => { pending.resolve(catalogPage('second', 'last')); await pending.promise })
  expect(screen.getByRole('button', { name: 'repo.catalog.loadMore' })).toBe(more)
  expect(document.activeElement).toBe(more)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['moved', 'scroll', 'cancelled'] as const)('does not move ClawHub focus after a %s pagination read', async (mode) => {
  const { mock, view } = await setup()
  mock.unary('skillsManager/listClawHub', () => ok(catalogPage('first', 'next')))
  fireEvent.click(screen.getByRole('button', { name: 'repo.subsource.clawhub' }))
  await screen.findByText('first')
  const more = screen.getByRole('button', { name: 'repo.catalog.loadMore' })
  const search = screen.getByRole('textbox', { name: 'repo.catalog.searchClawhub' })
  const pending = deferred<SkillOutput<'listClawHub'>>()
  onTestFinished(async () => { view.unmount(); pending.resolve(catalogPage('second', null)); await pending.promise })
  mock.unary('skillsManager/listClawHub', async () => ok(await pending.promise))
  if (mode === 'scroll') {
    search.focus()
    fireEvent.wheel(view.container.querySelector('.dssm-catalog-list')!, { deltaY: 100 })
  } else {
    more.focus(); fireEvent.click(more)
    if (mode === 'moved') search.focus()
    else {
      const github = screen.getByRole('button', { name: 'repo.subsource.github (1)' })
      github.focus(); fireEvent.click(github)
    }
  }
  const focused = document.activeElement
  await act(async () => { pending.resolve(catalogPage('second', null)); await pending.promise })
  expect(document.activeElement).toBe(focused)
  if (mode === 'cancelled') expect(screen.queryByText('second')).toBeNull()
  else expect(screen.getByText('second')).toBeDefined()
})

it.each([false, true])('merges overlapping ClawHub pages while retaining existing rows; duplicate-only: %s', async (duplicateOnly) => {
  const { mock } = await setup()
  mock.unary('skillsManager/listClawHub', () => ok(catalogPage('first', 'next')))
  fireEvent.click(screen.getByRole('button', { name: 'repo.subsource.clawhub' }))
  const first = (await screen.findByText('first')).closest('.dssm-repo-row')
  const updated = { ...catalogPage('first', null).items[0], displayName: 'Updated first' }
  mock.unary('skillsManager/listClawHub', () => ok({
    items: [updated, updated, ...duplicateOnly ? [] : catalogPage('second', null).items], nextCursor: null,
  }))
  const more = screen.getByRole('button', { name: 'repo.catalog.loadMore' })
  more.focus(); fireEvent.click(more)
  await screen.findByText('Updated first')
  expect(screen.getByText('Updated first').closest('.dssm-repo-row')).toBe(first)
  expect(screen.getAllByText('Updated first')).toHaveLength(1)
  expect(document.activeElement).toBe(duplicateOnly ? screen.getByRole('textbox', { name: 'repo.catalog.searchClawhub' })
    : within(screen.getByText('second').closest('.dssm-repo-row')!).getByRole('button', { name: 'repo.detail' }))
})

it.each(searchCatalogs.flatMap(catalog => (['success', 'failure'] as const).map(outcome => ({ ...catalog, outcome }))))('keeps the current $source search owned after a superseded $outcome', async (catalog) => {
  const { mock, view } = await setup()
  const old = deferred<ReturnType<typeof searchResult>>()
  const current = deferred<ReturnType<typeof searchResult>>()
  const latest = deferred<ReturnType<typeof searchResult>>()
  const requests = new Map([['old', old], ['current', current], ['latest', latest]])
  onTestFinished(async () => {
    view.unmount()
    for (const request of requests.values()) request.resolve(searchResult(catalog.source, 'disposed'))
    await Promise.allSettled([...requests.values()].map(request => request.promise))
  })
  mock.unary(`skillsManager/${catalog.method}`, async (query: string) => {
    const request = requests.get(query)
    if (!request) throw new Error('Unexpected search query')
    return ok(await request.promise)
  })
  fireEvent.click(screen.getByRole('button', { name: `repo.subsource.${catalog.source}` }))
  const input = screen.getByRole('textbox', { name: catalog.label })
  fireEvent.change(input, { target: { value: 'discarded' } })
  fireEvent.change(input, { target: { value: 'old' } })
  await waitFor(() => { expect(mock.remote.skillsManager[catalog.method]).toHaveBeenCalledTimes(1) }, { timeout: 3000 })
  expect(mock.remote.skillsManager[catalog.method].mock.calls[0]?.[0]).toBe('old')
  fireEvent.change(input, { target: { value: 'current' } })
  expect(searchSignal(mock, catalog.source, 0)?.aborted).toBe(true)
  await waitFor(() => { expect(mock.remote.skillsManager[catalog.method]).toHaveBeenCalledTimes(2) }, { timeout: 3000 })
  await act(async () => {
    if (catalog.outcome === 'failure') old.reject(new Error('Superseded search failed'))
    else old.resolve(searchResult(catalog.source, 'stale-result'))
    await old.promise.catch(() => undefined)
  })
  expect(screen.queryByText('stale-result')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('status', { name: catalog.loading })).toBeTruthy()
  fireEvent.change(input, { target: { value: 'latest' } })
  expect(searchSignal(mock, catalog.source, 1)?.aborted).toBe(true)
  await waitFor(() => { expect(mock.remote.skillsManager[catalog.method]).toHaveBeenCalledTimes(3) }, { timeout: 3000 })
  await act(async () => {
    current.resolve(searchResult(catalog.source, 'obsolete-result'))
    await current.promise
  })
  expect(screen.getByRole('status', { name: catalog.loading })).toBeTruthy()
  await act(async () => { latest.resolve(searchResult(catalog.source, 'current-result')); await latest.promise })
  expect(await screen.findByText('current-result')).toBeTruthy()
  expect(screen.queryByText('obsolete-result')).toBeNull()
  expect(screen.queryByRole('status', { name: catalog.loading })).toBeNull()
})

it.each(searchCatalogs.flatMap(catalog => (['source', 'inactive', 'unmount'] as const).map(exit => ({ ...catalog, exit }))))('cancels a $source search when its view exits by $exit', async (catalog) => {
  const { mock, view, Harness } = await setup()
  const pending = deferred<ReturnType<typeof searchResult>>()
  onTestFinished(async () => {
    view.unmount()
    pending.resolve(searchResult(catalog.source, 'disposed'))
    await pending.promise
  })
  mock.unary(`skillsManager/${catalog.method}`, async () => ok(await pending.promise))
  fireEvent.click(screen.getByRole('button', { name: `repo.subsource.${catalog.source}` }))
  fireEvent.change(screen.getByRole('textbox', { name: catalog.label }), { target: { value: 'orders' } })
  await waitFor(() => { expect(mock.remote.skillsManager[catalog.method]).toHaveBeenCalledOnce() }, { timeout: 3000 })
  if (catalog.exit === 'unmount') view.unmount()
  else if (catalog.exit === 'inactive') view.rerender(h(React.StrictMode, null, h(Harness, { active: false })))
  else fireEvent.click(screen.getByRole('button', { name: /repo.subsource.github/ }))
  expect(searchSignal(mock, catalog.source, 0)?.aborted).toBe(true)
  await act(async () => { pending.resolve(searchResult(catalog.source, 'dismissed-result')); await pending.promise })
  expect(screen.queryByText('dismissed-result')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(searchCatalogs)('reports a current $source search failure and retries its query', async (catalog) => {
  const { mock } = await setup()
  mock.unary(`skillsManager/${catalog.method}`, () => { throw new Error('Catalog unavailable') })
  fireEvent.click(screen.getByRole('button', { name: `repo.subsource.${catalog.source}` }))
  fireEvent.change(screen.getByRole('textbox', { name: catalog.label }), { target: { value: 'orders' } })
  expect((await screen.findByRole('alert')).textContent).toContain(catalog.error)
  mock.unary(`skillsManager/${catalog.method}`, () => ok(searchResult(catalog.source, 'retried-result')))
  fireEvent.click(screen.getByRole('button', { name: 'repo.catalog.retry' }))
  expect(await screen.findByText('retried-result')).toBeTruthy()
  expect(mock.remote.skillsManager[catalog.method].mock.calls.map(call => call[0])).toEqual(['orders', 'orders'])
  expect(screen.queryByRole('alert')).toBeNull()
})

it('closes a pending repository read through the native modal and aborts its Remote request', async () => {
  const { mock } = await setup()
  const pending = deferred<SkillOutput<'readRepository'>>()
  mock.unary('skillsManager/readRepository', async () => ok(await pending.promise))
  open()
  expect(screen.getByRole('status', { name: 'repo.detailLoading' })).toBeTruthy()
  const signal = mock.remote.skillsManager.readRepository.mock.calls[0][1]
  close()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(signal?.aborted).toBe(true)
  await act(async () => { pending.resolve(detail); await pending.promise })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['success', 'failure'] as const)('does not reopen or poison another dialog after a source change and late %s', async (outcome) => {
  const { mock } = await setup()
  const pending = deferred<SkillOutput<'readRepository'>>()
  mock.unary('skillsManager/readRepository', async () => ok(await pending.promise))
  open()
  fireEvent.click(screen.getByRole('button', { name: 'repo.subsource.skillsh' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /repo.subsource.github/ }))
  fireEvent.click(screen.getByRole('button', { name: 'repo.add' }))
  expect(screen.getByRole('dialog', { name: 'repo.add' })).toBeTruthy()
  await act(async () => {
    if (outcome === 'failure') pending.reject(new Error('Old request failed'))
    else pending.resolve(detail)
    await pending.promise.catch(() => {})
  })
  expect(screen.getByRole('dialog', { name: 'repo.add' })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('can open a new detail before the dismissed request settles', async () => {
  const { mock } = await setup()
  const old = deferred<SkillOutput<'readRepository'>>()
  mock.unary('skillsManager/readRepository', async () => ok(await old.promise))
  open(); close()
  mock.unary('skillsManager/readRepository', () => ok({ ...detail, body: 'New instructions' }))
  open()
  const reader = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'detail.body' })
  expect(reader.value).toBe('New instructions')
  await act(async () => { old.resolve(detail); await old.promise })
  expect(reader.value).toBe('New instructions')
})

it.each(['inactive', 'unmount'] as const)('cancels a detail when its view becomes %s', async (kind) => {
  const { mock, view, Harness } = await setup()
  const pending = deferred<SkillOutput<'readRepository'>>()
  mock.unary('skillsManager/readRepository', async () => ok(await pending.promise))
  open()
  const signal = mock.remote.skillsManager.readRepository.mock.calls[0][1]
  if (kind === 'unmount') view.unmount()
  else view.rerender(h(React.StrictMode, null, h(Harness, { active: false })))
  expect(signal?.aborted).toBe(true)
  await act(async () => { pending.resolve(detail); await pending.promise })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('cancels catalog details without locking other operations and still shows genuine failures', async () => {
  const { mock } = await setup()
  fireEvent.click(screen.getByRole('button', { name: 'repo.subsource.clawhub' }))
  await screen.findByText('Catalog orders')
  const pending = deferred<SkillOutput<'readCatalog'>>()
  mock.unary('skillsManager/readCatalog', async () => ok(await pending.promise))
  open()
  const signal = mock.remote.skillsManager.readCatalog.mock.calls[0][1]
  close()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(signal?.aborted).toBe(true)
  mock.unary('skillsManager/readCatalog', () => { throw new Error('Catalog unavailable') })
  open()
  await waitFor(() => { expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('Catalog unavailable') })
  await act(async () => { pending.resolve({ name: 'Old catalog', description: '', body: 'Stale', origin: 'catalog' }); await pending.promise })
  expect(screen.queryByText('Old catalog')).toBeNull()
})

it('keeps an installation mutually exclusive and its dialog open until the write finishes', async () => {
  const { mock } = await setup()
  const pending = deferred<SkillOutput<'installRepository'>>()
  mock.unary('skillsManager/installRepository', async () => ok(await pending.promise))
  fireEvent.click(screen.getByRole('button', { name: 'repo.install' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'repo.install' }))
  close()
  expect(screen.getByRole('dialog', { name: 'repo.install' })).toBeTruthy()
  expect(mock.remote.skillsManager.installRepository.mock.calls).toHaveLength(1)
  await act(async () => { pending.resolve({ name: 'orders', root: 'dsh', commit: 'revision' }); await pending.promise })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
})

const repositoryWrites = [
  { action: 'install', method: 'installRepository', open: 'repo.install', confirm: 'repo.install', success: 'repo.installSuccess', warning: 'repo.catalog.installRefreshWarning', receipt: { name: 'orders', root: 'dsh', commit: 'revision' } },
  { action: 'uninstall', method: 'uninstallRepository', open: 'repo.uninstall', confirm: 'repo.confirmUninstall', success: 'repo.uninstallSuccess', warning: 'repo.catalog.uninstallRefreshWarning', receipt: { id: 'trashed', name: 'orders', deletedAt: '2026-11-04T00:00:00Z', root: { key: 'dsh', scope: 'user', label: 'DSH' } } },
  { action: 'update', method: 'updateRepository', open: 'repo.review', confirm: 'repo.confirmUpdate', success: 'repo.updateSuccess', warning: 'repo.refreshAfterWriteWarning', receipt: { name: 'orders', commit: 'new' } },
  { action: 'rollback', method: 'rollbackRepository', open: 'repo.rollback', confirm: 'repo.confirmRollback', success: 'repo.rollbackSuccess', warning: 'repo.refreshAfterWriteWarning', receipt: { name: 'orders', commit: 'old' } },
] as const

async function prepareRepositoryWrite(write: typeof repositoryWrites[number], onInstalled?: () => unknown) {
  const { mock, view } = await setup(write.action !== 'install', [repo], undefined, onInstalled)
  mock.unary('skillsManager/previewUpdate', () => ok({ token: 'current', commit: 'new', localModified: false, changes: [{ path: 'SKILL.md', kind: 'modified' }], rollback: write.action === 'rollback' }))
  fireEvent.click(screen.getByRole('button', { name: write.open }))
  const confirm = await within(screen.getByRole('dialog')).findByRole('button', { name: write.confirm })
  return { mock, confirm, view }
}

const confirmationWrites = [
  ...repositoryWrites,
  { action: 'add', method: 'addRepository', confirm: 'repo.save', receipt: { ...repo, id: 'new', name: 'new-skills' } },
  { action: 'remove', method: 'removeRepository', confirm: 'repo.removeConfirm', receipt: { ok: true } },
  { action: 'catalog-install', method: 'installCatalog', confirm: 'repo.install', receipt: { name: 'orders', root: 'dsh' } },
  { action: 'catalog-uninstall', method: 'trashSkill', confirm: 'repo.confirmUninstall', receipt: repositoryWrites[1].receipt },
] as const

async function prepareConfirmation(write: typeof confirmationWrites[number]) {
  if (write.action === 'install' || write.action === 'uninstall' || write.action === 'update' || write.action === 'rollback') {
    return prepareRepositoryWrite(write)
  }
  const { mock, view } = await setup(false, [repo], undefined, undefined, write.action === 'catalog-uninstall'
    ? [{ id: 'clawhub:company/orders', name: 'orders', installedRoot: 'dsh', canUninstall: true }] : [])
  if (write.action === 'add') {
    mock.unary('skillsManager/refreshRepository', () => ok(repo))
    fireEvent.click(screen.getByRole('button', { name: 'repo.add' }))
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('textbox', { name: 'repo.url' }), { target: { value: 'company/new-skills' } })
  } else if (write.action === 'remove') {
    fireEvent.click(screen.getByRole('button', { name: 'repo.manage' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'repo.remove' }))
  } else {
    fireEvent.click(screen.getByRole('button', { name: 'repo.subsource.clawhub' }))
    fireEvent.click(await screen.findByRole('button', { name: write.action === 'catalog-install' ? 'repo.install' : 'repo.uninstall' }))
  }
  return { mock, view, confirm: within(screen.getByRole('dialog')).getByRole('button', { name: write.confirm }) }
}

it.each(confirmationWrites)('retains one $action confirmation and its failure through a locked retry', async (write) => {
  const { mock, view, confirm } = await prepareConfirmation(write)
  const failure = { ok: false as const, error: new RemoteError('skills/operation', 'Mutation rejected', {
    code: 'error.repo.conflict', error: 'Mutation rejected',
  }) }
  mock.unary(`skillsManager/${write.method}`, () => failure)
  confirm.focus()
  fireEvent.click(confirm)
  const dialog = screen.getByRole('dialog')
  const area = within(dialog)
  const alert = await area.findByRole('alert')
  await waitFor(() => { expect(confirm).toHaveProperty('disabled', false) })
  expect.soft(screen.getAllByRole('alert')).toEqual([alert])
  expect(document.activeElement).toBe(confirm)
  const pending = deferred<RemoteResult<typeof write.receipt>>()
  onTestFinished(async () => { view.unmount(); pending.resolve(ok(write.receipt)); await pending.promise })
  mock.unary(`skillsManager/${write.method}`, () => pending.promise)
  const cancel = area.getByRole('button', { name: 'repo.cancel' })
  act(() => {
    fireEvent.click(confirm); fireEvent.click(confirm); fireEvent.click(cancel)
    fireEvent.keyDown(document, { key: 'Escape' })
  })
  expect(mock.remote.skillsManager[write.method]).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect.soft(alert.isConnected).toBe(true)
  expect.soft(screen.queryAllByRole('alert')).toEqual([alert])
  expect.soft(confirm.getAttribute('aria-busy')).toBe('true')
  expect(confirm).toHaveProperty('disabled', false)
  expect(cancel).toHaveProperty('disabled', false)
  expect(confirm.getAttribute('aria-disabled')).toBe('true')
  expect(cancel.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(confirm)
  expect(confirm.classList.contains('product-control-pending')).toBe(true)
  expect(cancel.classList.contains('product-control-pending')).toBe(true)
  expect(cancel.getAttribute('aria-busy')).not.toBe('true')
  expect(screen.queryByText('repo.loading')).toBeNull()
  expect({ text: dialog.textContent, alerts: screen.getAllByRole('alert').map(node => node.textContent),
    buttons: area.getAllByRole('button').map(node => ({ label: node.textContent || node.getAttribute('aria-label'),
      busy: node.getAttribute('aria-busy'), disabled: node.hasAttribute('disabled'), unavailable: node.getAttribute('aria-disabled') })),
    focused: document.activeElement?.textContent }).toMatchSnapshot()
  await act(async () => { pending.resolve(ok(write.receipt)); await pending.promise })
  await waitFor(() => { expect(screen.getByRole('button', { name: 'repo.subsource.clawhub' })).toHaveProperty('disabled', false) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(mock.remote.skillsManager[write.method]).toHaveBeenCalledTimes(2)
  if (write.action === 'remove') {
    expect(area.queryByRole('button', { name: 'repo.removeConfirm' })).toBeNull()
  } else expect(screen.queryByRole('dialog')).toBeNull()
})

it('cancels post-install repository readback on disposal without undoing or repeating the committed write', async () => {
  const { mock, confirm, view } = await prepareRepositoryWrite(repositoryWrites[0])
  const result: SkillOutput<'listRepositories'> = { repositories: [repo], installRoots: [],
    catalogInstalls: [], catalogCopies: [], catalogWarnings: [] }
  const pending = deferred<SkillOutput<'listRepositories'>>()
  onTestFinished(async () => { pending.resolve(result); await pending.promise })
  mock.unary('skillsManager/installRepository', () => ok(repositoryWrites[0].receipt))
  mock.unary('skillsManager/listRepositories', async () => ok(await pending.promise))
  const reads = mock.remote.skillsManager.listRepositories.mock.calls.length
  const workspaces = mock.remote.skillsManager.listWorkspaces.mock.calls.length
  fireEvent.click(confirm)
  await waitFor(() => { expect(mock.remote.skillsManager.listRepositories.mock.calls).toHaveLength(reads + 1) })
  const signal = mock.remote.skillsManager.listRepositories.mock.calls.at(-1)?.[0]
  expect(signal?.aborted).toBe(false)
  expect(screen.queryByRole('dialog')).toBeNull()
  view.unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => { pending.resolve(result); await pending.promise })
  expect(mock.remote.skillsManager.listWorkspaces.mock.calls).toHaveLength(workspaces)
  expect(mock.remote.skillsManager.installRepository).toHaveBeenCalledOnce()
  expect(mock.remote.skillsManager.uninstallRepository).not.toHaveBeenCalled()
  expect(mock.remote.skillsManager.rollbackRepository).not.toHaveBeenCalled()
})

it.each(repositoryWrites.flatMap(write => ['repository', 'host'].map(refresh => ({ ...write, refresh }))))('keeps a successful $action when its $refresh refresh fails', async (write) => {
  let hostRefreshes = 0
  const { mock, confirm } = await prepareRepositoryWrite(write, () => {
    hostRefreshes++
    if (write.refresh === 'host') throw new Error('Host refresh unavailable')
  })
  mock.unary(`skillsManager/${write.method}`, () => ok(write.receipt))
  const reads = mock.remote.skillsManager.listRepositories.mock.calls.length
  if (write.refresh === 'repository') mock.unary('skillsManager/listRepositories', () => ({ ok: false, error: new RemoteError('skills/operation', 'Repository refresh unavailable', {
    code: 'error.repo.network', error: 'Repository refresh unavailable',
  }) }))
  fireEvent.click(confirm)
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText(`${write.warning} · orders`).getAttribute('role')).toBe('status')
  })
  expect(screen.getByText(write.success).getAttribute('role')).toBe('status')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(mock.remote.skillsManager[write.method]).toHaveBeenCalledOnce()
  expect(mock.remote.skillsManager.listRepositories.mock.calls).toHaveLength(reads + 1)
  expect(hostRefreshes).toBe(1)
})

it.each(repositoryWrites)('keeps a failed $action editable without starting post-write refresh', async (write) => {
  let hostRefreshes = 0
  const { mock, confirm } = await prepareRepositoryWrite(write, () => { hostRefreshes++ })
  mock.unary(`skillsManager/${write.method}`, () => ({ ok: false, error: new RemoteError('skills/operation', 'Mutation rejected', {
    code: 'error.repo.conflict', error: 'Mutation rejected',
  }) }))
  const reads = mock.remote.skillsManager.listRepositories.mock.calls.length
  fireEvent.click(confirm)
  await waitFor(() => { expect(confirm).toHaveProperty('disabled', false) })
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getAllByRole('alert').some(alert => alert.textContent === 'Mutation rejected')).toBe(true)
  expect(screen.queryByText(write.success)).toBeNull()
  expect(screen.queryByText(`${write.warning} · orders`)).toBeNull()
  expect(mock.remote.skillsManager[write.method]).toHaveBeenCalledOnce()
  expect(mock.remote.skillsManager.listRepositories.mock.calls).toHaveLength(reads)
  expect(hostRefreshes).toBe(0)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'repo.cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getAllByRole('alert').map(node => node.textContent)).toEqual(['Mutation rejected'])
})

it('preserves an editable repository form when leaving the tab', async () => {
  const { view, Harness } = await setup()
  fireEvent.click(screen.getByRole('button', { name: 'repo.add' }))
  const input = within(screen.getByRole('dialog')).getByRole('textbox', { name: 'repo.url' })
  fireEvent.change(input, { target: { value: 'company/unsaved-skills' } })
  view.rerender(h(React.StrictMode, null, h(Harness, { active: false })))
  view.rerender(h(React.StrictMode, null, h(Harness)))
  expect(within(screen.getByRole('dialog')).getByRole<HTMLInputElement>('textbox', { name: 'repo.url' }).value).toBe('company/unsaved-skills')
})

it.each(['review', 'rollback'] as const)('allows a pending %s preview to close and aborts the native read', async (kind) => {
  const { mock } = await setup(true)
  const pending = deferred<SkillOutput<'previewUpdate'>>()
  mock.unary('skillsManager/previewUpdate', async () => ok(await pending.promise))
  fireEvent.click(screen.getByRole('button', { name: `repo.${kind}` }))
  expect(screen.getByRole('dialog', { name: `repo.${kind}` })).toBeTruthy()
  expect(screen.getByRole('status', { name: 'repo.previewLoading' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: kind === 'rollback' ? 'repo.confirmRollback' : 'repo.confirmUpdate' })).toBeNull()
  const signal = mock.remote.skillsManager.previewUpdate.mock.calls[0][1]
  close()
  expect(signal?.aborted).toBe(true)
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => {
    pending.resolve({ token: 'stale', commit: 'old', localModified: false, changes: [{ path: 'SKILL.md', kind: 'modified' }], rollback: kind === 'rollback' })
    await pending.promise
  })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['review', 'rollback'] as const)('discards a %s preview on source switch and only confirms the current token', async (kind) => {
  const { mock } = await setup(true)
  const old = deferred<SkillOutput<'previewUpdate'>>()
  mock.unary('skillsManager/previewUpdate', async () => ok(await old.promise))
  const listCalls = mock.remote.skillsManager.listRepositories.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: `repo.${kind}` }))
  fireEvent.click(screen.getByRole('button', { name: 'repo.subsource.skillsh' }))
  fireEvent.click(screen.getByRole('button', { name: /repo.subsource.github/ }))
  mock.unary('skillsManager/previewUpdate', () => ok({ token: 'current', commit: 'new', localModified: false, changes: [{ path: 'SKILL.md', kind: 'modified' }], rollback: kind === 'rollback' }))
  fireEvent.click(screen.getByRole('button', { name: `repo.${kind}` }))
  const confirm = await screen.findByRole('button', { name: kind === 'rollback' ? 'repo.confirmRollback' : 'repo.confirmUpdate' })
  await act(async () => {
    old.resolve({ token: 'stale', commit: 'old', localModified: false, changes: [], rollback: kind === 'rollback' })
    await old.promise
  })
  expect(mock.remote.skillsManager.listRepositories.mock.calls).toHaveLength(listCalls)
  const method = kind === 'rollback' ? 'rollbackRepository' : 'updateRepository'
  mock.unary(`skillsManager/${method}`, () => ok({ name: 'orders', commit: 'new' }))
  fireEvent.click(confirm)
  await waitFor(() => { expect(mock.remote.skillsManager[method]).toHaveBeenCalledOnce() })
  expect(mock.remote.skillsManager[method].mock.calls[0][0]).toMatchObject({ token: 'current' })
})

it('keeps a confirmed update owned by the write lifecycle when leaving its read view', async () => {
  const { mock, view, Harness } = await setup(true)
  mock.unary('skillsManager/previewUpdate', () => ok({ token: 'current', commit: 'new', localModified: false, changes: [{ path: 'SKILL.md', kind: 'modified' }], rollback: false }))
  const write = deferred<SkillOutput<'updateRepository'>>()
  mock.unary('skillsManager/updateRepository', async () => ok(await write.promise))
  fireEvent.click(screen.getByRole('button', { name: 'repo.review' }))
  fireEvent.click(await screen.findByRole('button', { name: 'repo.confirmUpdate' }))
  close()
  expect(screen.getByRole('dialog', { name: 'repo.review' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'repo.subsource.skillsh' }))
  expect(screen.getByRole('dialog', { name: 'repo.review' })).toBeTruthy()
  view.rerender(h(React.StrictMode, null, h(Harness, { active: false })))
  expect(screen.getByRole('dialog', { name: 'repo.review' })).toBeTruthy()
  expect(mock.remote.skillsManager.updateRepository.mock.calls[0][1]).toBeUndefined()
  await act(async () => { write.resolve({ name: 'orders', commit: 'new' }); await write.promise })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
})
