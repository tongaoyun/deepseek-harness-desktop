import { expect, it, vi } from 'vitest'
import { submitAuditEvent } from './api'
import { reportTaskAudit } from './taskAudit'
vi.mock('./api', () => ({ submitAuditEvent: vi.fn(async () => {}) }))
it('reports user cancellation as canceled rather than failed', async () => {
  await reportTaskAudit({ sessionToken: 'test', employeeId: 'employee', endpoint: '/audit', taskId: 'task', outcome: 'CANCELED' })
  expect(submitAuditEvent).toHaveBeenCalledWith('/audit', 'employee', 'test', expect.objectContaining({ outcome: 'CANCELED', summary: '用户已停止本轮桌面任务' }))
})
