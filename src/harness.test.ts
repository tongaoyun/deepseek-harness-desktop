import { describe, expect, it } from 'vitest'
import { authorizeDroppedPaths, cancelHarness, classifyHarnessFailure, diagnoseConnectors, harnessProjectionUpdate, normalizeHarnessProjection } from './harness'

describe('Harness Session Projection', () => {
  it('accepts the official projection envelope and rejects compact event payloads', () => {
    const update = harnessProjectionUpdate({ requestId: 1, event: { method: 'session.projection', params: { sessionId: 's', key: 'xiaoyin.product', seq: 4, value: { updatedAt: '2026-09-11T00:00:00Z', changes: [], artifacts: [], visuals: [], knowledgeSources: [] } } } })
    expect(update).toMatchObject({ sessionId: 's', key: 'xiaoyin.product', seq: 4 })
    expect(normalizeHarnessProjection(update?.value)?.artifacts).toEqual([])
    expect(harnessProjectionUpdate({ requestId: 1, event: { sessionId: 's', key: 'xiaoyin.product', seq: 4, value: {} } })).toBeUndefined()
  })

  it('normalizes optional Harness metrics and drops unknown wire fields', () => {
    const normalized = normalizeHarnessProjection({
      updatedAt: '2026-09-11T00:00:00Z', changes: [], artifacts: [], visuals: [], knowledgeSources: [],
      privateRawOutput: 'must not persist',
    })
    expect(normalized).toMatchObject({ updatedAt: '2026-09-11T00:00:00Z', artifacts: [], changes: [] })
    expect(JSON.stringify(normalized)).not.toContain('privateRawOutput')
  })

})

it('accepts only explicit structured failure metadata', () => {
  expect(classifyHarnessFailure({ code: 'XY-CONNECTOR-AUTH', category: 'connector', title: '连接器需要重新授权', message: 'ERP 登录已失效', infrastructure: false, retryable: false })).toMatchObject({ code: 'XY-CONNECTOR-AUTH', category: 'connector', retryable: false })
  expect(classifyHarnessFailure({ code: 'XY-CAPACITY', category: 'capacity', title: '模型服务繁忙', message: '稍后重试', infrastructure: false, retryable: true })).toMatchObject({ code: 'XY-CAPACITY', category: 'capacity', retryable: true })
  expect(classifyHarnessFailure('429 rate limit')).toMatchObject({ code: 'XY-UNSTRUCTURED-ERROR', retryable: false })
})

it('keeps cancellation, drops and diagnostics safe outside Tauri', async () => {
  await expect(cancelHarness('missing-task')).resolves.toBe(false)
  await expect(authorizeDroppedPaths([])).resolves.toEqual({ directories: [], attachments: [] })
  await expect(diagnoseConnectors({ employeeId: 'e', connectors: [], sessionToken: 't' })).rejects.toThrow('桌面客户端')
})
