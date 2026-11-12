// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { ConnectorDraftSchema } from '@deepseek-harness/product/connector-draft'
import { ConnectorEditor } from '../src/client/ConnectorEditor.tsx'
import { ConnectorDetail } from '../src/client/ConnectorView.tsx'
import { AUTHORIZATION_POLL_INTERVAL_MS, items, localDetail } from '../src/client/catalog-shared.tsx'
import { en, zh } from '../src/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })
const t = (key: keyof typeof zh) => zh[key]
const editing = { id: 'personal-mcp', version: '1.0.0' }
const draft = ConnectorDraftSchema.parse({ ...editing, version: '1.0.1', kind: 'connector', name: 'MCP',
  summary: 'Tools', category: 'other', transport: 'streamable-http', url: 'https://mcp.example.test' })
const loaded = { draft, configured: true, savePending: false }
const configured = { ...editing, transport: 'streamable-http', url: draft.url, arguments: [],
  headers: ['Authorization'], environment: [], configured: false, timeoutSeconds: 60 }

function transport(handler: (method: string, payload: unknown) => Promise<unknown>) {
  const invoke = vi.fn(async (_namespace: string, method: string, payload: unknown) => ({ ok: true,
    result: await handler(method, payload) }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  return { invoke, cancel }
}

it.each(['create', 'edit'] as const)('deduplicates %s before the pending render and permits retry without clearing private values', async (mode) => {
  const pending = Promise.withResolvers<unknown>()
  const method = mode === 'create' ? 'extensions.save' : 'extensions.connector.update'
  let fail = true
  const api = transport(async (name, input) => {
    if (name === 'extensions.connector.read') return loaded
    if (name !== method) return []
    if (fail) return pending.promise
    const saved = ConnectorDraftSchema.parse(mode === 'create' ? input : (input as { draft: unknown }).draft)
    return { kind: 'connector', id: saved.id, version: saved.version, visibility: 'PERSONAL' }
  })
  const onSaved = vi.fn(), onClose = vi.fn()
  render(<ConnectorEditor {...mode === 'edit' ? { editing } : {}} onClose={onClose} onSaved={onSaved} t={t} />)
  await act(async () => {})
  if (mode === 'create') {
    fireEvent.change(screen.getByLabelText(zh.mcpServerType), { target: { value: 'streamable-http' } })
    fireEvent.change(screen.getByLabelText(zh.connectorEndpoint), { target: { value: draft.url } })
  }
  fireEvent.change(screen.getByLabelText(zh.mcpServerName), { target: { value: 'Retained draft' } })
  fireEvent.click(screen.getByRole('button', { name: zh.addConfigurationEntry }))
  fireEvent.change(screen.getByLabelText(`${zh.configurationKey} 1`), { target: { value: 'Authorization' } })
  fireEvent.change(screen.getByLabelText(`${zh.configurationValue} 1`), { target: { value: 'retained-private-value' } })
  const controls = [zh.pasteConfiguration, zh.addConfigurationEntry, `${zh.remove} 1`]
    .map(name => screen.getByRole<HTMLButtonElement>('button', { name }))
  const save = screen.getByRole('button', { name: mode === 'create' ? zh.addMcp : zh.saveConnector })
  act(() => { fireEvent.click(save); fireEvent.click(save) })
  expect(api.invoke.mock.calls.filter(call => call[1] === method)).toHaveLength(1)
  expect(screen.getByRole('button', { name: zh.connectingConnector })).toBe(save)
  expect(save.getAttribute('aria-busy')).toBe('true')
  expect(save.classList.contains('product-control-pending')).toBe(true)
  for (const control of controls) {
    expect(control.disabled).toBe(true)
    expect(control.classList.contains('product-control-pending')).toBe(true)
    control.click()
  }
  expect(screen.getAllByLabelText(new RegExp(`^${zh.configurationKey} `))).toHaveLength(1)
  expect(screen.getByLabelText<HTMLInputElement>(`${zh.configurationValue} 1`).value).toBe('retained-private-value')
  await act(async () => { pending.reject(new Error('Connection unavailable')) })
  for (const [index, name] of [zh.pasteConfiguration, zh.addConfigurationEntry, `${zh.remove} 1`].entries()) {
    const control = screen.getByRole<HTMLButtonElement>('button', { name })
    expect(control).toBe(controls[index])
    expect(control.disabled).toBe(false)
    expect(control.classList.contains('product-control-pending')).toBe(false)
  }
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(screen.getByLabelText<HTMLInputElement>(`${zh.configurationValue} 1`).value).toBe('retained-private-value')
  expect(onSaved).not.toHaveBeenCalled()
  fail = false
  fireEvent.click(screen.getByRole('button', { name: mode === 'create' ? zh.addMcp : zh.saveConnector }))
  await act(async () => {})
  expect(onSaved).toHaveBeenCalledOnce()
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('blocks dismissal in the same event batch that starts a connector save', async () => {
  const pending = Promise.withResolvers<unknown>()
  transport(async method => method === 'extensions.connector.read' ? loaded
    : method === 'extensions.connector.update' ? pending.promise : [])
  const onClose = vi.fn()
  render(<ConnectorEditor editing={editing} onClose={onClose} onSaved={vi.fn()} t={t} />)
  await screen.findByLabelText(zh.mcpServerName)
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
    fireEvent.keyDown(document, { key: 'Escape' })
  })
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByRole('status').textContent).toBe(zh.knowledgeWaitForSave)
  await act(async () => { pending.reject(new Error('Connection unavailable')) })
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
})

it('deduplicates device saves, blocks immediate dismissal and preserves secrets for a retry', async () => {
  const pending = Promise.withResolvers<unknown>()
  let fail = true
  const api = transport(async method => method.endsWith('.read') ? configured
    : fail ? pending.promise : { ...editing, configured: true })
  const product = localDetail(items([{ ...editing, name: 'Shared MCP', authMode: 'none', canConfigure: true,
    status: 'needs-configuration', visibility: 'COMPANY', tools: [] }])[0]!)
  const refreshed = vi.fn(async () => {})
  render(<ConnectorDetail product={product} onCatalogChanged={refreshed} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
  fireEvent.change(await screen.findByLabelText('Authorization'), { target: { value: 'device-secret' } })
  const save = screen.getByRole('button', { name: zh.saveConnector })
  act(() => { fireEvent.click(save); fireEvent.click(save); fireEvent.keyDown(document, { key: 'Escape' }) })
  expect(api.invoke.mock.calls.filter(call => call[1].endsWith('.save'))).toHaveLength(1)
  expect(screen.getByRole('button', { name: zh.connectingConnector })).toBe(save)
  expect(save.getAttribute('aria-busy')).toBe('true')
  expect(save.classList.contains('product-control-pending')).toBe(true)
  expect(screen.queryByText(zh.knowledgeDiscardDraftConfirmation)).toBeNull()
  expect(screen.getByRole('status').textContent).toBe(zh.knowledgeWaitForSave)
  await act(async () => { pending.reject(new Error('Connection unavailable')) })
  expect(screen.getByLabelText<HTMLInputElement>('Authorization').value).toBe('device-secret')
  expect(refreshed).not.toHaveBeenCalled()
  fail = false
  fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
  await act(async () => {})
  expect(refreshed).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['begin', 'status', 'revoke'] as const)('retains authorization feedback while retrying %s without duplicate requests', async (phase) => {
  vi.useFakeTimers()
  const pending = Promise.withResolvers<unknown>()
  const retry = Promise.withResolvers<undefined>()
  const method = `connectors.authorization.${phase}`
  let fail = true
  const api = transport(async (name) => {
    if (name === method) { if (fail) return pending.promise; await retry.promise }
    if (name.endsWith('.begin')) return { connectorId: editing.id, status: 'PENDING', authorizationUrl: 'https://auth.example.test/' }
    return { connectorId: editing.id, status: name.endsWith('.revoke') ? 'REQUIRED' : 'AUTHORIZED' }
  })
  const product = localDetail(items([{ ...editing, name: 'Company OAuth', authMode: 'oauth', visibility: 'COMPANY',
    authorizationStatus: phase === 'revoke' ? 'AUTHORIZED' : 'REQUIRED', tools: [] }])[0]!)
  const refreshed = vi.fn(async () => {})
  const view = render(<ConnectorDetail product={product} onCatalogChanged={refreshed} t={t} />)
  onTestFinished(() => { view.unmount(); retry.resolve(undefined); pending.resolve(undefined) })
  const label = phase === 'revoke' ? zh.revokeAuthorization : zh.authorize
  const button = screen.getByRole<HTMLButtonElement>('button', { name: label })
  button.focus()
  // Settle jsdom's selectionchange notification before measuring authorization timers.
  vi.advanceTimersByTime(0)
  act(() => { fireEvent.click(button); fireEvent.click(button) })
  if (phase === 'status') await act(async () => { await vi.advanceTimersByTimeAsync(AUTHORIZATION_POLL_INTERVAL_MS) })
  expect(api.invoke.mock.calls.filter(call => call[1] === method)).toHaveLength(1)
  await act(async () => { pending.reject(new Error('Authorization unavailable')) })
  const notice = screen.getByRole('alert')
  expect(notice.textContent).toBe(zh.authorizationFailed)
  expect(refreshed).not.toHaveBeenCalled()
  fail = false
  act(() => { fireEvent.click(button); fireEvent.click(button) })
  if (phase === 'status') await act(async () => { await vi.advanceTimersByTimeAsync(AUTHORIZATION_POLL_INTERVAL_MS) })
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.getByRole('button', { name: phase === 'revoke' ? zh.authorizationWorking : zh.authorizationWaiting })).toBe(button)
  expect(button.disabled).toBe(false)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(button)
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect(button.classList.contains('product-control-pending')).toBe(true)
  expect(api.invoke.mock.calls.filter(call => call[1] === method)).toHaveLength(2)
  const requests = api.invoke.mock.calls.length
  view.rerender(<ConnectorDetail product={product} onCatalogChanged={refreshed} t={key => en[key]} />)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(notice.textContent).toBe(en.authorizationFailed)
  expect(api.invoke).toHaveBeenCalledTimes(requests)
  expect({ button: button.textContent, busy: button.getAttribute('aria-busy'), error: notice.textContent,
    focused: document.activeElement === button }).toMatchSnapshot()
  await act(async () => { retry.resolve(undefined) })
  if (phase === 'begin') await act(async () => { await vi.advanceTimersByTimeAsync(AUTHORIZATION_POLL_INTERVAL_MS) })
  expect(refreshed).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(api.invoke.mock.calls.filter(call => call[1] === method)).toHaveLength(2)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('retries a confirmed revocation refresh once without revoking again', async () => {
  const first = Promise.withResolvers<undefined>(), retry = Promise.withResolvers<undefined>()
  const api = transport(async () => ({ connectorId: editing.id, status: 'REQUIRED' }))
  const product = localDetail(items([{ ...editing, name: 'Company OAuth', authMode: 'oauth', visibility: 'COMPANY',
    authorizationStatus: 'AUTHORIZED', tools: [] }])[0]!)
  const refreshed = vi.fn<() => Promise<void>>().mockReturnValueOnce(first.promise).mockReturnValue(retry.promise)
  render(<ConnectorDetail product={product} onCatalogChanged={refreshed} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.revokeAuthorization }))
  await act(async () => {})
  await act(async () => { first.reject(new Error('Directory unavailable')) })
  expect(screen.getByRole('alert').textContent).toBe(zh.connectorRefreshFailed)
  const refresh = screen.getByRole('button', { name: zh.refresh })
  act(() => { fireEvent.click(refresh); fireEvent.click(refresh) })
  expect(refreshed).toHaveBeenCalledTimes(2)
  await act(async () => { retry.resolve(undefined) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(api.invoke.mock.calls.map(call => call[1])).toEqual(['connectors.authorization.revoke'])
})
