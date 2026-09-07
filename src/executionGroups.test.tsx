import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { groupExecutionEntries, executionGroupLabel, executionGroupStatus } from './executionGroups'
import { ExecutionTimeline } from './ExecutionTimeline'
import type { TaskTimelineEntry } from './types'

const entry = (id: string, kind: TaskTimelineEntry['kind'], status: TaskTimelineEntry['status'] = 'completed'): TaskTimelineEntry => ({ id, kind, status, label: id, occurredAt: '', text: kind === 'assistant' ? id : undefined })
it('groups consecutive actual tool steps without swallowing progress or approval events', () => {
  const groups = groupExecutionEntries([entry('说明', 'assistant'), entry('搜索', 'browser'), entry('读取', 'file'), entry('确认', 'approval', 'running'), entry('写入', 'file', 'running')])
  expect(groups.map((group) => [group.kind, group.entries.length])).toEqual([['message', 1], ['steps', 2], ['notice', 1], ['steps', 1]])
  expect(executionGroupLabel(groups[1].entries)).toBe('已操作网页 · 已处理文件')
  expect(executionGroupLabel(groups[3].entries)).toBe('正在处理文件')
})
it('collapses successful groups while keeping failure and approval details visible', () => {
  const html = renderToStaticMarkup(<ExecutionTimeline entries={[entry('读取', 'file'), entry('说明', 'assistant'), entry('失败', 'tool', 'failed'), { ...entry('授权', 'approval', 'running'), approvalId: 'auth' }]} onApprovalDecision={() => {}} />)
  expect(html).toContain('class="execution-step-group"><summary>')
  expect(html).toContain('class="execution-step-group" open=""')
  expect(html).toContain('1 个步骤失败')
  expect(html).toContain('允许本次操作')
  expect(html).not.toContain('深度思考')
})
it('does not repeat the final answer in progress groups', () => {
  const html = renderToStaticMarkup(<ExecutionTimeline finalResponse="已完成报告" entries={[entry('读取', 'file'), entry('已完成报告', 'assistant')]} />)
  expect(html).not.toContain('已完成报告')
  expect(html).toContain('已处理文件')
})

it('summarizes real action categories without counting repeated reads as distinct files', () => {
  const entries = [
    { ...entry('read-one', 'file'), toolName: 'local_files_read_text', path: 'same.ts' },
    { ...entry('read-two', 'file'), toolName: 'local_files_read_text', path: 'same.ts' },
    { ...entry('write', 'file'), toolName: 'local_files_write_text' },
    { ...entry('run', 'command'), toolName: 'bash' },
  ]
  expect(executionGroupLabel(entries)).toBe('已读取文件 · 已编辑文件 · 已运行命令')
  expect(executionGroupStatus(entries)).toBe('共 4 次操作 · 完成 4')
})

it('never labels failed or canceled actions as completed or command text as verified work', () => {
  const entries = [
    { ...entry('read', 'file'), toolName: 'local_files_read_text' },
    { ...entry('write', 'file', 'failed'), toolName: 'local_files_write_text' },
    { ...entry('command', 'command', 'canceled'), text: 'curl search.example && edit file' },
    { ...entry('browser', 'browser', 'running'), toolName: 'browser_open' },
  ]
  expect(executionGroupLabel(entries)).toBe('1 个步骤失败 · 1 个步骤已停止 · 正在打开网页 · 已读取文件')
  expect(executionGroupLabel(entries)).not.toContain('已编辑')
  expect(executionGroupLabel(entries)).not.toContain('搜索网页')
  expect(executionGroupStatus(entries)).toBe('共 4 次操作 · 完成 1 · 失败 1 · 停止 1 · 执行中')
})

it('bounds long summaries and recognizes Office aliases and knowledge tools', () => {
  const entries = ['office.document.read', 'office_xlsx_update_cells', 'office.docx.create', 'knowledge_search'].map((toolName) => ({ ...entry(toolName, 'tool'), toolName }))
  expect(executionGroupLabel(entries)).toBe('已读取文件 · 已编辑表格 · 已生成文档 · 另有 1 类操作完成')
  expect(executionGroupLabel([entries[3]])).toBe('已检索知识库')
  expect(executionGroupLabel([])).toBe('暂无执行步骤')
})

it('shows error details supplied as text without hiding them inside a successful group', () => {
  const html = renderToStaticMarkup(<ExecutionTimeline entries={[{ ...entry('连接失败', 'error', 'failed'), text: '连接器响应超时，请重试。' }]} />)
  expect(html).toContain('连接器响应超时，请重试。')
  expect(html).toContain('open=""')
  expect(html).not.toContain('execution-step-group')
})

it('opens warning details even when the notification itself completed successfully', () => {
  const html = renderToStaticMarkup(<ExecutionTimeline entries={[{ ...entry('部分数据不可用', 'warning'), text: '连接器未配置，其他步骤仍可执行。' }]} />)
  expect(html).toContain('timeline-warning completed" open=""')
  expect(html).toContain('连接器未配置')
})
