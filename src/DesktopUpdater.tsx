import { isTauri } from '@tauri-apps/api/core'
import { DownloadCloud, RefreshCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useDesktopUpdater } from './updater'

interface DesktopUpdaterProps {
  onAvailabilityChange?: (available: boolean) => void
  variant?: 'toolbar' | 'menu'
}

export function DesktopUpdater({ onAvailabilityChange, variant = 'toolbar' }: DesktopUpdaterProps) {
  const { state, checkForUpdates, install } = useDesktopUpdater()
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    onAvailabilityChange?.(state.phase === 'available')
  }, [onAvailabilityChange, state.phase])

  useEffect(() => {
    if (state.phase === 'unsupported') setDialogOpen(false)
  }, [state.phase])

  useEffect(() => {
    if (!dialogOpen) return
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !['checking', 'downloading', 'installing'].includes(state.phase)) setDialogOpen(false)
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [dialogOpen, state.phase])

  if (!isTauri()) return null

  const busy = state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'installing'
  const buttonLabel = state.phase === 'available'
    ? `发现新版本 v${state.version}`
    : state.phase === 'checking'
      ? '正在检查更新'
      : state.phase === 'current'
        ? '已是最新版'
        : state.phase === 'unsupported'
          ? '仅支持 Windows 更新'
        : '检查更新'
  const openOrCheck = () => {
    if (state.phase === 'available' || state.phase === 'downloading' || state.phase === 'installing' || state.phase === 'error') {
      setDialogOpen(true)
    } else {
      void checkForUpdates()
    }
  }

  return <>
    <button className={`updater-trigger ${variant} ${state.phase}`} disabled={busy || state.phase === 'unsupported'} onClick={openOrCheck} type="button">
      <RefreshCw className={state.phase === 'checking' ? 'spin' : ''} size={variant === 'menu' ? 16 : 14} />
      {variant === 'menu' ? <span><strong>{buttonLabel}</strong><small>{state.phase === 'available'
        ? '点击查看版本说明并安装'
        : state.phase === 'unsupported'
          ? 'macOS 开发环境不参与自动更新'
          : '获取最新正式版客户端'}</small></span> : buttonLabel}
    </button>
    {dialogOpen && <div className="update-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDialogOpen(false) }} role="presentation">
      <section aria-labelledby="update-title" aria-modal="true" className="update-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog">
        {!busy && <button aria-label="稍后更新" className="update-close" onClick={() => setDialogOpen(false)} type="button"><X size={16} /></button>}
        <span className="update-icon"><DownloadCloud size={25} /></span>
        <small>小胤桌面更新</small>
        <h2 id="update-title">{state.phase === 'error'
          ? '更新没有完成'
          : state.phase === 'checking'
            ? '正在检查更新'
            : `发现新版本 v${state.version ?? ''}`}</h2>
        {state.phase === 'error'
          ? <p className="update-error">{state.error || '暂时无法连接更新服务，请稍后重试。'}</p>
          : <p>{state.notes || `当前版本 v${state.currentVersion ?? '未知'}，建议更新到最新正式版。`}</p>}
        {(state.phase === 'downloading' || state.phase === 'installing') && <div className="update-progress">
          <div><i style={{ width: `${state.percent ?? 12}%` }} /></div>
          <span>{state.phase === 'installing' ? '正在安装并准备重启…' : state.percent === undefined ? '正在下载安装包…' : `正在下载 ${state.percent}%`}</span>
        </div>}
        <div className="update-actions">
          {state.phase === 'error'
            ? <button onClick={() => void checkForUpdates()} type="button">重新检查</button>
            : <>
              {!busy && <button className="secondary" onClick={() => setDialogOpen(false)} type="button">稍后提醒</button>}
              <button disabled={busy} onClick={() => void install()} type="button">{busy ? '更新进行中' : '立即更新'}</button>
            </>}
        </div>
      </section>
    </div>}
  </>
}
