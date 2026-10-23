// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
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
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.revokeAuthorization })) })
  expect(refresh).toHaveBeenCalledOnce()
  expect(screen.getByRole('status', { name: zh.loading }).textContent).toBe('')
  expect(screen.queryByRole('button', { name: zh.revokeAuthorization })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.configureDevice })).toBeNull()
  expect(screen.queryByRole('heading', { name: zh.connectorTools })).toBeNull()
  view.unmount()
  await act(async () => { if (outcome === 'resolve') pending.resolve(undefined); else pending.reject(new Error('Late failure')) })
  expect(refresh).toHaveBeenCalledOnce()
  expect(invoke).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
})
