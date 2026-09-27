import { describe, expect, it } from 'vitest'
import { assistantEntry, userEntry } from './conversation/testing'
import type { ExtensionInvocation } from './extensionInvocations'
import { createXiaoyinTaskProjection } from './harness'
import { prepareTaskTurn } from './taskTurn'
import type { CapabilitySnapshot, LocalTaskRun } from './types'

const capability = (version = '1.0.0'): CapabilitySnapshot => ({
  schemaVersion: 2, createdAt: '2026-09-11T00:00:00Z', localTools: [],
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
    localDirectories: [], projection: createXiaoyinTaskProjection(), entries: [],
  }
}

describe('prepareTaskTurn', () => {
  it('starts elapsed time at the current message instead of the previous turn', () => {
    const result = prepareTaskTurn({
      taskId: 'task', input: '第二次提问', now: '2026-09-15T01:00:00Z', existingTask: existingTask(),
      sessionId: 'existing-session', model: 'model', directories: [], directoriesChanged: false,
      capabilities, invocations: [], entries: [userEntry('u1', '第一次提问')],
      projection: { ...createXiaoyinTaskProjection('2026-09-14T00:00:00Z'), status: 'completed', startedAt: '2026-09-14T00:00:00Z', completedAt: '2026-09-14T00:01:00Z' }, attachments: [],
    })
    expect(result.runningProjection.startedAt).toBe('2026-09-15T01:00:00Z')
  })

  it('pins reasoning effort without rebuilding the session when the effort changes', () => {
    const result = prepareTaskTurn({
      taskId: 'task', input: '继续', now: '2026-09-15T00:00:00Z',
      existingTask: { ...existingTask(), reasoningEffort: 'medium' }, sessionId: 'existing-session', model: 'model', reasoningEffort: 'ultra',
      directories: [], directoriesChanged: false, capabilities, invocations: [],
      entries: [userEntry('u1', '原来的问题')], projection: createXiaoyinTaskProjection(), attachments: [],
    })
    expect(result.runningTask.reasoningEffort).toBe('ultra')
    // A reasoning switch restarts the host process and resumes the same
    // session, so the conversation continues instead of being replayed.
    expect(result.rootSessionId).toBe('existing-session')
    expect(result.harnessPrompt).toBe('继续')
  })
  it('keeps UI tokens in task state but sends only employee text to the harness', () => {
    const result = prepareTaskTurn({
      taskId: 'task', input: '/kit:reports:weekly 分析本周数据', now: '2026-09-11T00:00:00Z',
      existingTask: existingTask(), sessionId: 'existing-session', model: 'model', directories: [], directoriesChanged: false,
      capabilities, invocations: [invocation()], entries: [], projection: createXiaoyinTaskProjection(), attachments: [],
    })
    expect(result.rootSessionId).toBe('existing-session')
    expect(result.harnessPrompt).toBe('分析本周数据')
    expect(result.runningTask.invocationTokens).toEqual(['/kit:reports:weekly'])
    expect(result.runningTask.capabilitySnapshot?.selections).toEqual([invocation().selection])
    expect(result.pendingEntries.at(-1)).toMatchObject({ role: 'assistant', status: 'streaming' })
  })

  it('keeps the session when the capability set changes', () => {
    const result = prepareTaskTurn({
      taskId: 'task', input: '/kit:reports:weekly 继续', now: '2026-09-11T00:00:00Z',
      existingTask: existingTask(), sessionId: 'existing-session', model: 'model', directories: [], directoriesChanged: false,
      capabilities: capability('2.0.0'), invocations: [invocation('2.0.0')],
      entries: [userEntry('user-1', '/kit:reports:weekly 分析本周数据'), assistantEntry('turn-1', '已分析')],
      projection: createXiaoyinTaskProjection(), attachments: [],
    })
    // A capability change restarts the host process and resumes the session;
    // the conversation is not flattened into a replayed prompt.
    expect(result.rootSessionId).toBe('existing-session')
    expect(result.harnessPrompt).toBe('继续')
    expect(result.harnessPrompt).not.toContain('/kit:reports')
  })

  it('carries schedule references into the durable task', () => {
    const result = prepareTaskTurn({
      taskId: 'scheduled-task', input: '生成日报', now: '2026-09-11T00:00:00Z', sessionId: '', model: 'model',
      scheduleId: 'schedule-1', scheduleRunId: 'run-1', directories: [], directoriesChanged: false,
      capabilities, invocations: [], entries: [], projection: createXiaoyinTaskProjection(), attachments: [],
    })
    expect(result.runningTask).toMatchObject({ scheduleId: 'schedule-1', scheduleRunId: 'run-1' })
  })

  it('keeps the session when only the model or reasoning effort changes', () => {
    const result = prepareTaskTurn({
      taskId: 'task', input: '继续', now: '2026-09-11T00:00:00Z',
      existingTask: existingTask(), sessionId: 'existing-session', model: 'other-model', reasoningEffort: 'high',
      directories: [], directoriesChanged: false, capabilities, invocations: [], entries: [],
      projection: createXiaoyinTaskProjection(), attachments: [],
    })
    // The host process restarts on the new model; the Harness session resumes.
    expect(result.rootSessionId).toBe('existing-session')
    expect(result.harnessPrompt).toBe('继续')
  })

  it('keeps the session after a failed or stopped turn instead of replaying the conversation', () => {
    for (const status of ['failed', 'canceled'] as const) {
      const result = prepareTaskTurn({
        taskId: 'task', input: '继续', now: '2026-09-11T00:00:00Z',
        existingTask: existingTask(), sessionId: 'existing-session', model: 'model',
        directories: [], directoriesChanged: false, capabilities, invocations: [], entries: [userEntry('u1', '之前的要求')],
        projection: { ...createXiaoyinTaskProjection(), status }, attachments: [],
      })
      expect(result.rootSessionId).toBe('existing-session')
      expect(result.harnessPrompt).toBe('继续')
    }
  })

  it('rebuilds the session when the authorized workspace changes', () => {
    const result = prepareTaskTurn({
      taskId: 'task', input: '继续', now: '2026-09-11T00:00:00Z',
      existingTask: existingTask(), sessionId: 'existing-session', model: 'model',
      directories: [], directoriesChanged: true, capabilities, invocations: [], entries: [userEntry('u1', '之前的要求')],
      projection: createXiaoyinTaskProjection(), attachments: [],
    })
    expect(result.rootSessionId).not.toBe('existing-session')
    expect(result.harnessPrompt).toContain('之前的要求')
  })

  it('records the context a turn ran with so the transcript can show it', () => {
    const result = prepareTaskTurn({
      taskId: 'task', input: '查一下库存', now: '2026-09-11T00:00:00Z',
      existingTask: existingTask(), sessionId: 'existing-session', model: 'model', directories: [], directoriesChanged: false,
      capabilities: { ...capabilities, requestedKnowledgeBaseRefs: ['team:kb'], connectors: [{ id: 'erp-mcp', name: 'erp-mcp' }] } as never,
      invocations: [], entries: [], projection: createXiaoyinTaskProjection(), attachments: [],
    })
    expect(result.runningTask.entries[0]).toMatchObject({
      role: 'user', text: '查一下库存',
      context: { knowledgeRefs: ['team:kb'], connectors: [{ id: 'erp-mcp', name: 'erp-mcp' }] },
    })
  })

  it('pins a queued message ID in the durable transcript for crash reconciliation', () => {
    const result = prepareTaskTurn({
      taskId: 'task', input: '排队继续', queuedItemId: 'queue-item-1', now: '2026-09-11T00:00:00Z',
      existingTask: existingTask(), sessionId: 'existing-session', model: 'model', directories: [], directoriesChanged: false,
      capabilities, invocations: [], entries: [], projection: createXiaoyinTaskProjection(), attachments: [],
    })
    expect(result.runningTask.entries[0]).toMatchObject({ role: 'user', id: 'queue-item-1', text: '排队继续' })
  })
})
