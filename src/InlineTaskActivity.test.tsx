import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FileChangesCard } from './FileChangesCard'
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

    expect(html).toContain('已处理')
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

  it('shows subagent collaboration in the Codex-style execution stream', () => {
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

    expect(html).toContain('检查前端开始工作')
    expect(html).toContain('检查后端已完成')
    expect(html).not.toContain('个协作任务')
    expect(html).not.toContain('Task Monitor')
  })

  it('keeps a completed execution stream expanded and labels elapsed time like Codex', () => {
    const html = renderToStaticMarkup(<InlineTaskActivity monitor={{
      status: 'completed', activity: '任务已完成', startedAt: '2026-09-03T10:00:00.000Z',
      completedAt: '2026-09-03T10:02:07.000Z', updatedAt: '2026-09-03T10:02:07.000Z', steps: [], artifacts: [],
      timeline: [{ id: 'command', kind: 'command', label: '运行命令', status: 'completed', toolName: 'bash', text: 'pnpm test', occurredAt: '2026-09-03T10:01:00.000Z' }],
    }} />)
    expect(html).toContain('用时 2分钟7秒')
    expect(html).toContain('运行了命令')
    expect(html).toContain('pnpm test')
  })

  it('renders a real file change summary with line counts', () => {
    const html = renderToStaticMarkup(<FileChangesCard changes={[
      { id: '1', rootId: 'root', rootName: 'repo', path: 'src/App.tsx', name: 'App.tsx', sourceTool: 'local_files_write_text', action: 'updated', addedLines: 12, deletedLines: 3, changedAt: '2026-09-03T10:00:00.000Z' },
      { id: '2', rootId: 'root', rootName: 'repo', path: 'src/new.ts', name: 'new.ts', sourceTool: 'local_files_write_text', action: 'created', addedLines: 8, deletedLines: 0, changedAt: '2026-09-03T10:00:01.000Z' },
    ]} />)
    expect(html).toContain('已编辑 2 个文件')
    expect(html).toContain('+20')
    expect(html).toContain('-3')
    expect(html).toContain('src/App.tsx')
  })

  it('renders files as a separate conversation result card', () => {
    const html = renderToStaticMarkup(<TaskArtifacts conversation artifacts={[
      { id: 'a', rootId: 'root', rootName: 'Downloads', path: 'report.xlsx', name: 'report.xlsx', kind: 'spreadsheet', sourceTool: 'office.xlsx.create', createdAt: '2026-09-03T10:00:00.000Z' },
    ]} />)
    expect(html).toContain('生成了 1 个文件')
    expect(html).toContain('report.xlsx')
  })
})
