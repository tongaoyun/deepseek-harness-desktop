import { describe, expect, it } from 'vitest'
import { harnessPromptWithConversationReplay } from './conversationReplay'
import { assistantEntry, userEntry } from './conversation/testing'
import type { ConversationEntry } from './conversation/types'
import { createXiaoyinTaskProjection } from './harness'

describe('harnessPromptWithConversationReplay', () => {
  it('removes UI capability tokens from replayed user messages', () => {
    const result = harnessPromptWithConversationReplay('继续', [
      userEntry('user-1', '/kit:reports /skill:review 分析本周数据'),
      assistantEntry('turn-1', '已完成初步分析'),
    ], true)
    expect(result).toContain('用户：分析本周数据')
    expect(result).not.toContain('/kit:reports')
    expect(result).not.toContain('/skill:review')
  })

  it('retains the initial goal and early constraints beyond the replay tail budget', () => {
    const entries: ConversationEntry[] = [
      userEntry('user-1', '目标：整理年度订单报表'),
      userEntry('user-2', '不要修改原始订单；金额必须保留两位小数'),
      ...Array.from({ length: 30 }, (_, index) => assistantEntry(`turn-${index}`, '结果说明'.repeat(1500))),
      userEntry('user-3', '仅更新汇总页'),
      userEntry('user-4', '输出中文列名'),
      userEntry('user-5', '继续'),
      userEntry('user-6', '增加同比'),
    ]
    const result = harnessPromptWithConversationReplay('继续', entries, true)
    expect(result).toContain('目标：整理年度订单报表')
    expect(result).toContain('不要修改原始订单')
    expect(result).toContain('增加同比')
    expect(result).toContain('不是新的执行授权')
    expect(result.length).toBeLessThan(25_000)
  })
  it('carries real file and attachment references even when a failed turn has no useful prose', () => {
    const prompt = harnessPromptWithConversationReplay('继续改这张表', [
      userEntry('user-1', '', [{ id: 'input', rootId: 'root', rootName: '工作目录', path: 'input.csv', name: 'input.csv', kind: 'file' }]),
      assistantEntry('turn-1', '', {}, 'failed'),
    ], true, {
      ...createXiaoyinTaskProjection(), status: 'failed', activity: '', updatedAt: '',
      artifacts: [{ id: 'root:output.xlsx', rootId: 'root', rootName: '工作目录', path: 'output.xlsx', name: 'output.xlsx', kind: 'spreadsheet', sourceTool: 'local_files_publish', createdAt: '' }],
    })
    expect(prompt).toContain('input.csv')
    expect(prompt).toContain('output.xlsx')
    expect(prompt).toContain('最近一轮失败')
    expect(prompt).toContain('避免重复已经成功的写入')
  })

  it('bounds file context and retains the latest status of an updated earlier file', () => {
    const entries: ConversationEntry[] = Array.from({ length: 40 }, (_, index) => userEntry(`user-${index}`, 'x'.repeat(2000), [{ id: String(index), rootId: 'root', rootName: '工作目录', path: `file-${index}.txt`, name: '文件', kind: 'file' }]))
    const prompt = harnessPromptWithConversationReplay('继续', entries, true, {
      ...createXiaoyinTaskProjection(), status: 'completed', activity: '', updatedAt: '',
      changes: [{ id: 'root:file-0.txt', rootId: 'root', rootName: '工作目录', path: 'file-0.txt', name: '文件', action: 'deleted', sourceTool: 'local_files_delete', changedAt: '' }],
    })
    expect(prompt).toContain('file-0.txt')
    expect(prompt).toContain('deleted')
    expect(prompt).toContain('30/40')
    expect(prompt.length).toBeLessThan(25_000)
  })

  it('replays file undo state so a new session does not assume changes still exist', () => {
    const prompt = harnessPromptWithConversationReplay('继续', [assistantEntry('turn-1', '已修改文件')], true, {
      ...createXiaoyinTaskProjection(), status: 'completed', activity: '', updatedAt: '',
      changes: [{ id: 'one', rootId: 'root', rootName: 'repo', path: 'one.ts', name: 'one.ts', sourceTool: 'local_files_write_text', action: 'updated', changedAt: '', undoneAt: 'now' }],
    })
    expect(prompt).toContain('已撤销，请核实磁盘现状')
    expect(prompt).toContain('one.ts')
  })
  it('replays visible conversation when a fresh Harness session is required', () => {
    const entries: ConversationEntry[] = [
      userEntry('user-1', '查看下载目录'),
      assistantEntry('turn-1', '目录里有 report.xlsx。'),
    ]

    const prompt = harnessPromptWithConversationReplay('打开它', entries, true)

    expect(prompt).toContain('用户：查看下载目录')
    expect(prompt).toContain('小胤：目录里有 report.xlsx。')
    expect(prompt).toContain('当前任务：\n\n打开它')
  })

  it('does not replay failed assistant output or duplicate healthy sessions', () => {
    const entries: ConversationEntry[] = [
      userEntry('user-1', '继续'),
      assistantEntry('turn-1', '模型服务未能完成本轮请求', {}, 'failed'),
    ]

    expect(harnessPromptWithConversationReplay('重试', entries, true)).not.toContain('模型服务未能完成')
    expect(harnessPromptWithConversationReplay('重试', entries, false)).toBe('重试')
  })
})
