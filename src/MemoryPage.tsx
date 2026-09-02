import { BrainCircuit, Download, History, Save, ShieldCheck, Upload } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { emptyMemoryProfile, loadMemoryHistory, loadSyncedMemoryProfile, saveSyncedMemoryProfile, type MemoryProfile, type MemoryRevision } from './memory'

interface Props {
  employeeId: string
  endpoint: string
  accessToken: string
  onSaved: (profile: MemoryProfile) => Promise<void> | void
}

export function MemoryPage({ employeeId, endpoint, accessToken, onSaved }: Props) {
  const [profile, setProfile] = useState<MemoryProfile>(emptyMemoryProfile)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [history, setHistory] = useState<MemoryRevision[]>([])

  useEffect(() => {
    void Promise.all([loadSyncedMemoryProfile(employeeId, endpoint, accessToken), loadMemoryHistory(employeeId)])
      .then(([value, revisions]) => { setProfile(value); setHistory(revisions) })
      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false))
  }, [employeeId, endpoint, accessToken])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setMessage('')
    try {
      const saved = await saveSyncedMemoryProfile(employeeId, endpoint, accessToken, profile)
      setProfile(saved)
      setHistory(await loadMemoryHistory(employeeId))
      await onSaved(saved)
      setMessage('已保存并同步，后续桌面对话、本机 IM 和其他电脑都会使用这份工作手册。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const exportMemory = () => {
    const payload = JSON.stringify({ schemaVersion: '1', exportedAt: new Date().toISOString(), profile }, null, 2)
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `xiaoyin-memory-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const importMemory = async (file?: File) => {
    if (!file) return
    try {
      const value = JSON.parse(await file.text()) as { profile?: MemoryProfile }
      const imported = value.profile
      if (!imported || typeof imported.collaborationStyle !== 'string' || typeof imported.workManual !== 'string' || typeof imported.enabled !== 'boolean') throw new Error('记忆文件格式无效')
      setProfile({ ...imported, updatedAt: profile.updatedAt })
      setMessage('已读取记忆文件，请检查内容后点击“保存设置”生效。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  return <form className="memory-page" onSubmit={(event) => void submit(event)}>
    <header className="memory-intro">
      <span><BrainCircuit size={22} /></span>
      <div><h2>记忆</h2><p>定制小胤与你长期协作的方式，并把稳定的业务偏好带到后续会话。</p></div>
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
    <section className="memory-history"><header><div><History size={16} /><span><strong>版本与迁移</strong><small>{profile.updatedAt ? `当前版本 ${new Date(profile.updatedAt).toLocaleString()}` : '尚未保存'}</small></span></div><div><label><Upload size={13} />导入<input accept="application/json,.json" onChange={(event) => void importMemory(event.target.files?.[0])} type="file" /></label><button onClick={exportMemory} type="button"><Download size={13} />导出</button></div></header>{history.slice(0, 5).map((revision) => <article key={revision.id}><span><strong>{new Date(revision.savedAt).toLocaleString()}</strong><small>{revision.profile.workManual.slice(0, 80) || revision.profile.collaborationStyle.slice(0, 80) || '空白记忆'}</small></span><button onClick={() => { setProfile(revision.profile); setMessage('已载入历史版本，点击“保存设置”后生效。') }} type="button">恢复</button></article>)}{history.length === 0 && <p>保存后会在本机保留最近 50 个版本。</p>}</section>
    <div className="memory-footer"><span><ShieldCheck size={14} />本机保留版本并同步到公司控制中心；“记住：规则”会先征求确认。</span><button disabled={loading || saving} type="submit"><Save size={14} />{saving ? '正在保存…' : '保存设置'}</button></div>
    {message && <div className="memory-message">{message}</div>}
  </form>
}
