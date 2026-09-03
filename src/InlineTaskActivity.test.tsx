import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { InlineTaskActivity } from './InlineTaskActivity'

describe('InlineTaskActivity', () => {
  it('keeps safe execution details and artifacts inside the chat flow', () => {
    const html = renderToStaticMarkup(<InlineTaskActivity monitor={{
      status: 'running',
      activity: '正在读取已授权目录',
      updatedAt: '2026-09-03T10:00:00.000Z',
      steps: [{ id: '1', kind: 'tool', label: '读取本地目录', status: 'running', toolName: 'local_files_list', startedAt: '2026-09-03T10:00:00.000Z' }],
      artifacts: [{ id: 'a', rootId: 'root', rootName: 'Downloads', path: 'report.xlsx', name: 'report.xlsx', kind: 'spreadsheet', sourceTool: 'office.xlsx.create', createdAt: '2026-09-03T10:00:00.000Z' }],
    }} />)

    expect(html).toContain('正在读取已授权目录')
    expect(html).toContain('local_files_list')
    expect(html).toContain('report.xlsx')
    expect(html).not.toContain('Task Monitor')
    expect(html).not.toContain('思考过程')
  })
})
