import { describe, expect, it } from 'vitest'
import { initialXiaoyinTaskView, reduceEvent, type XiaoyinTaskState } from './xiaoyin-projections-plugin.js'

describe('xiaoyin product projection', () => {
  it('turns official present declarations into workspace deliverables', () => {
    const initial: XiaoyinTaskState = { value: initialXiaoyinTaskView(), toolNames: {} }
    const state = reduceEvent(initial, {
      type: 'deliverables/presented', time: Date.now(), data: {
        turn: 1, step: 2, callId: 'present-1',
        files: [{ path: 'reports/final.xlsx', description: '最终报表' }, { path: '../secret.txt' }, { path: 'reports/./draft.xlsx' }],
      },
    })
    expect(state.value.artifacts).toEqual([expect.objectContaining({
      rootId: 'harness-workspace', path: 'reports/final.xlsx', sourceTool: 'present', action: 'presented', description: '最终报表',
    })])
    expect(state.value.timeline).toEqual([expect.objectContaining({ label: '交付 1 个文件' })])
  })

  it('keeps Harness compaction lifecycle in the product projection', () => {
    const initial: XiaoyinTaskState = { value: initialXiaoyinTaskView(), toolNames: {} }
    const started = reduceEvent(initial, { type: 'compaction/start', time: 1, data: { turn: 1, step: 2, compactionId: 'c-1' } })
    const completed = reduceEvent(started, { type: 'compaction/end', time: 2, data: { turn: 1, step: 2, compactionId: 'c-1' } })
    expect(completed.value.compactions).toBe(1)
    expect(completed.value.timeline).toMatchObject([{ id: 'compaction:c-1', label: '上下文整理完成', status: 'completed' }])
  })

  it('keeps Harness tool-result pruning as a bounded summary', () => {
    const initial: XiaoyinTaskState = { value: initialXiaoyinTaskView(), toolNames: {} }
    const state = reduceEvent(initial, { type: 'compaction/prune', time: 1, data: { turn: 1, step: 2, shadowedSeqs: [8, 9], shadowedTokenCount: 1400 } })
    expect(state.value.outputRetention).toEqual({ prunedResults: 2, omittedTokens: 1400 })
    expect(state.value.timeline[0]).toMatchObject({ label: '裁剪工具结果', detail: '2 项，约 1400 tokens' })
  })

  it('records local file tools as deliverables with their action', () => {
    const initial: XiaoyinTaskState = { value: initialXiaoyinTaskView(), toolNames: {} }
    const called = reduceEvent(initial, { type: 'tool/call', time: 1, data: { turn: 1, step: 1, callId: 'call-1', name: 'local_files_publish', arguments: JSON.stringify({ rootId: 'work', rootName: '工作目录', path: 'reports/q3.csv' }) } })
    const state = reduceEvent(called, { type: 'tool/result', time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: JSON.stringify({ rootId: 'work', rootName: '工作目录', path: 'reports/q3.csv', size: 2048 }) }] }] } } })
    expect(state.value.artifacts).toEqual([expect.objectContaining({ id: 'work:reports/q3.csv', path: 'reports/q3.csv', sourceTool: 'local_files_publish', action: 'published' })])
    expect(state.value.changes).toEqual([expect.objectContaining({ id: 'work:reports/q3.csv', action: 'created' })])
  })

  it('does not show read-only tools as file modifications or deliverables', () => {
    for (const name of ['load_workspace_dependencies', 'local_files_read_text']) {
      const initial: XiaoyinTaskState = { value: initialXiaoyinTaskView(), toolNames: {} }
      const called = reduceEvent(initial, { type: 'tool/call', time: 1, data: { turn: 1, step: 1, callId: 'read', name } })
      const state = reduceEvent(called, { type: 'tool/result', time: 2, data: { turn: 1, step: 1, message: { content: [{ toolCallId: 'read', content: [{ type: 'text', text: JSON.stringify({ rootId: 'work', rootName: '工作目录', path: 'input.xlsx' }) }] }] } } })
      expect(state.value.artifacts, name).toEqual([])
      expect(state.value.changes, name).toEqual([])
    }
  })

  it('does not crash on malformed event timestamps', () => {
    const initial: XiaoyinTaskState = { value: initialXiaoyinTaskView(), toolNames: {} }
    expect(() => reduceEvent(initial, { type: 'turn/start', time: Number.NaN, data: {} })).not.toThrow()
  })

  it('uses Harness sequence numbers to ignore duplicate and late events', () => {
    const initial: XiaoyinTaskState = { value: initialXiaoyinTaskView(), toolNames: {} }
    const started = reduceEvent(initial, { type: 'compaction/start', seq: 10, time: 1, data: { turn: 1, step: 1, compactionId: 'compact' } })
    const completed = reduceEvent(started, { type: 'compaction/end', seq: 11, time: 2, data: { turn: 1, step: 1, compactionId: 'compact' } })
    expect(reduceEvent(completed, { type: 'compaction/end', seq: 11, time: 3, data: { turn: 1, step: 1, compactionId: 'compact' } })).toBe(completed)
    const late = reduceEvent(completed, { type: 'tool/call', seq: 9, time: 4, data: { turn: 1, step: 2, callId: 'late', name: 'bash' } })
    expect(late).toBe(completed)
    expect(late.value.compactions).toBe(1)
    expect(late.value.steps).toHaveLength(0)
  })

  it('advances across unknown sequenced events without changing the product view', () => {
    const initial: XiaoyinTaskState = { value: initialXiaoyinTaskView(), toolNames: {} }
    const unknown = reduceEvent(initial, { type: 'future/informational', seq: 4, time: 1, data: { anything: true } })
    expect(unknown.value).toBe(initial.value)
    expect(unknown.lastSeq).toBe(4)
    expect(reduceEvent(unknown, { type: 'tool/call', seq: 3, time: 2, data: null })).toBe(unknown)
  })

  it('settles running steps and delegated agents when a turn ends', () => {
    const initial: XiaoyinTaskState = { value: initialXiaoyinTaskView(), toolNames: {} }
    const running = reduceEvent(reduceEvent(initial, { type: 'tool/call', time: 1, data: { turn: 1, step: 1, callId: 'write', name: 'bash' } }), { type: 'tool/call', time: 2, data: { turn: 1, step: 2, callId: 'delegate', name: 'subagent' } })
    const failed = reduceEvent(running, { type: 'turn/end', time: 3, data: { reason: { kind: 'error' } } })
    expect(failed.value.status).toBe('failed')
    expect(failed.value.steps.filter((item) => item.status === 'running')).toHaveLength(0)
    expect(failed.value.steps.find((item) => item.id === 'tool:write')?.status).toBe('canceled')
    expect(failed.value.steps.find((item) => item.id === 'tool:delegate')?.status).toBe('canceled')
  })

  it('tracks subagent calls as isolated product activities', () => {
    const initial: XiaoyinTaskState = { value: initialXiaoyinTaskView(), toolNames: {} }
    const started = reduceEvent(initial, { type: 'tool/call', time: 1, data: { turn: 1, step: 1, callId: 'delegate', name: 'subagent', arguments: JSON.stringify({ description: '检查测试' }) } })
    expect(started.value.subagents).toMatchObject([{ id: 'delegate', label: '检查测试', status: 'running' }])
    const completed = reduceEvent(started, { type: 'tool/result', time: 2, data: { message: { content: [{ toolCallId: 'delegate', isError: false, content: [{ type: 'text', text: '完成' }] }] } } })
    expect(completed.value.subagents).toMatchObject([{ id: 'delegate', status: 'completed' }])
  })

  it('projects approval and question requests for the desktop interaction layer', () => {
    const initial: XiaoyinTaskState = { value: initialXiaoyinTaskView(), toolNames: {} }
    const approval = reduceEvent(initial, { type: 'approval/request', time: 1, data: { approvalId: 'a-1', name: 'bash', reason: '需要执行命令' } })
    expect(approval.value.timeline).toMatchObject([{ kind: 'approval', approvalId: 'a-1', status: 'running' }])
    const question = reduceEvent(approval, { type: 'question/request', time: 2, data: { questionId: 'q-1', questions: [{ id: 'mode', question: '选择模式', options: [{ label: '安全' }] }] } })
    expect(question.value.timeline.find((item) => item.id === 'question:q-1')).toMatchObject({ kind: 'question', questionId: 'q-1', status: 'running', questions: [{ id: 'mode' }] })
    const answered = reduceEvent(question, { type: 'question/answered', time: 3, data: { questionId: 'q-1' } })
    expect(answered.value.timeline.find((item) => item.id === 'question:q-1')?.status).toBe('completed')
  })

  it('bounds product-owned free text before it crosses the projection bridge', () => {
    const initial: XiaoyinTaskState = { value: initialXiaoyinTaskView(), toolNames: {} }
    const started = reduceEvent(initial, { type: 'tool/call', time: 1, data: { callId: 'knowledge', name: 'knowledge_search' } })
    const huge = 'x'.repeat(100_000)
    const result = reduceEvent(started, { type: 'tool/result', time: 2, data: { message: { content: [{ toolCallId: 'knowledge', isError: false, content: [{ type: 'text', text: JSON.stringify([{ sourceId: 's', knowledgeBaseId: 'kb', documentId: 'doc', filename: 'a.md', content: huge }]) }] }] } } })
    expect(result.value.knowledgeSources[0]?.content).toHaveLength(8_000)
    expect(JSON.stringify(result.value).length).toBeLessThan(20_000)
  })

  it('bounds long task collections and total knowledge payload size', () => {
    const initial: XiaoyinTaskState = { value: initialXiaoyinTaskView(), toolNames: {} }
    let state = initial
    for (let index = 0; index < 140; index += 1) {
      state = reduceEvent(state, { type: 'tool/call', time: index + 1, data: { turn: 1, step: index + 1, callId: `call-${index}`, name: 'bash' } })
    }
    expect(state.value.steps.length).toBeLessThanOrEqual(100)
    expect(state.value.timeline.length).toBeLessThanOrEqual(100)
    const knowledge = reduceEvent(reduceEvent(initial, { type: 'tool/call', time: 1, data: { callId: 'knowledge', name: 'knowledge_search' } }), { type: 'tool/result', time: 2, data: { message: { content: [{ toolCallId: 'knowledge', isError: false, content: [{ type: 'text', text: JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ sourceId: String(index), knowledgeBaseId: 'kb', documentId: String(index), filename: 'a.md', content: 'x'.repeat(8_000) }))) }] }] } } })
    expect(JSON.stringify(knowledge.value.knowledgeSources).length).toBeLessThan(70_000)
  })
})
