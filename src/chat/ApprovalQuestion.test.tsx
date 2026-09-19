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
    await act(async () => button(app.container, '允许本次操作')!.click())
    expect(decide).toHaveBeenCalledWith('a1', 'allow')
    expect(button(app.container, '允许本次操作')!.disabled).toBe(true)
    expect(button(app.container, '拒绝')!.disabled).toBe(true)
    await act(async () => button(app.container, '允许本次操作')!.click())
    expect(decide).toHaveBeenCalledOnce()
    expect(app.container.textContent).toContain('确认已发送')
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
    expect(app.container.textContent).toContain('确认已发送')
  } finally { await app.cleanup() }
})

it('disables confirmation once the turn has stopped', async () => {
  const decide = vi.fn(async () => undefined)
  const app = await mount(<ApprovalCard segment={approval} enabled={false} onDecision={decide} />)
  try {
    expect(button(app.container, '允许本次操作')!.disabled).toBe(true)
    expect(app.container.textContent).toContain('本轮已停止或结束')
    await act(async () => button(app.container, '允许本次操作')!.click())
    expect(decide).not.toHaveBeenCalled()
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

it('collapses an unanswered question when the turn stops', async () => {
  const app = await mount(<QuestionCard segment={question} enabled={false} onAnswer={vi.fn()} />)
  try {
    expect(app.container.textContent).toContain('已停止')
    expect(app.container.querySelector('fieldset')).toBeNull()
    expect(button(app.container, '发送回答')).toBeUndefined()
  } finally { await app.cleanup() }
})
