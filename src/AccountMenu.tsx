import { ChevronUp, HelpCircle, LogOut, MessageSquareWarning, Settings, X } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { DesktopUpdater } from './DesktopUpdater'
import type { RuntimeStatus } from './types'

interface AccountMenuProps {
  companyName?: string
  department?: string
  displayName?: string
  runtimeStatus: RuntimeStatus
  onFeedback: (message: string) => Promise<void>
  onLogout: () => Promise<void>
  onSettings: () => void
}

export function AccountMenu({ companyName, department, displayName, runtimeStatus, onFeedback, onLogout, onSettings }: AccountMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [feedbackState, setFeedbackState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const accountButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const dismiss = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!feedbackOpen) return
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFeedbackOpen(false)
    }
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('keydown', escape)
      accountButtonRef.current?.focus()
    }
  }, [feedbackOpen])

  const submitFeedback = async (event: FormEvent) => {
    event.preventDefault()
    if (!feedback.trim() || feedbackState === 'sending') return
    setFeedbackState('sending')
    try {
      await onFeedback(feedback.trim())
      setFeedback('')
      setFeedbackState('sent')
    } catch {
      setFeedbackState('error')
    }
  }

  return <>
    <div className="account-area" ref={rootRef}>
      {menuOpen && <section aria-label="账户菜单" className="account-menu">
        <header><span>{displayName?.slice(0, 1) ?? '员'}</span><div><strong>{displayName ?? '企业员工'}</strong><small>{department || '跨境运营'} · {companyName || '企业内部版'}</small></div></header>
        <div className="account-runtime"><i className={`status-dot ${runtimeStatus}`} /><span>{runtimeStatus === 'ready' ? '企业服务已连接' : runtimeStatus === 'offline' ? '企业服务离线' : '企业服务连接中'}</span></div>
        <div className="account-menu-items">
          <button onClick={() => { setMenuOpen(false); onSettings() }} type="button"><Settings size={16} /><span><strong>桌面设置</strong><small>记忆、设备能力与运行环境</small></span></button>
          <DesktopUpdater onAvailabilityChange={setUpdateAvailable} variant="menu" />
          <button onClick={() => { setMenuOpen(false); setFeedbackState('idle'); setFeedbackOpen(true) }} type="button"><HelpCircle size={16} /><span><strong>反馈与帮助</strong><small>提交问题或改进建议</small></span></button>
        </div>
        <button className="account-logout" onClick={() => void onLogout()} type="button"><LogOut size={16} />退出登录</button>
      </section>}
      <button aria-expanded={menuOpen} className="account" onClick={() => setMenuOpen((value) => !value)} ref={accountButtonRef} type="button">
        <span>{displayName?.slice(0, 1) ?? '员'}</span><div><strong>{displayName ?? '企业员工'} · {department || '跨境运营'}</strong><small>{companyName || '企业内部版'}</small></div>
        <span className="account-indicators">{updateAvailable && <i aria-label="发现新版本" className="update-dot" />}<i className={`status-dot ${runtimeStatus}`} /><ChevronUp className={menuOpen ? 'open' : ''} size={14} /></span>
      </button>
    </div>
    {feedbackOpen && <div className="feedback-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setFeedbackOpen(false) }} role="presentation"><form aria-labelledby="feedback-title" aria-modal="true" className="feedback-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={submitFeedback} role="dialog">
      <button aria-label="关闭反馈" className="feedback-close" onClick={() => setFeedbackOpen(false)} type="button"><X size={16} /></button>
      <span className="feedback-icon"><MessageSquareWarning size={22} /></span><small>反馈与帮助</small><h2 id="feedback-title">告诉我们哪里需要改进</h2>
      <p>反馈会发送到公司控制中心，不上传聊天内容、本地文件或隐藏的模型上下文。</p>
      {feedbackState === 'sent' ? <div className="feedback-success">反馈已收到，谢谢。我们会在控制中心跟进。</div> : <><textarea autoFocus maxLength={400} onChange={(event) => setFeedback(event.target.value)} placeholder="请描述遇到的问题、期望结果或建议…" value={feedback} />{feedbackState === 'error' && <div className="feedback-error">暂时无法提交，请检查企业服务连接后重试。</div>}</>}
      <div className="feedback-actions"><button className="secondary" onClick={() => setFeedbackOpen(false)} type="button">{feedbackState === 'sent' ? '完成' : '取消'}</button>{feedbackState !== 'sent' && <button disabled={!feedback.trim() || feedbackState === 'sending'} type="submit">{feedbackState === 'sending' ? '正在提交' : '提交反馈'}</button>}</div>
    </form></div>}
  </>
}
