// @vitest-environment jsdom
import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Modal as NativeModal } from '@deepseek-ai/dsh-client-ui-primitives'
import { RemoteMock, ok } from '@deepseek-ai/dsh-remote-mock'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import type { ModalProps, SkillOutput } from '../src/client-types.ts'
import { createDestinationKit } from '../src/destination-picker.ts'
import { createRepositoryUI } from '../src/repository-ui.ts'
import { createSkillApi } from '../src/remote-client.ts'
import { createSourceSelect } from '../src/source-select.ts'

afterEach(cleanup)
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
async function setup(installed = false, repositories = [repo], workspaceRead: () => RemoteResult<SkillOutput<'listWorkspaces'>> | Promise<RemoteResult<SkillOutput<'listWorkspaces'>>> = () => ok({ items: [] }), onInstalled?: () => unknown) {
  const mock = RemoteMock.create()
  mock.unary('skillsManager/listRepositories', () => ok({ repositories: repositories.map(item => ({ ...item, skills: installed ? [{ ...skill, installations: [{ installedRoot: 'dsh', tracked: true, status: 'installed', updateAvailable: true, canRollback: true, canUninstall: true }] }] : item.skills })), installRoots: [{ key: 'dsh', path: '/skills', label: 'DSH', available: true }], catalogInstalls: [], catalogCopies: [], catalogWarnings: [] } satisfies SkillOutput<'listRepositories'>))
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

it.each(['success', 'failure'] as const)('keeps the current workspace destination after a superseded %s', async (outcome) => {
  const { mock, view } = await setup()
  const old = deferred<SkillOutput<'listWorkspaces'>>()
  onTestFinished(async () => { view.unmount(); old.resolve({ items: [] }); await old.promise.catch(() => undefined) })
  mock.unary('skillsManager/refreshRepository', () => ok({ ...repo, skills: [{ ...skill, body: 'Instructions' }] }))
  mock.unary('skillsManager/listWorkspaces', async () => ok(await old.promise))
  fireEvent.click(screen.getByRole('button', { name: 'repo.refresh' }))
  await waitFor(() => { expect(mock.remote.skillsManager.listWorkspaces).toHaveBeenCalledTimes(2) })
  await waitFor(() => { expect(screen.getByRole('button', { name: 'repo.refresh' })).toHaveProperty('disabled', false) })
  mock.unary('skillsManager/listWorkspaces', () => ok({ items: [{ name: 'Current workspace', path: '/current', registeredPaths: ['/current'], available: true, skillCount: 0 }] }))
  fireEvent.click(screen.getByRole('button', { name: 'repo.refresh' }))
  await waitFor(() => { expect(mock.remote.skillsManager.listWorkspaces).toHaveBeenCalledTimes(3) })
  fireEvent.click(screen.getByRole('button', { name: 'repo.install' }))
  const form = within(screen.getByRole('dialog'))
  fireEvent.click(form.getByRole('button', { name: 'dest.scope' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'dest.scope.workspace' }))
  fireEvent.click(form.getByRole('button', { name: 'dest.workspace' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Current workspace' }))
  await act(async () => {
    if (outcome === 'failure') old.reject(new Error('Superseded workspace read failed'))
    else old.resolve({ items: [] })
    await old.promise.catch(() => undefined)
  })
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
  const { mock } = await setup(write.action !== 'install', [repo], undefined, onInstalled)
  mock.unary('skillsManager/previewUpdate', () => ok({ token: 'current', commit: 'new', localModified: false, changes: [{ path: 'SKILL.md', kind: 'modified' }], rollback: write.action === 'rollback' }))
  fireEvent.click(screen.getByRole('button', { name: write.open }))
  const confirm = await within(screen.getByRole('dialog')).findByRole('button', { name: write.confirm })
  return { mock, confirm }
}

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
