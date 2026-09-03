import { ChevronUp, LogOut, Settings } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { DesktopUpdater } from './DesktopUpdater'
import { FeedbackButton } from './FeedbackButton'

interface AccountMenuProps {
  companyName?: string
  department?: string
  displayName?: string
  onFeedback: (message: string) => Promise<void>
  onLogout: () => Promise<void>
  onSettings: () => void
}

export function AccountMenu({ companyName, department, displayName, onFeedback, onLogout, onSettings }: AccountMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

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

  return <>
    <div className="account-area" ref={rootRef}>
      <section aria-label="账户菜单" className="account-menu" hidden={!menuOpen}>
        <header><span>{displayName?.slice(0, 1) ?? '员'}</span><div><strong>{displayName ?? '企业员工'}</strong><small>{department || '跨境运营'} · {companyName || '企业内部版'}</small></div></header>
        <div className="account-menu-items">
          <button onClick={() => { setMenuOpen(false); onSettings() }} type="button"><Settings size={16} /><span><strong>桌面设置</strong><small>记忆、设备能力与运行环境</small></span></button>
          <DesktopUpdater onAvailabilityChange={setUpdateAvailable} variant="menu" />
          <FeedbackButton onFeedback={onFeedback} />
        </div>
        <button className="account-logout" onClick={() => void onLogout()} type="button"><LogOut size={16} />退出登录</button>
      </section>
      <button aria-expanded={menuOpen} className="account" onClick={() => setMenuOpen((value) => !value)} type="button">
        <span>{displayName?.slice(0, 1) ?? '员'}</span><div><strong>{displayName ?? '企业员工'} · {department || '跨境运营'}</strong><small>{companyName || '企业内部版'}</small></div>
        <span className="account-indicators">{updateAvailable && <i aria-label="发现新版本" className="update-dot" />}<ChevronUp className={menuOpen ? 'open' : ''} size={14} /></span>
      </button>
    </div>
  </>
}
