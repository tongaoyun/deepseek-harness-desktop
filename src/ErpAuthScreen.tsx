import { ShieldCheck } from 'lucide-react'
import { XiaoyinMascot } from './XiaoyinMascot'

type Props = { checking: boolean; error: string; onReopen: () => void }

export function ErpAuthScreen({ checking, error, onReopen }: Props) {
  return (
    <main className="erp-auth-screen">
      <section className="erp-auth-card" aria-live="polite">
        <div className="erp-auth-mascot"><XiaoyinMascot size={86} variant="hero" /></div>
        <span className="erp-auth-badge"><ShieldCheck size={14} /> 企业身份认证</span>
        <h1>{checking ? '正在检查登录状态' : '请扫码登录 ERP'}</h1>
        <p>{checking ? '小胤正在确认你的企业身份，请稍候。' : '已在独立窗口打开钉钉二维码。扫码成功后，小胤会自动进入工作台。'}</p>
        {!checking && <button onClick={onReopen} type="button">重新打开二维码</button>}
        {error && <p className="erp-auth-error" role="alert">{error}</p>}
        {!checking && <small>登录身份由企业服务校验，小胤不会保存 ERP 密码。</small>}
      </section>
    </main>
  )
}
