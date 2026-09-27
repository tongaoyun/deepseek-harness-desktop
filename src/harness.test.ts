import { describe, expect, it } from 'vitest'
import { authorizeDroppedPaths, cancelHarness, classifyHarnessFailure, diagnoseConnectors, harnessProjectionUpdate, normalizeHarnessProjection } from './harness'

describe('Harness Session Projection', () => {
  it('accepts the official projection envelope and rejects compact event payloads', () => {
    const update = harnessProjectionUpdate({ requestId: 1, event: { method: 'session.projection', params: { sessionId: 's', key: 'xiaoyin.product', seq: 4, value: { status: 'running', activity: '处理', updatedAt: '2026-09-11T00:00:00Z', steps: [], artifacts: [] } } } })
    expect(update).toMatchObject({ sessionId: 's', key: 'xiaoyin.product', seq: 4 })
    expect(normalizeHarnessProjection(update?.value)?.status).toBe('running')
    expect(harnessProjectionUpdate({ requestId: 1, event: { sessionId: 's', key: 'xiaoyin.product', seq: 4, value: {} } })).toBeUndefined()
  })

  it('normalizes optional Harness metrics and drops unknown wire fields', () => {
    const normalized = normalizeHarnessProjection({
      status: 'completed', activity: '完成', updatedAt: '2026-09-11T00:00:00Z', executionStarted: true,
      steps: [], artifacts: [], tokenUsage: { uncachedInputTokens: 12, outputTokens: 5, cacheReadTokens: -1 },
      contextPressure: { contextWindow: 1000, projectedTokens: 1200 }, outputRetention: { prunedResults: 2, omittedTokens: 80 },
      compactions: 3, privateRawOutput: 'must not persist',
    })
    expect(normalized).toMatchObject({
      tokenUsage: { uncachedInputTokens: 12, outputTokens: 5 },
      contextPressure: { contextWindow: 1000, projectedTokens: 1200 },
      outputRetention: { prunedResults: 2, omittedTokens: 80 }, compactions: 3,
    })
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
