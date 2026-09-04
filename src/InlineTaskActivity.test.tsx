import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { InlineTaskActivity } from './InlineTaskActivity'
import { TaskArtifacts } from './TaskArtifacts'
import { taskDurationLabel } from './taskTiming'

describe('InlineTaskActivity', () => {
  it('keeps safe execution details inside the chat flow', () => {
    const html = renderToStaticMarkup(<InlineTaskActivity monitor={{
      status: 'running',
      activity: '正在读取已授权目录',
      updatedAt: '2026-09-03T10:00:00.000Z',
      steps: [{ id: '1', kind: 'tool', label: '读取本地目录', status: 'running', toolName: 'local_files_list', startedAt: '2026-09-03T10:00:00.000Z' }],
      timeline: [{ id: '1', kind: 'tool', label: '读取本地目录', status: 'running', toolName: 'local_files_list', occurredAt: '2026-09-03T10:00:00.000Z' }],
      artifacts: [{ id: 'a', rootId: 'root', rootName: 'Downloads', path: 'report.xlsx', name: 'report.xlsx', kind: 'spreadsheet', sourceTool: 'office.xlsx.create', createdAt: '2026-09-03T10:00:00.000Z' }],
    }} />)

    expect(html).toContain('正在处理')
    expect(html).toContain('local_files_list')
    expect(html).not.toContain('Task Monitor')
    expect(html).not.toContain('思考过程')
  })

  it('formats the completed turn duration', () => {
    expect(taskDurationLabel({
      status: 'completed', activity: '任务已完成', startedAt: '2026-09-03T10:00:00.000Z',
      completedAt: '2026-09-03T10:02:07.000Z', updatedAt: '2026-09-03T10:02:07.000Z', steps: [], artifacts: [],
    })).toBe('2分钟7秒')
  })

  it('shows subagent collaboration as compact activity in the same chat turn', () => {
    const html = renderToStaticMarkup(<InlineTaskActivity monitor={{
      status: 'running', activity: '子 Agent 正在处理', updatedAt: '2026-09-03T10:00:01.000Z',
      startedAt: '2026-09-03T10:00:00.000Z', steps: [], artifacts: [],
      subagents: [
        { id: 'one', label: '检查前端', status: 'running', startedAt: '2026-09-03T10:00:00.000Z' },
        { id: 'two', label: '检查后端', status: 'completed', startedAt: '2026-09-03T10:00:00.000Z', completedAt: '2026-09-03T10:00:01.000Z' },
      ],
      timeline: [
        { id: 'one', kind: 'subagent', label: '检查前端', status: 'running', occurredAt: '2026-09-03T10:00:00.000Z' },
        { id: 'two', kind: 'subagent', label: '检查后端', status: 'completed', occurredAt: '2026-09-03T10:00:00.000Z' },
      ],
    }} />)

    expect(html).toContain('2 个协作任务')
    expect(html).toContain('检查前端')
    expect(html).toContain('检查后端')
    expect(html).not.toContain('Task Monitor')
  })

  it('renders files as a separate conversation result card', () => {
    const html = renderToStaticMarkup(<TaskArtifacts conversation artifacts={[
      { id: 'a', rootId: 'root', rootName: 'Downloads', path: 'report.xlsx', name: 'report.xlsx', kind: 'spreadsheet', sourceTool: 'office.xlsx.create', createdAt: '2026-09-03T10:00:00.000Z' },
    ]} />)
    expect(html).toContain('生成了 1 个文件')
    expect(html).toContain('report.xlsx')
  })
})
