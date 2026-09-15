import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { TaskOutcomeDetails } from './TaskOutcomeDetails'
import { InlineTaskActivity } from './InlineTaskActivity'
import { taskStatusLabel, type TaskOutcome } from './taskOutcome'
import { harnessPromptWithConversationReplay } from './conversationReplay'
import { createXiaoyinTaskProjection } from './harness'
import type { LocalTaskRun } from './types'

it('shows outstanding work and check evidence without implying a finished turn completed the goal', () => {
  const outcome: TaskOutcome = { status: 'partial', summary: '表格已生成，尚未核对公式', remaining: ['安装重算引擎后核对公式'], checks: [{ description: '公式重算', result: 'not_run', evidence: '未找到 LibreOffice' }] }
  const projection = { ...createXiaoyinTaskProjection(), status: 'completed' as const, outcome }
  const html = renderToStaticMarkup(<><InlineTaskActivity projection={projection} /><TaskOutcomeDetails outcome={outcome} /></>)
  expect(html).toContain('部分完成')
  expect(html).toContain('安装重算引擎后核对公式')
  expect(html).toContain('未找到 LibreOffice')
  expect(html).not.toContain('任务已完成')
  expect(html).toContain('验收记录')
  expect(html).not.toContain('<details open')
  expect(html.indexOf('安装重算引擎后核对公式')).toBeGreaterThan(html.indexOf('<details'))
  const prompt = harnessPromptWithConversationReplay('继续核对', [{ role: 'user', text: '生成表格' }, { role: 'assistant', text: '表格已生成', projection }], true)
  expect(prompt).toContain('部分完成')
  expect(prompt).toContain('安装重算引擎后核对公式')
  expect(prompt).toContain('未找到 LibreOffice')
})

it('distinguishes a finished turn from a verified goal and prioritizes stop/failure labels', () => {
  const task = { status: 'COMPLETED', projection: createXiaoyinTaskProjection() } as LocalTaskRun
  expect(taskStatusLabel(task)).toBe('本轮已结束')
  expect(taskStatusLabel({ ...task, status: 'CANCELED' })).toBe('已停止')
  expect(taskStatusLabel({ ...task, status: 'FAILED' })).toBe('执行失败')
})

it('keeps the internal unverified fallback out of ordinary conversation UI', () => {
  const outcome: TaskOutcome = {
    status: 'unverified', summary: '本轮已结束，任务完成情况待核对。',
    remaining: ['核对当前成果和未完成事项后继续。'], checks: [],
  }
  const projection = { ...createXiaoyinTaskProjection(), status: 'completed' as const, outcome }
  const html = renderToStaticMarkup(<><InlineTaskActivity projection={projection} finalResponse="我是小胤。" /><TaskOutcomeDetails outcome={outcome} /></>)
  expect(html).toBe('')
  expect(taskStatusLabel({ status: 'COMPLETED', projection } as LocalTaskRun)).toBe('本轮已结束')
})

it('keeps successful verification metadata out of the final answer', () => {
  const outcome: TaskOutcome = {
    status: 'completed', summary: '下载目录已查看完毕。', remaining: [],
    checks: [{ description: '目录读取', result: 'passed', evidence: '已列出目录内容' }],
  }
  expect(renderToStaticMarkup(<TaskOutcomeDetails outcome={outcome} />)).toBe('')
})
