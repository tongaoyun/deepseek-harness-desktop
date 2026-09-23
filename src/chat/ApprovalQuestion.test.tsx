// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApprovalSegment, QuestionSegment } from '../conversation/types'
import { ApprovalCard } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

const approval: ApprovalSegment = {
  kind: 'approval', id: 'approval:a1', approvalId: 'a1', toolName: 'local_files_write_text',
  label: '需要确认：local_files_write_text', status: 'running', detail: '写入 report.md',
}
const question: QuestionSegment = {
  kind: 'question', id: 'question:q1', questionId: 'q1', label: '需要你的回答', status: 'running',
  questions: [{
    id: 'q1', question: '选择统计口径', header: '口径', detail: '**按自然月**统计',
    options: [{ label: '自然月', description: '每月 1 日起' }, { label: '财务月' }],
  }],
}

async function mount(node: React.ReactNode) {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  await act(async () => root.render(node))
  return { container, root, cleanup: async () => { await act(async () => root.unmount()); container.remove() } }
}
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)

it('submits one approval decision and never repeats it', async () => {
  const decide = vi.fn(async () => undefined)
  const app = await mount(<ApprovalCard segment={approval} enabled onDecision={decide} />)
  try {
    await act(async () => button(app.container, '允许一次')!.click())
    expect(decide).toHaveBeenCalledWith('a1', 'allow')
    expect(button(app.container, '允许一次')!.disabled).toBe(true)
    expect(button(app.container, '拒绝')!.disabled).toBe(true)
    await act(async () => button(app.container, '允许一次')!.click())
    expect(decide).toHaveBeenCalledOnce()
    expect(app.container.textContent).toContain('已允许，等待执行')
  } finally { await app.cleanup() }
})

it('reports an approval failure locally and allows a retry', async () => {
  const decide = vi.fn().mockRejectedValueOnce(new Error('连接已断开')).mockResolvedValue(undefined)
  const app = await mount(<ApprovalCard segment={approval} enabled onDecision={decide} />)
  try {
    await act(async () => button(app.container, '拒绝')!.click())
    expect(app.container.textContent).toContain('连接已断开')
    await act(async () => button(app.container, '拒绝')!.click())
    expect(decide).toHaveBeenCalledTimes(2)
    expect(app.container.textContent).toContain('已允许，等待执行')
  } finally { await app.cleanup() }
})

it('disables confirmation once the turn has stopped', async () => {
  const decide = vi.fn(async () => undefined)
  const app = await mount(<ApprovalCard segment={approval} enabled={false} onDecision={decide} />)
  try {
    expect(button(app.container, '允许一次')!.disabled).toBe(true)
    expect(app.container.textContent).toContain('本轮已停止或结束')
    await act(async () => button(app.container, '允许一次')!.click())
    expect(decide).not.toHaveBeenCalled()
  } finally { await app.cleanup() }
})

it('formats an MCP approval without repeating the connector prefix', async () => {
  const app = await mount(<ApprovalCard segment={{ ...approval,
    toolName: 'mcp_erp-mcp_order_intake_rollback_watermark',
    detail: '调用「erp-mcp」修改工具：mcp_erp-mcp_order_intake_rollback_watermark\n参数：{"request":{"shop":"TikTok1414-MY"}}',
  }} enabled onDecision={vi.fn()} />)
  try {
    expect(app.container.textContent).toContain('操作确认')
    expect(app.container.textContent).toContain('erp-mcp · 修改操作')
    expect(app.container.querySelector('.approval-operation code')?.textContent).toBe('order_intake_rollback_watermark')
    expect(app.container.querySelector('.approval-arguments pre')?.textContent).toContain('\n  "request": {')
    expect(app.container.querySelector('.approval-arguments pre')?.textContent).toContain('"shop": "TikTok1414-MY"')
  } finally { await app.cleanup() }
})

it('collapses a settled approval into a quiet audit row', async () => {
  const app = await mount(<ApprovalCard segment={{ ...approval, status: 'completed' }} enabled onDecision={vi.fn()} />)
  try {
    expect(app.container.textContent).toContain('已允许本次操作')
    expect(button(app.container, '允许一次')).toBeUndefined()
    expect(app.container.querySelector('.approval-card.settled')).not.toBeNull()
  } finally { await app.cleanup() }
})

it('submits a structured single-choice answer once', async () => {
  const answer = vi.fn(async () => undefined)
  const app = await mount(<QuestionCard segment={question} enabled onAnswer={answer} />)
  try {
    expect(app.container.textContent).toContain('按自然月')
    await act(async () => app.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[0]!.click())
    await act(async () => button(app.container, '发送回答')!.click())
    expect(answer).toHaveBeenCalledWith('q1', [{ id: 'q1', selected: ['自然月'] }])
    expect(button(app.container, '等待继续')!.disabled).toBe(true)
  } finally { await app.cleanup() }
})

it('supports multi-select plus custom text in one answer', async () => {
  const multi: QuestionSegment = {
    ...question,
    questions: [{ id: 'q1', question: '包含哪些维度？', options: [{ label: '地区' }, { label: '渠道' }], multiSelect: true }],
  }
  const answer = vi.fn(async () => undefined)
  const app = await mount(<QuestionCard segment={multi} enabled onAnswer={answer} />)
  try {
    await act(async () => app.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!.click())
    await act(async () => app.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click())
    const textarea = app.container.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, '再按周汇总')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button(app.container, '发送回答')!.click())
    expect(answer).toHaveBeenCalledWith('q1', [{ id: 'q1', selected: ['地区', '渠道'], custom: '再按周汇总' }])
  } finally { await app.cleanup() }
})

it('renders a settled question as answered instead of asking again', async () => {
  const app = await mount(<QuestionCard segment={{ ...question, status: 'completed', answers: [{ id: 'q1', selected: ['自然月'] }] }} enabled onAnswer={vi.fn()} />)
  try {
    expect(app.container.textContent).toContain('已回答：自然月')
    expect(button(app.container, '发送回答')).toBeUndefined()
  } finally { await app.cleanup() }
})

it('replays each answered question on its own row', async () => {
  const app = await mount(<QuestionCard segment={{
    ...question,
    status: 'completed',
    questions: [{ id: 'stack', question: '选择技术栈' }, { id: 'scope', question: '选择范围' }],
    answers: [{ id: 'stack', selected: ['Java'] }, { id: 'scope', selected: ['核心闭环'] }],
  }} enabled onAnswer={vi.fn()} />)
  try {
    const rows = app.container.querySelectorAll('.question-settled')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('选择技术栈')
    expect(rows[0].textContent).toContain('已回答：Java')
    expect(rows[0].textContent).not.toContain('核心闭环')
    expect(rows[1].textContent).toContain('选择范围')
    expect(rows[1].textContent).toContain('已回答：核心闭环')
  } finally { await app.cleanup() }
})

it('keeps long answered questions and answers readable instead of truncating them', async () => {
  const longQuestion = '请说明本次订单分析需要覆盖的业务范围、时间口径、异常订单处理方式以及最终需要输出的指标明细'
  const longAnswer = '按自然月统计，包含退款和取消订单，并补充渠道、地区和商品维度的汇总结果'
  const app = await mount(<QuestionCard segment={{
    ...question,
    status: 'completed',
    questions: [{ id: 'long', question: longQuestion }],
    answers: [{ id: 'long', selected: [], custom: longAnswer }],
  }} enabled onAnswer={vi.fn()} />)
  try {
    const row = app.container.querySelector('.question-settled')
    expect(row?.textContent).toContain(longQuestion)
    expect(row?.textContent).toContain(`已回答：${longAnswer}`)
  } finally { await app.cleanup() }
})

it('collapses an unanswered question when the turn stops', async () => {
  const app = await mount(<QuestionCard segment={question} enabled={false} onAnswer={vi.fn()} />)
  try {
    expect(app.container.textContent).toContain('已停止')
    expect(app.container.querySelector('fieldset')).toBeNull()
    expect(button(app.container, '发送回答')).toBeUndefined()
  } finally { await app.cleanup() }
})

it('localizes plan review while preserving the raw approval value sent to Harness', async () => {
  const answer = vi.fn(async () => undefined)
  const plan: QuestionSegment = {
    ...question,
    questions: [{
      id: 'plan-review', header: 'Plan review', question: 'Approve this plan and leave plan mode?',
      detail: '# 新增订单系统\n\n## 目标\n完成规划。', intent: { kind: 'plan-review', approve: 'Approve' },
      options: [
        { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
        { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
      ],
    }],
  }
  const app = await mount(<QuestionCard segment={plan} enabled onAnswer={answer} />)
  try {
    expect(app.container.textContent).toContain('计划确认')
    expect(app.container.textContent).toContain('请确认是否采用这份计划')
    expect(app.container.textContent).toContain('采用此计划')
    expect(app.container.textContent).toContain('继续完善')
    expect(app.container.textContent).not.toContain('Plan review')
    expect(app.container.textContent).not.toContain('Keep planning')
    expect(app.container.querySelector('.plan-review-document h1')?.textContent).toBe('新增订单系统')
    await act(async () => app.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[0]!.click())
    await act(async () => button(app.container, '提交选择')!.click())
    expect(answer).toHaveBeenCalledWith('q1', [{ id: 'plan-review', selected: ['Approve'] }])
  } finally { await app.cleanup() }
})

it('advances after a single choice and keeps prior selections', async () => {
  const answer = vi.fn(async () => undefined)
  const multiQuestion: QuestionSegment = {
    ...question,
    questions: [
      { id: 'stack', question: '选择技术栈', options: [{ label: 'Java' }, { label: 'Go' }] },
      { id: 'scope', question: '选择范围', options: [{ label: '核心闭环' }, { label: '完整订单域' }] },
    ],
  }
  const app = await mount(<QuestionCard segment={multiQuestion} enabled onAnswer={answer} />)
  try {
    expect(app.container.textContent).toContain('1 / 2')
    expect(app.container.textContent).toContain('选择技术栈')
    await act(async () => app.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[0]!.click())
    expect(app.container.textContent).toContain('2 / 2')
    expect(app.container.textContent).toContain('选择范围')
    await act(async () => app.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[0]!.click())
    await act(async () => button(app.container, '发送回答')!.click())
    expect(answer).toHaveBeenCalledWith('q1', [
      { id: 'stack', selected: ['Java'] },
      { id: 'scope', selected: ['核心闭环'] },
    ])
  } finally { await app.cleanup() }
})

it('keeps a multi-select question in place until Next is clicked', async () => {
  const multiPage: QuestionSegment = {
    ...question,
    questions: [
      { id: 'features', question: '选择能力', options: [{ label: '订单' }, { label: '库存' }], multiSelect: true },
      { id: 'scope', question: '选择范围', options: [{ label: 'MVP' }] },
    ],
  }
  const app = await mount(<QuestionCard segment={multiPage} enabled onAnswer={vi.fn()} />)
  try {
    await act(async () => app.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!.click())
    expect(app.container.textContent).toContain('1 / 2')
    expect(button(app.container, '下一题')!.disabled).toBe(false)
    await act(async () => button(app.container, '下一题')!.click())
    expect(app.container.textContent).toContain('2 / 2')
    expect(app.container.textContent).toContain('选择范围')
  } finally { await app.cleanup() }
})
