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

  it('asks for required local values before enabling the connector', async () => {
    const onToggle = vi.fn()
    const onSaveSecrets = vi.fn()
    const root = createRoot(container)
    await act(async () => root.render(<ConnectorsPage
      accessToken="token"
      catalog={[catalog]}
      catalogError=""
      loading={false}
      onSaveSecrets={onSaveSecrets}
      onToggle={onToggle}
      runtime={[{ ...catalog, enabled: false } as ConnectorRuntimeDefinition]}
      secrets={{}}
      syncError=""
    />))

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
})
