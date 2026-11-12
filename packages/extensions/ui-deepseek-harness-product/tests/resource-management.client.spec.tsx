// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { ConnectorsPanel } from '../src/client/DeepSeekHarnessCatalogSection.tsx'
import { contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { en, zh } from '../src/locales.ts'
import { ProductError } from '@deepseek-harness/product/errors'

const t = makeTranslate(zh, commonZh)
const identity = { id: 'personal-resource', version: '1.0.0', sha256: 'a'.repeat(64) }
const entry = { ...identity, name: 'Receipt resource', canEdit: true, canSubmit: true, canDelete: true, visibility: 'PERSONAL' }
const cases = [
  { kind: 'connector', Panel: ConnectorsPanel, list: 'connectors.list', action: 'delete', method: 'extensions.connector.delete' },
  { kind: 'connector', Panel: ConnectorsPanel, list: 'connectors.list', action: 'submit', method: 'extensions.submit' },
] as const

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function unusedSlot(): never { throw new Error('Resource management does not read this slot') }

async function fixture(operation: typeof cases[number], result: () => Promise<unknown>) {
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
    useContextMenu: contextMenuHook(), openEmployeeSignIn: vi.fn(),
    usePanelInfo: unusedSlot, useRemoteAccess: unusedSlot, useSessionAccess: unusedSlot, useWorkspaceAccess: unusedSlot,
    useSessions: unusedSlot, useSessionStatus: unusedSlot, useSessionRetainInfo: unusedSlot,
    useWorkspaces: unusedSlot, useResource: unusedSlot, useAccess: unusedSlot, renderFactorySlot: unusedSlot,
  }
  const view = render(<operation.Panel t={t} {...actions} />)
  fireEvent.click(await screen.findByRole('tab', { name: zh.mineExtensions }))
  const label = operation.action === 'delete' ? zh.deleteResource : zh.submitShared
  return { ...view, invoke, cancel, label,
    changeLanguage: () => { view.rerender(<operation.Panel t={makeTranslate(en, commonZh)} {...actions} />) },
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

it('removes a confirmed deletion from the catalog and prevents repeating it after device cleanup fails', async () => {
  const view = await fixture(cases[0], async () => {
    view.commit()
    throw new ProductError('CONNECTOR_DELETE_CLEANUP_FAILED', 'Synthetic private error', false,
      [{ kind: 'connector', id: identity.id }])
  })
  const dialog = await confirm(view.label)
  expect((await within(dialog).findByRole('alert')).textContent).toContain(zh.connectorDeleteCleanupFailed)
  await waitFor(() => { expect(view.invoke.mock.calls.filter(call => call[1] === cases[0].list)).toHaveLength(2) })
  expect(within(dialog).queryByRole('button', { name: zh.deleteResource })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.resourceActions })).toBeNull()
  view.changeLanguage()
  expect(within(dialog).getByRole('alert').textContent).toContain(en.connectorDeleteCleanupFailed)
  expect(within(dialog).getByRole('alert').textContent).not.toContain('Synthetic private error')
  expect(within(dialog).getByRole('alert').textContent).toMatchSnapshot()
  fireEvent.click(within(dialog).getByText(en.close, { selector: 'button' }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(view.invoke.mock.calls.filter(call => call[1] === cases[0].method)).toHaveLength(1)
})

it.each(invalidCases)('keeps $kind $action unconfirmed after $invalid until retry succeeds', async (operation) => {
  let valid = false
  const view = await fixture(operation, async () => {
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

it.each((['card', 'details'] as const).flatMap(surface => (['removed', 'cleanup'] as const).flatMap(outcome =>
  [false, true].map(elsewhere => ({ surface, outcome, elsewhere })))))(
  'recovers deleted connector focus from $surface without replacing drafts ($outcome, elsewhere=$elsewhere)', async ({ surface, outcome, elsewhere }) => {
    const pending = deferred<unknown>()
    const operation = cases[0]
    const view = await fixture(operation, () => pending.promise)
    onTestFinished(() => { view.unmount(); pending.resolve(receipt(operation)) })
    render(<input aria-label="Other draft" defaultValue="Unsubmitted" />)
    const other = screen.getByLabelText<HTMLInputElement>('Other draft')
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: zh.search })
    fireEvent.change(search, { target: { value: 'Receipt' } })
    search.setSelectionRange(1, 4)
    if (surface === 'details') fireEvent.click(screen.getByRole('button', { name: entry.name }))
    const area = surface === 'details' ? within(screen.getByRole('dialog')) : screen
    fireEvent.click(area.getByRole('button', { name: zh.resourceActions }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh.deleteResource }))
    const dialog = screen.getByRole('dialog', { name: zh.resourceDeleteTitle.replace('{name}', entry.name) })
    const confirm = within(dialog).getByRole('button', { name: zh.deleteResource })
    confirm.focus()
    fireEvent.click(confirm)
    expect(document.activeElement).toBe(confirm)
    if (elsewhere) { other.focus(); other.setSelectionRange(2, 5) }
    await act(async () => {
      view.commit()
      if (outcome === 'removed') pending.resolve(receipt(operation))
      else pending.resolve(Promise.reject(new ProductError('CONNECTOR_DELETE_CLEANUP_FAILED', 'Synthetic cleanup failure', false,
        [{ kind: 'connector', id: identity.id }])))
    })
    if (outcome === 'cleanup') {
      await within(dialog).findByRole('alert')
      const close = within(dialog).getByText(zh.close, { selector: 'button' })
      expect(document.activeElement).toBe(elsewhere ? other : close)
      fireEvent.click(close)
    }
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(screen.getByRole('searchbox', { name: zh.search })).toBe(search)
    expect(search.value).toBe('Receipt')
    expect([search.selectionStart, search.selectionEnd]).toEqual([1, 4])
    expect(document.activeElement).toBe(elsewhere ? other : search)
    if (elsewhere) expect([other.selectionStart, other.selectionEnd]).toEqual([2, 5])
    expect(other.value).toBe('Unsubmitted')
    expect(screen.queryByText(entry.name)).toBeNull()
    expect(view.invoke.mock.calls.filter(call => call[1] === operation.method)).toHaveLength(1)
  },
)

it.each(cases)('retains $action feedback and locks confirmation before rendering a retry', async (operation) => {
  const pending = deferred<unknown>()
  let attempts = 0
  const view = await fixture(operation, async () => {
    if (++attempts === 1) throw new Error('Temporary outage')
    return pending.promise
  })
  onTestFinished(() => { view.unmount(); pending.resolve(receipt(operation)) })
  const dialog = await confirm(view.label)
  const error = await within(dialog).findByRole('alert')
  const retry = within(dialog).getByRole<HTMLButtonElement>('button', { name: view.label })
  const cancel = within(dialog).getByRole<HTMLButtonElement>('button', { name: zh.cancel })
  retry.focus()
  act(() => { retry.click(); retry.click(); cancel.click(); fireEvent.keyDown(dialog, { key: 'Escape' }) })
  expect(attempts).toBe(2)
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(within(dialog).getByRole('alert')).toBe(error)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(cancel.classList.contains('product-control-pending')).toBe(true)
  expect(retry.disabled).toBe(false)
  expect(cancel.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(cancel.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect({ error: error.textContent, action: retry.textContent, busy: retry.getAttribute('aria-busy'),
    focused: document.activeElement?.textContent }).toMatchSnapshot()
  await act(async () => { view.commit(); pending.resolve(receipt(operation)) })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(view.invoke.mock.calls.filter(call => call[1] === operation.method)).toHaveLength(2)
})

it.each(cases)('cancels $kind $action on unmount and ignores a late receipt', async (operation) => {
  const pending = deferred<unknown>()
  const view = await fixture(operation, () => pending.promise)
  await confirm(view.label)
  const reads = view.invoke.mock.calls.filter(call => call[1] === operation.list).length
  view.unmount()
  expect(view.cancel).toHaveBeenCalledWith('product', expect.any(String))
  await act(async () => { pending.resolve(receipt(operation)) })
  expect(view.invoke.mock.calls.filter(call => call[1] === operation.list)).toHaveLength(reads)
})

it.each(cases)('cancels $kind $action on employee change without refreshing from its late response', async (operation) => {
  const pending = deferred<unknown>()
  const view = await fixture(operation, () => pending.promise)
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
  const view = await fixture(operation, () => pending.promise)
  const dialog = await confirm(view.label)
  try {
    if (action === 'header') fireEvent.click(within(dialog).getByRole('button', { name: zh.close }))
    else if (action === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
    else fireEvent.click(document.querySelector('[role="presentation"] > [aria-hidden="true"]')!)
    expect(dialog.isConnected).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: zh.deletingResource }).disabled).toBe(false)
    expect(within(dialog).getByRole('button', { name: zh.deletingResource }).getAttribute('aria-disabled')).toBe('true')
  } finally { await act(async () => { pending.resolve(receipt(operation)) }) }
})
