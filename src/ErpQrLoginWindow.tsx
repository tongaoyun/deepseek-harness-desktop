import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LoaderCircle, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type Configuration = { loginUrl: string }

const DINGTALK_LOGIN_ORIGIN = 'https://login.dingtalk.com'

export function ErpQrLoginWindow() {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const completingRef = useRef(false)
  const [configuration, setConfiguration] = useState<Configuration | null>(null)
  const [status, setStatus] = useState('正在加载钉钉二维码…')
  const [error, setError] = useState('')

  async function loadConfiguration() {
    completingRef.current = false
    setConfiguration(null)
    setStatus('正在加载钉钉二维码…')
    setError('')
    try {
      const value = await invoke<Configuration>('erp_qr_login_configuration')
      setConfiguration(value)
      setStatus('请使用钉钉扫描二维码')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause || '无法加载钉钉二维码'))
    }
  }

  useEffect(() => { void loadConfiguration() }, [])

  useEffect(() => {
    const receiveLoginCode = (event: MessageEvent) => {
      if (event.origin !== DINGTALK_LOGIN_ORIGIN || event.source !== frameRef.current?.contentWindow) return
      if (typeof event.data !== 'string' || !event.data.trim() || completingRef.current) return
      completingRef.current = true
      setStatus('已确认，正在完成 ERP 登录…')
      setError('')
      void invoke('complete_erp_qr_login', { loginTmpCode: event.data.trim() }).catch((cause) => {
        completingRef.current = false
        setStatus('ERP 登录未完成')
        setError(cause instanceof Error ? cause.message : String(cause || '无法完成 ERP 登录'))
      })
    }
    window.addEventListener('message', receiveLoginCode)
    return () => window.removeEventListener('message', receiveLoginCode)
  }, [])

  return (
    <main className="erp-qr-window">
      <button aria-label="关闭扫码窗口" className="erp-qr-close" onClick={() => void getCurrentWindow().close()} type="button"><X size={18} /></button>
      <header><span><ShieldCheck size={17} /></span><div><strong>企业身份认证</strong><small>小胤 · 马帮 ERP</small></div></header>
      <h1>扫码登录</h1>
      <p>使用钉钉扫描下方二维码并在手机上确认。</p>
      <div className="erp-qr-code">
        {configuration
          ? <iframe
              ref={frameRef}
              sandbox="allow-same-origin allow-scripts"
              src={configuration.loginUrl}
              title="钉钉扫码登录"
            />
          : <LoaderCircle aria-label="正在加载二维码" className="spin" size={36} />}
      </div>
      <strong className="erp-qr-state">{status}</strong>
      {error && <p className="erp-qr-window-error" role="alert">{error}</p>}
      {error && <button className="erp-qr-refresh" onClick={() => void loadConfiguration()} type="button"><RefreshCw size={14} /> 重新加载</button>}
      <small className="erp-qr-security">二维码状态由钉钉官方页面处理，扫码凭据不会保存在桌面端。</small>
    </main>
  )
}
