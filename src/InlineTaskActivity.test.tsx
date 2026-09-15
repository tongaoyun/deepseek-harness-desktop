import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FileChangesCard } from './FileChangesCard'
import { InlineTaskActivity } from './InlineTaskActivity'
import { TaskArtifacts } from './TaskArtifacts'
import { taskDurationLabel } from './taskTiming'

describe('InlineTaskActivity', () => {
  it('distinguishes an interrupted run from tool failure and does not count offline time as execution', () => {
    const html = renderToStaticMarkup(<InlineTaskActivity projection={{
      status: 'failed', activity: '上次运行已中断', updatedAt: '2026-09-06T01:00:00Z',
      startedAt: '2026-09-05T01:00:00Z', completedAt: '2026-09-06T01:00:00Z',
      failure: { code: 'XY-INTERRUPTED', category: 'local-agent', detail: '应用退出' }, steps: [], artifacts: [],
    }} />)
    expect(html).toContain('上次运行已中断')
    expect(html).not.toContain('处理失败')
    expect(html).not.toContain('用时')
  })
  it('keeps safe execution details inside the chat flow', () => {
    const html = renderToStaticMarkup(<InlineTaskActivity projection={{
      status: 'running',
      activity: '正在读取已授权目录',
      updatedAt: '2026-09-03T10:00:00.000Z',
      steps: [{ id: '1', kind: 'tool', label: '读取本地目录', status: 'running', toolName: 'local_files_list', startedAt: '2026-09-03T10:00:00.000Z' }],
      timeline: [{ id: '1', kind: 'tool', label: '读取本地目录', status: 'running', toolName: 'local_files_list', occurredAt: '2026-09-03T10:00:00.000Z' }],
      artifacts: [{ id: 'a', rootId: 'root', rootName: 'Downloads', path: 'report.xlsx', name: 'report.xlsx', kind: 'spreadsheet', sourceTool: 'office.xlsx.create', createdAt: '2026-09-03T10:00:00.000Z' }],
    }} />)

    expect(html).toContain('正在读取已授权目录')
    expect(html).toContain('local_files_list')
    expect(html).not.toContain('Task Projection')
    expect(html).not.toContain('思考过程')
  })

  it('formats the completed turn duration', () => {
    expect(taskDurationLabel({
      status: 'completed', activity: '任务已完成', startedAt: '2026-09-03T10:00:00.000Z',
      completedAt: '2026-09-03T10:02:07.000Z', updatedAt: '2026-09-03T10:02:07.000Z', steps: [], artifacts: [],
    })).toBe('2分钟7秒')
  })

  it('shows elapsed time when a completed turn has no execution details', () => {
    const projection = { status: 'completed' as const, activity: '任务已完成', executionStarted: true, startedAt: '2026-09-03T10:00:00.000Z', completedAt: '2026-09-03T10:00:02.000Z', updatedAt: '2026-09-03T10:00:02.000Z', steps: [], artifacts: [], outcome: { status: 'completed' as const, summary: '完成', remaining: [], checks: [] } }
    const html = renderToStaticMarkup(<InlineTaskActivity projection={projection} />)
    expect(html).toContain('执行过程 · 用时 2秒')
  })

  it('shows subagent collaboration in the Codex-style execution stream', () => {
    const html = renderToStaticMarkup(<InlineTaskActivity projection={{
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
    expect(html).not.toContain('Task Projection')
  })

  it('collapses a completed execution stream and retains elapsed time', () => {
    const html = renderToStaticMarkup(<InlineTaskActivity projection={{
      status: 'completed', activity: '任务已完成', startedAt: '2026-09-03T10:00:00.000Z',
      completedAt: '2026-09-03T10:02:07.000Z', updatedAt: '2026-09-03T10:02:07.000Z', steps: [], artifacts: [],
      timeline: [{ id: 'command', kind: 'command', label: '运行命令', status: 'completed', toolName: 'bash', text: 'pnpm test', occurredAt: '2026-09-03T10:01:00.000Z' }],
    }} />)
    expect(html).toContain('用时 2分钟7秒')
    expect(html).toContain('执行过程')
    expect(html).not.toContain('已完成')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('pnpm test')
  })

  it('shows elapsed time above an ordinary answer', () => {
    const html = renderToStaticMarkup(<InlineTaskActivity finalResponse="我是小胤。" projection={{
      status: 'completed', activity: '已完成', startedAt: '2026-09-03T10:00:00.000Z',
      completedAt: '2026-09-03T10:00:01.000Z', updatedAt: '2026-09-03T10:00:01.000Z',
      outcome: { status: 'completed', summary: '已回答', remaining: [], checks: [] }, steps: [], artifacts: [],
    }} />)
    expect(html).toContain('执行过程 · 用时 1秒')
  })

  it('does not expose startup internals in the conversation', () => {
    const html = renderToStaticMarkup(<InlineTaskActivity projection={{ status: 'running', activity: '正在启动本地 Agent', updatedAt: '', steps: [], artifacts: [] }} />)
    expect(html).toContain('正在处理')
    expect(html).not.toContain('启动本地 Agent')
  })

  it('shows a compact summary when Harness prunes tool results', () => {
    const html = renderToStaticMarkup(<InlineTaskActivity projection={{
      status: 'completed', activity: '任务已完成', updatedAt: '2026-09-03T10:00:01.000Z', steps: [], artifacts: [],
      outputRetention: { prunedResults: 2, omittedTokens: 2400 },
      timeline: [{ id: 'retention:1', kind: 'tool', label: '裁剪工具结果', status: 'completed', occurredAt: '2026-09-03T10:00:00.000Z' }],
    }} />)
    expect(html).toContain('已裁剪 2 项')
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
