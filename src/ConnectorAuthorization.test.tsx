// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ConnectorsPage } from './ConnectorsPage'
import type { ConnectorCatalogEntry, ConnectorDiagnosticResult, ConnectorRuntimeDefinition } from './types'

it('offers ERP reauthorization on 401 and rechecks on return without treating 403 as expired login', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const connector: ConnectorCatalogEntry = { id: 'erp', name: 'ERP', summary: '订单', category: 'industry-data', kind: 'managed-mcp', scope: 'organization', status: 'ready', managed: true, version: '1', transport: 'streamable-http', url: 'https://erp.example/mcp', authMode: 'erp-cookie', toolNames: [], environment: {}, headers: {} }
  let status: ConnectorDiagnosticResult['status'] = 'authentication-required'
  const diagnose = vi.fn(async () => ({ id: 'erp', status, latencyMs: 1, discoveredTools: [], missingTools: [], undeclaredTools: [] }))
  const authorize = vi.fn().mockRejectedValueOnce(new Error('登录窗口无法打开')).mockResolvedValue(undefined)
  try {
    await act(async () => root.render(<ConnectorsPage catalog={[connector]} runtime={[{ ...connector, enabled: true } as ConnectorRuntimeDefinition]} catalogError="" syncError="" query="" loading={false} secrets={{}} personalIds={[]} onEdit={vi.fn()} onDelete={vi.fn()} onToggle={vi.fn()} onSaveSecrets={vi.fn()} onDiagnose={diagnose} onReauthorizeErp={authorize} />))
    const authButton = () => [...container.querySelectorAll('button')].find(button => button.textContent === '重新扫码登录')
    expect(authButton()).toBeDefined()
    await act(async () => authButton()!.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('登录窗口无法打开')
    await act(async () => authButton()!.click())
    expect(authorize).toHaveBeenCalledTimes(2)
    status = 'access-denied'
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(diagnose).toHaveBeenCalledTimes(2)
    expect(authButton()).toBeUndefined()
    expect(container.textContent).toContain('无访问权限')
    status = 'ready'
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '重新检测')!.click())
    expect(container.textContent).toContain('连接正常')
  } finally { await act(async () => root.unmount()); container.remove() }
})
