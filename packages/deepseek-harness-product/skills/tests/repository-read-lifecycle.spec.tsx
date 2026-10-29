// @vitest-environment jsdom
import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Button, Modal as NativeModal } from '@deepseek-ai/dsh-client-ui-primitives'
import { RemoteMock, ok } from '@deepseek-ai/dsh-remote-mock'
import { afterEach, expect, it } from 'vitest'
import type { ModalProps, SkillOutput } from '../src/client-types.ts'
import { createDestinationKit } from '../src/destination-picker.ts'
import { createRepositoryUI } from '../src/repository-ui.ts'
import { createSkillApi } from '../src/remote-client.ts'
import { Input } from '../src/plugin-ui.ts'
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
async function setup(installed = false) {
  const mock = RemoteMock.create()
  mock.unary('skillsManager/listRepositories', () => ok({ repositories: [{ ...repo, skills: installed ? [{ ...skill, installations: [{ installedRoot: 'dsh', tracked: true, status: 'installed', updateAvailable: true, canRollback: true, canUninstall: true }] }] : repo.skills }], installRoots: [{ key: 'dsh', path: '/skills', label: 'DSH', available: true }], catalogInstalls: [], catalogCopies: [], catalogWarnings: [] } satisfies SkillOutput<'listRepositories'>))
  mock.unary('skillsManager/listWorkspaces', () => ok({ items: [] }))
  mock.unary('skillsManager/listClawHub', () => ok({ items: [{ ownerHandle: 'company', slug: 'orders', displayName: 'Catalog orders' }], nextCursor: null }))
  const native = createSkillApi(Object.assign(mock.remote, { $mount: async () => async () => {}, $on: () => () => {} }))
  const api = native
  const useRepositoryUI = createRepositoryUI({ react: React, Modal, Input, Button, SourceSelect, destination, api, translateError })
  function Harness({ active = true }: { active?: boolean }) {
    const { content } = useRepositoryUI({ active, t })
    return content
  }
  const view = render(h(React.StrictMode, null, h(Harness)))
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'repo.add' }).disabled).toBe(false) })
  fireEvent.click(await screen.findByRole('button', { name: /company\/skills/, expanded: false }))
  return { mock, view, Harness }
}
function open() { fireEvent.click(screen.getByRole('button', { name: 'repo.detail' })) }
function close() { fireEvent.click(screen.getByRole('button', { name: 'repo.close' })) }

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
