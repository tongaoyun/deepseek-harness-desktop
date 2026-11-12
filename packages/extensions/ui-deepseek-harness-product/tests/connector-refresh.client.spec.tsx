// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ConnectorDetail } from '../src/client/ConnectorView.tsx'
import { items, localDetail } from '../src/client/catalog-shared.tsx'
import { zh } from '../src/locales.ts'

const t = makeTranslate(zh, commonZh)
const descriptor = { id: 'erp', version: '1.0.0', name: 'ERP', authMode: 'oauth', authorizationStatus: 'AUTHORIZED',
  status: 'ready', canConfigure: true, tools: [] }
const launch = { connectorId: 'erp', status: 'PENDING', authorizationUrl: 'https://auth.example.test/' }
const template = { id: 'erp', version: '1.0.0', transport: 'streamable-http', url: 'https://mcp.example.test',
  arguments: [], headers: ['Authorization'], environment: [], configured: false, timeoutSeconds: 60 }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('restores capability browsing after a failed authorization refresh without rebuilding its controls', async () => {
  const response = Promise.withResolvers<undefined>()
  const refresh = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('Directory unavailable')).mockReturnValue(response.promise)
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: vi.fn(async () => (
    { ok: true, result: { connectorId: 'erp', status: 'REQUIRED' } })) } })
  const tools = Array.from({ length: 45 }, (_, index) => ({ name: `order.read_${index}`,
    displayName: `查询订单 ${index}`, description: `订单说明 ${index}`, access: 'READ' }))
  const view = render(<ConnectorDetail product={localDetail(items([{ ...descriptor, tools }])[0]!)} onCatalogChanged={refresh} t={t} />)
  onTestFinished(() => { view.unmount(); response.resolve(undefined) })
  const disclosure = screen.getByText(zh.viewConnectorTools.replace('{count}', '45')).closest('details')!
  disclosure.open = true
  const search = screen.getByRole<HTMLInputElement>('searchbox', { name: zh.searchConnectorTools })
  const access = screen.getByRole<HTMLSelectElement>('combobox', { name: zh.connectorToolAccess })
  fireEvent.change(search, { target: { value: '订单' } })
  fireEvent.change(access, { target: { value: 'READ' } })
  const first = screen.getByText('查询订单 0').closest('details')!
  first.open = true
  fireEvent.click(screen.getByRole('button', { name: zh.showMoreConnectorTools.replace('{shown}', '20').replace('{total}', '45') }))
  const more = screen.getByRole('button', { name: zh.showMoreConnectorTools.replace('{shown}', '40').replace('{total}', '45') })
  fireEvent.click(screen.getByRole('button', { name: zh.revokeAuthorization }))
  const notice = await screen.findByRole('alert')
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(screen.queryByRole('listitem')).toBeNull()
  const retry = screen.getByRole('button', { name: zh.refresh })
  retry.focus(); fireEvent.click(retry)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.queryByRole('searchbox')).toBeNull()
  await act(async () => { response.resolve(undefined) })
  expect(screen.getByRole('searchbox', { name: zh.searchConnectorTools })).toBe(search)
  expect(screen.getByRole('combobox', { name: zh.connectorToolAccess })).toBe(access)
  expect(search.value).toBe('订单')
  expect(access.value).toBe('READ')
  expect(disclosure.open).toBe(true)
  expect(first.open).toBe(true)
  expect(screen.getAllByRole('listitem')).toHaveLength(40)
  expect(screen.getByRole('button', { name: more.textContent })).toBe(more)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: zh.revokeAuthorization }))
  expect(refresh).toHaveBeenCalledTimes(2)
  expect({ query: search.value, access: access.value, expanded: disclosure.open, firstExpanded: first.open,
    visible: screen.getAllByRole('listitem').length }).toMatchSnapshot()
})

it.each([false, true])('moves hidden capability focus to its refresh retry without taking focus elsewhere (%s)', async (elsewhere) => {
  const response = Promise.withResolvers<undefined>()
  const refresh = vi.fn(() => response.promise)
  vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: vi.fn(async () => (
    { ok: true, result: { connectorId: 'erp', status: 'REQUIRED' } })) } })
  const product = localDetail(items([{ ...descriptor,
    tools: [{ name: 'order.get', displayName: '查询订单', description: '订单说明', access: 'READ' }] }])[0]!)
  const view = render(<><ConnectorDetail product={product} onCatalogChanged={refresh} t={t} /><button>Elsewhere</button></>)
  onTestFinished(() => { view.unmount(); response.resolve(undefined) })
  const summary = screen.getByText('查询订单').closest('summary')!
  const disclosure = summary.closest('section')!.querySelector('details')!
  disclosure.open = true
  fireEvent.click(screen.getByRole('button', { name: zh.revokeAuthorization }))
  await vi.waitFor(() => { expect(refresh).toHaveBeenCalledOnce() })
  const other = screen.getByRole('button', { name: 'Elsewhere' })
  const focused = elsewhere ? other : summary
  focused.focus()
  await act(async () => { response.reject(new Error('Directory unavailable')) })
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(summary.isConnected).toBe(true)
  expect(document.activeElement).toBe(elsewhere ? other : screen.getByRole('button', { name: zh.refresh }))
  expect({ elsewhere, focused: document.activeElement?.textContent, hidden: summary.closest('section')!.hidden }).toMatchSnapshot()
})

it.each((['oauth', 'device'] as const).flatMap(mode => [false, true].map(elsewhere => ({ mode, elsewhere }))))(
  'recovers $mode connector refresh focus after success (elsewhere=$elsewhere)', async ({ mode, elsewhere }) => {
    const pending = Promise.withResolvers<undefined>()
    const refresh = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('Directory unavailable')).mockReturnValue(pending.promise)
    vi.stubGlobal('dshDesktop', { extensions: { cancel: vi.fn(), invoke: vi.fn(async (_namespace: string, method: string) => ({ ok: true,
      result: method === 'extensions.connector.configuration.read' ? template
        : method === 'extensions.connector.configuration.save' ? { id: 'erp', version: '1.0.0', configured: true }
          : { connectorId: 'erp', status: 'REQUIRED' } })) } })
    const product = localDetail(items([{ ...descriptor, authMode: mode === 'oauth' ? 'oauth' : 'none' }])[0]!)
    const view = render(<><ConnectorDetail product={product} onCatalogChanged={refresh} t={t} /><button>Elsewhere</button></>)
    onTestFinished(() => { view.unmount(); pending.resolve(undefined) })
    if (mode === 'oauth') fireEvent.click(screen.getByRole('button', { name: zh.revokeAuthorization }))
    else {
      fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
      fireEvent.change(await screen.findByLabelText('Authorization'), { target: { value: 'private-fixture' } })
      fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
    }
    await screen.findByRole('alert')
    const retry = screen.getByRole('button', { name: zh.refresh })
    retry.focus()
    fireEvent.click(retry)
    expect(document.activeElement).toBe(retry)
    const other = screen.getByRole('button', { name: 'Elsewhere' })
    if (elsewhere) other.focus()
    await act(async () => { pending.resolve(undefined) })
    const target = screen.getByRole('button', { name: mode === 'oauth' ? zh.revokeAuthorization : zh.configureDevice })
    expect(document.activeElement).toBe(elsewhere ? other : target)
    expect(screen.queryByRole('button', { name: zh.refresh })).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(2)
    expect({ mode, elsewhere, focused: document.activeElement?.textContent }).toMatchSnapshot()
  },
)

it.each(['resolve', 'reject'] as const)('retains the refresh failure without restoring unverified tools during a retry that will %s', async (outcome) => {
  const pending = Promise.withResolvers<undefined>()
  const invoke = vi.fn(async () => ({ ok: true, result: { connectorId: 'erp', status: 'REQUIRED' } }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const refresh = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('Directory unavailable')).mockReturnValue(pending.promise)
  const view = render(<ConnectorDetail product={localDetail(items([{ ...descriptor,
    tools: [{ name: 'order.get', displayName: 'Read order', access: 'READ' }] }])[0]!)} onCatalogChanged={refresh} t={t} />)
  onTestFinished(() => { view.unmount(); pending.resolve(undefined) })
  fireEvent.click(screen.getByRole('button', { name: zh.revokeAuthorization }))
  const failure = await screen.findByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.refresh })
  retry.focus()
  fireEvent.click(retry)
  expect(screen.getByRole('alert')).toBe(failure)
  expect(screen.getByRole('button', { name: zh.refresh })).toBe(retry)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(screen.queryByRole('button', { name: zh.revokeAuthorization })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.configureDevice })).toBeNull()
  expect(screen.queryByRole('heading', { name: zh.connectorTools })).toBeNull()
  expect(screen.getByText('Read order').closest('section')).toHaveProperty('hidden', true)
  fireEvent.click(retry)
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(invoke).toHaveBeenCalledOnce()
  await act(async () => { if (outcome === 'resolve') pending.resolve(undefined); else pending.reject(new Error('Still unavailable')) })
  expect(screen.queryByRole('alert') !== null).toBe(outcome === 'reject')
  if (outcome === 'reject') {
    expect(screen.getByRole('alert')).toBe(failure)
    expect(screen.getByRole('button', { name: zh.refresh })).toBe(retry)
    expect(retry.disabled).toBe(false)
    expect(retry.getAttribute('aria-disabled')).toBe('false')
    expect(document.activeElement).toBe(retry)
    expect(screen.queryByRole('heading', { name: zh.connectorTools })).toBeNull()
  } else expect(screen.getByRole('heading', { name: zh.connectorTools })).toBeTruthy()
})

it.each(['authorize', 'revoke', 'configure'] as const)('retries only status reads after confirmed %s and a failed refresh', async (operation) => {
  const saved = operation === 'configure'
  const invoke = vi.fn(async (_namespace: string, method: string) => ({ ok: true,
    result: method === 'extensions.connector.configuration.read' ? template
      : method === 'extensions.connector.configuration.save' ? { id: 'erp', version: '1.0.0', configured: true }
        : method === 'connectors.authorization.begin' ? launch
          : { connectorId: 'erp', status: operation === 'authorize' ? 'AUTHORIZED' : 'REQUIRED' } }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  let available = false
  const refresh = vi.fn(async () => { if (!available) throw new Error('Directory unavailable') })
  const product = localDetail(items([{ ...descriptor, authorizationStatus: operation === 'authorize' ? 'REQUIRED' : 'AUTHORIZED' }])[0]!)
  render(<ConnectorDetail product={product} onCatalogChanged={refresh} t={t} />)
  if (saved) {
    fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
    fireEvent.change(await screen.findByLabelText('Authorization'), { target: { value: 'private-fixture-value' } })
    fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
  } else {
    if (operation === 'authorize') vi.useFakeTimers()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: operation === 'authorize' ? zh.authorize : zh.revokeAuthorization })) })
    if (operation === 'authorize') { await act(async () => { await vi.advanceTimersByTimeAsync(1_000) }); vi.useRealTimers() }
  }
  expect((await screen.findByRole('alert')).textContent).toBe(zh.connectorRefreshFailed)
  expect(screen.queryByText(zh.authorizationFailed)).toBeNull()
  expect(screen.queryByRole('dialog', { name: zh.configureDevice })).toBeNull()
  expect(screen.queryByText('已配置')).toBeNull()
  const writeCount = invoke.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await screen.findByRole('alert')
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(invoke).toHaveBeenCalledTimes(writeCount)
  available = true
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await act(async () => {})
  expect(refresh).toHaveBeenCalledTimes(3)
  expect(invoke).toHaveBeenCalledTimes(writeCount)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['resolve', 'reject'] as const)('ignores a late refresh %s after the connector detail unmounts', async (outcome) => {
  const pending = Promise.withResolvers<undefined>()
  const invoke = vi.fn(async () => ({ ok: true, result: { connectorId: 'erp', status: 'REQUIRED' } }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const refresh = vi.fn(() => pending.promise)
  const view = render(<ConnectorDetail product={localDetail(items([descriptor])[0]!)} onCatalogChanged={refresh} t={t} />)
  const revoke = screen.getByRole('button', { name: zh.revokeAuthorization })
  await act(async () => { fireEvent.click(revoke) })
  expect(refresh).toHaveBeenCalledOnce()
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  expect(screen.getByRole('button', { name: zh.authorizationWorking })).toBe(revoke)
  expect(revoke.getAttribute('aria-disabled')).toBe('true')
  expect(screen.getByRole('button', { name: zh.configureDevice })).toHaveProperty('disabled', true)
  expect(screen.getByRole('heading', { name: zh.connectorTools })).toBeTruthy()
  view.unmount()
  await act(async () => { if (outcome === 'resolve') pending.resolve(undefined); else pending.reject(new Error('Late failure')) })
  expect(refresh).toHaveBeenCalledOnce()
  expect(invoke).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
})
