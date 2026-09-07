import { describe, expect, it } from 'vitest'
import { compactTaskForStorage, loadLocalTasks, recoverInterruptedTasks, saveLocalTask } from './taskHistory'
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

  it('does not overwrite malformed persisted history when saving another task', () => {
    const storage = new MemoryStorage()
    storage.setItem('xiaoyin.task-history.employee-1', '{broken')
    expect(() => loadLocalTasks('employee-1', storage)).toThrow('原始数据已保留')
    expect(() => saveLocalTask('employee-1', {
      id: 'new', source: 'DESKTOP', name: '新任务', status: 'COMPLETED',
      createdAt: '', updatedAt: '', monitor, messages: [],
    }, storage)).toThrow('不会覆盖')
    expect(storage.getItem('xiaoyin.task-history.employee-1')).toBe('{broken')
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

  it('turns tasks left running by an app exit into retryable failures', () => {
    const task: LocalTaskRun = {
      id: 'task-interrupted', source: 'DESKTOP', name: '整理下载目录', status: 'RUNNING',
      createdAt: '2026-08-29T01:00:00Z', updatedAt: '2026-08-29T01:00:01Z',
      monitor: { status: 'running', activity: '正在读取文件', updatedAt: '2026-08-29T01:00:01Z', artifacts: [], steps: [
        { id: 'tool:1', kind: 'tool', label: '读取文件', status: 'running', startedAt: '2026-08-29T01:00:01Z' },
      ] },
      sessionId: 'interrupted-session',
      messages: [{ role: 'user', text: '整理下载目录' }, { role: 'assistant', text: '已检查第一份报表', pending: true }],
    }

    const [recovered] = recoverInterruptedTasks([task], '2026-08-29T01:05:00Z')

    expect(recovered?.status).toBe('FAILED')
    expect(recovered?.monitor.status).toBe('failed')
    expect(recovered?.monitor.failure?.code).toBe('XY-INTERRUPTED')
    expect(recovered?.monitor.steps[0]?.status).toBe('failed')
    expect(recovered?.messages.at(-1)?.role).toBe('assistant')
    expect(recovered?.messages.at(-1)?.pending).toBeUndefined()
    expect(recovered?.messages.at(-1)?.text).toContain('已检查第一份报表')
    expect(recovered?.messages.at(-1)?.text).toContain('不要重复已经完成的操作')
    expect(recovered?.sessionId).toBeUndefined()
  })

  it('preserves the initial requirement and all execution traces in long histories', () => {
    const task: LocalTaskRun = {
      id: 'long', source: 'DESKTOP', name: '长任务', status: 'COMPLETED',
      createdAt: '2026-08-29T01:00:00Z', updatedAt: '2026-08-29T01:01:00Z', monitor,
      messages: Array.from({ length: 140 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, text: `消息 ${index}` })),
    }
    const compacted = compactTaskForStorage(task)
    expect(compacted.messages).toHaveLength(140)
    expect(compacted.messages[0]?.text).toBe('消息 0')
    expect(compacted).toEqual(task)
    expect(compacted.messages.at(-1)?.text).toBe('消息 139')
  })

  it('does not evict older or archived tasks when saving beyond 200 records', () => {
    const storage = new MemoryStorage()
    const task = (index: number): LocalTaskRun => ({
      id: String(index), source: 'DESKTOP', name: '任务', status: 'COMPLETED',
      createdAt: '2026-09-01', updatedAt: '2026-09-01', archivedAt: index === 0 ? '2026-09-01' : undefined,
      monitor, messages: [{ role: 'user', text: '原始要求' + (index === 0 ? '长'.repeat(250_000) : '') }],
    })
    // Start just before the boundary; exercise real saves across and beyond it.
    // Avoid rewriting the same large history 199 times merely to arrange the fixture.
    storage.setItem('xiaoyin.task-history.employee-1', JSON.stringify(Array.from({ length: 199 }, (_, index) => task(index))))
    for (let index = 199; index < 205; index++) saveLocalTask('employee-1', task(index), storage)
    expect(loadLocalTasks('employee-1', storage)).toHaveLength(205)
    expect(loadLocalTasks('employee-1', storage).find((task) => task.id === '0')?.messages[0].text).toHaveLength(250_004)
    expect(loadLocalTasks('employee-1', storage).find((task) => task.id === '0')?.archivedAt).toBe('2026-09-01')
  })
})
