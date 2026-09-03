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

  it('renders files as a separate conversation result card', () => {
    const html = renderToStaticMarkup(<TaskArtifacts conversation artifacts={[
      { id: 'a', rootId: 'root', rootName: 'Downloads', path: 'report.xlsx', name: 'report.xlsx', kind: 'spreadsheet', sourceTool: 'office.xlsx.create', createdAt: '2026-09-03T10:00:00.000Z' },
    ]} />)
    expect(html).toContain('处理了 1 个文件')
    expect(html).toContain('report.xlsx')
  })
})
