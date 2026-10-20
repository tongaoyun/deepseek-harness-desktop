// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ConnectorDetail } from '../src/client/ConnectorView.tsx'
import { ExpertKitsPanel } from '../src/client/DeepSeekHarnessCatalogSection.tsx'
import { items, localDetail } from '../src/client/catalog-shared.tsx'
import { zh } from '../src/locales.ts'

const t = makeTranslate(zh, commonZh)
const descriptor = { id: 'erp', name: 'ERP 连接器', version: '1.0.0', authMode: 'oauth', authorizationStatus: 'AUTHORIZED', tools: [] }
const launch = { connectorId: 'erp', status: 'PENDING', authorizationUrl: 'https://auth.example.test/', state: 'state-private', expiresAt: 2_000_000_000 }
function unusedSlot(): never { throw new Error('Authorization does not read this slot') }
const actions = {
  usePanelInfo: unusedSlot, useRemoteAccess: unusedSlot, useSessionAccess: unusedSlot, useWorkspaceAccess: unusedSlot,
  useSessions: unusedSlot, useSessionStatus: unusedSlot, useSessionRetainInfo: unusedSlot,
  useWorkspaces: unusedSlot, useResource: unusedSlot, useAccess: unusedSlot, renderFactorySlot: unusedSlot,
  startExpertKit: unusedSlot, installSkill: unusedSlot, installExpertKit: unusedSlot,
  readInstalledExpertKits: async () => ({ installed: [] }),
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
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

it.each(['authorize', 'revoke'] as const)('refreshes the connector dialog and kit dependency after %s from a kit', async (action) => {
  let authorized = action === 'revoke'
  const kit = { id: 'order-kit', version: '1.0.0', name: '订单套件', connectorRefs: ['erp'] }
  transport(async (method) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee' }
    if (method === 'expertKits.list') return [kit]
    if (method === 'expertKits.get') return kit
    if (method === 'expertKits.readme') return { ...kit, readme: '# 订单套件' }
    if (method === 'connectors.list') return [{ ...descriptor, authorizationStatus: authorized ? 'AUTHORIZED' : 'REQUIRED' }]
    if (method === 'connectors.authorization.begin') return launch
    if (method === 'connectors.authorization.status') { authorized = true; return { connectorId: 'erp', status: 'AUTHORIZED' } }
    if (method === 'connectors.authorization.revoke') { authorized = false; return { connectorId: 'erp', status: 'REQUIRED', expiresAt: null } }
    return []
  })
  render(<ExpertKitsPanel {...actions} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: /^订单套件/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'ERP 连接器' }))
  const dialog = await screen.findByRole('dialog', { name: zh.connectorDetails })
  if (action === 'authorize') vi.useFakeTimers()
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: action === 'authorize' ? zh.authorize : zh.revokeAuthorization })) })
  if (action === 'authorize') { await act(async () => { await vi.advanceTimersByTimeAsync(1_000) }); vi.useRealTimers() }
  await waitFor(() => { expect(within(dialog).queryByRole('button', { name: action === 'authorize' ? zh.revokeAuthorization : zh.authorize })).toBeTruthy() })
  const dependencies = screen.getByRole('heading', { level: 2, name: `${zh.dataConnections} 1` }).closest('section')!
  expect(within(dependencies).getByText(action === 'authorize' ? zh.statusAuthorized : zh.statusRequired)).toBeTruthy()
  expect(screen.getByRole('heading', { name: '订单套件' })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
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

it('cancels a connector reference refresh when closed and ignores its late result', async () => {
  const pending = Promise.withResolvers<unknown>()
  const started = Promise.withResolvers<undefined>()
  const kit = { id: 'order-kit', name: '订单套件', version: '1.0.0', connectorRefs: ['erp'] }
  let reads = 0
  const api = transport(async (method) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee' }
    if (method === 'expertKits.list') return [kit]
    if (method === 'expertKits.get') return kit
    if (method === 'expertKits.readme') return { ...kit, readme: '# 订单套件' }
    if (method === 'connectors.list') {
      if (++reads === 3) { started.resolve(undefined); return pending.promise }
      return [descriptor]
    }
    if (method === 'connectors.authorization.revoke') return { connectorId: 'erp', status: 'REQUIRED' }
    return []
  })
  render(<ExpertKitsPanel {...actions} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: /^订单套件/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'ERP 连接器' }))
  const dialog = await screen.findByRole('dialog', { name: zh.connectorDetails })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: zh.revokeAuthorization })); await started.promise })
  const request = api.invoke.mock.calls.filter(call => call[1] === 'connectors.list').at(-1)!
  fireEvent.click(within(dialog).getByRole('button', { name: zh.close }))
  expect(api.cancel).toHaveBeenCalledWith('product', request[3])
  await act(async () => { pending.resolve([{ ...descriptor, authorizationStatus: 'REQUIRED' }]) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  const dependencies = screen.getByRole('heading', { level: 2, name: `${zh.dataConnections} 1` }).closest('section')!
  expect(within(dependencies).getByText(zh.statusAuthorized)).toBeTruthy()
})

it('reports a failed reference refresh and retains the kit until a successful retry', async () => {
  const kit = { id: 'order-kit', name: '订单套件', version: '1.0.0', connectorRefs: ['erp'] }
  let reads = 0
  transport(async (method) => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee' }
    if (method === 'expertKits.list') return [kit]
    if (method === 'expertKits.get') return kit
    if (method === 'expertKits.readme') return { ...kit, readme: '# 订单套件' }
    if (method === 'connectors.list') {
      reads += 1
      if (reads === 3) throw new Error('Directory unavailable')
      return [{ ...descriptor, authorizationStatus: reads > 3 ? 'REQUIRED' : 'AUTHORIZED' }]
    }
    if (method === 'connectors.authorization.revoke') return { connectorId: 'erp', status: 'REQUIRED' }
    return []
  })
  render(<ExpertKitsPanel {...actions} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: /^订单套件/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'ERP 连接器' }))
  const dialog = await screen.findByRole('dialog', { name: zh.connectorDetails })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.revokeAuthorization }))
  expect((await within(dialog).findByRole('alert')).textContent).toBe(zh.authorizationFailed)
  const dependencies = screen.getByRole('heading', { level: 2, name: `${zh.dataConnections} 1` }).closest('section')!
  expect(within(dependencies).getByText(zh.statusAuthorized)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: zh.revokeAuthorization }))
  await within(dialog).findByRole('button', { name: zh.authorize })
  expect(within(dependencies).getByText(zh.statusRequired)).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})
