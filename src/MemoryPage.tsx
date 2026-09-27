import { BrainCircuit, Save } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { emptyMemoryProfile, loadMemoryHistory, loadSyncedMemoryProfile, memorySaveMessage, memoryContents, resolveMemoryConflict, saveSyncedMemoryProfile, upsertMemoryEntry, validateMemoryProfile, type MemoryProfile, type MemoryRevision } from './memory'
import { relatedMemories } from './memoryEditing'
import { useDesktopDialog } from './DesktopDialog'
import { useMemoryChoice } from './MemoryChoiceDialog'
import './memory.css'

interface Props {
  employeeId: string
  endpoint: string
  sessionToken: string
  onSaved: (profile: MemoryProfile) => Promise<void> | void
  onOpenTask?: (id: string) => void
}
const styles = [
  ['简洁直接', '先给结论，再给必要依据。简洁表达，不重复问题；需要我决定时说明推荐方案。'],
  ['细致严谨', '说明关键依据、假设和不确定性。交付前检查结果，必要时补充可验证的来源。'],
  ['耐心易懂', '使用清晰易懂的语言，解释必要术语。复杂任务分步说明，提供可操作的建议。'],
]
export function MemoryPage({ employeeId, endpoint, sessionToken, onSaved, onOpenTask }: Props) {
  const [profile, setProfile] = useState<MemoryProfile>(emptyMemoryProfile)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [message, setMessage] = useState('')
  const [history, setHistory] = useState<MemoryRevision[]>([])
  const [query, setQuery] = useState('')
  const [reload, setReload] = useState(0)
  const saveLock = useRef(false)
  const unreadableDraft = useRef(false)
  const { confirm, dialog: confirmation } = useDesktopDialog()
  const { choose, dialog: choiceDialog } = useMemoryChoice()
  const [baseline, setBaseline] = useState('')
  const [newText, setNewText] = useState('')
  const [newKind, setNewKind] = useState<'preference' | 'fact'>('fact')
  const [adding, setAdding] = useState(false)
  const [draftError, setDraftError] = useState('')
  const dirty = !loading && Boolean(baseline) && (memoryContents(profile) !== baseline || Boolean(newText))
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const draftKey = `xiaoyin.memory-draft.${employeeId}`
  const clearDraft = () => { window.localStorage.removeItem(draftKey); unreadableDraft.current = false; setDraftError('') }
  useEffect(() => {
    if (loading || !baseline || unreadableDraft.current) return
    try {
      if (dirty) window.localStorage.setItem(draftKey, JSON.stringify({ profile, newText, newKind }))
      else window.localStorage.removeItem(draftKey)
      setDraftError('')
    } catch { setDraftError('未保存草稿无法写入本机，请先保存设置再离开。') }
  }, [draftKey, dirty, profile, newText, newKind, loading, baseline])
  useEffect(() => {
    const onUnload = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ employeeId: string; profile: MemoryProfile }>).detail
      if (detail?.employeeId !== employeeId || saveLock.current) return
      if (dirtyRef.current) { setMessage('记忆有新的同步结果；未保存草稿已保留，保存前会检查版本。'); return }
      setProfile(detail.profile); setBaseline(memoryContents(detail.profile)); setMessage(detail.profile.syncPending ? memorySaveMessage(detail.profile) : '')
    }
    window.addEventListener('xiaoyin:memory-updated', update)
    return () => window.removeEventListener('xiaoyin:memory-updated', update)
  }, [employeeId])
  useEffect(() => {
    let allowed: HTMLElement | undefined
    let asking = false
    const leave = (event: MouseEvent) => {
      const target = (event.target as Element)?.closest<HTMLElement>('.sidebar button, .settings-navigation button')
      if (!target || !dirtyRef.current || target === allowed) return
      event.preventDefault(); event.stopImmediatePropagation()
      if (asking) return
      asking = true
      void confirm({ title: '记忆修改尚未保存', message: draftError || '离开后保留本机草稿，再次进入可继续编辑。未保存内容不会影响任务。', confirmLabel: '保留草稿并离开' })
        .then((yes) => { if (yes && !draftError && target.isConnected) { allowed = target; target.click(); allowed = undefined } })
        .finally(() => { asking = false })
    }
    document.addEventListener('click', leave, true)
    return () => document.removeEventListener('click', leave, true)
  }, [confirm, draftError])
  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadError('')
    void Promise.all([loadSyncedMemoryProfile(employeeId, endpoint, sessionToken), loadMemoryHistory(employeeId)])
      .then(([value, revisions]) => { if (active) {
        setBaseline(memoryContents(value)); setProfile(value); setHistory(revisions); setNewText(''); setMessage(value.syncPending ? memorySaveMessage(value) : '')
        try {
          const draft = JSON.parse(window.localStorage.getItem(draftKey) ?? 'null') as { profile: MemoryProfile; newText?: string; newKind?: 'preference' | 'fact' } | null
          if (draft) {
            validateMemoryProfile({ ...draft.profile, entries: draft.profile.entries?.map((entry) => ({ ...entry, text: entry.text === '' ? '未填写草稿' : entry.text })) })
            if (draft.newText !== undefined && (typeof draft.newText !== 'string' || draft.newText.length > 800)) throw new Error('草稿无效')
            setProfile(draft.profile); setNewText(draft.newText ?? ''); setNewKind(draft.newKind === 'preference' ? 'preference' : 'fact'); setAdding(Boolean(draft.newText)); setMessage('已恢复未保存草稿。保存前会检查最新版本。')
          }
        } catch { unreadableDraft.current = true; setMessage('本机草稿无法读取，已保留原文件；当前展示已保存版本。可导出当前内容后重新读取。') }
      } })
      .catch((error) => { if (active) setLoadError(String(error)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [employeeId, endpoint, sessionToken, reload, draftKey])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saveLock.current || loading || loadError) return
    if (newText.trim()) { setMessage('新增内容还未加入记忆，请先点击“加入草稿”。'); return }
    saveLock.current = true
    setSaving(true)
    setMessage('')
    try {
      validateMemoryProfile(profile)
      const pairs = (profile.entries ?? []).flatMap((entry, index, entries) => relatedMemories(entries.slice(index + 1), entry.text).map((other) => `${entry.text}\n${other.text}`))
      if (pairs.length && !await confirm({ title: '这些记忆可能重复或冲突', message: pairs.slice(0, 3).join('\n\n') + '\n\n请确认需要同时保留；也可以取消后删除旧规则。', confirmLabel: '仍然保留并保存' })) return
      const saved = await saveSyncedMemoryProfile(employeeId, endpoint, sessionToken, profile)
      setProfile(saved)
      setBaseline(memoryContents(saved))
      try { clearDraft() } catch { setDraftError('设置已保存，但草稿缓存清理失败。') }
      setMessage(memorySaveMessage(saved))
      setHistory(await loadMemoryHistory(employeeId))
      try { await onSaved(saved) } catch { setMessage(memorySaveMessage(saved) + ' 部分频道将在重新连接后更新。') }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { saveLock.current = false; setSaving(false) }
  }
  const addEntry = async () => {
    try {
      const related = relatedMemories(profile.entries ?? [], newText)
      let selected: string | undefined
      if (related.length) {
        selected = await choose('已有相似记忆，如何处理？', `新内容：${newText}`, [...related.map((entry) => ({ id: entry.id, label: `替换：${entry.text}` })), { id: '__new__', label: '作为独立记忆新增' }])
        if (!selected) return
      }
      const next = selected && selected !== '__new__'
        ? { ...profile, entries: profile.entries?.map((entry) => entry.id === selected ? { ...entry, text: newText.trim(), kind: newKind, source: '用户编辑', updatedAt: new Date().toISOString() } : entry) }
        : upsertMemoryEntry(profile, newText, '设置中添加', '', newKind)
      validateMemoryProfile(next)
      setProfile(next); setNewText(''); setAdding(false); setMessage(next === profile ? '已有相同记忆，未重复添加。' : '已加入草稿，点击保存后生效。')
    } catch (error) { setMessage(String(error)) }
  }
  const discardDraft = async () => {
    if (dirty && !await confirm({ title: '放弃未保存修改？', message: '将重新读取已保存版本，当前草稿会被移除。', confirmLabel: '放弃并重新读取' })) return
    try { clearDraft(); setReload((value) => value + 1) } catch { setDraftError('无法清理草稿，请检查本机存储') }
  }
  const resolveConflict = async (useLocal: boolean) => {
    if (!await confirm({ title: useLocal ? '保留本机版本？' : '使用云端版本？', message: useLocal ? '用已保存到本机的完整内容替换最新云端版本。若云端再次变化会重新提示冲突。' : '用最新云端版本替换本机已保存内容；本机原内容仍可从版本记录恢复。', confirmLabel: '确认版本' })) return
    setSaving(true); saveLock.current = true
    try {
      const saved = await resolveMemoryConflict(employeeId, endpoint, sessionToken, useLocal, profile.updatedAt)
      setProfile(saved); setBaseline(memoryContents(saved)); setMessage(memorySaveMessage(saved))
      try { clearDraft() } catch { setDraftError('设置已保存，但草稿缓存清理失败。') }
      await onSaved(saved)
    } catch (error) { setMessage(String(error)) }
    finally { setSaving(false); saveLock.current = false }
  }
  const exportMemory = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: '2', profile }, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'xiaoyin-memory-' + new Date().toISOString().slice(0, 10) + '.json'
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const importMemory = async (file?: File) => {
    if (!file) return
    try {
      if (file.size > 512_000) throw new Error('记忆文件不能超过 500 KB')
      const value = JSON.parse(await file.text()) as { profile?: MemoryProfile }
      validateMemoryProfile(value.profile)
      setProfile({ ...value.profile!, updatedAt: profile.updatedAt, version: profile.version, syncPending: profile.syncPending, syncConflict: profile.syncConflict })
      setMessage('已载入记忆文件，检查后点击保存生效。')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }
  return <form className="memory-page memory-settings" onSubmit={(event) => void submit(event)}>
    <header className="memory-title"><BrainCircuit size={24} /><div><h2>记忆</h2><p>记住你的工作方式，把有用的经验带到下一次任务。</p></div></header>
    {loading && <p role="status">正在读取记忆…</p>}
    {dirty && <p className="memory-draft-status">未保存修改 · {draftError || '草稿已在本机保留'} <button type="button" disabled={saving} onClick={() => void discardDraft()}>放弃草稿</button></p>}
    {profile.syncConflict && <section className="memory-conflict" role="alert"><strong>本机与云端版本冲突</strong><p>未自动覆盖任一版本。可以先导出本机内容，再选择要保留的版本。</p><button disabled={saving || dirty} type="button" onClick={() => void resolveConflict(true)}>保留本机版本</button><button disabled={saving || dirty} type="button" onClick={() => void resolveConflict(false)}>使用云端版本</button>{dirty && <small>请先保存或放弃草稿，再选择版本。</small>}</section>}
    {loadError && <p role="alert">读取失败，未覆盖已有记忆。<button type="button" onClick={() => setReload((value) => value + 1)}>重新读取</button></p>}
    <fieldset disabled={loading || saving || Boolean(loadError)}>
      <section className="memory-options">
        <label><span><strong>使用记忆</strong><small>协作风格与工作手册随任务加载，其他记忆按相关性读取。</small></span><input role="switch" type="checkbox" checked={profile.enabled} onChange={(event) => setProfile({ ...profile, enabled: event.target.checked })} /></label>
        <label><span><strong>自动记忆</strong><small>桌面任务完成后，记住你明确表达的长期偏好；不保存推测和临时要求。</small></span><input role="switch" disabled={!profile.enabled} type="checkbox" checked={profile.automaticMemory ?? false} onChange={(event) => setProfile({ ...profile, automaticMemory: event.target.checked })} /></label>
      </section>
      <details className="memory-section" open>
        <summary>协作风格 <span>沟通与交付方式</span></summary>
        <div className="memory-presets">{styles.map(([name, text]) => <button key={name} type="button" onClick={() => setProfile({ ...profile, collaborationStyle: text })}>{name}</button>)}</div>
        <textarea aria-label="协作风格" maxLength={8000} placeholder="例如：先给结论，使用中文，交付前检查结果。" value={profile.collaborationStyle} onChange={(event) => setProfile({ ...profile, collaborationStyle: event.target.value })} />
      </details>
      <details className="memory-section">
        <summary>工作手册 <span>长期工作规范与业务规则</span></summary>
        <textarea aria-label="工作手册" maxLength={16000} placeholder="记录团队术语、固定流程与业务判断标准。" value={profile.workManual} onChange={(event) => setProfile({ ...profile, workManual: event.target.value })} />
      </details>
      <section className="memory-section">
        <header><h3>用户偏好与长期记忆</h3><span>{profile.entries?.length ?? 0} / 100</span><button type="button" onClick={() => setAdding((value) => !value)}>添加记忆</button></header>
        {adding && <div className="memory-add"><select aria-label="新增记忆分类" value={newKind} onChange={(event) => setNewKind(event.target.value as 'preference' | 'fact')}><option value="fact">长期记忆</option><option value="preference">用户偏好</option></select><textarea aria-label="新增记忆内容" placeholder="例如：金额默认使用人民币。" maxLength={800} value={newText} onChange={(event) => setNewText(event.target.value)} /><button type="button" disabled={!newText.trim()} onClick={() => void addEntry()}>加入草稿</button></div>}
        <input aria-label="搜索记忆" placeholder="搜索记忆内容" value={query} onChange={(event) => setQuery(event.target.value)} />
        {(profile.entries ?? []).filter((entry) => entry.text.toLowerCase().includes(query.toLowerCase())).map((entry) => <article className="memory-entry" key={entry.id}>
          <div><select aria-label="记忆分类" value={entry.kind} onChange={(event) => setProfile({ ...profile, entries: profile.entries?.map((item) => item.id === entry.id ? { ...item, kind: event.target.value as 'preference' | 'fact' } : item) })}><option value="preference">用户偏好</option><option value="fact">长期记忆</option></select>
            <button type="button" onClick={() => { setProfile({ ...profile, entries: profile.entries?.filter((item) => item.id !== entry.id) }); setMessage('已移除条目，点击保存后生效。也可重新读取撤销未保存修改。') }}>删除</button></div>
          <textarea aria-label="记忆内容" maxLength={800} value={entry.text} onChange={(event) => setProfile({ ...profile, entries: profile.entries?.map((item) => item.id === entry.id ? { ...item, text: event.target.value, updatedAt: new Date().toISOString(), source: '用户编辑' } : item) })} />
          <footer><span>{entry.source} · {new Date(entry.updatedAt).toLocaleString()}</span>{entry.taskId && onOpenTask && <button type="button" onClick={async () => { if (!dirty || await confirm({ title: '记忆修改尚未保存', message: '打开来源任务后保留草稿，返回可继续编辑。', confirmLabel: '保留草稿并打开' })) onOpenTask(entry.taskId) }}>来源任务</button>}</footer>
        </article>)}
        {!(profile.entries ?? []).some((entry) => entry.text.toLowerCase().includes(query.toLowerCase())) && <p className="memory-empty">{query ? '没有匹配的记忆。' : '暂无记忆。在对话中说“记住：……”即可添加，也可以开启自动记忆。'}</p>}
      </section>
      <details className="memory-section">
        <summary>备份与恢复 <span>本机最近 50 个版本</span></summary>
        <div className="memory-presets"><label>导入<input aria-label="导入记忆" accept="application/json,.json" type="file" onChange={(event) => { void importMemory(event.target.files?.[0]); event.target.value = '' }} /></label><button type="button" onClick={exportMemory}>导出</button><button type="button" onClick={() => void discardDraft()}>重新读取</button></div>
        {history.slice(0, 5).map((revision) => <div className="memory-revision" key={revision.id}><span>{new Date(revision.savedAt).toLocaleString()}</span><button type="button" onClick={() => { setProfile({ ...revision.profile, updatedAt: profile.updatedAt, version: profile.version, syncPending: profile.syncPending, syncConflict: profile.syncConflict }); setMessage('已载入历史版本，点击保存后生效。') }}>恢复</button></div>)}
      </details>
      <footer className="memory-actions"><span>修改后点击保存生效；关闭记忆不会删除已有内容。</span><button type="submit"><Save size={15} />{saving ? '正在保存…' : '保存设置'}</button></footer>
    </fieldset>
    {message && <p role="status" className="memory-message">{message}</p>}
    {confirmation}
    {choiceDialog}
  </form>
}
