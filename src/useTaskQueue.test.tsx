// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readTaskQueues, useTaskQueue } from './useTaskQueue'
import type { LocalTaskRun } from './types'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
    removeItem: (key: string) => { values.delete(key) },
    clear: () => values.clear(),
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const task = (id: string, status: LocalTaskRun['status'] = 'COMPLETED') => ({ id, status, model: `model-${id}`, messages: [{ role: 'user', text: `context-${id}` }], monitor: { status: 'completed' } }) as LocalTaskRun

async function fixture(check: (controls: { queue: () => ReturnType<typeof useTaskQueue>; render: (changes: Partial<Parameters<typeof useTaskQueue>[0]>) => Promise<void> }) => Promise<void>) {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let current: ReturnType<typeof useTaskQueue>
  let props: Parameters<typeof useTaskQueue>[0] = { owner: 'employee', ready: false, tasks: [task('a'), task('b')], runningIds: [], run: async (_task, _item, accepted) => { accepted(); return 'completed' } }
  function Host(input: typeof props) { current = useTaskQueue(input); return null }
  const render = async (changes: Partial<ComponentProps<typeof Host>>) => { props = { ...props, ...changes }; await act(async () => root.render(<Host {...props} />)) }
  try { await render({}); await check({ queue: () => current, render }) }
  finally { await act(async () => root.unmount()); container.remove() }
}

it('runs queued messages exactly once in FIFO order with their original task context', async () => {
  await fixture(async ({ queue, render }) => {
    await act(async () => { queue().enqueue('a', '第一条'); queue().enqueue('a', '第二条'); queue().enqueue('b', '另一个任务') })
    const run = vi.fn(async (_task, _item, accepted) => { accepted(); return 'completed' as const })
    await render({ ready: true, run })
    expect(run.mock.calls.map(([task, item]) => [task.id, item.text, task.model])).toEqual([['a', '第一条', 'model-a'], ['a', '第二条', 'model-a'], ['b', '另一个任务', 'model-b']])
    expect(queue().queues).toEqual({})
  })
})

it('waits while a task runs and pauses remaining messages after a failed turn', async () => {
  await fixture(async ({ queue, render }) => {
    const run = vi.fn(async (_task, _item, accepted) => { accepted(); return 'failed' as const })
    await act(async () => { queue().enqueue('a', '第一条'); queue().enqueue('a', '保留这条') })
    await render({ ready: true, runningIds: ['a'], tasks: [task('a', 'RUNNING')], run })
    expect(run).not.toHaveBeenCalled()
    await render({ runningIds: [], tasks: [task('a')] })
    expect(run).toHaveBeenCalledOnce()
    expect(queue().queues.a).toMatchObject({ paused: true, items: [{ text: '保留这条' }] })
    await render({ tasks: [task('a', 'FAILED')] })
    expect(run).toHaveBeenCalledOnce()
  })
})

it('keeps blocked messages for editing and supports remove and resume', async () => {
  await fixture(async ({ queue, render }) => {
    await act(async () => { queue().enqueue('a', '工作目录尚未选择') })
    const blocked = vi.fn(async () => 'blocked' as const)
    await render({ ready: true, run: blocked })
    expect(queue().queues.a.paused).toBe(true)
    const id = queue().queues.a.items[0].id
    await act(async () => { queue().edit('a', id, '只回答问题') })
    const run = vi.fn(async (_task, _item, accepted) => { accepted(); return 'completed' as const })
    await render({ run })
    expect(run).not.toHaveBeenCalled()
    await act(async () => { queue().resume('a') })
    expect(run.mock.calls[0][1].text).toBe('只回答问题')
    await render({ ready: false })
    await act(async () => { queue().enqueue('a', '删除我') })
    await act(async () => { queue().remove('a', queue().queues.a.items[0].id) })
    expect(queue().queues.a).toBeUndefined()
  })
})

it('restores queues paused and never crosses employee boundaries', async () => {
  window.localStorage.setItem('xiaoyin:task-queue:employee', JSON.stringify({ a: { paused: false, items: [{ id: 'old', text: '恢复消息' }] } }))
  expect(readTaskQueues('employee').a.paused).toBe(true)
  await fixture(async ({ queue, render }) => {
    const run = vi.fn(async () => 'completed' as const)
    await render({ ready: true, run })
    expect(run).not.toHaveBeenCalled()
    await render({ owner: 'another' })
    expect(queue().queues).toEqual({})
    expect(readTaskQueues('employee').a.items[0].text).toBe('恢复消息')
  })
})

it('honors cancellation or editing while a queued request is still preparing', async () => {
  await fixture(async ({ queue, render }) => {
    let accept: () => void = () => {}
    let finish: (result: 'blocked') => void = () => {}
    await act(async () => { queue().enqueue('a', '准备中') })
    await render({ ready: true, run: async (_task, _item, accepted) => { accept = accepted; return new Promise((resolve) => { finish = resolve }) } })
    await act(async () => { queue().pause('a') })
    expect(accept).toThrow('队列已调整')
    await act(async () => { finish('blocked') })
    expect(queue().queues.a.items).toHaveLength(1)
  })
})

it('reports persistence errors and does not claim that a message was queued', async () => {
  await fixture(async ({ queue }) => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
    await act(async () => { expect(queue().enqueue('a', '不能丢失')).toBe(false) })
    expect(queue().queues).toEqual({})
    expect(queue().error).toContain('保存失败')
  })
})

it('pauses existing items on storage failure and does not silently resume after storage recovers', async () => {
  await fixture(async ({ queue, render }) => {
    await act(async () => { queue().enqueue('a', '保留的要求') })
    const persist = vi.spyOn(window.localStorage, 'setItem')
    persist.mockImplementationOnce(() => { throw new Error('quota') })
    const run = vi.fn(async (_task, _item, accepted) => { accepted(); return 'completed' as const })
    await render({ ready: true, run })
    expect(run).toHaveBeenCalledOnce()
    expect(queue().queues.a).toMatchObject({ paused: true, items: [{ text: '保留的要求' }] })
    await act(async () => { queue().enqueue('a', '恢复后追加') })
    expect(run).toHaveBeenCalledOnce()
    await act(async () => { queue().resume('a') })
    expect(run).toHaveBeenCalledTimes(3)
    expect(queue().queues).toEqual({})
  })
})

it('does not drain archived tasks or exceed the foreground concurrency limit', async () => {
  await fixture(async ({ queue, render }) => {
    await act(async () => { queue().enqueue('a', '等待空闲') })
    const run = vi.fn(async (_task, _item, accepted) => { accepted(); return 'completed' as const })
    await render({ ready: true, runningIds: ['b', 'c', 'd'], run })
    expect(run).not.toHaveBeenCalled()
    await render({ runningIds: [], tasks: [{ ...task('a'), archivedAt: '2026-09-05' }] })
    expect(run).not.toHaveBeenCalled()
    await render({ tasks: [task('a')] })
    expect(run).toHaveBeenCalledOnce()
  })
})
