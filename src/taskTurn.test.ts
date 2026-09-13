import { describe, expect, it } from 'vitest'
import type { ExtensionInvocation } from './extensionInvocations'
import { createXiaoyinTaskProjection } from './harness'
import { prepareTaskTurn } from './taskTurn'
import type { CapabilitySnapshot, LocalTaskRun } from './types'

const capability = (version = '1.0.0'): CapabilitySnapshot => ({
  schemaVersion: 1, createdAt: '2026-09-11T00:00:00Z',
  selections: [{ mode: 'explicit', kind: 'expert-kit', extensionId: 'reports', extensionVersion: version, commandId: 'weekly' }],
  artifacts: [{ kind: 'expert-kit', id: 'reports', version, sha256: 'a'.repeat(64) }],
  implicitArtifacts: [],
  requestedConnectorIds: [], connectors: [], requestedKnowledgeBaseRefs: [], knowledgeBaseRefs: [],
})
const capabilities = capability()
const invocation = (version = '1.0.0'): ExtensionInvocation => ({
  token: '/kit:reports:weekly', kind: 'expert-kit', id: 'reports', name: '周报', description: '生成周报',
  selection: { mode: 'explicit', kind: 'expert-kit', extensionId: 'reports', extensionVersion: version, commandId: 'weekly' },
})

function existingTask(): LocalTaskRun {
  return {
    id: 'task', source: 'DESKTOP', name: '周报', status: 'RUNNING',
    createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z', sessionId: 'existing-session', model: 'model',
    invocationTokens: ['/kit:reports:weekly'], capabilitySnapshot: capabilities,
    localDirectories: [], projection: createXiaoyinTaskProjection(), messages: [],
  }
}

describe('prepareTaskTurn', () => {
  it('keeps UI tokens in task state but sends only employee text to the harness', () => {
    const result = prepareTaskTurn({
      taskId: 'task', input: '/kit:reports:weekly 分析本周数据', now: '2026-09-11T00:00:00Z',
      existingTask: existingTask(), sessionId: 'existing-session', model: 'model', directories: [], directoriesChanged: false,
      capabilities, invocations: [invocation()], messages: [], projection: createXiaoyinTaskProjection(), attachments: [],
    })
    expect(result.rootSessionId).toBe('existing-session')
    expect(result.harnessPrompt).toBe('分析本周数据')
    expect(result.runningTask.invocationTokens).toEqual(['/kit:reports:weekly'])
    expect(result.runningTask.capabilitySnapshot?.selections).toEqual([invocation().selection])
    expect(result.pendingMessages.at(-1)?.pending).toBe(true)
  })

  it('starts a fresh session when the exact invocation version changes', () => {
    const result = prepareTaskTurn({
      taskId: 'task', input: '/kit:reports:weekly 继续', now: '2026-09-11T00:00:00Z',
      existingTask: existingTask(), sessionId: 'existing-session', model: 'model', directories: [], directoriesChanged: false,
      capabilities: capability('2.0.0'), invocations: [invocation('2.0.0')],
      messages: [{ role: 'user', text: '/kit:reports:weekly 分析本周数据' }, { role: 'assistant', text: '已分析' }],
      projection: createXiaoyinTaskProjection(), attachments: [],
    })
    expect(result.rootSessionId).not.toBe('existing-session')
    expect(result.harnessPrompt).toContain('用户：分析本周数据')
    expect(result.harnessPrompt).not.toContain('/kit:reports')
  })

  it('carries schedule references into the durable task', () => {
    const result = prepareTaskTurn({
      taskId: 'scheduled-task', input: '生成日报', now: '2026-09-11T00:00:00Z', sessionId: '', model: 'model',
      scheduleId: 'schedule-1', scheduleRunId: 'run-1', directories: [], directoriesChanged: false,
      capabilities, invocations: [], messages: [], projection: createXiaoyinTaskProjection(), attachments: [],
    })
    expect(result.runningTask).toMatchObject({ scheduleId: 'schedule-1', scheduleRunId: 'run-1' })
  })

  it('pins a queued message ID in the durable transcript for crash reconciliation', () => {
    const result = prepareTaskTurn({
      taskId: 'task', input: '排队继续', queuedItemId: 'queue-item-1', now: '2026-09-11T00:00:00Z',
      existingTask: existingTask(), sessionId: 'existing-session', model: 'model', directories: [], directoriesChanged: false,
      capabilities, invocations: [], messages: [], projection: createXiaoyinTaskProjection(), attachments: [],
    })
    expect(result.runningTask.messages[0]).toMatchObject({ role: 'user', id: 'queue-item-1', text: '排队继续' })
  })
})
