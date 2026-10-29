// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ConnectorDetail } from '../src/client/ConnectorView.tsx'
import { ConnectorsPanel } from '../src/client/DeepSeekHarnessCatalogSection.tsx'
import { items, localDetail } from '../src/client/catalog-shared.tsx'
import { zh } from '../src/locales.ts'

const t = makeTranslate(zh, commonZh)
const descriptor = { visibility: 'COMPANY', reviewStatus: 'PUBLISHED', id: 'erp', name: 'ERP 连接器', version: '1.0.0', authMode: 'oauth', authorizationStatus: 'AUTHORIZED', tools: [] }
const launch = { connectorId: 'erp', status: 'PENDING', authorizationUrl: 'https://auth.example.test/', state: 'state-private', expiresAt: 2_000_000_000 }
function unusedSlot(): never { throw new Error('Authorization does not read this slot') }
const actions = {
  usePanelInfo: unusedSlot, useRemoteAccess: unusedSlot, useSessionAccess: unusedSlot, useWorkspaceAccess: unusedSlot,
  useSessions: unusedSlot, useSessionStatus: unusedSlot, useSessionRetainInfo: unusedSlot,
  useWorkspaces: unusedSlot, useResource: unusedSlot, useAccess: unusedSlot, renderFactorySlot: unusedSlot,
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function transport(handler: (method: string) => Promise<unknown>) {
  const invoke = vi.fn(async (_namespace: string, method: string, _payload?: unknown, _requestId?: string) => (
    { ok: true, result: await handler(method) }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel, subscribe: () => () => {} } })
  return { invoke, cancel }
}

it('keeps authorization unchanged when revocation confirms another connector', async () => {
  const changed = vi.fn(async () => {})
  transport(async () => ({ connectorId: 'another', status: 'REQUIRED', expiresAt: null }))
  render(<ConnectorDetail product={localDetail(items([descriptor])[0]!)} onCatalogChanged={changed} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.revokeAuthorization }))
  await screen.findByRole('alert')
  expect(changed).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: zh.revokeAuthorization })).toBeTruthy()
})

it('rejects an authorized poll result belonging to another connector', async () => {
  const changed = vi.fn(async () => {})
  transport(async method => method === 'connectors.authorization.begin' ? launch : { connectorId: 'another', status: 'AUTHORIZED', expiresAt: null })
  render(<ConnectorDetail product={localDetail(items([{ ...descriptor, authorizationStatus: 'REQUIRED' }])[0]!)} onCatalogChanged={changed} t={t} />)
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole('button', { name: zh.authorize }))
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(changed).not.toHaveBeenCalled()
})

const invalidResponses = [
  { method: 'connectors.authorization.begin', valid: launch },
  { method: 'connectors.authorization.status', valid: { connectorId: 'erp', status: 'AUTHORIZED' } },
  { method: 'connectors.authorization.revoke', valid: { connectorId: 'erp', status: 'REQUIRED' } },
].flatMap(operation => [undefined, null, {}, [], { ...operation.valid, connectorId: 'other' }, { ...operation.valid, status: 'UNKNOWN' },
  ...operation.method.endsWith('.begin') ? [{ ...launch, authorizationUrl: 'file:///authorization' }, { ...launch, status: 'AUTHORIZED' }]
    : operation.method.endsWith('.revoke') ? [{ ...operation.valid, status: 'AUTHORIZED' }, { ...operation.valid, status: 'PENDING' }] : [],
].map(invalid => ({ ...operation, invalid })))

it.each(invalidResponses)('preserves the connector and permits retry after invalid $method: $invalid', async ({ method, valid, invalid }) => {
  let accept = false
  const changed = vi.fn(async () => {})
  const api = transport(async operation => operation === method ? accept ? valid : invalid
    : operation === 'connectors.authorization.begin' ? launch : { connectorId: 'erp', status: 'AUTHORIZED' })
  const revoke = method.endsWith('.revoke')
  render(<ConnectorDetail product={localDetail(items([{ ...descriptor, authorizationStatus: revoke ? 'AUTHORIZED' : 'REQUIRED' }])[0]!)}
    onCatalogChanged={changed} t={t} />)
  if (!revoke) vi.useFakeTimers()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: revoke ? zh.revokeAuthorization : zh.authorize })) })
  if (!revoke) await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect(screen.getByRole('alert').textContent).toBe(zh.authorizationFailed)
  expect(changed).not.toHaveBeenCalled()
  if (method.endsWith('.begin')) expect(api.invoke.mock.calls.some(call => call[1] === 'connectors.authorization.status')).toBe(false)
  accept = true
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: revoke ? zh.revokeAuthorization : zh.authorize })) })
  if (!revoke) await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect(changed).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['begin', 'status', 'revoke'] as const)('cancels pending authorization %s on unmount and ignores its late response', async (phase) => {
  const pending = Promise.withResolvers<unknown>()
  const changed = vi.fn(async () => {})
  const method = `connectors.authorization.${phase}`
  const api = transport(async operation => operation === method ? pending.promise : launch)
  const view = render(<ConnectorDetail product={localDetail(items([{ ...descriptor, authorizationStatus: phase === 'revoke' ? 'AUTHORIZED' : 'REQUIRED' }])[0]!)}
    onCatalogChanged={changed} t={t} />)
  vi.useFakeTimers()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: phase === 'revoke' ? zh.revokeAuthorization : zh.authorize })) })
  if (phase === 'status') await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  const request = api.invoke.mock.calls.find(call => call[1] === method)
  expect(request).toBeTruthy()
  const calls = api.invoke.mock.calls.length
  view.unmount()
  expect(api.cancel).toHaveBeenCalledWith('product', request![3])
  await act(async () => { pending.resolve({ connectorId: 'other', status: 'AUTHORIZED' }); await vi.advanceTimersByTimeAsync(2_000) })
  expect(api.invoke).toHaveBeenCalledTimes(calls)
  expect(changed).not.toHaveBeenCalled()
})

it('continues pending authorization until the matching connector is authorized', async () => {
  let polls = 0
  const changed = vi.fn(async () => {})
  transport(async method => method.endsWith('.begin') ? launch : { connectorId: 'erp', status: ++polls === 1 ? 'PENDING' : 'AUTHORIZED' })
  render(<ConnectorDetail product={localDetail(items([{ ...descriptor, authorizationStatus: 'REQUIRED' }])[0]!)} onCatalogChanged={changed} t={t} />)
  vi.useFakeTimers()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.authorize })); await vi.advanceTimersByTimeAsync(1_000) })
  expect(changed).not.toHaveBeenCalled()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.authorizationWaiting }).disabled).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect(polls).toBe(2)
  expect(changed).toHaveBeenCalledOnce()
})

function authorizationClock(): void {
  vi.useFakeTimers()
  // Node's intrinsic AbortSignal timer is outside Vitest's fake timer clock.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController()
    setTimeout(() => { controller.abort(new DOMException('Authorization timed out', 'TimeoutError')) }, milliseconds)
    return controller.signal
  })
}

it.each((['begin', 'status'] as const).flatMap(phase => (['resolve', 'reject'] as const).map(outcome => ({ phase, outcome }))))(
  'ends authorization at its deadline while $phase is pending and ignores its late $outcome during retry', async ({ phase, outcome }) => {
    authorizationClock()
    const pending = Promise.withResolvers<unknown>()
    const changed = vi.fn(async () => {})
    let retry = false
    const method = `connectors.authorization.${phase}`
    const api = transport(async operation => !retry && operation === method ? pending.promise
      : operation.endsWith('.begin') ? launch : { connectorId: 'erp', status: 'AUTHORIZED' })
    render(<ConnectorDetail product={localDetail(items([{ ...descriptor, authorizationStatus: 'REQUIRED' }])[0]!)}
      onCatalogChanged={changed} t={t} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.authorize })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999) })
    expect(screen.queryByRole('alert')).toBeNull()
    const old = api.invoke.mock.calls.find(call => call[1] === method)!
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(screen.getByRole('alert').textContent).toMatchSnapshot()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.authorize }).disabled).toBe(false)
    expect(api.cancel).toHaveBeenCalledWith('product', old[3])
    retry = true
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.authorize })) })
    const calls = api.invoke.mock.calls.length
    await act(async () => {
      if (outcome === 'resolve') pending.resolve(phase === 'begin' ? launch : { connectorId: 'erp', status: 'AUTHORIZED' })
      else pending.reject(new Error('Late authorization failure'))
    })
    expect(changed).not.toHaveBeenCalled()
    expect(api.invoke).toHaveBeenCalledTimes(calls)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(changed).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
    const fresh = api.invoke.mock.calls.filter(call => call[1] === method).at(-1)!
    expect(fresh[3]).not.toBe(old[3])
  })

it.each([-3_600_000, 3_600_000])('keeps the authorization deadline when the system clock changes by %i ms', async (clockChange) => {
  authorizationClock()
  const changed = vi.fn(async () => {})
  const api = transport(async operation => operation.endsWith('.begin') ? launch : { connectorId: 'erp', status: 'PENDING' })
  render(<ConnectorDetail product={localDetail(items([{ ...descriptor, authorizationStatus: 'REQUIRED' }])[0]!)}
    onCatalogChanged={changed} t={t} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.authorize })); await vi.advanceTimersByTimeAsync(1_000) })
  vi.setSystemTime(Date.now() + clockChange)
  await act(async () => { await vi.advanceTimersByTimeAsync(58_999) })
  expect(screen.queryByRole('alert')).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(screen.getByRole('alert').textContent).toBe(zh.authorizationFailed)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.authorize }).disabled).toBe(false)
  const calls = api.invoke.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
  expect(api.invoke).toHaveBeenCalledTimes(calls)
  expect(changed).not.toHaveBeenCalled()
})

it('releases cancellation listeners after authorization succeeds', async () => {
  authorizationClock()
  const changed = vi.fn(async () => {})
  const api = transport(async operation => operation.endsWith('.begin') ? launch : { connectorId: 'erp', status: 'AUTHORIZED' })
  const view = render(<ConnectorDetail product={localDetail(items([{ ...descriptor, authorizationStatus: 'REQUIRED' }])[0]!)}
    onCatalogChanged={changed} t={t} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.authorize })); await vi.advanceTimersByTimeAsync(1_000) })
  expect(changed).toHaveBeenCalledOnce()
  const calls = api.invoke.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(api.invoke).toHaveBeenCalledTimes(calls)
  expect(api.cancel).not.toHaveBeenCalled()
  view.unmount()
  expect(api.cancel).not.toHaveBeenCalled()
})

it.each(['authorize', 'revoke', 'configure'] as const)('retains catalog connector details and retries only reads after confirmed %s', async (operation) => {
  let reads = 0
  let authorized = operation !== 'authorize'
  const api = transport(async (method) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee' }
    if (method === 'connectors.list') {
      if (++reads === 2) throw new Error('Directory unavailable')
      return [{ ...descriptor, canConfigure: true, authorizationStatus: authorized ? 'AUTHORIZED' : 'REQUIRED' }]
    }
    if (method === 'connectors.authorization.begin') return launch
    if (method === 'connectors.authorization.status') { authorized = true; return { connectorId: 'erp', status: 'AUTHORIZED' } }
    if (method === 'connectors.authorization.revoke') { authorized = false; return { connectorId: 'erp', status: 'REQUIRED' } }
    if (method === 'extensions.connector.configuration.read') return { id: 'erp', version: '1.0.0',
      transport: 'streamable-http', url: 'https://mcp.example.test', arguments: [], headers: [], environment: [], configured: false, timeoutSeconds: 60 }
    if (method === 'extensions.connector.configuration.save') return { id: 'erp', version: '1.0.0', configured: true }
    throw new Error(`Unexpected method ${method}`)
  })
  render(<ConnectorsPanel {...actions} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: /^ERP 连接器/ }))
  const dialog = await screen.findByRole('dialog', { name: zh.connectorDetails })
  if (operation === 'configure') {
    fireEvent.click(within(dialog).getByRole('button', { name: zh.configureDevice }))
    fireEvent.click(await screen.findByRole('button', { name: zh.saveConnector }))
  } else {
    if (operation === 'authorize') vi.useFakeTimers()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: operation === 'authorize' ? zh.authorize : zh.revokeAuthorization })) })
    if (operation === 'authorize') { await act(async () => { await vi.advanceTimersByTimeAsync(1_000) }); vi.useRealTimers() }
  }
  expect((await screen.findByRole('alert')).textContent).toBe(zh.connectorRefreshFailed)
  expect(screen.getByRole('dialog', { name: zh.connectorDetails })).toBe(dialog)
  expect(screen.queryByRole('dialog', { name: zh.configureDevice })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: zh.refresh }))
  await within(dialog).findByRole('button', { name: authorized ? zh.revokeAuthorization : zh.authorize })
  expect(reads).toBe(3)
  expect(screen.queryByRole('alert')).toBeNull()
  const write = operation === 'configure' ? 'extensions.connector.configuration.save'
    : operation === 'authorize' ? 'connectors.authorization.begin' : 'connectors.authorization.revoke'
  expect(api.invoke.mock.calls.filter(call => call[1] === write)).toHaveLength(1)
})

it.each(['resolve', 'reject'] as const)('cancels a catalog connector refresh on close and ignores its late %s after another connector opens', async (outcome) => {
  const pending = Promise.withResolvers<unknown>()
  const started = Promise.withResolvers<undefined>()
  const other = { ...descriptor, id: 'hr', name: 'HR 连接器' }
  let reads = 0
  const api = transport(async (method) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee' }
    if (method === 'connectors.list') {
      if (++reads === 2) { started.resolve(undefined); return pending.promise }
      return [descriptor, other]
    }
    if (method === 'connectors.authorization.revoke') return { connectorId: 'erp', status: 'REQUIRED' }
    throw new Error(`Unexpected method ${method}`)
  })
  render(<ConnectorsPanel {...actions} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: /^ERP 连接器/ }))
  const dialog = await screen.findByRole('dialog', { name: zh.connectorDetails })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh.revokeAuthorization })); await started.promise })
  const request = api.invoke.mock.calls.filter(call => call[1] === 'connectors.list').at(-1)!
  fireEvent.click(within(dialog).getByRole('button', { name: zh.close }))
  expect(api.cancel).toHaveBeenCalledWith('product', request[3])
  fireEvent.click(screen.getByRole('button', { name: /^HR 连接器/ }))
  await act(async () => {
    if (outcome === 'resolve') pending.resolve([{ ...descriptor, authorizationStatus: 'REQUIRED' }])
    else pending.reject(new Error('Late directory failure'))
  })
  const current = screen.getByRole('dialog', { name: zh.connectorDetails })
  expect(within(current).getByText('HR 连接器')).toBeTruthy()
  expect(within(current).queryByText('ERP 连接器')).toBeNull()
  expect(within(current).getByRole('button', { name: zh.revokeAuthorization })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(reads).toBe(2)
})

it('keeps a missing connector unavailable until the directory returns its matching resource', async () => {
  let reads = 0
  const api = transport(async (method) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee' }
    if (method === 'connectors.list') return ++reads === 2 ? [] : [{ ...descriptor, authorizationStatus: reads > 2 ? 'REQUIRED' : 'AUTHORIZED' }]
    if (method === 'connectors.authorization.revoke') return { connectorId: 'erp', status: 'REQUIRED' }
    throw new Error(`Unexpected method ${method}`)
  })
  render(<ConnectorsPanel {...actions} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: /^ERP 连接器/ }))
  const dialog = await screen.findByRole('dialog', { name: zh.connectorDetails })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.revokeAuthorization }))
  expect((await within(dialog).findByRole('alert')).textContent).toBe(zh.connectorRefreshFailed)
  expect(within(dialog).queryByRole('button', { name: zh.revokeAuthorization })).toBeNull()
  expect(within(dialog).queryByRole('heading', { name: zh.connectorTools })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: zh.refresh }))
  await within(dialog).findByRole('button', { name: zh.authorize })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(api.invoke.mock.calls.filter(call => call[1] === 'connectors.authorization.revoke')).toHaveLength(1)
})
