import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { DeepSeekHarnessRuntime } from './runtime.js'
import { initialTranscriptState, reduceTranscriptEvent, currentAssistantTurn, type TranscriptState } from './transcript-projection.js'
import { withTaskInstructions } from './task-instructions.js'
import type { SessionEvent } from './xiaoyin-projections-plugin.js'

let clock = 0
function event(type: string, data: Record<string, unknown>, seq?: number): SessionEvent {
  clock += 1
  return { type, time: clock, data, ...(seq !== undefined ? { seq } : {}) }
}

function userMessage(id: string, text: string, source: Record<string, unknown> = { kind: 'user' }): SessionEvent {
  return event('user/message', { id, role: 'user', content: [{ type: 'text', text }], source })
}

function assistantMessage(turn: number, step: number, text: string, usage?: Record<string, unknown>): SessionEvent {
  return event('assistant/message', {
    turn, step,
    message: { id: `assistant-${turn}-${step}`, role: 'assistant', content: text ? [{ type: 'text', text }] : [], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } },
    ...(usage ? { usage } : {}),
  })
}

function toolCall(turn: number, step: number, callId: string, name: string, args: Record<string, unknown> = {}): SessionEvent {
  return event('tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) })
}

function toolResult(turn: number, step: number, callId: string, content: Array<Record<string, unknown>>, failed = false): SessionEvent {
  return event('tool/result', {
    turn, step,
    message: { id: `result-${callId}`, role: 'user', content: [{ type: 'tool-result', toolCallId: callId, isError: failed, content }], source: { kind: 'tool', callId } },
  })
}

function fold(events: SessionEvent[]): TranscriptState {
  clock = 0
  return events.reduce<TranscriptState>((state, item) => reduceTranscriptEvent(state, item), initialTranscriptState())
}

describe('transcript projection', () => {
  it('builds user and assistant turns in conversation order', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      userMessage('m1', '帮我重构登录模块'),
      event('step/start', { turn: 1, step: 1 }),
      assistantMessage(1, 1, '我先检查现有代码。'),
      toolCall(1, 1, 'call-1', 'local_files_list', { path: 'src/login' }),
      toolResult(1, 1, 'call-1', [{ type: 'text', text: JSON.stringify({ directory: 'src/login', entries: [{}, {}, {}] }) }]),
      assistantMessage(1, 2, '重构完成。', { inputTokens: 100, outputTokens: 50 }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])

    expect(state.entries).toHaveLength(2)
    expect(state.entries[0]).toMatchObject({ role: 'user', id: 'm1', text: '帮我重构登录模块' })
    const turn = state.entries[1]
    expect(turn).toMatchObject({ role: 'assistant', status: 'completed' })
    if (turn!.role !== 'assistant') return
    expect(turn.segments.map((segment) => segment.kind)).toEqual(['commentary', 'tool', 'text'])
    expect(turn.segments[0]).toMatchObject({ kind: 'commentary', id: '1:1', text: '我先检查现有代码。' })
    expect(turn.segments[1]).toMatchObject({ kind: 'tool', toolName: 'local_files_list', status: 'completed', label: '查看 src/login', itemCount: 3 })
    expect(turn.meta.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50 })
  })

  it('does not project private reasoning into the desktop transcript', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      userMessage('m1', '下载目录里有啥'),
      event('assistant/message', {
        turn: 1, step: 1,
        message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [
          { type: 'reasoning', text: 'The user wants to list the files in their Downloads directory.' },
          { type: 'text', text: '你的下载目录里有 20 个顶层项目。' },
        ] },
      }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    const turn = state.entries.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.segments).toEqual([{ kind: 'text', id: '1:1', text: '你的下载目录里有 20 个顶层项目。' }])
    expect(JSON.stringify(turn)).not.toContain('The user wants to list')
    expect(turn.segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text))
      .toEqual(['你的下载目录里有 20 个顶层项目。'])
  })

  it('never turns injected context into a user bubble', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      userMessage('m1', '开始任务'),
      userMessage('inject-1', '技能内容注入', { kind: 'plugin', plugin: 'skill' }),
      assistantMessage(1, 1, '好的。'),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(state.entries.filter((entry) => entry.role === 'user')).toHaveLength(1)
  })

  it('restores only the employee prompt from product instructions and memory', () => {
    const prompt = '请读取合成文件'
    const memory = '<xiaoyin-memory>\n偏好先给结论\n</xiaoyin-memory>\n\n当前任务：\n'
    const desktop = (text: string) => `你正在小胤桌面端中工作，执行本地任务。\n\n按所选能力的职责组合完成同一任务。\n\n员工任务：\n${text}`
    const state = fold([
      event('turn/start', { turn: 1 }),
      userMessage('m1', withTaskInstructions(`${memory}${desktop(prompt)}`)),
      assistantMessage(1, 1, '已读取。'),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event('turn/start', { turn: 2 }),
      userMessage('m2', withTaskInstructions(desktop('继续核对'))),
      assistantMessage(2, 1, '核对完成。'),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ])
    expect(state.entries.filter((entry) => entry.role === 'user')).toEqual([
      { id: 'm1', role: 'user', text: prompt },
      { id: 'm2', role: 'user', text: '继续核对' },
    ])
  })

  it('keeps only the new employee input when rebuilding a workspace session', () => {
    const replay = '以下是同一任务在重建本地执行会话前的可见对话，仅用于保持上下文。不要重复回答历史内容。\n\n用户：旧要求\n\n当前任务：\n\n新要求'
    const state = fold([userMessage('m1', withTaskInstructions(`你正在小胤桌面端的 Plan 模式中工作。\n\n员工任务：\n${replay}`))])
    expect(state.entries[0]).toMatchObject({ role: 'user', text: '新要求' })
  })

  it('embeds a mid-turn steer as a user segment between visible segments', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      userMessage('m1', '调研方案'),
      assistantMessage(1, 1, '初步结论……'),
      userMessage('m2', '不对，改成方案 B'),
      assistantMessage(1, 2, '已改用方案 B。'),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    const turn = state.entries.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.segments.map((segment) => segment.kind)).toEqual(['text', 'user', 'text'])
    expect(turn.segments[1]).toMatchObject({ kind: 'user', id: 'm2', text: '不对，改成方案 B' })
  })

  it('keeps text across tool calls and never drops earlier segments', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      userMessage('m1', '任务'),
      assistantMessage(1, 1, '第一段。'),
      toolCall(1, 1, 'call-1', 'bash', { command: 'pnpm test' }),
      toolResult(1, 1, 'call-1', [{ type: 'text', text: 'ok\n[exit code: 0]' }]),
      assistantMessage(1, 2, '第二段。'),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    const turn = state.entries.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.segments.find((segment) => segment.kind === 'commentary')).toMatchObject({ text: '第一段。' })
    expect(turn.segments.findLast((segment) => segment.kind === 'text')).toMatchObject({ text: '第二段。' })
    const tool = turn.segments.find((segment) => segment.kind === 'tool') as { command?: string; output?: string; detail?: string }
    expect(tool.command).toBe('pnpm test')
    expect(tool.output).toBe('ok')
    expect(tool.detail).toBe('退出码 0')
  })

  it('marks a failed turn with a readable failure and settles running tools', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      userMessage('m1', '任务'),
      toolCall(1, 1, 'call-1', 'bash', { command: 'pnpm test' }),
      event('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'model disconnected' } } }),
    ])
    const turn = state.entries.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.status).toBe('failed')
    expect(turn.meta.failure).toEqual({ kind: 'error', message: 'model disconnected' })
    expect(turn.segments[0]).toMatchObject({ kind: 'tool', status: 'canceled' })
  })

  it('marks an aborted turn as canceled and records approvals and questions', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      userMessage('m1', '任务'),
      event('approval/asked', { id: 'a1', toolName: 'local_files_write_text', reason: '写入文件' }),
      event('question/request', { questionId: 'q1', questions: [{ id: 'q1', question: '选哪个方案？', options: [{ label: 'A' }, { label: 'B' }] }] }),
      event('approval/decided', { id: 'a1', outcome: 'allowed-once' }),
      event('question/answered', { questionId: 'q1' }),
      event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    ])
    const turn = state.entries.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.status).toBe('canceled')
    expect(turn.segments.find((segment) => segment.kind === 'approval')).toMatchObject({ status: 'completed', label: '已允许：local_files_write_text' })
    expect(turn.segments.find((segment) => segment.kind === 'question')).toMatchObject({ status: 'completed' })
  })

  it('replays a rejected approval from durable audit events without exposing a stale decision button', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      toolCall(1, 1, 'call-1', 'mcp_erp-mcp_store_sales_summary'),
      event('approval/asked', { id: 'audit-1', toolName: 'mcp_erp-mcp_store_sales_summary', callId: 'call-1', reason: '需要确认' }),
      event('approval/decided', { id: 'audit-1', outcome: 'rejected' }),
      event('turn/end', { turn: 1, reason: { kind: 'aborted' } }),
    ])
    const turn = state.entries.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.segments.find((segment) => segment.kind === 'approval')).toMatchObject({ status: 'failed', label: '已拒绝：mcp_erp-mcp_store_sales_summary' })
  })

  it('drops stale events by sequence and keeps the fold monotonic', () => {
    const first = fold([
      event('turn/start', { turn: 1 }, 0),
      userMessage('m1', '任务', ),
    ])
    const replayed = reduceTranscriptEvent(first, event('turn/start', { turn: 1 }, 0))
    expect(replayed).toBe(first)
    const ahead = reduceTranscriptEvent(first, event('turn/start', { turn: 2 }, 5))
    expect(ahead).not.toBe(first)
  })

  it('settles a still-open turn when the log jumps to a new turn', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      userMessage('m1', '任务'),
      assistantMessage(1, 1, '进行中……'),
      event('turn/start', { turn: 2 }),
      userMessage('m2', '继续'),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ])
    const turns = state.entries.filter((entry) => entry.role === 'assistant')
    expect(turns[0]).toMatchObject({ status: 'failed' })
    expect(turns[1]).toMatchObject({ status: 'completed' })
  })

  it('carries the turn timestamps inside meta so the desktop keeps its clock', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      userMessage('m1', '任务'),
      assistantMessage(1, 1, '完成。'),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    const turn = state.entries.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.meta.startedAt).toBeDefined()
    expect(turn.meta.completedAt).toBeDefined()
    expect(Date.parse(turn.meta.completedAt!)).toBeGreaterThanOrEqual(Date.parse(turn.meta.startedAt!))
  })

  it('exposes only the latest assistant turn in the wire view', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      userMessage('m1', '任务'),
      assistantMessage(1, 1, '第一轮。'),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event('turn/start', { turn: 2 }),
      userMessage('m2', '继续'),
      assistantMessage(2, 1, '第二轮。'),
    ])
    const view = currentAssistantTurn(state)
    expect(view?.segments[0]).toMatchObject({ kind: 'text', text: '第二轮。' })
    expect(view?.status).toBe('streaming')
  })

  it('sums token usage across the steps of one turn', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      userMessage('m1', '任务'),
      assistantMessage(1, 1, 'a', { inputTokens: 10, outputTokens: 5 }),
      toolCall(1, 1, 'call-1', 'bash', { command: 'ls' }),
      toolResult(1, 1, 'call-1', [{ type: 'text', text: '' }]),
      assistantMessage(1, 2, 'b', { inputTokens: 20, outputTokens: 15, cacheReadTokens: 7 }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    const turn = state.entries.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.meta.tokenUsage).toEqual({ inputTokens: 30, outputTokens: 20, cacheReadTokens: 7 })
  })

  it('projects context compaction into the replayable timeline', () => {
    const state = fold([
      event('turn/start', { turn: 1 }),
      event('compaction/start', { turn: 1, step: 2, compactionId: 'c-1' }),
      event('compaction/end', { turn: 1, step: 2, compactionId: 'c-1' }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    const turn = state.entries.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.segments).toEqual([expect.objectContaining({ kind: 'status', id: 'compaction:c-1', label: '上下文已自动压缩', status: 'completed' })])
  })

  it('rebuilds the identical transcript from a persisted session log', async () => {
    const home = await mkdtemp(join(tmpdir(), 'xiaoyin-transcript-parity-'))
    try {
      const root = join(home, 'sessions')
      const persistence = new JsonlSessionPersistence(new Context(), { root, compression: 'none' })
      const handle = await persistence.create({
        version: SESSION_FORMAT_VERSION,
        id: SessionId('transcript-parity'),
        createdAt: Date.now(),
        isSeeded: false,
      })
      const events: Array<SessionEvent & Record<string, unknown>> = [
        event('turn/start', { turn: 1 }),
        { ...userMessage('m1', '帮我整理周报'), surfaceOp: 'append', sourceEventSeqs: [0] },
        event('step/start', { turn: 1, step: 1 }),
        { ...assistantMessage(1, 1, '我先读取数据。', { inputTokens: 10, outputTokens: 4 }), surfaceOp: 'append' },
        event('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'local_files_read_text', arguments: JSON.stringify({ path: 'report/weekly.md' }) }),
        { ...event('tool/result', {
          turn: 1, step: 1,
          message: { id: 'result-call-1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: JSON.stringify({ rootId: 'work', rootName: '工作目录', path: 'report/weekly.md', size: 2048 }) }] }], source: { kind: 'tool', callId: 'call-1' } },
        }), surfaceOp: 'append', sourceEventSeqs: [4] },
        { ...assistantMessage(1, 2, '整理完成。', { inputTokens: 30, outputTokens: 20 }), surfaceOp: 'append' },
        event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ]
      const sequenced = events.map((item, index) => ({ ...item, seq: index }))
      await handle.append(sequenced as never)
      await handle.flush()
      await handle.close()

      const runtime = new DeepSeekHarnessRuntime({ DSH_HOME: home, DSH_SESSION_ROOT: root })
      try {
        const inspection = await runtime.inspectSession?.('transcript-parity')
        expect(inspection).toBeDefined()
        const liveFold = fold(sequenced)
        // Reload and live rendering must produce the same transcript shape.
        expect(inspection?.transcript).toEqual(liveFold.entries)
      } finally {
        await runtime.close()
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
