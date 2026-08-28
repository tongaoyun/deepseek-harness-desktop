import { isTauri } from '@tauri-apps/api/core'
import { DownloadCloud, RefreshCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useDesktopUpdater } from './updater'

export function DesktopUpdater() {
  const { state, checkForUpdates, install } = useDesktopUpdater()
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    if (state.phase === 'available') setDialogOpen(true)
    if (state.phase === 'current') setDialogOpen(false)
  }, [state.phase])

  if (!isTauri()) return null

  const busy = state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'installing'
  const buttonLabel = state.phase === 'available'
    ? `发现新版本 v${state.version}`
    : state.phase === 'checking'
      ? '正在检查更新'
      : state.phase === 'current'
        ? '已是最新版'
        : '检查更新'
  const openOrCheck = () => {
    if (state.phase === 'available' || state.phase === 'downloading' || state.phase === 'installing' || state.phase === 'error') {
      setDialogOpen(true)
    } else {
      void checkForUpdates()
    }
  }

  return <>
    <button className={`updater-trigger ${state.phase}`} disabled={busy} onClick={openOrCheck} type="button">
      <RefreshCw className={state.phase === 'checking' ? 'spin' : ''} size={14} /> {buttonLabel}
    </button>
    {dialogOpen && <div aria-modal="true" className="update-overlay" role="dialog">
      <section className="update-dialog">
        {!busy && <button aria-label="稍后更新" className="update-close" onClick={() => setDialogOpen(false)} type="button"><X size={16} /></button>}
        <span className="update-icon"><DownloadCloud size={25} /></span>
        <small>小胤桌面更新</small>
        <h2>{state.phase === 'error'
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
