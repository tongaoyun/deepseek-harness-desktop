import { CircleHelp } from 'lucide-react'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { QuestionSegment } from '../conversation/types'
import type { TaskQuestionAnswer } from '../types'

export type QuestionAnswerHandler = (questionId: string, answers: TaskQuestionAnswer[]) => void | Promise<void>

/** Structured questions and plan reviews, answered in place inside the turn. */
export function QuestionCard({ segment, enabled, onAnswer }: {
  segment: QuestionSegment
  enabled: boolean
  onAnswer?: QuestionAnswerHandler
}) {
  const [answers, setAnswers] = useState<Record<string, TaskQuestionAnswer>>({})
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [error, setError] = useState('')
  const questions = segment.questions
  const valid = questions.every((question) => {
    const answer = answers[question.id]
    return Boolean(answer?.selected.length || answer?.custom?.trim())
  })
  const select = (id: string, label: string, multi: boolean) => setAnswers((current) => {
    const answer = current[id] ?? { id, selected: [] }
    const selected = multi
      ? answer.selected.includes(label) ? answer.selected.filter((item) => item !== label) : [...answer.selected, label]
      : [label]
    return { ...current, [id]: { ...answer, selected } }
  })
  const submit = async () => {
    if (!valid || !enabled || !onAnswer || state === 'sending' || state === 'sent') return
    setState('sending'); setError('')
    try {
      await onAnswer(segment.questionId, questions.map((question) => answers[question.id] ?? { id: question.id, selected: [] }))
      setState('sent')
    } catch (reason) {
      setState('error'); setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const settled = segment.status !== 'running' || !enabled
  const answerLabel = segment.answers?.flatMap((answer) => [...answer.selected, ...(answer.custom ? [answer.custom] : [])]).join(' · ')
  if (settled) return <section className="timeline-question question-card settled" aria-label={segment.label}>
    <div className="question-settled"><CircleHelp size={15} /><span>{questions[0]?.question ?? segment.label}</span><small title={answerLabel}>{answerLabel ? `已回答：${answerLabel}` : segment.status === 'running' ? '已停止' : '回答已提交'}</small></div>
  </section>
  return <section className="timeline-question question-card" aria-label={segment.label}>
    {questions.map((question) => {
      const answer = answers[question.id] ?? { id: question.id, selected: [] }
      return <fieldset key={question.id} disabled={!enabled || state === 'sending' || state === 'sent'}>
        <legend>{question.header && <small>{question.header}</small>}<strong>{question.question}</strong></legend>
        {question.detail && <div className="question-detail message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{question.detail}</ReactMarkdown></div>}
        {question.options?.map((option) => <label className="question-option" key={option.label}>
          <input checked={answer.selected.includes(option.label)} name={question.multiSelect ? undefined : question.id} onChange={() => select(question.id, option.label, Boolean(question.multiSelect))} type={question.multiSelect ? 'checkbox' : 'radio'} />
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        </label>)}
        <textarea aria-label={`${question.question}的补充回答`} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: { ...answer, custom: event.target.value } }))} placeholder={question.options?.length ? '填写具体信息或补充说明' : '输入你的回答'} rows={2} value={answer.custom ?? ''} />
      </fieldset>
    })}
    <div className="timeline-question-actions"><button disabled={!valid || !enabled || state === 'sending' || state === 'sent'} onClick={() => void submit()} type="button">{state === 'sending' ? '正在提交…' : state === 'sent' ? '等待继续' : '发送回答'}</button></div>
    {!enabled && <p className="approval-feedback" role="status">本轮已停止或结束，不能再回答。</p>}
    {state === 'error' && <p className="approval-feedback error" role="alert">{error}</p>}
  </section>
}
