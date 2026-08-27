import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LoaderCircle, RefreshCw, ShieldCheck, X } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'

type Configuration = { qrCodeContent: string; qrSessionCode: string; pollIntervalSeconds: number }
type PollResult = { status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error'; errorMessage: string | null }

export function ErpQrLoginWindow() {
  const [configuration, setConfiguration] = useState<Configuration | null>(null)
  const [qrImage, setQrImage] = useState('')
  const [status, setStatus] = useState('正在加载钉钉二维码…')
  const [error, setError] = useState('')

  async function loadConfiguration() {
    setConfiguration(null)
    setQrImage('')
    setStatus('正在加载钉钉二维码…')
    setError('')
    try {
      const value = await invoke<Configuration>('erp_qr_login_configuration')
      setQrImage(await QRCode.toDataURL(value.qrCodeContent, { width: 244, margin: 1, errorCorrectionLevel: 'M' }))
      setConfiguration(value)
      setStatus('请使用钉钉扫描二维码')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause || '无法加载钉钉二维码'))
    }
  }

  useEffect(() => { void loadConfiguration() }, [])

  useEffect(() => {
    if (!configuration) return
    let cancelled = false
    let timeout = 0
    const poll = async () => {
      try {
        const result = await invoke<PollResult>('poll_erp_qr_login', { qrSessionCode: configuration.qrSessionCode })
        if (cancelled) return
        if (result.status === 'confirmed') {
          setStatus('登录成功，正在进入 ERP…')
          return
        }
        if (result.status === 'expired' || result.status === 'error') {
          setStatus(result.status === 'expired' ? '二维码已失效' : '二维码状态异常')
          setError(result.errorMessage ?? (result.status === 'expired' ? '请重新生成二维码' : '无法确认扫码状态'))
          return
        }
        setStatus(result.status === 'scanned' ? '已扫码，请在手机上确认' : '请使用钉钉扫描二维码')
        timeout = window.setTimeout(() => void poll(), configuration.pollIntervalSeconds * 1_000)
      } catch (cause) {
        if (!cancelled) {
          setStatus('二维码状态查询失败')
          setError(cause instanceof Error ? cause.message : String(cause || '无法确认扫码状态'))
        }
      }
    }
    timeout = window.setTimeout(() => void poll(), configuration.pollIntervalSeconds * 1_000)
    return () => { cancelled = true; window.clearTimeout(timeout) }
  }, [configuration])

  return (
    <main className="erp-qr-window">
      <button aria-label="关闭扫码窗口" className="erp-qr-close" onClick={() => void getCurrentWindow().close()} type="button"><X size={18} /></button>
      <header><span><ShieldCheck size={17} /></span><div><strong>企业身份认证</strong><small>小胤 · 马帮 ERP</small></div></header>
      <h1>扫码登录</h1>
      <p>使用钉钉扫描下方二维码并在手机上确认。</p>
      <div className="erp-qr-code">{qrImage ? <img alt="钉钉登录二维码" src={qrImage} /> : <LoaderCircle aria-label="正在加载二维码" className="spin" size={36} />}</div>
      <strong className="erp-qr-state">{status}</strong>
      {error && <p className="erp-qr-window-error" role="alert">{error}</p>}
      {error && <button className="erp-qr-refresh" onClick={() => void loadConfiguration()} type="button"><RefreshCw size={14} /> 重新加载</button>}
      <small className="erp-qr-security">扫码凭据仅用于本次 ERP 登录，不会保存在桌面端。</small>
    </main>
  )
}
