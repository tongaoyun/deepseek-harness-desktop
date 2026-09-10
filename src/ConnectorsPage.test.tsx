// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectorsPage } from './ConnectorsPage'
import type { ConnectorCatalogEntry, ConnectorRuntimeDefinition } from './types'

const catalog: ConnectorCatalogEntry = {
  id: 'crm', name: 'CRM', summary: '客户系统', category: 'project-management', kind: 'managed-mcp', scope: 'organization',
  status: 'ready', managed: false, version: '1', transport: 'stdio', command: 'node', arguments: ['server.js'],
  url: '', authMode: 'none', toolNames: [], environment: { CRM_TOKEN: '' }, headers: {},
}

describe('connector local configuration', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div')
    document.body.append(container)
  })

  afterEach(() => container.remove())

  it('shows catalog errors without also claiming that no connectors were configured', async () => {
    const root = createRoot(container)
    await act(async () => root.render(<ConnectorsPage
      catalog={[]} catalogError="连接器同步失败，正在显示最近一次可用内容。" loading={false} query="" syncError=""
      personalIds={[]} onEdit={vi.fn()} onDelete={vi.fn()} onDiagnose={vi.fn()} runtime={[]} secrets={{}}
      onToggle={vi.fn()} onSaveSecrets={vi.fn()} />))
    expect(container.textContent).toContain('连接器同步失败')
    expect(container.textContent).not.toContain('控制中心尚未配置连接器')
    await act(async () => root.unmount())
  })

  it('asks for required local values before enabling the connector', async () => {
    const onToggle = vi.fn()
    const onSaveSecrets = vi.fn()
    const root = createRoot(container)
    await act(async () => root.render(<ConnectorsPage
      catalog={[catalog]}
      catalogError=""
      loading={false}
      query=""
      onDiagnose={async () => undefined}
      onSaveSecrets={onSaveSecrets}
      onToggle={onToggle}
      personalIds={['crm']}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      runtime={[{ ...catalog, status: 'needs-configuration', enabled: false } as ConnectorRuntimeDefinition]}
      secrets={{}}
      syncError=""
    />))

    await act(async () => container.querySelector<HTMLButtonElement>('.connector-card-name')!.click())
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toContain('CRM')
    const enable = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '为我启用')!
    await act(async () => enable.click())
    expect(container.textContent).toContain('值只保存在当前员工的这台设备')

    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'local-secret')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '保存并启用')!
    await act(async () => save.click())

    expect(onSaveSecrets).toHaveBeenCalledWith('crm', { environment: { CRM_TOKEN: 'local-secret' }, headers: {} })
    expect(onToggle).toHaveBeenCalledWith('crm', true)
    await act(async () => root.unmount())
  })

  it('keeps the dialog open and does not enable when saving credentials fails', async () => {
    const onToggle = vi.fn()
    const root = createRoot(container)
    await act(async () => root.render(<ConnectorsPage catalog={[catalog]} catalogError="" loading={false} query="" syncError=""
      personalIds={['crm']} onEdit={vi.fn()} onDelete={vi.fn()} onDiagnose={vi.fn()}
      runtime={[{ ...catalog, enabled: false } as ConnectorRuntimeDefinition]} secrets={{}}
      onToggle={onToggle} onSaveSecrets={async () => { throw new Error('无法保存配置') }} />))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="启用连接器"]')!.click())
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'token')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    expect(onToggle).not.toHaveBeenCalled()
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(container.textContent).toContain('无法保存配置')
    await act(async () => root.unmount())
  })

  it('discards stale checks after config changes and keeps disabled personal connectors manageable', async () => {
    const results: Array<(value: import('./types').ConnectorDiagnosticResult) => void> = []
    const onDiagnose = vi.fn(() => new Promise<import('./types').ConnectorDiagnosticResult>((resolve) => results.push(resolve)))
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    const root = createRoot(container)
    const render = async (command: string, enabled = true) => act(async () => root.render(<ConnectorsPage
      catalog={[{ ...catalog, command, environment: {} }]} catalogError="" loading={false} query="" syncError=""
      personalIds={['crm']} onEdit={onEdit} onDelete={onDelete} onDiagnose={onDiagnose}
      runtime={[{ ...catalog, command, environment: {}, enabled } as ConnectorRuntimeDefinition]} secrets={{}}
      onToggle={vi.fn()} onSaveSecrets={vi.fn()} />))
    await render('node')
    expect(container.textContent).toContain('正在连接')
    await render('python')
    const result = { id: 'crm', status: 'ready' as const, latencyMs: 5, discoveredTools: ['new-tool'], missingTools: [], undeclaredTools: [] }
    await act(async () => results[1]!(result))
    expect(container.textContent).toContain('连接正常')
    await act(async () => results[0]!({ ...result, discoveredTools: ['old-tool'] }))
    expect(container.textContent).toContain('new-tool')
    expect(container.textContent).not.toContain('old-tool')
    await render('python', false)
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent?.startsWith('已添加'))!.click())
    expect(container.textContent).toContain('已关闭')
    expect(container.textContent).not.toContain('连接正常')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="编辑 CRM"]')!.click())
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'crm' }))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="删除 CRM"]')!.click())
    expect(onDelete).toHaveBeenCalledWith('crm')
    await act(async () => root.unmount())
  })

  it.each([['authentication-required', '待授权'], ['access-denied', '无访问权限']] as const)('shows %s separately from connection failure', async (status, label) => {
    const root = createRoot(container)
    try {
      await act(async () => root.render(<ConnectorsPage
        catalog={[{ ...catalog, environment: {} }]} catalogError="" loading={false} query="" syncError=""
        personalIds={['crm']} onEdit={vi.fn()} onDelete={vi.fn()}
        onDiagnose={async () => ({ id: 'crm', status, latencyMs: 10, discoveredTools: [], missingTools: [], undeclaredTools: [] })}
        runtime={[{ ...catalog, environment: {}, enabled: true } as ConnectorRuntimeDefinition]} secrets={{}}
        onToggle={vi.fn()} onSaveSecrets={vi.fn()} />))
      expect(container.querySelector('.connector-health')?.textContent).toContain(label)
      expect(container.querySelector('.connector-health')?.textContent).not.toContain('连接失败')
      expect(container.textContent).not.toContain('服务没有返回工具')
    } finally { await act(async () => root.unmount()) }
  })
})
