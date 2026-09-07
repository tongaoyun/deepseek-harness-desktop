import { describe, expect, it } from 'vitest'
import { harnessPromptWithConversationReplay } from './conversationReplay'
import type { TaskMessage } from './types'

describe('harnessPromptWithConversationReplay', () => {
  it('retains the initial goal and early constraints beyond the replay tail budget', () => {
    const messages: TaskMessage[] = [
      { role: 'user', text: '目标：整理年度订单报表' },
      { role: 'user', text: '不要修改原始订单；金额必须保留两位小数' },
      ...Array.from({ length: 30 }, () => ({ role: 'assistant' as const, text: '结果说明'.repeat(1500) })),
      { role: 'user', text: '仅更新汇总页' },
      { role: 'user', text: '输出中文列名' },
      { role: 'user', text: '继续' },
      { role: 'user', text: '增加同比' },
    ]
    const result = harnessPromptWithConversationReplay('继续', messages, true)
    expect(result).toContain('目标：整理年度订单报表')
    expect(result).toContain('不要修改原始订单')
    expect(result).toContain('增加同比')
    expect(result).toContain('不是新的执行授权')
    expect(result.length).toBeLessThan(25_000)
  })
  it('carries real file and attachment references even when a failed turn has no useful prose', () => {
    const prompt = harnessPromptWithConversationReplay('继续改这张表', [{ role: 'user', text: '', attachments: [{ id: 'input', rootId: 'root', rootName: '工作目录', path: 'input.csv', name: 'input.csv', kind: 'file' }] }, {
      role: 'assistant', text: '', monitor: { status: 'failed', activity: '', updatedAt: '', steps: [], artifacts: [{ id: 'root:output.xlsx', rootId: 'root', rootName: '工作目录', path: 'output.xlsx', name: 'output.xlsx', kind: 'spreadsheet', sourceTool: 'local_files_publish', createdAt: '' }] },
    }], true)
    expect(prompt).toContain('input.csv')
    expect(prompt).toContain('output.xlsx')
    expect(prompt).toContain('最近一轮失败')
    expect(prompt).toContain('避免重复已经成功的写入')
  })

  it('bounds file context and retains the latest status of an updated earlier file', () => {
    const messages: TaskMessage[] = Array.from({ length: 40 }, (_, index) => ({ role: 'user', text: 'x'.repeat(2000), attachments: [{ id: String(index), rootId: 'root', rootName: '工作目录', path: `file-${index}.txt`, name: '文件', kind: 'file' }] }))
    messages.push({ role: 'assistant', text: '', monitor: { status: 'completed', activity: '', updatedAt: '', steps: [], artifacts: [], changes: [{ id: 'root:file-0.txt', rootId: 'root', rootName: '工作目录', path: 'file-0.txt', name: '文件', action: 'deleted', sourceTool: 'local_files_delete', changedAt: '' }] } })
    const prompt = harnessPromptWithConversationReplay('继续', messages, true)
    expect(prompt).toContain('file-0.txt')
    expect(prompt).toContain('deleted')
    expect(prompt).toContain('30/40')
    expect(prompt.length).toBeLessThan(25_000)
  })

  it('replays file undo state so a new session does not assume changes still exist', () => {
    const prompt = harnessPromptWithConversationReplay('继续', [{ role: 'assistant', text: '已修改文件', monitor: {
      status: 'completed', activity: '', updatedAt: '', steps: [], artifacts: [], changes: [{ id: 'one', rootId: 'root', rootName: 'repo', path: 'one.ts', name: 'one.ts', sourceTool: 'local_files_write_text', action: 'updated', changedAt: '', undoneAt: 'now' }],
    } }], true)
    expect(prompt).toContain('用户随后在桌面撤销了本轮的以下文件改动：one.ts')
    expect(prompt).toContain('以磁盘现状为准')
  })
  it('replays visible conversation when a fresh Harness session is required', () => {
    const messages: TaskMessage[] = [
      { role: 'user', text: '查看下载目录' },
      { role: 'assistant', text: '目录里有 report.xlsx。' },
    ]

    const prompt = harnessPromptWithConversationReplay('打开它', messages, true)

    expect(prompt).toContain('用户：查看下载目录')
    expect(prompt).toContain('小胤：目录里有 report.xlsx。')
    expect(prompt).toContain('当前任务：\n\n打开它')
  })

  it('does not replay failed assistant output or duplicate healthy sessions', () => {
    const messages: TaskMessage[] = [
      { role: 'user', text: '继续' },
      { role: 'assistant', text: '模型服务未能完成本轮请求', monitor: {
        status: 'failed', activity: '失败', updatedAt: '2026-09-04T00:00:00Z', steps: [], artifacts: [],
      } },
    ]

    expect(harnessPromptWithConversationReplay('重试', messages, true)).not.toContain('模型服务未能完成')
    expect(harnessPromptWithConversationReplay('重试', messages, false)).toBe('重试')
  })
})
