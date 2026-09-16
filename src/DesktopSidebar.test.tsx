import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { DesktopSidebar } from './DesktopSidebar'
import type { LocalTaskRun } from './types'

const noop = () => undefined
const task: LocalTaskRun = {
  id: 'current', source: 'DESKTOP', name: '分析文档', status: 'COMPLETED',
  createdAt: '', updatedAt: '', entries: [],
  projection: { status: 'idle', activity: '', updatedAt: '', steps: [], artifacts: [] },
}
const props: ComponentProps<typeof DesktopSidebar> = {
  collapsed: false, activeTaskId: task.id, page: 'chat', taskSearchOpen: false,
  taskQuery: '', taskSearchInputRef: { current: null }, tasks: [task], visibleTasks: [task],
  onNewTask: noop, onToggleCollapsed: noop, onToggleSearch: noop, onTaskQuery: noop,
  onCloseSearch: noop, onPage: noop, onOpenTask: noop, onRenameTask: noop,
  onArchiveTask: noop, onDeleteTask: noop, onFeedback: async () => {}, onLogout: async () => {},
}

it('marks the open task as current only on the conversation page', () => {
  const html = renderToStaticMarkup(<DesktopSidebar {...props} />)
  expect(html).toContain('aria-current="true" class="recent-task active"')
  expect(html).toContain('>专家套件</span>')
  expect(html).toContain('>技能</span>')
  expect(html).not.toContain('技能与套件')
  expect(html).not.toContain('session-')
  const catalog = renderToStaticMarkup(<DesktopSidebar {...props} page="skills" />)
  expect(catalog).not.toContain('recent-task active')
  expect(catalog).toContain('aria-current="page" class="nav-item active"')
  const newTask = renderToStaticMarkup(<DesktopSidebar {...props} activeTaskId={undefined} />)
  expect(newTask).not.toContain('recent-task active')
})

it('shows interrupted separately from ordinary task failure', () => {
  const interrupted: LocalTaskRun = { ...task, status: 'FAILED', projection: { ...task.projection, status: 'failed',
    failure: { code: 'XY-INTERRUPTED', category: 'local-agent', detail: '应用退出' },
  } }
  const html = renderToStaticMarkup(<DesktopSidebar {...props} tasks={[interrupted]} visibleTasks={[interrupted]} />)
  expect(html).toContain('>已中断</small>')
  expect(html).not.toContain('>执行失败</small>')
})

it('only shows task/channel tabs and keeps archived tasks accessible through search', () => {
  const archived = { ...task, id: 'archived', name: '已收起的报告', archivedAt: '2026-09-06T00:00:00Z' }
  const data = { ...props, tasks: [archived], visibleTasks: [archived] }
  const html = renderToStaticMarkup(<DesktopSidebar {...data} />)
  expect(html).not.toContain('归档任务')
  expect(html).not.toContain('暂无归档任务')
  expect(html).not.toContain(archived.name)
  const search = renderToStaticMarkup(<DesktopSidebar {...data} taskSearchOpen taskQuery="报告" />)
  expect(search).toContain(archived.name)
})
