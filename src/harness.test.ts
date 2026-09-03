import { describe, expect, it } from 'vitest'
import { applyHarnessNotification, authorizeDroppedPaths, cancelHarness, createTaskMonitor, diagnoseConnectors, harnessActivityLabel, probeHarnessHost, selfTestLocalCapabilities } from './harness'

describe('harnessActivityLabel', () => {
  it('shows safe progress labels without exposing reasoning content', () => {
    const label = harnessActivityLabel({
      requestId: 1,
      event: {
        event: {
          method: 'session.event',
          params: { event: { type: 'tool/call', time: 1_787_981_950_440,
            data: { turn: 1, step: 1, callId: 'call-1', name: 'sales_summary', reasoning: 'private' } } },
        },
      },
    })
    expect(label).toBe('正在查询销售汇总')
    expect(label).not.toContain('private')

    expect(harnessActivityLabel({
      requestId: 1,
      event: { event: { method: 'session.status', params: { status: 'idle' } } },
    })).toBe('正在整理结果')
  })

  it('builds a safe durable timeline and correlates tool results', () => {
    const notifications = [
      event('step/start', { turn: 1, step: 1 }, 1),
      event('assistant/message', { turn: 1, step: 1, message: { reasoning: 'hidden chain' } }, 2),
      event('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'inventory_risk',
        arguments: '{"sensitive":"not rendered"}' }, 3),
      event('tool/result', { turn: 1, step: 1, message: { content: [
        { type: 'tool-result', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'private ERP result' }] },
      ] } }, 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ]
    const monitor = notifications.reduce(applyHarnessNotification, createTaskMonitor('2026-08-29T00:00:00Z'))

    expect(monitor.steps.map(({ kind, label, status, toolName }) => ({ kind, label, status, toolName }))).toEqual([
      { kind: 'analysis', label: '分析任务', status: 'completed', toolName: undefined },
      { kind: 'tool', label: '查询库存风险', status: 'completed', toolName: 'inventory_risk' },
      { kind: 'response', label: '完成回复', status: 'completed', toolName: undefined },
    ])
    expect(monitor.timeline).toMatchObject([
      { kind: 'tool', label: '查询库存风险', status: 'completed', toolName: 'inventory_risk' },
    ])
    expect(JSON.stringify(monitor)).not.toContain('hidden chain')
    expect(JSON.stringify(monitor)).not.toContain('private ERP result')
    expect(JSON.stringify(monitor)).not.toContain('sensitive')
  })

  it('marks unfinished steps failed when the turn ends with an error', () => {
    const monitor = [
      event('step/start', { turn: 2, step: 1 }, 1),
      event('turn/end', { turn: 2, reason: { kind: 'error' } }, 2),
    ].reduce(applyHarnessNotification, createTaskMonitor())

    expect(monitor.steps.map((step) => step.status)).toEqual(['failed', 'failed'])
    expect(monitor.steps.at(-1)?.label).toBe('执行未完成')
    expect(monitor.status).toBe('failed')
  })

  it('streams only visible text into the conversation timeline', () => {
    const monitor = [
      event('step/start', { turn: 3, step: 1 }, 1),
      event('reasoning-chunks', { turn: 3, step: 1, texts: ['private reasoning'] }, 2),
      event('text-chunks', { turn: 3, step: 1, texts: ['我先', '查看目录。'] }, 3),
      event('text-chunks', { turn: 3, step: 1, texts: ['正在处理。'] }, 4),
      event('assistant/message', { turn: 3, step: 1, message: { content: [
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'text', text: '我先查看目录。正在处理。' },
      ] } }, 5),
    ].reduce(applyHarnessNotification, createTaskMonitor())

    expect(monitor.timeline).toMatchObject([{
      kind: 'assistant', text: '我先查看目录。正在处理。', status: 'completed',
    }])
    expect(JSON.stringify(monitor)).not.toContain('private reasoning')
  })

  it('records only the approval decision and tool name', () => {
    const monitor = [event('approval/decision', {
      approvalId: 'approval-1', name: 'local_shell_run', decision: 'reject', reason: 'sensitive command',
    }, 1)].reduce(applyHarnessNotification, createTaskMonitor())

    expect(monitor.steps).toMatchObject([{ kind: 'approval', toolName: 'local_shell_run', status: 'failed' }])
    expect(JSON.stringify(monitor)).not.toContain('sensitive command')
  })

  it('records artifacts only from structured results of file-producing tools', () => {
    const monitor = [
      event('tool/call', { callId: 'call-doc', name: 'office.docx.create' }, 1),
      event('tool/result', { message: { content: [{
        type: 'tool-result', toolCallId: 'call-doc', isError: false, content: [{
          type: 'text', text: JSON.stringify({ rootId: 'local-1', rootName: '报表', path: 'output/daily.docx', size: 1200 }),
        }],
      }] } }, 2),
    ].reduce(applyHarnessNotification, createTaskMonitor())

    expect(monitor.artifacts).toMatchObject([{
      rootId: 'local-1', path: 'output/daily.docx', name: 'daily.docx', kind: 'document', sizeBytes: 1200,
    }])

    const ignored = [
      event('tool/call', { callId: 'call-erp', name: 'sales_summary' }, 1),
      event('tool/result', { message: { content: [{
        type: 'tool-result', toolCallId: 'call-erp', isError: false,
        content: [{ type: 'text', text: JSON.stringify({ rootId: 'secret', rootName: 'secret', path: 'leak.pdf' }) }],
      }] } }, 2),
    ].reduce(applyHarnessNotification, createTaskMonitor())
    expect(ignored.artifacts).toEqual([])
  })

  it('maps local files, commands and connectors into distinct conversation blocks', () => {
    const monitor = [
      event('tool/call', { callId: 'files', name: 'local_files_list', arguments: JSON.stringify({ rootId: 'r1', path: 'reports' }) }, 1),
      event('tool/result', { message: { content: [{
        type: 'tool-result', toolCallId: 'files', isError: false, content: [{ type: 'text', text: JSON.stringify({
          rootId: 'r1', rootName: 'Downloads', directory: 'reports', entries: [{ path: 'reports/a.md', type: 'file' }], truncated: false,
        }) }],
      }] } }, 2),
      event('tool/call', { callId: 'shell', name: 'local_shell_run', arguments: JSON.stringify({ command: 'pnpm test', description: '运行测试', workdir: 'app' }) }, 3),
      event('tool/result', { message: { content: [{
        type: 'tool-result', toolCallId: 'shell', isError: false, content: [{ type: 'text', text: JSON.stringify({ exitCode: 0, stdout: '42 tests passed', stderr: '' }) }],
      }] } }, 4),
      event('tool/call', { callId: 'github', name: 'mcp_github_list_pull_requests', arguments: JSON.stringify({ owner: 'private' }) }, 5),
    ].reduce(applyHarnessNotification, createTaskMonitor())

    expect(monitor.timeline).toMatchObject([
      { kind: 'file', label: '查看 reports', path: 'reports', itemCount: 1, status: 'completed' },
      { kind: 'command', label: '运行命令', text: 'pnpm test', detail: '退出码 0', output: '42 tests passed', status: 'completed' },
      { kind: 'connector', label: '使用 github', connectorName: 'github', status: 'running' },
    ])
    expect(JSON.stringify(monitor)).not.toContain('private')
  })

  it('renders public runtime errors without exposing reasoning', () => {
    const monitor = [event('error', { message: '连接器暂时不可用', reasoning: 'hidden chain' }, 1)]
      .reduce(applyHarnessNotification, createTaskMonitor())
    expect(monitor.timeline).toMatchObject([{ kind: 'error', detail: '连接器暂时不可用', status: 'failed' }])
    expect(JSON.stringify(monitor)).not.toContain('hidden chain')
  })
})

describe('diagnoseConnectors', () => {
  it('does not fall back to browser network access outside Tauri', async () => {
    await expect(diagnoseConnectors({ connectors: [], accessToken: '' }))
      .rejects.toThrow('只能在小胤桌面客户端中运行')
  })

  it('does not fake a local capability self-test outside Tauri', async () => {
    await expect(selfTestLocalCapabilities()).rejects.toThrow('只能在小胤桌面客户端中运行')
  })

  it('does not fake a Harness Host probe outside Tauri', async () => {
    await expect(probeHarnessHost()).rejects.toThrow('仅在小胤桌面客户端中运行')
  })

  it('keeps cancellation and empty drops safe outside Tauri', async () => {
    await expect(cancelHarness()).resolves.toBe(false)
    await expect(authorizeDroppedPaths([])).resolves.toEqual([])
  })
})

function event(type: string, data: Record<string, unknown>, time: number) {
  return {
    requestId: 1,
    event: { event: { method: 'session.event', params: { event: { type, time, data } } } },
  }
}
