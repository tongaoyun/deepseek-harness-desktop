import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Check, RefreshCw } from 'lucide-react'
import { beginDingTalkRegistration, pollDingTalkRegistration } from './localIm'

export function DingTalkRegistration({ revision, onAuthorized }: { revision: number; onAuthorized: (id: string, secret: string) => void }) {
  const [qr, setQr] = useState('')
  const [status, setStatus] = useState('正在获取二维码…')
  const [done, setDone] = useState(false)
  const [failed, setFailed] = useState(false)
  const callback = useRef(onAuthorized)
  callback.current = onAuthorized
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setQr(''); setDone(false); setFailed(false); setStatus('正在获取二维码…')
    const fail = (reason: unknown) => { if (!disposed) { setFailed(true); setStatus(reason instanceof Error ? reason.message : String(reason)) } }
    void (async () => {
      try {
        const session = await beginDingTalkRegistration()
        if (disposed) return
        const data = await QRCode.toDataURL(session.verificationUri, { width: 256, margin: 2, errorCorrectionLevel: 'M' })
        if (disposed) return
        setQr(data); setStatus('使用钉钉扫码，创建或选择机器人应用')
        const expires = Date.now() + session.expiresIn * 1000
        const poll = async () => {
          if (disposed) return
          if (Date.now() >= expires) { fail('二维码已过期，请刷新'); return }
          try {
            const result = await pollDingTalkRegistration(session.deviceCode)
            if (disposed) return
            if (result.status === 'SUCCESS') {
              setDone(true); setStatus('扫码成功，请检查准入策略并保存')
              callback.current(result.clientId, result.clientSecret)
              return
            }
            if (result.status !== 'WAITING') { fail(result.status === 'EXPIRED' ? '二维码已过期，请刷新' : '授权未完成，请刷新或使用手动配置'); return }
            setStatus('使用钉钉扫码，创建或选择机器人应用')
          } catch { if (!disposed) setStatus('扫码状态暂时无法读取，正在重试…') }
          if (!disposed) timer = setTimeout(poll, session.interval * 1000)
        }
        timer = setTimeout(poll, session.interval * 1000)
      } catch (reason) { fail(reason) }
    })()
    return () => { disposed = true; clearTimeout(timer) }
  }, [revision])
  return <div className="im-registration">
    <div className={`im-qr-frame${failed ? ' failed' : ''}`}>
      {done ? <Check size={52} /> : qr && !failed ? <img alt="钉钉机器人应用注册二维码" src={qr} /> : <RefreshCw className={failed ? '' : 'spin'} size={28} />}
    </div><p role={failed ? 'alert' : 'status'}>{status}</p>
  </div>
}
