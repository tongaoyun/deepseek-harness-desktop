import { describe, expect, it } from 'vitest'
import { initialXiaoyinTaskView, reduceEvent, type XiaoyinTaskState } from './xiaoyin-projections-plugin.js'

const state = (): XiaoyinTaskState => ({ value: initialXiaoyinTaskView(), toolNames: {} })

describe('xiaoyin product projection', () => {
  it('keeps only product-owned deliverables from an official present event', () => {
    const result = reduceEvent(state(), { type: 'deliverables/presented', time: Date.now(), data: { callId: 'present-1', files: [{ path: 'reports/final.xlsx', description: '最终报表' }, { path: '../secret.txt' }] } })
    expect(result.value.artifacts).toEqual([expect.objectContaining({ path: 'reports/final.xlsx', action: 'presented' })])
    expect(result.value).not.toHaveProperty('status')
    expect(result.value).not.toHaveProperty('timeline')
  })

  it('records product file receipts while the official session owns tool state', () => {
    const called = reduceEvent(state(), { type: 'tool/call', time: 1, data: { callId: 'call-1', name: 'local_files_publish' } })
    const result = reduceEvent(called, { type: 'tool/result', time: 2, data: { message: { content: [{ toolCallId: 'call-1', content: [{ type: 'text', text: JSON.stringify({ rootId: 'work', rootName: '工作目录', path: 'reports/q3.csv' }) }] }] } } })
    expect(result.value.artifacts).toEqual([expect.objectContaining({ id: 'work:reports/q3.csv', action: 'published' })])
    expect(result.value.changes).toEqual([expect.objectContaining({ id: 'work:reports/q3.csv', action: 'created' })])
  })

  it('does not turn read-only tools into product file changes', () => {
    const called = reduceEvent(state(), { type: 'tool/call', time: 1, data: { callId: 'read', name: 'local_files_read_text' } })
    const result = reduceEvent(called, { type: 'tool/result', time: 2, data: { message: { content: [{ toolCallId: 'read', content: [{ type: 'text', text: JSON.stringify({ rootId: 'work', rootName: '工作目录', path: 'input.xlsx' }) }] }] } } })
    expect(result.value.artifacts).toEqual([])
    expect(result.value.changes).toEqual([])
  })

  it('keeps sequence ordering without projecting Harness lifecycle state', () => {
    const started = reduceEvent(state(), { type: 'future/event', seq: 10, time: 1, data: {} })
    const late = reduceEvent(started, { type: 'tool/call', seq: 9, time: 2, data: { callId: 'late', name: 'bash' } })
    expect(late).toBe(started)
    expect(late.value).toEqual(initialXiaoyinTaskView())
  })

  it('bounds product knowledge receipts', () => {
    const called = reduceEvent(state(), { type: 'tool/call', time: 1, data: { callId: 'knowledge', name: 'knowledge_search' } })
    const huge = 'x'.repeat(100_000)
    const result = reduceEvent(called, { type: 'tool/result', time: 2, data: { message: { content: [{ toolCallId: 'knowledge', content: [{ type: 'text', text: JSON.stringify([{ sourceId: 's', knowledgeBaseId: 'kb', documentId: 'doc', filename: 'a.md', content: huge }]) }] }] } } })
    expect(result.value.knowledgeSources[0]?.content).toHaveLength(8_000)
    expect(JSON.stringify(result.value).length).toBeLessThan(20_000)
  })

  it('advances unknown events without changing product data', () => {
    const initial = state()
    const next = reduceEvent(initial, { type: 'future/informational', seq: 4, time: Number.NaN, data: { anything: true } })
    expect(next.value).toBe(initial.value)
    expect(next.lastSeq).toBe(4)
  })
})
