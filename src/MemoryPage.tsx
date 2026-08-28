import { BrainCircuit, Save, ShieldCheck } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { emptyMemoryProfile, loadMemoryProfile, saveMemoryProfile, type MemoryProfile } from './memory'

interface Props {
  employeeId: string
  onSaved: (profile: MemoryProfile) => Promise<void> | void
}

export function MemoryPage({ employeeId, onSaved }: Props) {
  const [profile, setProfile] = useState<MemoryProfile>(emptyMemoryProfile)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    void loadMemoryProfile(employeeId)
      .then(setProfile)
      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false))
  }, [employeeId])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setMessage('')
    try {
      const saved = await saveMemoryProfile(employeeId, profile)
      setProfile(saved)
      await onSaved(saved)
      setMessage('已保存，后续桌面对话和 IM 消息都会使用这份工作手册。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return <form className="memory-page" onSubmit={(event) => void submit(event)}>
    <header className="memory-intro">
      <span><BrainCircuit size={22} /></span>
      <div><h2>意识</h2><p>定制小胤与你长期协作的方式，并把稳定的业务偏好带到后续会话。</p></div>
      <button aria-pressed={profile.enabled} className={`memory-switch ${profile.enabled ? 'on' : ''}`} disabled={loading || saving} onClick={() => setProfile((value) => ({ ...value, enabled: !value.enabled }))} type="button"><i /></button>
    </header>
    <div className="memory-grid">
      <label><span><strong>协作风格</strong><small>告诉小胤希望如何沟通、分析和呈现结果。</small></span>
        <textarea disabled={loading} maxLength={8_000} onChange={(event) => setProfile((value) => ({ ...value, collaborationStyle: event.target.value }))} placeholder="例如：先给结论，再说明风险；涉及金额时统一显示美元和人民币。" value={profile.collaborationStyle} />
        <em>{profile.collaborationStyle.length} / 8000</em>
      </label>
      <label><span><strong>工作手册</strong><small>记录长期有效的业务规则、术语、流程和判断标准。</small></span>
        <textarea disabled={loading} maxLength={16_000} onChange={(event) => setProfile((value) => ({ ...value, workManual: event.target.value }))} placeholder="例如：库存风险按 7/14/30 天覆盖率分级；广告诊断默认排除新品冷启动期。" value={profile.workManual} />
        <em>{profile.workManual.length} / 16000</em>
      </label>
    </div>
    <div className="memory-footer"><span><ShieldCheck size={14} />仅保存在本机，不上传控制中心；启用后自动作用于桌面对话和本机 IM。</span><button disabled={loading || saving} type="submit"><Save size={14} />{saving ? '正在保存…' : '保存设置'}</button></div>
    {message && <div className="memory-message">{message}</div>}
  </form>
}
