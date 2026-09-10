import { describe, expect, it } from 'vitest'
import type { ExtensionInvocation } from './extensionInvocations'
import { createTaskMonitor } from './harness'
import { prepareTaskTurn } from './taskTurn'
import type { CapabilitySnapshot, LocalTaskRun } from './types'

const capabilities: CapabilitySnapshot = { createdAt: '2026-09-11T00:00:00Z', extensions: [], connectors: [], knowledgeBaseRefs: [] }
const invocation = (version = '1.0.0'): ExtensionInvocation => ({
  token: '/kit:reports:weekly', kind: 'expert-kit', id: 'reports', name: '周报', description: '生成周报',
  spec: { mode: 'explicit', kind: 'expert-kit', extensionId: 'reports', extensionVersion: version, commandId: 'weekly' },
})

function existingTask(): LocalTaskRun {
  return {
    id: 'task', source: 'DESKTOP', name: '周报', status: 'RUNNING',
    createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z', sessionId: 'existing-session', model: 'model',
    invocationTokens: ['/kit:reports:weekly'], invocationSpecs: [invocation().spec], capabilitySnapshot: capabilities,
    localDirectories: [], monitor: createTaskMonitor(), messages: [],
  }
}

describe('prepareTaskTurn', () => {
  it('keeps UI tokens in task state but sends only employee text to the harness', () => {
    const result = prepareTaskTurn({
      taskId: 'task', input: '/kit:reports:weekly 分析本周数据', now: '2026-09-11T00:00:00Z',
      existingTask: existingTask(), sessionId: 'existing-session', model: 'model', directories: [], directoriesChanged: false,
      connectorIds: [], capabilities, invocations: [invocation()], messages: [], monitor: createTaskMonitor(), attachments: [],
    })
    expect(result.rootSessionId).toBe('existing-session')
    expect(result.harnessPrompt).toBe('分析本周数据')
    expect(result.runningTask.invocationTokens).toEqual(['/kit:reports:weekly'])
    expect(result.runningTask.invocationSpecs).toEqual([invocation().spec])
  })

  it('starts a fresh session when the exact invocation version changes', () => {
    const result = prepareTaskTurn({
      taskId: 'task', input: '/kit:reports:weekly 继续', now: '2026-09-11T00:00:00Z',
      existingTask: existingTask(), sessionId: 'existing-session', model: 'model', directories: [], directoriesChanged: false,
      connectorIds: [], capabilities, invocations: [invocation('2.0.0')],
      messages: [{ role: 'user', text: '/kit:reports:weekly 分析本周数据' }, { role: 'assistant', text: '已分析' }],
      monitor: createTaskMonitor(), attachments: [],
    })
    expect(result.rootSessionId).not.toBe('existing-session')
    expect(result.harnessPrompt).toContain('用户：分析本周数据')
    expect(result.harnessPrompt).not.toContain('/kit:reports')
  })
})
