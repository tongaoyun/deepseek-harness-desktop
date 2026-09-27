import { ShieldCheck } from 'lucide-react'
import { XiaoyinMascot } from './XiaoyinMascot'

type Props = { authorizing: boolean; checking: boolean; error: string; onReopen: () => void }

export function DingTalkAuthScreen({ authorizing, checking, error, onReopen }: Props) {
  const busy = checking || authorizing
  return (
    <main className="dingtalk-auth-screen">
      <section className="dingtalk-auth-card" aria-live="polite">
        <div className="dingtalk-auth-mascot"><XiaoyinMascot size={86} variant="hero" /></div>
        <span className="dingtalk-auth-badge"><ShieldCheck size={14} /> 钉钉身份认证</span>
        <h1>{authorizing ? '正在确认钉钉身份' : checking ? '正在检查登录状态' : error ? '登录状态待确认' : '请先登录钉钉'}</h1>
        <p>{authorizing ? '钉钉已打开，小胤正在等待官方授权结果。' : checking ? '小胤正在确认你的企业身份，请稍候。' : error ? '确认后将自动进入工作台。' : '小胤会打开钉钉官方授权，已登录钉钉的账号无需扫码。'}</p>
        <button disabled={busy} onClick={onReopen} type="button">{authorizing ? '正在确认…' : checking ? '正在检查…' : error ? '重新打开钉钉' : '打开钉钉'}</button>
        {error && <p className="dingtalk-auth-error" role="alert">{error}</p>}
        {!busy && <small>身份由钉钉企业应用确认，小胤不会保存钉钉密码。</small>}
      </section>
    </main>
  )
}
