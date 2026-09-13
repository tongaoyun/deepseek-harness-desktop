import { describe, expect, it } from 'vitest'
import { applyStoppingHarnessNotification, type HarnessNotification } from './harness'
import { applyHarnessNotification, authorizeDroppedPaths, cancelHarness, classifyHarnessFailure, createXiaoyinTaskProjection, diagnoseConnectors, harnessActivityLabel, harnessProjectionUpdate, harnessResponseUpdate, normalizeHarnessProjection, probeHarnessHost, selfTestLocalCapabilities, shouldRetryHarnessFailure } from './harness'

describe('Harness Session Projection', () => {
  it('accepts the official projection envelope and rejects compact event payloads', () => {
    const update = harnessProjectionUpdate({ requestId: 1, event: { method: 'session.projection', params: { sessionId: 's', key: 'xiaoyin.task', seq: 4, value: { status: 'running', activity: '处理', updatedAt: '2026-09-11T00:00:00Z', steps: [], artifacts: [] } } } })
    expect(update).toMatchObject({ sessionId: 's', key: 'xiaoyin.task', seq: 4 })
    expect(normalizeHarnessProjection(update?.value)?.status).toBe('running')
    expect(harnessProjectionUpdate({ requestId: 1, event: { sessionId: 's', key: 'xiaoyin.task', seq: 4, value: {} } })).toBeUndefined()
  })

  it('normalizes optional Harness metrics and drops unknown wire fields', () => {
    const normalized = normalizeHarnessProjection({
      status: 'completed', activity: '完成', updatedAt: '2026-09-11T00:00:00Z', executionStarted: true,
      steps: [], artifacts: [], tokenUsage: { uncachedInputTokens: 12, outputTokens: 5, cacheReadTokens: -1 },
      contextPressure: { contextWindow: 1000, projectedTokens: 1200 }, outputRetention: { prunedResults: 2, omittedTokens: 80 },
      compactions: 3, privateRawOutput: 'must not persist',
    })
    expect(normalized).toMatchObject({
      tokenUsage: { uncachedInputTokens: 12, outputTokens: 5 },
      contextPressure: { contextWindow: 1000, projectedTokens: 1200 },
      outputRetention: { prunedResults: 2, omittedTokens: 80 }, compactions: 3,
    })
    expect(JSON.stringify(normalized)).not.toContain('privateRawOutput')
  })

  it('keeps Harness compaction lifecycle visible without implementing compaction locally', () => {
    const projection = [
      event('compaction/start', { turn: 1, step: 1, compactionId: 'compact-1' }, 1),
      event('compaction/end', { turn: 1, step: 1, compactionId: 'compact-1' }, 2),
    ].reduce(applyHarnessNotification, createXiaoyinTaskProjection())
    expect(projection.compactions).toBe(1)
    expect(projection.timeline?.map((item) => item.label)).toEqual(['上下文整理完成'])
  })

  it('keeps Harness tool-result pruning as a bounded summary', () => {
    const projection = applyHarnessNotification(createXiaoyinTaskProjection(), event('compaction/prune', {
      turn: 1, step: 2, shadowedSeqs: [8, 9], shadowedTokenCount: 1400,
    }, 1))
    expect(projection.outputRetention).toEqual({ prunedResults: 2, omittedTokens: 1400 })
    expect(projection.timeline?.[0]).toMatchObject({ label: '裁剪工具结果', detail: '2 项，约 1400 tokens' })
  })
})

describe('harnessActivityLabel', () => {
  it('retains structured Office failure reasons instead of replacing them with file metadata', () => {
    const projection = [
      event('tool/call', { turn: 1, step: 1, callId: 'export', name: 'office_document_export_pdf', arguments: { path: 'report.docx' } }, 1),
      event('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'export', isError: true, content: [{ type: 'text', text: JSON.stringify({ error: '未找到 LibreOffice', path: 'report.docx', size: 1024 }) }] }] } }, 2),
    ].reduce(applyHarnessNotification, createXiaoyinTaskProjection())
    expect(projection.timeline?.[0].status).toBe('failed')
    expect(projection.timeline?.[0].detail).toContain('未找到 LibreOffice')
    expect(projection.artifacts).toEqual([])
  })
  it('persists bounded source receipts only from successful knowledge tools', () => {
    const source = { sourceId: '12', knowledgeBaseId: 'kb', knowledgeBaseName: '制度', documentId: 'doc', filename: '报销.md', locator: '正文', content: '报销上限 800 元', score: 1 }
    const run = (name: string, failed = false) => [
      event('tool/call', { turn: 1, step: 1, callId: 'knowledge', name }, 1),
      event('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'knowledge', isError: failed, content: [{ type: 'text', text: JSON.stringify([source, source, { ...source, sourceId: 'file:///fake' }]) }] }] } }, 2),
      event('step/start', { turn: 1, step: 2 }, 3),
      event('text-chunks', { turn: 1, step: 2, texts: ['报销上限 800 元。'] }, 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ].reduce(applyHarnessNotification, createXiaoyinTaskProjection())
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
    expect(shouldRetryHarnessFailure(transient, createXiaoyinTaskProjection())).toBe(true)
    const afterTool = { ...createXiaoyinTaskProjection(), steps: [{
      id: 'tool:1', kind: 'tool' as const, label: '运行命令', status: 'completed' as const,
      toolName: 'bash', startedAt: new Date().toISOString(),
    }] }
    expect(shouldRetryHarnessFailure(transient, afterTool)).toBe(false)
    expect(shouldRetryHarnessFailure(classifyHarnessFailure(new Error('认证失败')), createXiaoyinTaskProjection())).toBe(false)
  })

  it('does not forget tool execution when long-task display records are trimmed', () => {
    const transient = classifyHarnessFailure(new Error('模型服务繁忙'))
    let projection = applyHarnessNotification(createXiaoyinTaskProjection(), event('tool/call', { callId: 'write', name: 'bash' }, 1))
    for (let step = 1; step <= 110; step += 1) {
      projection = applyHarnessNotification(projection, event('step/start', { turn: 1, step }, step + 1))
    }
    expect(projection.steps.some(step => step.kind === 'tool')).toBe(false)
    expect(projection.executionStarted).toBe(true)
    expect(shouldRetryHarnessFailure(transient, { ...projection, timeline: [] })).toBe(false)
  })

  it('blocks replay after a delegated tool starts even without a root tool event', () => {
    const notification: HarnessNotification = event('tool/call', { callId: 'child-write', name: 'bash' }, 1)
    notification.event = { rootSessionId: 'root', event: { method: 'session.event', params: {
      sessionId: 'child', event: { type: 'tool/call', time: 1, data: { callId: 'child-write', name: 'bash' } },
    } } }
    const projection = applyHarnessNotification(createXiaoyinTaskProjection(), notification)
    expect(projection.steps).toEqual([])
    expect(shouldRetryHarnessFailure(classifyHarnessFailure('模型服务繁忙'), projection)).toBe(false)
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

  it('names rc.2 terminal, web, planning, todo and workflow tools', () => {
    const labels: Record<string, string> = {
      terminal_open: '正在打开持久终端',
      terminal_read: '正在读取终端输出',
      web_search: '正在搜索网页资料',
      web_fetch: '正在读取网页内容',
      todo_write: '正在更新任务清单',
      workflow: '正在执行工作流',
      exit_plan_mode: '正在提交计划审阅',
    }
    for (const [name, expected] of Object.entries(labels)) {
      expect(harnessActivityLabel({
        taskId: 'task-1', requestId: 1,
        event: { event: { method: 'session.event', params: { event: {
          type: 'tool/call', time: 1, data: { name },
        } } } },
      })).toBe(expected)
    }
  })

  it('keeps Session Query and Jobs results as safe action summaries', () => {
    const tools = [
      ['session_search', '查询历史会话'],
      ['session_event_search', '查询会话事件'],
      ['session_trace', '查看会话关系'],
      ['session_event_trace', '查看事件关系'],
      ['session_event_read', '读取会话事件'],
      ['job_list', '查看后台任务'],
      ['job_output', '读取后台任务'],
      ['job_kill', '停止后台任务'],
    ] as const
    let projection = createXiaoyinTaskProjection()
    for (const [index, [name, label]] of tools.entries()) {
      const callId = `safe-${index}`
      projection = applyHarnessNotification(projection, event('tool/call', {
        callId, name, arguments: JSON.stringify({ query: 'private query', sessionId: 'private-session' }),
      }, index * 2 + 1))
      projection = applyHarnessNotification(projection, event('tool/result', {
        message: { content: [{ type: 'tool-result', toolCallId: callId, isError: false,
          content: [{ type: 'text', text: JSON.stringify({ output: 'private raw event payload', sessionId: 'private-session' }) }],
        }] },
      }, index * 2 + 2))
      expect(projection.timeline?.at(-1)).toMatchObject({ label, status: 'completed' })
      expect(projection.timeline?.at(-1)?.detail).toBe(name.startsWith('job_') ? '已同步 Harness 后台任务状态' : '查询完成，结果仅在当前任务上下文中使用')
      expect(JSON.stringify(projection)).not.toContain('private raw event payload')
      expect(JSON.stringify(projection)).not.toContain('private-session')
    }
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
    const projection = notifications.reduce(applyHarnessNotification, createXiaoyinTaskProjection('2026-08-29T00:00:00Z'))

    expect(projection.steps.map(({ kind, label, status, toolName }) => ({ kind, label, status, toolName }))).toEqual([
      { kind: 'analysis', label: '分析任务', status: 'completed', toolName: undefined },
      { kind: 'tool', label: '查询库存风险', status: 'completed', toolName: 'inventory_risk' },
      { kind: 'response', label: '完成回复', status: 'completed', toolName: undefined },
    ])
    expect(projection.timeline).toMatchObject([
      { kind: 'tool', label: '查询库存风险', status: 'completed', toolName: 'inventory_risk' },
    ])
    expect(JSON.stringify(projection)).not.toContain('hidden chain')
    expect(JSON.stringify(projection)).not.toContain('private ERP result')
    expect(JSON.stringify(projection)).not.toContain('sensitive')
  })

  it('marks unfinished steps failed when the turn ends with an error', () => {
    const projection = [
      event('step/start', { turn: 2, step: 1 }, 1),
      event('turn/end', { turn: 2, reason: { kind: 'error' } }, 2),
    ].reduce(applyHarnessNotification, createXiaoyinTaskProjection())

    expect(projection.steps.map((step) => step.status)).toEqual(['failed', 'failed'])
    expect(projection.steps.at(-1)?.label).toBe('执行未完成')
    expect(projection.status).toBe('failed')
  })

  it('streams only visible text into the conversation timeline', () => {
    const projection = [
      event('step/start', { turn: 3, step: 1 }, 1),
      event('reasoning-chunks', { turn: 3, step: 1, texts: ['private reasoning'] }, 2),
      event('text-chunks', { turn: 3, step: 1, texts: ['我先', '查看目录。'] }, 3),
      event('text-chunks', { turn: 3, step: 1, texts: ['正在处理。'] }, 4),
      event('assistant/message', { turn: 3, step: 1, message: { content: [
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'text', text: '我先查看目录。正在处理。' },
      ] } }, 5),
    ].reduce(applyHarnessNotification, createXiaoyinTaskProjection())

    expect(projection.timeline).toMatchObject([{
      kind: 'assistant', text: '我先查看目录。正在处理。', status: 'completed',
    }])
    expect(JSON.stringify(projection)).not.toContain('private reasoning')
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

    const running = { ...createXiaoyinTaskProjection(), status: 'running' as const, activity: '正在处理' }
    const afterChildEnd = applyHarnessNotification(running, scopedEvent('child-1', 'root-1', 'turn/end', {
      turn: 1, reason: { kind: 'completed' },
    }, 2))
    expect(afterChildEnd.status).toBe('running')
    expect(afterChildEnd.activity).toBe('子 Agent 正在处理')
  })

  it('records real subagent tool calls as compact collaboration activities', () => {
    const projection = [
      scopedEvent('root-1', 'root-1', 'tool/call', {
        turn: 1, step: 1, callId: 'delegate-1', name: 'subagent',
        arguments: JSON.stringify({ description: '检查后端测试', prompt: '不应展示的子任务全文' }),
      }, 1),
      scopedEvent('root-1', 'root-1', 'tool/result', { message: { content: [{
        type: 'tool-result', toolCallId: 'delegate-1', isError: false,
        content: [{ type: 'text', text: '子 Agent 的完整回复不在进度中展示' }],
      }] } }, 2),
    ].reduce(applyHarnessNotification, createXiaoyinTaskProjection())

    expect(projection.subagents).toMatchObject([{
      id: 'delegate-1', label: '检查后端测试', status: 'completed',
    }])
    expect(projection.timeline).toMatchObject([{
      kind: 'subagent', label: '检查后端测试', status: 'completed',
    }])
    expect(JSON.stringify(projection)).not.toContain('不应展示')
    expect(JSON.stringify(projection)).not.toContain('完整回复')
  })

  it('records only the approval decision and tool name', () => {
    const projection = [event('approval/decision', {
      approvalId: 'approval-1', name: 'bash', decision: 'reject', reason: 'sensitive command',
    }, 1)].reduce(applyHarnessNotification, createXiaoyinTaskProjection())

    expect(projection.steps).toMatchObject([{ kind: 'approval', toolName: 'bash', status: 'failed' }])
    expect(JSON.stringify(projection)).not.toContain('sensitive command')
  })

  it('records artifacts only from structured results of file-producing tools', () => {
    const projection = [
      event('tool/call', { callId: 'call-doc', name: 'office.docx.create' }, 1),
      event('tool/result', { message: { content: [{
        type: 'tool-result', toolCallId: 'call-doc', isError: false, content: [{
          type: 'text', text: JSON.stringify({ rootId: 'local-1', rootName: '报表', path: 'output/daily.docx', size: 1200 }),
        }],
      }] } }, 2),
    ].reduce(applyHarnessNotification, createXiaoyinTaskProjection())

    expect(projection.artifacts).toMatchObject([{
      rootId: 'local-1', path: 'output/daily.docx', name: 'daily.docx', kind: 'document', sizeBytes: 1200,
    }])

    const ignored = [
      event('tool/call', { callId: 'call-erp', name: 'sales_summary' }, 1),
      event('tool/result', { message: { content: [{
        type: 'tool-result', toolCallId: 'call-erp', isError: false,
        content: [{ type: 'text', text: JSON.stringify({ rootId: 'secret', rootName: 'secret', path: 'leak.pdf' }) }],
      }] } }, 2),
    ].reduce(applyHarnessNotification, createXiaoyinTaskProjection())
    expect(ignored.artifacts).toEqual([])
  })

  it('keeps the first review baseline and avoids misleading repeated-edit totals', () => {
    const projection = [
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
    ].reduce(applyHarnessNotification, createXiaoyinTaskProjection())

    expect(projection.changes).toMatchObject([{
      path: 'src/App.tsx', action: 'updated', backupPath: '.xiaoyin-backups/first/App.tsx',
      beforeHash: 'original', afterHash: 'last',
      addedLines: undefined, deletedLines: undefined,
    }])
  })

  it('exposes browser screenshots as safe durable visual references', () => {
    const attachmentId = `sha256:${'a'.repeat(64)}`
    const projection = [
      event('tool/call', { callId: 'shot', name: 'browser_screenshot' }, 1),
      event('tool/result', { message: { content: [{
        type: 'tool-result', toolCallId: 'shot', isError: false, content: [
          { type: 'text', text: '{}' },
          { type: 'image', attachment: { attachmentId, mediaType: 'image/png', width: 1280, height: 720, name: 'browser.png' } },
        ],
      }] } }, 2),
    ].reduce(applyHarnessNotification, createXiaoyinTaskProjection())
    expect(projection.visuals).toMatchObject([{ attachmentId, mediaType: 'image/png', width: 1280, height: 720 }])
  })

  it('retains every valid connector image, deduplicates references and ignores failed or malformed results', () => {
    const image = (hash: string) => ({ type: 'image', attachment: { attachmentId: `sha256:${hash.repeat(64)}`, mediaType: 'image/png', width: 320, height: 240 } })
    const result = (callId: string, isError: boolean, content: unknown[]) => event('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: callId, isError, content }] } }, 2)
    const projection = [
      event('tool/call', { callId: 'images', name: 'mcp_design_generate' }, 1),
      result('images', false, [image('a'), image('b'), image('a'), image('../'), { type: 'image', data: 'raw-data', mimeType: 'image/png' }]),
      event('tool/call', { callId: 'failed', name: 'mcp_design_generate' }, 3),
      result('failed', true, [image('c')]),
    ].reduce(applyHarnessNotification, createXiaoyinTaskProjection())
    expect(projection.visuals).toHaveLength(2)
    expect(projection.visuals?.map((item) => item.attachmentId)).toEqual([`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`])
    expect(JSON.parse(JSON.stringify(projection)).visuals).toEqual(projection.visuals)
  })

  it('classifies published image files for inline previews', () => {
    const projection = [
      event('tool/call', { callId: 'poster', name: 'local_files_publish' }, 1),
      event('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'poster', isError: false,
        content: [{ type: 'text', text: JSON.stringify({ rootId: 'workspace', rootName: '工作目录', path: 'out/海报.WEBP', size: 1234 }) }],
      }] } }, 2),
    ].reduce(applyHarnessNotification, createXiaoyinTaskProjection())
    expect(projection.artifacts).toMatchObject([{ kind: 'image', path: 'out/海报.WEBP', action: 'published' }])
  })

  it('keeps approval requests inside the task timeline until decided', () => {
    const projection = [event('approval/request', {
      approvalId: 'approval-1', name: 'local_files_delete', reason: '删除 report.md',
    }, 1)].reduce(applyHarnessNotification, createXiaoyinTaskProjection())
    expect(projection.activity).toContain('等待确认')
    expect(projection.timeline).toMatchObject([{ kind: 'approval', approvalId: 'approval-1', status: 'running' }])
  })

  it('maps local files, commands and connectors into distinct conversation blocks', () => {
    const projection = [
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
    ].reduce(applyHarnessNotification, createXiaoyinTaskProjection())

    expect(projection.timeline).toMatchObject([
      { kind: 'file', label: '查看 reports', path: 'reports', itemCount: 1, status: 'completed' },
      { kind: 'command', label: '运行命令', text: 'pnpm test', detail: '运行测试', output: '42 tests passed', status: 'completed' },
      { kind: 'connector', label: '使用 github', connectorName: 'github', status: 'running' },
    ])
    expect(JSON.stringify(projection)).not.toContain('private')
  })

  it('renders public runtime errors without exposing reasoning', () => {
    const projection = [event('error', { message: '连接器暂时不可用', reasoning: 'hidden chain' }, 1)]
      .reduce(applyHarnessNotification, createXiaoyinTaskProjection())
    expect(projection.timeline).toMatchObject([{ kind: 'error', detail: '连接器暂时不可用', status: 'failed' }])
    expect(JSON.stringify(projection)).not.toContain('hidden chain')
  })
})

describe('diagnoseConnectors', () => {
  it('does not fall back to browser network access outside Tauri', async () => {
    await expect(diagnoseConnectors({ employeeId: 'employee', connectors: [], accessToken: '' }))
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
  const started = applyHarnessNotification(createXiaoyinTaskProjection(), event('tool/call', { callId: 'write', name: 'local_files_write_text' }, 1))
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
  const idle = createXiaoyinTaskProjection()
  expect(applyStoppingHarnessNotification(idle, receipt)).toBe(idle)
  expect(applyStoppingHarnessNotification(stopping, event('text-chunks', { texts: ['迟到正文'] }, 3))).toBe(stopping)
  expect(applyStoppingHarnessNotification(stopping, event('tool/call', { callId: 'new', name: 'bash' }, 3))).toBe(stopping)
})

it('projects structured questions and settles them after a desktop answer', () => {
  const requested = applyHarnessNotification(createXiaoyinTaskProjection(), event('question/request', {
    questionId: 'question-1',
    questions: [{ id: 'mode', header: '执行方式', question: '请选择模式', options: [
      { label: '安全模式', description: '每次写入前确认' }, { label: '快速模式' },
    ], multiSelect: false }],
  }, 1))
  expect(requested).toMatchObject({ status: 'running', activity: '等待你回答' })
  expect(requested.timeline).toMatchObject([{ kind: 'question', questionId: 'question-1', status: 'running', questions: [{ id: 'mode' }] }])
  const answered = applyHarnessNotification(requested, event('question/answered', { questionId: 'question-1' }, 2))
  expect(answered.timeline).toMatchObject([{ kind: 'question', status: 'completed' }])
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
