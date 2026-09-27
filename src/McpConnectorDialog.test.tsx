// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { McpConnectorDialog } from './McpConnectorDialog'
import { parseConnectorJson } from './connectorImport'

it('saves the selected ERP login mode when editing an HTTP MCP connector', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const save = vi.fn().mockResolvedValue(undefined)
  const initial = parseConnectorJson(JSON.stringify({ id: 'erp', name: 'ERP', url: 'https://erp.example/mcp' }))
  try {
    await act(async () => root.render(<McpConnectorDialog initial={initial} existingIds={['erp']} onSave={save} onClose={() => {}} />))
    const option = document.querySelector<HTMLOptionElement>('option[value="erp-cookie"]')!
    expect(option.textContent).toBe('ERP 扫码会话')
    const select = option.parentElement as HTMLSelectElement
    await act(async () => { select.value = 'erp-cookie'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ authMode: 'erp-cookie', headers: {}, readOnlyTools: [] }))
  } finally { await act(async () => root.unmount()); container.remove() }
})
