import { describe, expect, it } from 'vitest'
import { applyStoppingHarnessNotification } from './harness'
import { applyHarnessNotification, authorizeDroppedPaths, cancelHarness, classifyHarnessFailure, createTaskMonitor, diagnoseConnectors, harnessActivityLabel, harnessResponseUpdate, probeHarnessHost, selfTestLocalCapabilities, shouldRetryHarnessFailure } from './harness'

describe('harnessActivityLabel', () => {
  it('persists bounded source receipts only from successful knowledge tools', () => {
    const source = { sourceId: '12', knowledgeBaseId: 'kb', knowledgeBaseName: '制度', documentId: 'doc', filename: '报销.md', locator: '正文', content: '报销上限 800 元', score: 1 }
    const run = (name: string, failed = false) => [
      event('tool/call', { turn: 1, step: 1, callId: 'knowledge', name }, 1),
      event('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'knowledge', isError: failed, content: [{ type: 'text', text: JSON.stringify([source, source, { ...source, sourceId: 'file:///fake' }]) }] }] } }, 2),
      event('step/start', { turn: 1, step: 2 }, 3),
      event('text-chunks', { turn: 1, step: 2, texts: ['报销上限 800 元。'] }, 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ].reduce(applyHarnessNotification, createTaskMonitor())
    expect(run('knowledge_search').knowledgeSources).toEqual([source])
    expect(run('knowledge_search', true).knowledgeSources ?? []).toEqual([])
    expect(run('bash').knowledgeSources ?? []).toEqual([])
  })

  it('classifies runtime failures into actionable user-facing groups', () => {
    expect(classifyHarnessFailure(new Error('任务执行超过 15 分钟')).category).toBe('timeout')
    expect(classifyHarnessFailure(new Error('MCP connector unavailable')).category).toBe('connector')
    expect(classifyHarnessFailure(new Error('Harness Host 意外退出')).infrastructure).toBe(true)
  })

  it('retries transient model failures only before a tool or approval starts', () => {
    const transient = classifyHarnessFailure(new Error('模型本轮没有返回可显示文本'))
    expect(shouldRetryHarnessFailure(transient, createTaskMonitor())).toBe(true)
    const afterTool = { ...createTaskMonitor(), steps: [{
      id: 'tool:1', kind: 'tool' as const, label: '运行命令', status: 'completed' as const,
      toolName: 'bash', startedAt: new Date().toISOString(),
    }] }
    expect(shouldRetryHarnessFailure(transient, afterTool)).toBe(false)
    expect(shouldRetryHarnessFailure(classifyHarnessFailure(new Error('认证失败')), createTaskMonitor())).toBe(false)
  })

  it('shows safe progress labels without exposing reasoning content', () => {
    const label = harnessActivityLabel({
      taskId: 'task-1',
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
      taskId: 'task-1',
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

  it('projects visible response chunks without exposing reasoning', () => {
    expect(harnessResponseUpdate(event('reasoning-chunks', { turn: 1, step: 1, texts: ['private'] }, 1))).toBeUndefined()
    expect(harnessResponseUpdate(event('text-chunks', { turn: 1, step: 2, texts: ['正在', '回答'] }, 2)))
      .toEqual({ key: 'assistant:visible-response', mode: 'append', text: '正在回答' })
    expect(harnessResponseUpdate(event('assistant/message', { turn: 1, step: 2, message: { content: [
      { type: 'reasoning', text: 'private' }, { type: 'text', text: '完整回答' },
    ] } }, 3))).toEqual({ key: 'assistant:visible-response', mode: 'replace', text: '完整回答' })
    expect(harnessResponseUpdate(event('tool/call', { callId: '1', name: 'local_files_list' }, 4)))
      .toEqual({ key: '', mode: 'clear', text: '' })
  })

  it('keeps child session text and completion out of the root conversation', () => {
    const childText = scopedEvent('child-1', 'root-1', 'text-chunks', {
      turn: 1, step: 1, texts: ['子 Agent 内部回复'],
    }, 1)
    expect(harnessResponseUpdate(childText)).toBeUndefined()

    const running = { ...createTaskMonitor(), status: 'running' as const, activity: '正在处理' }
    const afterChildEnd = applyHarnessNotification(running, scopedEvent('child-1', 'root-1', 'turn/end', {
      turn: 1, reason: { kind: 'completed' },
    }, 2))
    expect(afterChildEnd.status).toBe('running')
    expect(afterChildEnd.activity).toBe('子 Agent 正在处理')
  })

  it('records real subagent tool calls as compact collaboration activities', () => {
    const monitor = [
      scopedEvent('root-1', 'root-1', 'tool/call', {
        turn: 1, step: 1, callId: 'delegate-1', name: 'subagent',
        arguments: JSON.stringify({ description: '检查后端测试', prompt: '不应展示的子任务全文' }),
      }, 1),
      scopedEvent('root-1', 'root-1', 'tool/result', { message: { content: [{
        type: 'tool-result', toolCallId: 'delegate-1', isError: false,
        content: [{ type: 'text', text: '子 Agent 的完整回复不在进度中展示' }],
      }] } }, 2),
    ].reduce(applyHarnessNotification, createTaskMonitor())

    expect(monitor.subagents).toMatchObject([{
      id: 'delegate-1', label: '检查后端测试', status: 'completed',
    }])
    expect(monitor.timeline).toMatchObject([{
      kind: 'subagent', label: '检查后端测试', status: 'completed',
    }])
    expect(JSON.stringify(monitor)).not.toContain('不应展示')
    expect(JSON.stringify(monitor)).not.toContain('完整回复')
  })

  it('records only the approval decision and tool name', () => {
    const monitor = [event('approval/decision', {
      approvalId: 'approval-1', name: 'bash', decision: 'reject', reason: 'sensitive command',
    }, 1)].reduce(applyHarnessNotification, createTaskMonitor())

    expect(monitor.steps).toMatchObject([{ kind: 'approval', toolName: 'bash', status: 'failed' }])
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

  it('keeps the first review baseline and avoids misleading repeated-edit totals', () => {
    const monitor = [
      event('tool/call', { callId: 'write-1', name: 'local_files_write_text' }, 1),
      event('tool/result', { message: { content: [{
        type: 'tool-result', toolCallId: 'write-1', isError: false, content: [{ type: 'text', text: JSON.stringify({
          rootId: 'repo', rootName: 'xiaoyin', path: 'src/App.tsx', action: 'updated', backupPath: '.xiaoyin-backups/first/App.tsx', beforeHash: 'original', afterHash: 'first', addedLines: 5, deletedLines: 2,
        }) }],
      }] } }, 2),
      event('tool/call', { callId: 'write-2', name: 'local_files_write_text' }, 3),
      event('tool/result', { message: { content: [{
        type: 'tool-result', toolCallId: 'write-2', isError: false, content: [{ type: 'text', text: JSON.stringify({
          rootId: 'repo', rootName: 'xiaoyin', path: 'src/App.tsx', action: 'updated', backupPath: '.xiaoyin-backups/second/App.tsx', beforeHash: 'first', afterHash: 'last', addedLines: 3, deletedLines: 1,
        }) }],
      }] } }, 4),
    ].reduce(applyHarnessNotification, createTaskMonitor())

    expect(monitor.changes).toMatchObject([{
      path: 'src/App.tsx', action: 'updated', backupPath: '.xiaoyin-backups/first/App.tsx',
      beforeHash: 'original', afterHash: 'last',
      addedLines: undefined, deletedLines: undefined,
    }])
  })

  it('exposes browser screenshots as safe durable visual references', () => {
    const attachmentId = `sha256:${'a'.repeat(64)}`
    const monitor = [
      event('tool/call', { callId: 'shot', name: 'browser_screenshot' }, 1),
      event('tool/result', { message: { content: [{
        type: 'tool-result', toolCallId: 'shot', isError: false, content: [
          { type: 'text', text: '{}' },
          { type: 'image', attachment: { attachmentId, mediaType: 'image/png', width: 1280, height: 720, name: 'browser.png' } },
        ],
      }] } }, 2),
    ].reduce(applyHarnessNotification, createTaskMonitor())
    expect(monitor.visuals).toMatchObject([{ attachmentId, mediaType: 'image/png', width: 1280, height: 720 }])
  })

  it('retains every valid connector image, deduplicates references and ignores failed or malformed results', () => {
    const image = (hash: string) => ({ type: 'image', attachment: { attachmentId: `sha256:${hash.repeat(64)}`, mediaType: 'image/png', width: 320, height: 240 } })
    const result = (callId: string, isError: boolean, content: unknown[]) => event('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: callId, isError, content }] } }, 2)
    const monitor = [
      event('tool/call', { callId: 'images', name: 'mcp_design_generate' }, 1),
      result('images', false, [image('a'), image('b'), image('a'), image('../'), { type: 'image', data: 'raw-data', mimeType: 'image/png' }]),
      event('tool/call', { callId: 'failed', name: 'mcp_design_generate' }, 3),
      result('failed', true, [image('c')]),
    ].reduce(applyHarnessNotification, createTaskMonitor())
    expect(monitor.visuals).toHaveLength(2)
    expect(monitor.visuals?.map((item) => item.attachmentId)).toEqual([`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`])
    expect(JSON.parse(JSON.stringify(monitor)).visuals).toEqual(monitor.visuals)
  })

  it('classifies published image files for inline previews', () => {
    const monitor = [
      event('tool/call', { callId: 'poster', name: 'local_files_publish' }, 1),
      event('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'poster', isError: false,
        content: [{ type: 'text', text: JSON.stringify({ rootId: 'workspace', rootName: '工作目录', path: 'out/海报.WEBP', size: 1234 }) }],
      }] } }, 2),
    ].reduce(applyHarnessNotification, createTaskMonitor())
    expect(monitor.artifacts).toMatchObject([{ kind: 'image', path: 'out/海报.WEBP', action: 'published' }])
  })

  it('keeps approval requests inside the task timeline until decided', () => {
    const monitor = [event('approval/request', {
      approvalId: 'approval-1', name: 'local_files_delete', reason: '删除 report.md',
    }, 1)].reduce(applyHarnessNotification, createTaskMonitor())
    expect(monitor.activity).toContain('等待确认')
    expect(monitor.timeline).toMatchObject([{ kind: 'approval', approvalId: 'approval-1', status: 'running' }])
  })

  it('maps local files, commands and connectors into distinct conversation blocks', () => {
    const monitor = [
      event('tool/call', { callId: 'files', name: 'local_files_list', arguments: JSON.stringify({ rootId: 'r1', path: 'reports' }) }, 1),
      event('tool/result', { message: { content: [{
        type: 'tool-result', toolCallId: 'files', isError: false, content: [{ type: 'text', text: JSON.stringify({
          rootId: 'r1', rootName: 'Downloads', directory: 'reports', entries: [{ path: 'reports/a.md', type: 'file' }], truncated: false,
        }) }],
      }] } }, 2),
      event('tool/call', { callId: 'shell', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test', description: '运行测试', workdir: 'app' }) }, 3),
      event('tool/result', { message: { content: [{
        type: 'tool-result', toolCallId: 'shell', isError: false, content: [{ type: 'text', text: '42 tests passed' }],
      }] } }, 4),
      event('tool/call', { callId: 'github', name: 'mcp_github_list_pull_requests', arguments: JSON.stringify({ owner: 'private' }) }, 5),
    ].reduce(applyHarnessNotification, createTaskMonitor())

    expect(monitor.timeline).toMatchObject([
      { kind: 'file', label: '查看 reports', path: 'reports', itemCount: 1, status: 'completed' },
      { kind: 'command', label: '运行命令', text: 'pnpm test', detail: '运行测试', output: '42 tests passed', status: 'completed' },
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
    await expect(cancelHarness('missing-task')).resolves.toBe(false)
    await expect(authorizeDroppedPaths([])).resolves.toEqual({ directories: [], attachments: [] })
  })
})

it('retains late file receipts while stopping without resuming text or accepting unstarted work', () => {
  const started = applyHarnessNotification(createTaskMonitor(), event('tool/call', { callId: 'write', name: 'local_files_write_text' }, 1))
  const stopping = { ...started, activity: '正在停止' }
  const receipt = event('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'write', isError: false,
    content: [{ type: 'text', text: JSON.stringify({ rootId: 'repo', rootName: '测试', path: 'checkpoint.txt', action: 'created', sizeBytes: 13 }) }],
  }] } }, 2)
  const next = applyStoppingHarnessNotification(stopping, receipt)
  expect(next.activity).toBe('正在停止')
  expect(next.status).toBe(stopping.status)
  expect(next.steps.find((step) => step.id === 'tool:write')?.status).toBe('completed')
  expect(next.changes).toMatchObject([{ path: 'checkpoint.txt', action: 'created' }])
  expect(applyStoppingHarnessNotification(next, receipt)).toBe(next)
  const idle = createTaskMonitor()
  expect(applyStoppingHarnessNotification(idle, receipt)).toBe(idle)
  expect(applyStoppingHarnessNotification(stopping, event('text-chunks', { texts: ['迟到正文'] }, 3))).toBe(stopping)
  expect(applyStoppingHarnessNotification(stopping, event('tool/call', { callId: 'new', name: 'bash' }, 3))).toBe(stopping)
})

function event(type: string, data: Record<string, unknown>, time: number) {
  return {
    taskId: 'task-1',
    requestId: 1,
    event: { event: { method: 'session.event', params: { event: { type, time, data } } } },
  }
}

function scopedEvent(sessionId: string, rootSessionId: string, type: string, data: Record<string, unknown>, time: number) {
  return {
    taskId: 'task-1',
    requestId: 1,
    event: {
      rootSessionId,
      event: { method: 'session.event', params: { sessionId, event: { type, time, data } } },
    },
  }
}
