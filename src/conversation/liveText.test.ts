import { describe, expect, it } from 'vitest'
import { appendCapabilityNotice, applyLiveEvent, mergeSettledTurn } from './liveText'
import { captureCapabilityNotices } from './capabilityNotices'
import { assistantEntry, userEntry } from './testing'
import { appendSteerToOpenTurn } from './entries'
import type { ConversationEntry } from './types'

describe('live transcript overlay', () => {
  it('shows tool receipts from root events while the projection bridge is late', () => {
    const entries: ConversationEntry[] = [userEntry('u1', '读取文件'), assistantEntry('pending', [], {}, 'streaming')]
    const started = applyLiveEvent(entries, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'read-1', name: 'local_files_read_text' } })
    const turn = started.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.id).toBe('turn:1')
    expect(turn.segments[0]).toMatchObject({ kind: 'tool', id: 'tool:read-1', label: '读取文件', status: 'running' })
    const finished = applyLiveEvent(started, { type: 'tool/result', data: { turn: 1, step: 1, message: { content: [
      { type: 'tool-result', toolCallId: 'read-1', isError: false, content: [{ type: 'text', text: 'secret file contents' }] },
    ] } } })
    const final = finished.at(-1)
    if (final?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(final.segments[0]).toMatchObject({ kind: 'tool', status: 'completed' })
    expect(JSON.stringify(final)).not.toContain('secret file contents')
    const reconciled = mergeSettledTurn(finished, assistantEntry('turn:1', [
      { kind: 'tool', id: 'tool:read-1', toolName: 'local_files_read_text', label: '读取 inventory.csv', status: 'completed', startedAt: '2026-09-18T00:00:00Z' },
    ], {}, 'completed'))
    const authoritative = reconciled.at(-1)
    if (authoritative?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(authoritative.segments[0]).toMatchObject({ label: '读取 inventory.csv' })
  })

  it('settles unfinished tool cards when a turn ends', () => {
    const entries = applyLiveEvent([assistantEntry('turn:2', [], {}, 'streaming')], { type: 'tool/call', data: { turn: 2, callId: 'call', name: 'task_report' } })
    const ended = applyLiveEvent(entries, { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } })
    expect(ended[0]).toMatchObject({ status: 'canceled', segments: [{ kind: 'tool', status: 'canceled' }] })
  })

  it('keeps a mid-turn employee message through projections and settles the tool after it', () => {
    const open = appendSteerToOpenTurn([assistantEntry('turn:1', [{
      kind: 'tool', id: 'tool:ask', toolName: 'ask_user_question', label: '等待回答', status: 'running', startedAt: '2026-09-18T09:33:00Z',
    }], {}, 'streaming')], { id: 'steer', role: 'user', source: 'steer', text: '店铺 A' })
    const merged = mergeSettledTurn(open, assistantEntry('turn:1', [{
      kind: 'tool', id: 'tool:ask', toolName: 'ask_user_question', label: '等待回答', status: 'completed', startedAt: '2026-09-18T09:33:00Z',
    }], {}, 'streaming'))
    expect(merged[0]).toMatchObject({ segments: [{ kind: 'tool', status: 'completed' }, { kind: 'user', text: '店铺 A' }] })
    expect(applyLiveEvent(merged, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })[0])
      .toMatchObject({ status: 'completed' })
  })

  it('shows native approval requests without a turn number and keeps the actionable ID across projection updates', () => {
    const entries = [assistantEntry('turn:1', [{ kind: 'tool' as const, id: 'tool:call-1', toolName: 'mcp_erp-mcp_store_sales_summary', label: 'ERP', status: 'running' as const, startedAt: '2026-09-18T00:00:00Z' }], {}, 'streaming')]
    const requested = applyLiveEvent(entries, { type: 'approval/request', data: { approvalId: 'bridge-1', name: 'mcp_erp-mcp_store_sales_summary', reason: '需要确认' } })
    expect(requested[0]).toMatchObject({ segments: [{ kind: 'tool' }, { kind: 'approval', approvalId: 'bridge-1', status: 'running' }] })
    const projected = mergeSettledTurn(requested, assistantEntry('turn:1', entries[0]!.role === 'assistant' ? entries[0]!.segments : [], {}, 'streaming'))
    expect(projected[0]).toMatchObject({ segments: [{ kind: 'tool' }, { kind: 'approval', approvalId: 'bridge-1', status: 'running' }] })
    const decided = applyLiveEvent(projected, { type: 'approval/decision', data: { approvalId: 'bridge-1', decision: 'allow' } })
    expect(decided[0]).toMatchObject({ segments: [{ kind: 'tool' }, { kind: 'approval', status: 'completed', label: '已允许：mcp_erp-mcp_store_sales_summary' }] })
    const replayed = mergeSettledTurn(decided, assistantEntry('turn:1', [
      ...entries[0]!.role === 'assistant' ? entries[0]!.segments : [],
      { kind: 'approval', id: 'approval:audit-1', approvalId: 'audit-1', toolName: 'mcp_erp-mcp_store_sales_summary', label: '已允许：mcp_erp-mcp_store_sales_summary', status: 'completed' },
    ], {}, 'completed'))
    expect(replayed[0]).toMatchObject({ segments: [{ kind: 'tool' }, { kind: 'approval', approvalId: 'audit-1', status: 'completed' }] })
  })

  it('shows native questions immediately and keeps them across transcript projections', () => {
    const entries = [userEntry('u1', '你说'), assistantEntry('turn:1', [{
      kind: 'tool' as const, id: 'tool:ask-1', toolName: 'ask_user_question', label: 'ask_user_question',
      status: 'running' as const, startedAt: '2026-09-18T00:00:00Z',
    }], {}, 'streaming')]
    const requested = applyLiveEvent(entries, { type: 'question/request', data: {
      questionId: 'bridge-1', questions: [{ id: 'intent', question: '要做什么？', options: [{ label: '继续聊' }] }],
    } })
    expect(requested.at(-1)).toMatchObject({ segments: [{ kind: 'tool' }, {
      kind: 'question', questionId: 'bridge-1', status: 'running', questions: [{ id: 'intent', question: '要做什么？' }],
    }] })
    const projected = mergeSettledTurn(requested, assistantEntry('turn:1', entries[1]!.role === 'assistant' ? entries[1]!.segments : [], {}, 'streaming'))
    expect(projected.at(-1)).toMatchObject({ segments: [{ kind: 'tool' }, { kind: 'question', questionId: 'bridge-1' }] })
    const answered = applyLiveEvent(projected, { type: 'question/answered', data: { questionId: 'bridge-1', answers: [{ id: 'choice', selected: ['继续'] }] } })
    expect(answered.at(-1)).toMatchObject({ segments: [{ kind: 'tool' }, { kind: 'question', status: 'completed', answers: [{ selected: ['继续'] }] }] })
    expect(mergeSettledTurn(answered, assistantEntry('turn:1', entries[1]!.role === 'assistant' ? entries[1]!.segments : [], {}, 'streaming')).at(-1))
      .toMatchObject({ segments: [{ kind: 'tool' }, { kind: 'question', status: 'completed' }] })
  })

  it('keeps a live capability notice when a later transcript projection settles', () => {
    const entries = appendCapabilityNotice([userEntry('u1', '查订单'), assistantEntry('turn:1', [], {}, 'streaming')],
      { kind: 'connector', name: 'ERP', reason: '连接失败' })
    const merged = mergeSettledTurn(entries, assistantEntry('turn:1', [{ kind: 'text', id: '1:1', text: '暂时无法查询订单' }], {}, 'completed'))
    const turn = merged.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.segments.map((segment) => segment.kind)).toEqual(['text', 'notice'])
  })

  it('keeps a desktop question before the answer when the durable transcript only contains text', () => {
    const question = { kind: 'question' as const, id: 'question:q1', questionId: 'q1', label: '需要回答',
      questions: [{ id: 'number', question: '选择数字？' }], status: 'completed' as const,
      answers: [{ id: 'number', selected: ['42'] }] }
    const text = { kind: 'text' as const, id: '1:2', text: '42 + 7 = 49' }
    const live = [assistantEntry('turn:1', [question, text], {}, 'streaming')]
    const merged = mergeSettledTurn(live, assistantEntry('turn:1', [text], {}, 'completed'))
    expect(merged[0]).toMatchObject({ segments: [question, text] })
  })
  it('bounds long multilingual notices to the native sidecar limits', () => {
    const entries = appendCapabilityNotice([assistantEntry('pending', [], {}, 'streaming')], {
      kind: 'knowledge', name: '资料😀'.repeat(120), reason: '访问已撤销😀'.repeat(500),
    })
    const notice = entries[0].role === 'assistant' ? entries[0].segments[0] : undefined
    if (notice?.kind !== 'notice') throw new Error('expected notice')
    expect(new TextEncoder().encode(notice.id).length).toBeLessThanOrEqual(200)
    expect(new TextEncoder().encode(notice.text).length).toBeLessThanOrEqual(6_000)
    expect(notice.text.length).toBeLessThanOrEqual(2_000)
    expect(captureCapabilityNotices('session-long', entries)).toHaveLength(1)
  })
  it('keeps the clock monotonic when the settled projection arrives', () => {
    const sent = '2026-09-16T10:00:00.000Z'
    const entries: ConversationEntry[] = [
      userEntry('u1', '整理报表'),
      { id: 'turn:1', role: 'assistant', status: 'streaming', segments: [{ kind: 'text', id: '1:1', text: '处理中', streaming: true }], meta: { startedAt: sent } },
    ]
    // The harness opens the turn a few seconds after the employee sent it.
    const settled = applyLiveEvent(entries, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '处理中' }] } },
    })
    const merged = mergeSettledTurn(settled, {
      id: 'turn:1', role: 'assistant', status: 'completed',
      segments: [{ kind: 'text', id: '1:1', text: '处理中' }],
      meta: { startedAt: '2026-09-16T10:00:04.000Z', completedAt: '2026-09-16T10:00:09.000Z' },
    })
    const turn = merged.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.meta.startedAt).toBe(sent)
    expect(turn.meta.completedAt).toBe('2026-09-16T10:00:09.000Z')
  })

  it('keeps the submitted start when the first live turn replaces the placeholder', () => {
    const sent = '2026-09-16T10:00:00.000Z'
    const entries: ConversationEntry[] = [userEntry('u1', '整理报表'), {
      id: 'pending', role: 'assistant', status: 'streaming', segments: [], meta: { startedAt: sent },
    }]
    const started = applyLiveEvent(entries, { type: 'turn/start', data: { turn: 1 } })
    expect(started.at(-1)).toMatchObject({ id: 'turn:1', meta: { startedAt: sent } })
  })

  it('replaces the placeholder when a projection arrives before the live turn', () => {
    const sent = '2026-09-16T10:00:00.000Z'
    const entries: ConversationEntry[] = [userEntry('u1', '整理报表'), {
      id: 'pending', role: 'assistant', status: 'streaming', segments: [], meta: { startedAt: sent },
    }]
    const merged = mergeSettledTurn(entries, {
      id: 'turn:1', role: 'assistant', status: 'streaming', segments: [],
      meta: { startedAt: '2026-09-16T10:00:04.000Z' },
    })
    expect(merged).toHaveLength(2)
    expect(merged.at(-1)).toMatchObject({ id: 'turn:1', meta: { startedAt: sent } })
    expect(applyLiveEvent(merged, { type: 'turn/start', data: { turn: 1 } })).toEqual(merged)
  })

  it('ignores a late live start after the projected turn already ended', () => {
    const entries: ConversationEntry[] = [userEntry('u1', '整理报表'), {
      id: 'pending', role: 'assistant', status: 'streaming', segments: [], meta: { startedAt: '2026-09-16T10:00:00Z' },
    }]
    const merged = mergeSettledTurn(entries, {
      id: 'turn:1', role: 'assistant', status: 'completed', segments: [],
      meta: { startedAt: '2026-09-16T10:00:04Z', completedAt: '2026-09-16T10:00:09Z' },
    })
    expect(applyLiveEvent(merged, { type: 'turn/start', data: { turn: 1 } })).toEqual(merged)
    expect(merged).toHaveLength(2)
  })

  it('never puts reasoning content into the visible reply', () => {
    const entries: ConversationEntry[] = [userEntry('u1', '下载目录里有啥'), assistantEntry('pending', [], {}, 'streaming')]
    const reasoning = applyLiveEvent(entries, { type: 'reasoning-chunks', data: { turn: 1, step: 1, texts: ['Private reasoning'] } })
    expect(reasoning).toBe(entries)
    const streamed = applyLiveEvent(entries, { type: 'assistant/stream', data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'Private reasoning' } } })
    expect(streamed).toBe(entries)
    const settled = applyLiveEvent(entries, {
      type: 'assistant/message',
      data: {
        turn: 1, step: 1,
        message: { content: [
          { type: 'reasoning', text: 'The user wants to list the files in their Downloads directory.' },
          { type: 'text', text: '你的下载目录里有 20 个顶层项目。' },
        ] },
      },
    })
    const turn = settled.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.segments.map((segment) => segment.kind === 'text' ? segment.text : '')).toEqual(['你的下载目录里有 20 个顶层项目。'])
    expect(JSON.stringify(turn)).not.toContain('The user wants to list')
  })
})
