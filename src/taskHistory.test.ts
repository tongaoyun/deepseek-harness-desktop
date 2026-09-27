import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectHarnessSessionSearch, compactTaskForStorage, loadLocalTasks, loadTaskById, loadTaskHistory, loadTaskHistoryPage, persistCapabilityNotice, recoverInterruptedTasks, saveLocalTask } from './taskHistory'
import { assistantEntry, entryText, lastEntryText, userEntry } from './conversation/testing'
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
  afterEach(() => vi.unstubAllGlobals())
  const projection: LocalTaskRun['projection'] = {
    status: 'idle', activity: '等待开始', updatedAt: '2026-08-28T01:00:00Z', steps: [], changes: [], artifacts: [], visuals: [], knowledgeSources: [],
  }

  it('follows official session search cursors and stops on a repeated cursor', async () => {
    const calls: Array<string | undefined> = []
    const pages = new Map<string | undefined, { items: Array<{ sessionId: string; excerpt: string; updatedAt: string }>; nextCursor?: string }>([
      [undefined, { items: [{ sessionId: 'one', excerpt: '一', updatedAt: '' }], nextCursor: 'page-2' }],
      ['page-2', { items: [{ sessionId: 'two', excerpt: '二', updatedAt: '' }], nextCursor: 'page-3' }],
      ['page-3', { items: [{ sessionId: 'three', excerpt: '三', updatedAt: '' }], nextCursor: 'page-3' }],
    ])
    const items = await collectHarnessSessionSearch(async (cursor) => {
      calls.push(cursor)
      return pages.get(cursor) ?? { items: [] }
    })
    expect(items.map((item) => item.sessionId)).toEqual(['one', 'two', 'three'])
    expect(calls).toEqual([undefined, 'page-2', 'page-3'])
  })

  it('caps cursor pagination without requesting an unnecessary extra page', async () => {
    const calls: Array<string | undefined> = []
    const items = await collectHarnessSessionSearch(async (cursor) => {
      calls.push(cursor)
      return {
        items: Array.from({ length: 3 }, (_, index) => ({ sessionId: `${cursor ?? 'first'}-${index}`, excerpt: '', updatedAt: '' })),
        nextCursor: cursor ? 'later' : 'next',
      }
    }, 4)
    expect(items).toHaveLength(4)
    expect(calls).toEqual([undefined, 'next'])
  })

  it('restarts once when Harness invalidates a cursor after an index generation change', async () => {
    const calls: Array<string | undefined> = []
    let stale = true
    const items = await collectHarnessSessionSearch(async (cursor) => {
      calls.push(cursor)
      if (cursor === 'next' && stale) {
        stale = false
        throw new Error('session-search cursor is stale because its relevant corpus changed')
      }
      return cursor ? { items: [{ sessionId: 'second', excerpt: '', updatedAt: '' }] } : {
        items: [{ sessionId: 'first', excerpt: '', updatedAt: '' }], nextCursor: 'next',
      }
    })
    expect(items.map((item) => item.sessionId)).toEqual(['first', 'second'])
    expect(calls).toEqual([undefined, 'next', undefined, 'next'])
  })

  it('keeps employee histories separate and replaces updated tasks', () => {
    const storage = new MemoryStorage()
    const task: LocalTaskRun = {
      id: 'task-1', source: 'DESKTOP', name: '库存分析', status: 'RUNNING',
      createdAt: '2026-08-28T01:00:00Z', updatedAt: '2026-08-28T01:00:00Z', lastOpenedAt: '2026-08-28T01:00:30Z', projection, entries: [],
    }
    saveLocalTask('employee-1', task, storage)
    saveLocalTask('employee-1', { ...task, status: 'COMPLETED', updatedAt: '2026-08-28T01:01:00Z' }, storage)

    expect(loadLocalTasks('employee-1', storage)).toHaveLength(1)
    expect(loadLocalTasks('employee-1', storage)[0].status).toBe('COMPLETED')
    expect(loadLocalTasks('employee-1', storage)[0].lastOpenedAt).toBe('2026-08-28T01:00:30Z')
    expect(loadLocalTasks('employee-2', storage)).toEqual([])
  })

  it('keeps an immediately written notice when a stale browser checkpoint follows', () => {
    const storage = new MemoryStorage()
    const task: LocalTaskRun = { id: 'notice', source: 'DESKTOP', name: '告警任务', status: 'RUNNING',
      createdAt: '2026-09-12', updatedAt: '2026-09-12', sessionId: 'session-1', projection, entries: [] }
    saveLocalTask('employee-1', task, storage)
    const notice = { sessionId: 'session-1', turnId: 'pending', segment: {
      kind: 'notice' as const, id: 'notice:knowledge:scope', level: 'warning' as const, text: '范围无效',
    } }
    saveLocalTask('employee-1', { ...task, capabilityNotices: [notice] }, storage)
    saveLocalTask('employee-1', { ...task, status: 'COMPLETED' }, storage)
    expect(loadLocalTasks('employee-1', storage)[0].capabilityNotices).toEqual([notice])
    saveLocalTask('employee-1', { ...task, sessionId: 'session-2' }, storage)
    expect(loadLocalTasks('employee-1', storage)[0].capabilityNotices).toBeUndefined()
  })

  it('compacts model text while keeping a durable answer and mid-turn supplement', () => {
    const storage = new MemoryStorage()
    const task: LocalTaskRun = { id: 'interactive', source: 'DESKTOP', name: '交互验收', status: 'COMPLETED',
      createdAt: '2026-09-18', updatedAt: '2026-09-18', sessionId: 'session-1',
      projection: { ...projection, executionStarted: true },
      entries: [userEntry('u1', '计算'), assistantEntry('turn:1', [
        { kind: 'question', id: 'question:q1', questionId: 'q1', label: '需要你的回答', status: 'completed',
          questions: [{ id: 'number', question: '哪个数？' }], answers: [{ id: 'number', selected: [], custom: '58' }] },
        { kind: 'user', id: 'steer:1', text: '再检查' },
        { kind: 'text', id: 'answer', text: '58 + 7 = 65' },
      ], {}, 'completed')],
    }
    saveLocalTask('employee-1', task, storage)
    const compacted = loadLocalTasks('employee-1', storage)[0]
    expect(compacted.entries).toEqual([])
    expect(compacted.interactionSegments?.map((item) => item.segment.kind)).toEqual(['question', 'user'])
    saveLocalTask('employee-1', { ...task, entries: [] }, storage)
    expect(loadLocalTasks('employee-1', storage)[0].interactionSegments).toEqual(compacted.interactionSegments)
  })

  it('restores an immediately written browser notice after restart on all history paths', async () => {
    const storage = new MemoryStorage()
    const notice = { sessionId: 'session-browser', turnId: 'pending', segment: {
      kind: 'notice' as const, id: 'notice:connector:erp', level: 'warning' as const, text: '连接失败',
    } }
    const task: LocalTaskRun = { id: 'browser-notice', source: 'DESKTOP', name: '告警任务', status: 'RUNNING',
      createdAt: '2026-09-12', updatedAt: '2026-09-12', sessionId: notice.sessionId, projection,
      entries: [userEntry('u1', '查询订单'), assistantEntry('pending', [], {}, 'streaming')] }
    saveLocalTask('employee-1', task, storage)
    vi.stubGlobal('window', { localStorage: storage })
    await persistCapabilityNotice('employee-1', task.id, notice)

    const opened = await loadTaskById('employee-1', task.id)
    const listed = (await loadTaskHistory('employee-1')).tasks[0]
    const paged = (await loadTaskHistoryPage('employee-1')).items[0]
    for (const restored of [opened, listed, paged]) {
      expect(restored?.status).toBe('FAILED')
      expect(restored?.entries.at(-1)).toMatchObject({ segments: expect.arrayContaining([notice.segment, expect.objectContaining({ kind: 'text', text: expect.stringContaining('上次任务') })]) })
    }

    saveLocalTask('employee-1', { ...task, projection: { ...projection, executionStarted: true }, capabilityNotices: [notice] }, storage)
    const compacted = await loadTaskById('employee-1', task.id)
    expect(compacted?.entries[0]).toMatchObject({ segments: [notice.segment, { kind: 'text', text: expect.stringContaining('上次任务') }] })
  })

  it('does not overwrite malformed persisted history when saving another task', () => {
    const storage = new MemoryStorage()
    storage.setItem('xiaoyin.task-history.employee-1', '{broken')
    expect(() => loadLocalTasks('employee-1', storage)).toThrow('原始数据已保留')
    expect(() => saveLocalTask('employee-1', {
      id: 'new', source: 'DESKTOP', name: '新任务', status: 'COMPLETED',
      createdAt: '', updatedAt: '', projection, entries: [],
    }, storage)).toThrow('不会覆盖')
    expect(storage.getItem('xiaoyin.task-history.employee-1')).toBe('{broken')
  })

  it('keeps user-cancelled tasks available for retry', () => {
    const storage = new MemoryStorage()
    const task: LocalTaskRun = {
      id: 'task-cancelled', source: 'DESKTOP', name: '广告诊断', status: 'CANCELED',
      createdAt: '2026-08-28T01:00:00Z', updatedAt: '2026-08-28T01:01:00Z', projection, entries: [],
    }
    saveLocalTask('employee-1', task, storage)
    expect(loadLocalTasks('employee-1', storage)[0].status).toBe('CANCELED')
  })

  it('searches the local Harness session and selected capability tokens', async () => {
    const storage = new MemoryStorage()
    const task: LocalTaskRun = {
      id: 'task-session-search', source: 'DESKTOP', name: '日报', status: 'COMPLETED',
      createdAt: '2026-08-28T01:00:00Z', updatedAt: '2026-08-28T01:01:00Z', projection, entries: [],
      sessionId: 'session-harness-42', invocationTokens: ['/kit:finance', 'skill:invoice-check'],
    }
    saveLocalTask('employee-1', task, storage)
    vi.stubGlobal('window', { localStorage: storage })
    await expect(loadTaskHistoryPage('employee-1', 'harness-42')).resolves.toMatchObject({ items: [{ id: task.id }] })
    await expect(loadTaskHistoryPage('employee-1', 'invoice-check')).resolves.toMatchObject({ items: [{ id: task.id }] })
  })

  it('persists the structured task projection independently from response text', () => {
    const storage = new MemoryStorage()
    const task: LocalTaskRun = {
      id: 'task-trace', source: 'DESKTOP', name: '店铺日报', status: 'COMPLETED',
      createdAt: '2026-08-29T01:00:00Z', updatedAt: '2026-08-29T01:01:00Z',
      projection: {
        status: 'completed', activity: '任务已完成', updatedAt: '2026-08-29T01:01:00Z', changes: [], artifacts: [], visuals: [], knowledgeSources: [], steps: [],
      },
      entries: [assistantEntry('turn-1', '分析完成')],
    }

    saveLocalTask('employee-1', task, storage)

    const stored = JSON.parse(storage.getItem('xiaoyin.task-history.employee-1')!)
    expect(Object.hasOwn(stored[0], 'execution')).toBe(false)
    expect(stored[0]?.projection).toEqual(task.projection)
    expect(loadLocalTasks('employee-1', storage)[0].projection).toEqual(task.projection)
  })

  it('rejects a corrupted projection cache instead of rebuilding it from the desktop execution tree', () => {
    const storage = new MemoryStorage()
    const stale = { ...projection, updatedAt: '2026-09-11T00:00:00Z' }
    saveLocalTask('employee-1', {
      id: 'canonical', source: 'DESKTOP', name: '事件事实源', status: 'COMPLETED',
      createdAt: '2026-09-11T01:00:00Z', updatedAt: '2026-09-11T01:01:00Z',
      projection: stale, entries: [assistantEntry('turn-1', '完成')],
    }, storage)
    const persisted = JSON.parse(storage.getItem('xiaoyin.task-history.employee-1')!)
    persisted[0].projection = { stale: true }
    storage.setItem('xiaoyin.task-history.employee-1', JSON.stringify(persisted))

    expect(() => loadLocalTasks('employee-1', storage)).toThrow('本地历史无法读取')
  })

  it('round trips official completed turn metadata', () => {
    const storage = new MemoryStorage()
    const finishedProjection: LocalTaskRun['projection'] = { ...projection, status: 'completed' }
    const task: LocalTaskRun = { id: 'awaiting', source: 'DESKTOP', name: '销售报告', status: 'COMPLETED',
      createdAt: '2026-09-07', updatedAt: '2026-09-07', projection: finishedProjection,
      entries: [assistantEntry('turn-1', '报告已生成', { completedAt: '2026-09-07T00:00:10Z' })],
    }
    saveLocalTask('employee-1', task, storage)
    const [restored] = recoverInterruptedTasks(loadLocalTasks('employee-1', storage))
    expect(restored?.projection.status).toBe('completed')
    expect(restored?.entries[0]).toMatchObject({ meta: { completedAt: '2026-09-07T00:00:10Z' } })
  })

  it('turns tasks left running by an app exit into retryable failures', () => {
    const task: LocalTaskRun = {
      id: 'task-interrupted', source: 'DESKTOP', name: '整理下载目录', status: 'RUNNING',
      createdAt: '2026-08-29T01:00:00Z', updatedAt: '2026-08-29T01:00:01Z',
      projection: { status: 'running', activity: '正在读取文件', updatedAt: '2026-08-29T01:00:01Z', changes: [], artifacts: [], visuals: [], knowledgeSources: [], steps: [
        { id: 'tool:1', kind: 'tool', label: '读取文件', status: 'running', startedAt: '2026-08-29T01:00:01Z' },
      ] },
      sessionId: 'interrupted-session',
      entries: [userEntry('turn-1', '整理下载目录'), assistantEntry('turn-2', '已检查第一份报表', {}, 'streaming')],
    }

    const [recovered] = recoverInterruptedTasks([task], '2026-08-29T01:05:00Z')

    expect(recovered?.status).toBe('FAILED')
    expect(recovered?.projection.status).toBe('failed')
    expect(recovered?.projection.failure?.code).toBe('XY-INTERRUPTED')
    expect(recovered?.projection.interruption?.pendingOperations).toEqual([])
    const last = recovered?.entries.at(-1)
    expect(last?.role).toBe('assistant')
    expect(last).toMatchObject({ status: 'failed' })
    expect(entryText(last)).toContain('已检查第一份报表')
    expect(entryText(last)).toContain('不要重复已经完成的操作')
    expect(recovered?.sessionId).toBe('interrupted-session')
  })

  it('preserves the initial requirement and all execution traces in long histories', () => {
    const task: LocalTaskRun = {
      id: 'long', source: 'DESKTOP', name: '长任务', status: 'COMPLETED',
      createdAt: '2026-08-29T01:00:00Z', updatedAt: '2026-08-29T01:01:00Z', projection,
      entries: Array.from({ length: 140 }, (_, index) => index % 2
        ? assistantEntry(`turn-${index}`, `消息 ${index}`) : userEntry(`turn-${index}`, `消息 ${index}`)),
    }
    const compacted = compactTaskForStorage(task)
    expect(compacted.entries).toHaveLength(140)
    expect(entryText(compacted.entries[0])).toBe('消息 0')
    expect(compacted).toEqual(task)
    expect(lastEntryText(compacted.entries)).toBe('消息 139')
  })

  it('does not evict older or archived tasks when saving beyond 200 records', () => {
    const storage = new MemoryStorage()
    const task = (index: number): LocalTaskRun => ({
      id: String(index), source: 'DESKTOP', name: '任务', status: 'COMPLETED',
      createdAt: '2026-09-01', updatedAt: '2026-09-01', archivedAt: index === 0 ? '2026-09-01' : undefined,
      projection, entries: [userEntry('turn-1', '原始要求' + (index === 0 ? '长'.repeat(250_000) : ''))],
    })
    // Start just before the boundary; exercise real saves across and beyond it.
    // Avoid rewriting the same large history 199 times merely to arrange the fixture.
    storage.setItem('xiaoyin.task-history.employee-1', JSON.stringify(Array.from({ length: 199 }, (_, index) => task(index))))
    for (let index = 199; index < 205; index++) saveLocalTask('employee-1', task(index), storage)
    expect(loadLocalTasks('employee-1', storage)).toHaveLength(205)
    expect(entryText(loadLocalTasks('employee-1', storage).find((task) => task.id === '0')?.entries[0])).toHaveLength(250_004)
    expect(loadLocalTasks('employee-1', storage).find((task) => task.id === '0')?.archivedAt).toBe('2026-09-01')
  })

  it('preserves Harness usage and compaction projections while recovering an interrupted task', () => {
    const task: LocalTaskRun = {
      id: 'harness-projection', source: 'DESKTOP', name: '任务', status: 'RUNNING',
      createdAt: '2026-09-11T00:00:00Z', updatedAt: '2026-09-11T00:01:00Z',
      projection: {
        ...projection,
        status: 'running',
        tokenUsage: { uncachedInputTokens: 120, outputTokens: 30, cacheReadTokens: 4, cacheWriteTokens: 2 },
        contextPressure: { contextWindow: 1000, pressureTokens: 120, projectedTokens: 180 },
        outputRetention: { prunedResults: 3, omittedTokens: 900 },
        compactions: 2,
      },
      entries: [],
    }
    const [recovered] = recoverInterruptedTasks([task], '2026-09-12T00:00:00Z')
    expect(recovered?.projection).toMatchObject({
      tokenUsage: task.projection.tokenUsage,
      contextPressure: task.projection.contextPressure,
      outputRetention: task.projection.outputRetention,
      compactions: 2,
      status: 'failed',
    })
  })
})
