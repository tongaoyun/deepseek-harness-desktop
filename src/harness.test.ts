import { describe, expect, it } from 'vitest'
import { authorizeDroppedPaths, cancelHarness, classifyHarnessFailure, diagnoseConnectors, harnessProjectionUpdate, normalizeHarnessProjection } from './harness'

describe('Harness Session Projection', () => {
  it('accepts the official projection envelope and rejects compact event payloads', () => {
    const update = harnessProjectionUpdate({ requestId: 1, event: { method: 'session.projection', params: { sessionId: 's', key: 'xiaoyin.task', seq: 4, value: { status: 'running', activity: '处理', updatedAt: '2026-09-11T00:00:00Z', steps: [], artifacts: [] } } } })
    expect(update).toMatchObject({ sessionId: 's', key: 'xiaoyin.task', seq: 4 })
    expect(normalizeHarnessProjection(update?.value)?.status).toBe('running')
    expect(harnessProjectionUpdate({ requestId: 1, event: { sessionId: 's', key: 'xiaoyin.task', seq: 4, value: {} } })).toBeUndefined()
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

it('classifies failures by their real cause instead of a generic retry', () => {
  expect(classifyHarnessFailure('[XY-CONNECTOR-AUTH] ERP：401 Unauthorized')).toMatchObject({ code: 'XY-CONNECTOR-AUTH', category: 'connector', retryable: false })
  expect(classifyHarnessFailure('model 401 Unauthorized').code).toBe('XY-AUTH')
  expect(classifyHarnessFailure('429 rate limit').category).toBe('capacity')
  expect(classifyHarnessFailure('Harness Host ECONNRESET').category).toBe('local-agent')
  expect(classifyHarnessFailure('任务执行超过 15 分钟').category).toBe('timeout')
})

it('keeps cancellation, drops and diagnostics safe outside Tauri', async () => {
  await expect(cancelHarness('missing-task')).resolves.toBe(false)
  await expect(authorizeDroppedPaths([])).resolves.toEqual({ directories: [], attachments: [] })
  await expect(diagnoseConnectors({ employeeId: 'e', connectors: [], accessToken: 't' })).rejects.toThrow('桌面客户端')
})
