// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ConnectorAccount } from './ConnectorAccount'
import { TaskOperationReview } from './TaskOperationReview'
import { connectorAuthorization } from './connectorAuthorization'
import { invoke } from '@tauri-apps/api/core'
import type { ConnectorRuntimeDefinition } from './types'

vi.mock('./connectorAuthorization', () => ({ connectorAuthorization: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const connector: ConnectorRuntimeDefinition = { id: 'calendar', name: '日历', version: '1', status: 'ready', transport: 'streamable-http', url: 'https://calendar.test/mcp', authMode: 'oauth', enabled: false, toolNames: [] }

it('enables only after authorization succeeds and supports canceling the pending browser flow', async () => {
  const element = document.body.appendChild(document.createElement('div')), root = createRoot(element)
  const connected = vi.fn(), disconnected = vi.fn()
  let cancel!: (error: Error) => void
  vi.mocked(connectorAuthorization).mockImplementation(async (_employee, _connector, action) => {
    if (action === 'status') return { status: 'disconnected' }
    if (action === 'cancel') { cancel(new Error('授权已取消')); return { status: 'canceled' } }
    return new Promise((_, reject) => { cancel = reject })
  })
  try {
    await act(async () => root.render(<ConnectorAccount employeeId="alice" connector={connector} onConnected={connected} onDisconnected={disconnected} />))
    await act(async () => element.querySelector('button')!.click())
    expect(element.textContent).toContain('等待浏览器授权')
    expect(connected).not.toHaveBeenCalled()
    await act(async () => [...element.querySelectorAll('button')].find(button => button.textContent === '取消授权')!.click())
    expect(element.textContent).toContain('授权已取消')
    vi.mocked(connectorAuthorization).mockResolvedValueOnce({ status: 'authorized', scope: 'calendar:read' })
    await act(async () => element.querySelector('button')!.click())
    expect(connected).toHaveBeenCalledOnce()
    expect(element.textContent).toContain('calendar:read')
    vi.mocked(connectorAuthorization).mockResolvedValueOnce({ status: 'disconnected', revoked: false })
    await act(async () => [...element.querySelectorAll('button')].find(button => button.textContent === '断开账户')!.click())
    expect(disconnected).toHaveBeenCalledOnce()
    expect(element.textContent).toContain('服务端授权可在账户的应用管理中撤销')
  } finally { await act(async () => root.unmount()); element.remove() }
})

it('requires evidence before releasing an uncertain write and disables review during execution', async () => {
  const element = document.body.appendChild(document.createElement('div')), root = createRoot(element)
  vi.mocked(invoke).mockResolvedValueOnce([{ id: 'a'.repeat(64), connector: '订单', tool: 'create_order', startedAt: '2026-09-09T00:00:00Z' }]).mockResolvedValue([])
  try {
    await act(async () => root.render(<TaskOperationReview employeeId="alice" taskId="task" revision="1" disabled={false} />))
    await act(async () => [...element.querySelectorAll('button')].find(button => button.textContent === '已确认未执行')!.click())
    expect(element.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    await act(async () => {
      const input = element.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '已查询服务端订单，确认没有生成')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(invoke).toHaveBeenLastCalledWith('task_write_operations', { request: { employeeId: 'alice', taskId: 'task', resolution: { id: 'a'.repeat(64), applied: false, evidence: '已查询服务端订单，确认没有生成' } } })
    expect(element.textContent).toBe('')
    await act(async () => root.render(<TaskOperationReview employeeId="alice" taskId="task" revision="2" disabled />))
    expect(invoke).toHaveBeenCalledTimes(2)
  } finally { await act(async () => root.unmount()); element.remove() }
})
