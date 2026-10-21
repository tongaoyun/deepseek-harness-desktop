// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ConnectorStatus, isConnectorConfigured } from '../src/client/catalog-shared.tsx'
import { ConnectorDetail } from '../src/client/ConnectorView.tsx'
import { items, localDetail } from '../src/client/catalog-shared.tsx'
import { zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'

afterEach(cleanup)

const t = (key: DeepSeekHarnessProductKey): string => zh[key]

it.each([
  { status: 'ready', ready: true, authMode: 'employee-bearer', authorizationStatus: 'AUTHORIZED', label: zh.connectorConfigured, configured: true },
  { status: 'disabled', ready: false, authMode: 'employee-bearer', authorizationStatus: 'AUTHORIZED', label: zh.statusDisabled, configured: false },
  { status: 'unavailable', ready: false, authMode: 'none', authorizationStatus: 'AUTHORIZED', label: zh.statusUnavailable, configured: false },
  { status: 'ready', ready: false, authMode: 'oauth', authorizationStatus: 'REQUIRED', label: zh.connectorAccountRequired, configured: false },
  { status: 'ready', ready: false, authMode: 'oauth', authorizationStatus: 'EXPIRED', label: zh.connectorAccountExpired, configured: false },
  { status: 'needs-configuration', ready: false, authMode: 'none', authorizationStatus: 'AUTHORIZED', label: zh.statusNeedsConfiguration, configured: false },
  { status: 'ready', ready: false, authMode: 'none', authorizationStatus: 'AUTHORIZED', label: zh.statusUnavailable, configured: false },
])('shows $label without claiming a live connection', (connector) => {
  render(<ConnectorStatus connector={connector} t={t} />)
  expect(screen.getByText(connector.label)).toBeTruthy()
  expect(screen.queryByText('已连接')).toBeNull()
  expect(isConnectorConfigured(connector)).toBe(connector.configured)
})

it.each(['disabled', 'unavailable'])('does not suggest reconnecting an account while the service is %s', (status) => {
  const entry = items([{ id: 'crm', name: 'CRM', status, authMode: 'oauth', authorizationStatus: 'REQUIRED', tools: [] }])[0]!
  render(<ConnectorDetail product={localDetail(entry)} t={t} onCatalogChanged={async () => {}} />)
  expect(screen.queryByRole('button', { name: zh.authorize })).toBeNull()
  expect(screen.getByText(status === 'disabled' ? zh.statusDisabled : zh.statusUnavailable)).toBeTruthy()
})
