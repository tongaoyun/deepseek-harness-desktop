import { describe, expect, it } from 'vitest'
import { loadLocalTasks, saveLocalTask } from './taskHistory'
import type { LocalTaskRun } from './types'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

describe('task history', () => {
  it('keeps employee histories separate and replaces updated tasks', () => {
    const storage = new MemoryStorage()
    const task: LocalTaskRun = {
      id: 'task-1', source: 'DESKTOP', name: '库存分析', status: 'RUNNING',
      createdAt: '2026-08-28T01:00:00Z', updatedAt: '2026-08-28T01:00:00Z', messages: [],
    }
    saveLocalTask('employee-1', task, storage)
    saveLocalTask('employee-1', { ...task, status: 'COMPLETED', updatedAt: '2026-08-28T01:01:00Z' }, storage)

    expect(loadLocalTasks('employee-1', storage)).toHaveLength(1)
    expect(loadLocalTasks('employee-1', storage)[0].status).toBe('COMPLETED')
    expect(loadLocalTasks('employee-2', storage)).toEqual([])
  })

  it('ignores malformed persisted data', () => {
    const storage = new MemoryStorage()
    storage.setItem('xiaoyin.task-history.employee-1', '{broken')
    expect(loadLocalTasks('employee-1', storage)).toEqual([])
  })

  it('persists the safe execution timeline with the assistant message', () => {
    const storage = new MemoryStorage()
    const task: LocalTaskRun = {
      id: 'task-trace', source: 'DESKTOP', name: '店铺日报', status: 'COMPLETED',
      createdAt: '2026-08-29T01:00:00Z', updatedAt: '2026-08-29T01:01:00Z',
      messages: [{
        role: 'assistant', text: '分析完成', executionSteps: [{
          id: 'tool:call-1', kind: 'tool', label: '查询销售汇总', status: 'completed',
          toolName: 'sales_summary', startedAt: '2026-08-29T01:00:10Z',
          completedAt: '2026-08-29T01:00:11Z',
        }],
      }],
    }

    saveLocalTask('employee-1', task, storage)

    expect(loadLocalTasks('employee-1', storage)[0].messages[0].executionSteps)
      .toEqual(task.messages[0].executionSteps)
  })
})
