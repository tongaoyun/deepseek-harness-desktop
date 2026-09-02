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
  const monitor: LocalTaskRun['monitor'] = {
    status: 'idle', activity: '等待开始', updatedAt: '2026-08-28T01:00:00Z', steps: [], artifacts: [],
  }

  it('keeps employee histories separate and replaces updated tasks', () => {
    const storage = new MemoryStorage()
    const task: LocalTaskRun = {
      id: 'task-1', source: 'DESKTOP', name: '库存分析', status: 'RUNNING',
      createdAt: '2026-08-28T01:00:00Z', updatedAt: '2026-08-28T01:00:00Z', monitor, messages: [],
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

  it('keeps user-cancelled tasks available for retry', () => {
    const storage = new MemoryStorage()
    const task: LocalTaskRun = {
      id: 'task-cancelled', source: 'DESKTOP', name: '广告诊断', status: 'CANCELED',
      createdAt: '2026-08-28T01:00:00Z', updatedAt: '2026-08-28T01:01:00Z', monitor, messages: [],
    }
    saveLocalTask('employee-1', task, storage)
    expect(loadLocalTasks('employee-1', storage)[0].status).toBe('CANCELED')
  })

  it('persists the structured task monitor independently from response text', () => {
    const storage = new MemoryStorage()
    const task: LocalTaskRun = {
      id: 'task-trace', source: 'DESKTOP', name: '店铺日报', status: 'COMPLETED',
      createdAt: '2026-08-29T01:00:00Z', updatedAt: '2026-08-29T01:01:00Z',
      monitor: {
        status: 'completed', activity: '任务已完成', updatedAt: '2026-08-29T01:01:00Z', artifacts: [], steps: [{
          id: 'tool:call-1', kind: 'tool', label: '查询销售汇总', status: 'completed',
          toolName: 'sales_summary', startedAt: '2026-08-29T01:00:10Z',
          completedAt: '2026-08-29T01:00:11Z',
        }],
      },
      messages: [{ role: 'assistant', text: '分析完成' }],
    }

    saveLocalTask('employee-1', task, storage)

    expect(loadLocalTasks('employee-1', storage)[0].monitor).toEqual(task.monitor)
  })
})
