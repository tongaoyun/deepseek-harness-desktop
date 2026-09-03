import { HelpCircle, MessageSquareWarning, X } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'

interface Props {
  onFeedback: (message: string) => Promise<void>
  variant: 'menu' | 'topbar'
}

export function FeedbackButton({ onFeedback, variant }: Props) {
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [open])

  const show = () => {
    setState('idle')
    setOpen(true)
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!feedback.trim() || state === 'sending') return
    setState('sending')
    try {
      await onFeedback(feedback.trim())
      setFeedback('')
      setState('sent')
    } catch {
      setState('error')
    }
  }

  return <>
    {variant === 'topbar'
      ? <button className="topbar-feedback" onClick={show} type="button"><HelpCircle size={15} />问题反馈</button>
      : <button onClick={show} type="button"><HelpCircle size={16} /><span><strong>反馈与帮助</strong><small>提交问题或改进建议</small></span></button>}
    {open && <div className="feedback-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }} role="presentation"><form aria-labelledby="feedback-title" aria-modal="true" className="feedback-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={submit} role="dialog">
      <button aria-label="关闭反馈" className="feedback-close" onClick={() => setOpen(false)} type="button"><X size={16} /></button>
      <span className="feedback-icon"><MessageSquareWarning size={22} /></span><small>反馈与帮助</small><h2 id="feedback-title">告诉我们哪里需要改进</h2>
      <p>反馈会发送到公司控制中心，不上传聊天内容、本地文件或隐藏的模型上下文。</p>
      {state === 'sent' ? <div className="feedback-success">反馈已收到，谢谢。我们会在控制中心跟进。</div> : <><textarea autoFocus maxLength={400} onChange={(event) => setFeedback(event.target.value)} placeholder="请描述遇到的问题、期望结果或建议…" value={feedback} />{state === 'error' && <div className="feedback-error">暂时无法提交，请检查内网连接后重试。</div>}</>}
      <div className="feedback-actions"><button className="secondary" onClick={() => setOpen(false)} type="button">{state === 'sent' ? '完成' : '取消'}</button>{state !== 'sent' && <button disabled={!feedback.trim() || state === 'sending'} type="submit">{state === 'sending' ? '正在提交' : '提交反馈'}</button>}</div>
    </form></div>}
  </>
}
