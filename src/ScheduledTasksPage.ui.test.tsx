// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ScheduledTasksPage } from './ScheduledTasksPage'
import type { LocalSchedule } from './localSchedules'

// These tests cover controls and focus, not calendar scanning. Real cron and
// timezone behavior is covered separately in cronPreview.test.ts.
vi.mock('./cronPreview', () => ({ nextCronRuns: vi.fn(() => [new Date('2026-10-01T01:00:00Z')]) }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it('matches the creation controls and closes a popup with Escape before closing the dialog', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const create = vi.fn(), refresh = vi.fn()
  try {
    await act(async () => root.render(<ScheduledTasksPage local={{ items: [], error: '', action: vi.fn(), save: vi.fn(), refresh }} onCreateWithXiaoyin={create} onOpenLocalTask={() => {}} />))
    expect(container.querySelector('.schedule-server-note .schedule-wake')).not.toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('.schedule-create-with-ai')!.click())
    expect(create).toHaveBeenCalledOnce()
    await act(async () => container.querySelector<HTMLButtonElement>('.schedule-refresh')!.click())
    expect(refresh).toHaveBeenCalledOnce()
    await act(async () => container.querySelector<HTMLButtonElement>('.schedule-new-button')!.click())
    const choose = async (label: string) => act(async () => {
      const menu = container.querySelector('[role="menu"][aria-label="执行频率"]')!
      ;[...menu.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!.click()
    })
    expect([...container.querySelectorAll('[role="menu"][aria-label="执行频率"] button')].map((o) => o.textContent)).toEqual(['不重复', '间隔', '每小时', '每天', '每周', '每月', '自定义'])
    await choose('间隔')
    expect(container.querySelector<HTMLInputElement>('[aria-label="间隔分钟"]')!.value).toBe('30')
    await choose('每周')
    expect(container.querySelectorAll('.schedule-weekdays [aria-pressed=true]')).toHaveLength(5)
    await choose('每月')
    expect(container.querySelectorAll('.schedule-month-picker .schedule-date-grid button')).toHaveLength(31)
    await choose('不重复')
    expect(container.querySelector('[aria-label="执行日期"]')).not.toBeNull()
    await choose('自定义')
    expect(container.querySelector<HTMLInputElement>('[aria-label="时区"]')!.value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    const details = container.querySelector<HTMLDetailsElement>('.schedule-frequency')!
    await act(async () => { details.open = true; details.querySelector('summary')!.focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(details.open).toBe(false)
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() }
})

it('keeps run/delete in the more menu, confirms deletion and filters execution records', async () => {
  const at = '2026-09-06T01:00:00Z'
  const items: LocalSchedule[] = [{ id: 'a', name: '周报', prompt: '整理报告', cronExpression: '0 9 * * 1', timeZone: 'Asia/Shanghai', directories: [], active: false, createdAt: at, nextAt: at,
    runs: [{ id: 'done', taskId: 'task-a', status: 'COMPLETED', scheduledAt: at, startedAt: at }, { id: 'failed', status: 'FAILED', scheduledAt: at, startedAt: at }] }]
  const action = vi.fn(async () => {})
  const open = vi.fn()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ScheduledTasksPage local={{ items, error: '', action, save: vi.fn(), refresh: vi.fn() }} onCreateWithXiaoyin={() => {}} onOpenLocalTask={open} />))
    expect(container.querySelector('.local-schedule-actions')).toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('.schedule-card-more .danger')!.click())
    expect(action).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLButtonElement>('.schedule-delete-dialog .danger')!.click())
    expect(action).toHaveBeenCalledWith('a', 'delete')
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role=tab]')].find((b) => b.textContent === '执行记录')!.click())
    expect(container.querySelectorAll('.schedule-execution-page article')).toHaveLength(2)
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role=menu][aria-label="按状态筛选"] button')].find((b) => b.textContent === '成功')!.click())
    expect(container.querySelectorAll('.schedule-execution-page article')).toHaveLength(1)
    await act(async () => container.querySelector<HTMLButtonElement>('.schedule-execution-page article button')!.click())
    expect(open).toHaveBeenCalledWith('task-a')
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.schedule-record-grouping button')].find((b) => b.textContent === '按月')!.click())
    expect(container.querySelector('.schedule-execution-page h3')!.textContent).toBe('2026 年 9 月')
  } finally { await act(async () => root.unmount()); container.remove() }
})
