import { ChevronLeft, ChevronRight, CircleHelp } from 'lucide-react'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { QuestionSegment } from '../conversation/types'
import type { TaskQuestionAnswer, TaskQuestionItem } from '../types'

export type QuestionAnswerHandler = (questionId: string, answers: TaskQuestionAnswer[]) => void | Promise<void>

/** Structured questions stay separate from activity receipts and use the same compact choice surface as Codex. */
export function QuestionCard({ segment, enabled, onAnswer }: {
  segment: QuestionSegment
  enabled: boolean
  onAnswer?: QuestionAnswerHandler
}) {
  const [answers, setAnswers] = useState<Record<string, TaskQuestionAnswer>>({})
  const [activeIndex, setActiveIndex] = useState(0)
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [error, setError] = useState('')
  const questions = segment.questions
  const question = questions[Math.min(activeIndex, questions.length - 1)]!
  const planReview = isPlanReview(question)
  const valid = questions.every((item) => {
    const answer = answers[item.id]
    return Boolean(answer?.selected.length || answer?.custom?.trim())
  })
  const locked = !enabled || state === 'sending' || state === 'sent'
  const select = (id: string, label: string, multi: boolean) => {
    setAnswers((current) => {
      const answer = current[id] ?? { id, selected: [] }
      const selected = multi
        ? answer.selected.includes(label) ? answer.selected.filter((item) => item !== label) : [...answer.selected, label]
        : [label]
      return { ...current, [id]: { ...answer, selected } }
    })
    if (!multi && activeIndex < questions.length - 1) setActiveIndex((index) => index + 1)
  }
  const submit = async (skip = false) => {
    if ((!skip && !valid) || !enabled || !onAnswer || state === 'sending' || state === 'sent') return
    setState('sending'); setError('')
    try {
      await onAnswer(segment.questionId, questions.map((item) => skip
        ? { id: item.id, selected: [] }
        : answers[item.id] ?? { id: item.id, selected: [] }))
      setState('sent')
    } catch (reason) {
      setState('error'); setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const settled = segment.status !== 'running' || !enabled
  if (settled) return <section className="timeline-question question-card settled" aria-label={segment.label}>
    {questions.map((item) => {
      const saved = segment.answers?.find((entry) => entry.id === item.id)
      const rawLabel = saved ? [...saved.selected, ...(saved.custom ? [saved.custom] : [])].join(' · ') : ''
      const label = isPlanReview(item) ? localizePlanAnswer(rawLabel) : rawLabel
      return <div className="question-settled" key={item.id}><CircleHelp size={15} /><span>{displayQuestion(item)}</span><small title={label}>{label ? `已回答：${label}` : segment.status === 'running' ? '已停止' : '回答已提交'}</small></div>
    })}
  </section>

  const answer = answers[question.id] ?? { id: question.id, selected: [] }
  const currentAnswered = Boolean(answer.selected.length || answer.custom?.trim())
  const lastQuestion = activeIndex === questions.length - 1
  return <section className={`timeline-question question-card active${planReview ? ' plan-review-card' : ''}`} aria-label={segment.label}>
    <header className="question-card-header">
      <div>{displayHeader(question) && <small>{displayHeader(question)}</small>}<strong>{displayQuestion(question)}</strong></div>
      {questions.length > 1 && <nav aria-label="问题分页">
        <button aria-label="上一个问题" disabled={activeIndex === 0} onClick={() => setActiveIndex((index) => Math.max(0, index - 1))} type="button"><ChevronLeft size={17} /></button>
        <span>{activeIndex + 1} / {questions.length}</span>
        <button aria-label="下一个问题" disabled={activeIndex === questions.length - 1} onClick={() => setActiveIndex((index) => Math.min(questions.length - 1, index + 1))} type="button"><ChevronRight size={17} /></button>
      </nav>}
    </header>
    {question.detail && <div className={`question-detail message-markdown${planReview ? ' plan-review-document' : ''}`}><ReactMarkdown remarkPlugins={[remarkGfm]}>{question.detail}</ReactMarkdown></div>}
    <fieldset disabled={locked}>
      {question.options?.map((option, index) => <label className="question-option" key={option.label}>
        <input checked={answer.selected.includes(option.label)} name={question.multiSelect ? undefined : question.id} onChange={() => select(question.id, option.label, Boolean(question.multiSelect))} type={question.multiSelect ? 'checkbox' : 'radio'} />
        <span className="question-option-index" aria-hidden="true">{index + 1}</span>
        <span><strong>{displayOptionLabel(question, option.label)}</strong>{option.description && <small>{displayOptionDescription(question, option.label, option.description)}</small>}</span>
        {!question.multiSelect && <ChevronRight className="question-option-arrow" size={18} />}
      </label>)}
      <textarea aria-label={`${question.question}的补充回答`} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: { ...answer, custom: event.target.value } }))} placeholder={planReview ? '填写希望调整的内容（可选）' : question.options?.length ? '填写其他答案或补充说明' : '输入你的回答'} rows={2} value={answer.custom ?? ''} />
    </fieldset>
    <footer className="timeline-question-actions">
      {!planReview && <button className="secondary" disabled={locked} onClick={() => void submit(true)} type="button">跳过</button>}
      {!lastQuestion
        ? <button disabled={!currentAnswered || locked} onClick={() => setActiveIndex((index) => Math.min(questions.length - 1, index + 1))} type="button">下一题</button>
        : <button disabled={!valid || locked} onClick={() => void submit()} type="button">{state === 'sending' ? '正在提交…' : state === 'sent' ? '等待继续' : planReview ? '提交选择' : '发送回答'}</button>}
    </footer>
    {state === 'error' && <p className="approval-feedback error" role="alert">{error}</p>}
  </section>
}

function isPlanReview(question: TaskQuestionItem): boolean {
  return question.intent?.kind === 'plan-review' || question.id === 'plan-review' || question.header === 'Plan review'
}

function displayHeader(question: TaskQuestionItem): string {
  return isPlanReview(question) ? '计划确认' : question.header ?? ''
}

function displayQuestion(question: TaskQuestionItem): string {
  return isPlanReview(question) ? '请确认是否采用这份计划' : question.question
}

function displayOptionLabel(question: TaskQuestionItem, label: string): string {
  if (!isPlanReview(question)) return label
  return label === question.intent?.approve || /^Approve$/i.test(label) ? '采用此计划' : /^Keep planning$/i.test(label) ? '继续完善' : label
}

function displayOptionDescription(question: TaskQuestionItem, label: string, fallback: string): string {
  if (!isPlanReview(question)) return fallback
  return label === question.intent?.approve || /^Approve$/i.test(label)
    ? '确认计划内容并结束规划模式。'
    : /^Keep planning$/i.test(label) ? '保持规划模式，并将补充说明交给模型继续修改。' : fallback
}

function localizePlanAnswer(answer: string | undefined): string | undefined {
  if (!answer) return answer
  return answer.replace(/Approve/gi, '采用此计划').replace(/Keep planning/gi, '继续完善')
}
