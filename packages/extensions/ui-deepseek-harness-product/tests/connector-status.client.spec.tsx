// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ConnectorDetail } from '../src/client/ConnectorView.tsx'
import { items, localDetail } from '../src/client/catalog-shared.tsx'
import { zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'

afterEach(cleanup)

const t = (key: DeepSeekHarnessProductKey): string => zh[key]

it('shows tools without a redundant connection section for company connectors', () => {
  const entry = items([{ id: 'crm', name: 'CRM', authMode: 'employee-bearer', tools: [
    { name: 'orders.read', displayName: '查询订单', access: 'READ' },
    { name: 'orders.write', displayName: '更新订单', access: 'WRITE' },
  ] }])[0]!
  render(<ConnectorDetail product={localDetail(entry)} t={t} onCatalogChanged={async () => {}} />)
  expect(screen.queryByRole('heading', { name: zh.connectorConfiguration })).toBeNull()
  expect(screen.getByText(zh.readOnlyLabel, { selector: 'span[data-access="READ"]' })).toBeTruthy()
  expect(screen.getByText(zh.writeLabel, { selector: 'span[data-access="WRITE"]' })).toBeTruthy()
  expect(screen.queryByText(/已配置|就绪|待配置|停用|不可用|已连接/)).toBeNull()
})

it.each([
  { authorizationStatus: 'REQUIRED', action: zh.authorize },
  { authorizationStatus: 'EXPIRED', action: zh.reauthorize },
  { authorizationStatus: 'AUTHORIZED', action: zh.revokeAuthorization },
])('retains the $action action for third-party OAuth', ({ authorizationStatus, action }) => {
  const entry = items([{ id: 'crm', name: 'CRM', authMode: 'oauth', authorizationStatus, tools: [] }])[0]!
  render(<ConnectorDetail product={localDetail(entry)} t={t} onCatalogChanged={async () => {}} />)
  expect(screen.getByRole('button', { name: action })).toBeTruthy()
  expect(screen.queryByText(/已配置|就绪|待配置|停用|不可用|已连接/)).toBeNull()
})

it('offers device configuration only when required by the connector', () => {
  const entry = items([{ id: 'crm', name: 'CRM', authMode: 'none', canConfigure: true, tools: [] }])[0]!
  render(<ConnectorDetail product={localDetail(entry)} t={t} onCatalogChanged={async () => {}} />)
  expect(screen.getByRole('button', { name: zh.configureDevice })).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh.authorize })).toBeNull()
})
