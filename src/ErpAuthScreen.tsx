import { ShieldCheck } from 'lucide-react'
import { XiaoyinMascot } from './XiaoyinMascot'

type Props = { authorizing: boolean; checking: boolean; error: string; onReopen: () => void }

export function ErpAuthScreen({ authorizing, checking, error, onReopen }: Props) {
  const busy = checking || authorizing
  return (
    <main className="erp-auth-screen">
      <section className="erp-auth-card" aria-live="polite">
        <div className="erp-auth-mascot"><XiaoyinMascot size={86} variant="hero" /></div>
        <span className="erp-auth-badge"><ShieldCheck size={14} /> 企业身份认证</span>
        <h1>{authorizing ? '正在完成登录' : checking ? '正在检查登录状态' : error ? '登录状态待确认' : '请扫码登录 ERP'}</h1>
        <p>{authorizing ? '钉钉已确认，小胤正在建立 ERP 会话，通常只需几秒。' : checking ? '小胤正在确认你的企业身份，请稍候。' : error ? '企业身份确认后将进入工作台。' : '点击下方按钮打开钉钉二维码。扫码成功后，小胤会自动进入工作台。'}</p>
        <button disabled={busy} onClick={onReopen} type="button">{authorizing ? '正在完成登录…' : checking ? '正在检查…' : error ? '重新检查' : '打开二维码'}</button>
        {error && <p className="erp-auth-error" role="alert">{error}</p>}
        {!busy && <small>登录身份由企业服务校验，小胤不会保存 ERP 密码。</small>}
      </section>
    </main>
  )
}
