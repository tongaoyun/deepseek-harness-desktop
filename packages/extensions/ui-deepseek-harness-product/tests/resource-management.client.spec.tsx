// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConnectorsPanel } from '../src/client/DeepSeekHarnessCatalogSection.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/locales.ts'

const t = makeTranslate(zh, commonZh)
const identity = { id: 'personal-resource', version: '1.0.0', sha256: 'a'.repeat(64) }
const entry = { ...identity, name: 'Receipt resource', canEdit: true, canSubmit: true, canDelete: true, visibility: 'PERSONAL' }
const cases = [
  { kind: 'connector', Panel: ConnectorsPanel, list: 'connectors.list', action: 'delete', method: 'extensions.connector.delete' },
  { kind: 'connector', Panel: ConnectorsPanel, list: 'connectors.list', action: 'submit', method: 'extensions.submit' },
] as const

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function unusedSlot(): never { throw new Error('Resource management does not read this slot') }

function fixture(operation: typeof cases[number], result: () => Promise<unknown>) {
  let removed = false
  let submitted = false
  let employeeId = 'employee-one'
  let listener: ((event: { type: string; payload: object }) => void) | undefined
  const invoke = vi.fn(async (_namespace: string, method: string) => ({ ok: true, result: method === operation.list
    ? removed ? [] : [{ ...entry, canSubmit: !submitted, reviewStatus: submitted ? 'SUBMITTED' : 'DRAFT' }]
    : method === 'auth.getSession' ? { authenticated: true, employeeId }
      : method === operation.method ? await result() : [] }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel,
    subscribe: (_namespace: string, callback: typeof listener) => { listener = callback; return () => { listener = undefined } },
  } })
  const actions = {
    usePanelInfo: unusedSlot, useRemoteAccess: unusedSlot, useSessionAccess: unusedSlot, useWorkspaceAccess: unusedSlot,
    useSessions: unusedSlot, useSessionStatus: unusedSlot, useSessionRetainInfo: unusedSlot,
    useWorkspaces: unusedSlot, useResource: unusedSlot, useAccess: unusedSlot, renderFactorySlot: unusedSlot,
  }
  const view = render(<operation.Panel t={t} {...actions} />)
  const label = operation.action === 'delete' ? zh.deleteResource : zh.submitShared
  return { ...view, invoke, cancel, label,
    changeEmployee: () => { employeeId = 'employee-two'; listener?.({ type: 'session.changed', payload: { authenticated: true, employeeId } }) },
    commit: () => { removed = operation.action === 'delete'; submitted = operation.action === 'submit' },
  }
}

async function confirm(label: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: zh.resourceActions }))
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: label }))
  return dialog
}

function receipt(operation: typeof cases[number]) {
  return operation.action === 'delete' ? { id: identity.id, removed: true }
    : { id: identity.id, version: identity.version, submitted: true }
}

const invalidCases = cases.flatMap(operation => [undefined, null, {}, [], { ...receipt(operation), id: 'another-resource' },
  ...operation.action === 'submit' ? [{ ...receipt(operation), version: '2.0.0' }, { ...receipt(operation), submitted: false },
    { ...receipt(operation), submitted: 'true' }]
    : operation.action === 'delete' ? [{ ...receipt(operation), removed: false }, { ...receipt(operation), removed: 'true' }]
      : [{ id: '' }, { id: 42 }],
].map(invalid => ({ ...operation, invalid })))

it.each(invalidCases)('keeps $kind $action unconfirmed after $invalid until retry succeeds', async (operation) => {
  let valid = false
  const view = fixture(operation, async () => {
    if (!valid) return operation.invalid
    view.commit()
    return receipt(operation)
  })
  const dialog = await confirm(view.label)
  const reads = view.invoke.mock.calls.filter(call => call[1] === operation.list).length
  await within(dialog).findByRole('alert')
  expect(dialog.isConnected).toBe(true)
  expect(screen.getByText(entry.name)).toBeTruthy()
  expect(view.invoke.mock.calls.filter(call => call[1] === operation.list)).toHaveLength(reads)
  valid = true
  fireEvent.click(within(dialog).getByRole('button', { name: view.label }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(view.invoke.mock.calls.filter(call => call[1] === operation.method)).toHaveLength(2)
  if (operation.action === 'delete') expect(screen.queryByText(entry.name)).toBeNull()
  else {
    fireEvent.click(await screen.findByRole('button', { name: zh.resourceActions }))
    expect(screen.getByText(zh.reviewPending)).toBeTruthy()
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

it.each(cases)('cancels $kind $action on unmount and ignores a late receipt', async (operation) => {
  const pending = deferred<unknown>()
  const view = fixture(operation, () => pending.promise)
  await confirm(view.label)
  const reads = view.invoke.mock.calls.filter(call => call[1] === operation.list).length
  view.unmount()
  expect(view.cancel).toHaveBeenCalledWith('product', expect.any(String))
  await act(async () => { pending.resolve(receipt(operation)) })
  expect(view.invoke.mock.calls.filter(call => call[1] === operation.list)).toHaveLength(reads)
})

it.each(cases)('cancels $kind $action on employee change without refreshing from its late response', async (operation) => {
  const pending = deferred<unknown>()
  const view = fixture(operation, () => pending.promise)
  await confirm(view.label)
  await act(async () => { view.changeEmployee() })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  await screen.findByText(entry.name)
  const reads = view.invoke.mock.calls.filter(call => call[1] === operation.list).length
  expect(view.cancel).toHaveBeenCalledWith('product', expect.any(String))
  await act(async () => { pending.resolve({}) })
  expect(view.invoke.mock.calls.filter(call => call[1] === operation.list)).toHaveLength(reads)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['header', 'escape', 'mask'] as const)('keeps resource confirmation open on %s close during a pending deletion', async (action) => {
  const pending = deferred<unknown>()
  const operation = cases[0]
  const view = fixture(operation, () => pending.promise)
  const dialog = await confirm(view.label)
  try {
    if (action === 'header') fireEvent.click(within(dialog).getByRole('button', { name: zh.close }))
    else if (action === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
    else fireEvent.click(document.querySelector('[role="presentation"] > [aria-hidden="true"]')!)
    expect(dialog.isConnected).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: zh.deletingResource }).disabled).toBe(true)
  } finally { await act(async () => { pending.resolve(receipt(operation)) }) }
})
