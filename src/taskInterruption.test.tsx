// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { taskInterruption } from './taskInterruption'
import { TaskRecoveryNotice } from './TaskRecoveryNotice'
import { recoverInterruptedTasks } from './taskHistory'
import { harnessPromptWithConversationReplay } from './conversationReplay'
import { assistantEntry, userEntry } from './conversation/testing'
import { createXiaoyinTaskProjection, classifyHarnessFailure } from './harness'
import type { LocalTaskRun, XiaoyinTaskProjection } from './types'

const checkpoint = '2026-09-08T12:00:00.000Z'
const projection: XiaoyinTaskProjection = { ...createXiaoyinTaskProjection(checkpoint), status: 'running',
  steps: [{ id: 'write', kind: 'tool', label: '提交订单', status: 'running', startedAt: checkpoint }],
  timeline: [{ id: 'write', kind: 'tool', label: '提交订单', toolName: 'mcp__erp__submit', status: 'running', occurredAt: checkpoint },
    { id: 'read', kind: 'tool', label: '读取订单', status: 'completed', occurredAt: checkpoint }],
}

it('preserves uncertain operations in the recovery record and model context', () => {
  const task: LocalTaskRun = { id: 'test', name: '订单任务', source: 'DESKTOP', status: 'RUNNING', createdAt: checkpoint, updatedAt: checkpoint, projection,
    entries: [userEntry('u1', '核对并提交订单'), assistantEntry('turn:1', '已核对价格', {}, 'streaming')] }
  const [recovered] = recoverInterruptedTasks([task], '2026-09-09T12:00:00.000Z')
  expect(recovered.projection.completedAt).toBe(checkpoint)
  expect(recovered.projection.interruption).toEqual({ checkpointAt: checkpoint, cause: 'exit', pendingOperations: [{ id: 'write', label: '提交订单', toolName: 'mcp__erp__submit' }] })
  const replay = harnessPromptWithConversationReplay('继续', recovered.entries, true, recovered.projection)
  expect(replay).toContain('mcp__erp__submit')
  expect(replay).toContain('先用只读方式核对')
  expect(replay).toContain('不能据此断言某操作未发生')
  expect(recoverInterruptedTasks([recovered])[0]).toBe(recovered)
})

it('shows pending operations and blocks resume while another input or run is active', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  const resume = vi.fn()
  const interrupted = { ...projection, interruption: taskInterruption(projection, 'failure') }
  try {
    await act(async () => root.render(<TaskRecoveryNotice projection={interrupted} disabled onResume={resume} />))
    expect(element.textContent).toContain('提交订单')
    expect(element.textContent).toContain('结果待核对')
    await act(async () => element.querySelector('button')!.click())
    expect(resume).not.toHaveBeenCalled()
    await act(async () => root.render(<TaskRecoveryNotice projection={interrupted} disabled={false} onResume={resume} />))
    await act(async () => element.querySelector('button')!.click())
    expect(resume).toHaveBeenCalledOnce()
  } finally { await act(async () => root.unmount()); element.remove() }
})

it('keeps connector authentication separate from model authentication and automatic retries', () => {
  expect(classifyHarnessFailure({ code: 'XY-CONNECTOR-AUTH', category: 'connector', title: '连接器需要重新授权', message: 'ERP 登录已失效', infrastructure: false, retryable: false })).toMatchObject({ code: 'XY-CONNECTOR-AUTH', category: 'connector', retryable: false })
  expect(classifyHarnessFailure({ code: 'XY-AUTH', category: 'authentication', title: '模型认证失败', message: '模型服务认证失败', infrastructure: false, retryable: false }).code).toBe('XY-AUTH')
})

it('keeps an unsettled tool in the recovery record', () => {
  // The Harness projection settles running tools on turn/end; an unknown tool
  // result still leaves its receipt for the employee to reconcile.
  const ended = { ...projection, steps: projection.steps.map((step) => step.status === 'running' ? { ...step, status: 'canceled' as const } : step) }
  expect(ended.steps[0]?.status).toBe('canceled')
  expect(taskInterruption(ended, 'failure').pendingOperations).toEqual([
    { id: 'write', label: '提交订单', toolName: 'mcp__erp__submit' },
  ])
})

it('uses detailed file and connector timeline entries instead of generic step labels', () => {
  const record = taskInterruption({ ...projection, timeline: [
    { id: 'write', kind: 'connector', label: '提交订单 XY-001', toolName: 'mcp__erp__submit', status: 'running', occurredAt: checkpoint },
    { id: 'file', kind: 'file', label: '写入 receipt.md', toolName: 'local_files_write_text', status: 'running', occurredAt: checkpoint },
  ] }, 'exit')
  expect(record.pendingOperations).toEqual([
    { id: 'write', label: '提交订单 XY-001', toolName: 'mcp__erp__submit' },
    { id: 'file', label: '写入 receipt.md', toolName: 'local_files_write_text' },
  ])
})
