import { BookOpenCheck, FileText, Plus, RefreshCw, Search, Trash2, Upload } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  deleteKnowledgeDocument,
  loadKnowledgeBases,
  loadKnowledgeDocuments,
  reindexKnowledgeDocument,
  searchKnowledge,
  uploadKnowledgeDocument,
} from './api'
import type { KnowledgeBaseEntry, KnowledgeDocumentEntry, KnowledgeSearchHit } from './types'

interface KnowledgeBasePageProps {
  endpoint: string
  employeeId: string
  teamId: string
  accessToken: string
}

export function KnowledgeBasePage({ endpoint, employeeId, teamId, accessToken }: KnowledgeBasePageProps) {
  const [bases, setBases] = useState<KnowledgeBaseEntry[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [documents, setDocuments] = useState<KnowledgeDocumentEntry[]>([])
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [referenceKey, setReferenceKey] = useState('')
  const [scope, setScope] = useState<KnowledgeBaseEntry['scope']>('PERSONAL')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<KnowledgeSearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const selected = bases.find((item) => item.id === selectedId)

  const refreshBases = useCallback(async (signal?: AbortSignal) => {
    const values = await loadKnowledgeBases(endpoint, employeeId, teamId, accessToken, signal)
    setBases(values)
    setSelectedId((current) => values.some((item) => item.id === current) ? current : values[0]?.id ?? '')
  }, [accessToken, employeeId, endpoint, teamId])

  const refreshDocuments = useCallback(async (signal?: AbortSignal) => {
    if (!selectedId) { setDocuments([]); return }
    setDocuments(await loadKnowledgeDocuments(endpoint, employeeId, teamId, accessToken, selectedId, signal))
  }, [accessToken, employeeId, endpoint, selectedId, teamId])

  useEffect(() => {
    const controller = new AbortController()
    void refreshBases(controller.signal).catch((reason) => {
      if (!controller.signal.aborted) setError(message(reason))
    })
    return () => controller.abort()
  }, [refreshBases])

  useEffect(() => {
    const controller = new AbortController()
    void refreshDocuments(controller.signal).catch((reason) => {
      if (!controller.signal.aborted) setError(message(reason))
    })
    return () => controller.abort()
  }, [refreshDocuments])

  const indexing = useMemo(() => documents.some((item) => item.status === 'QUEUED' || item.status === 'PROCESSING'), [documents])
  useEffect(() => {
    if (!indexing) return
    const timer = window.setInterval(() => void refreshDocuments().catch(() => undefined), 2_500)
    return () => window.clearInterval(timer)
  }, [indexing, refreshDocuments])

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true); setError('')
    try {
      const value = await createKnowledgeBase(endpoint, employeeId, teamId, accessToken, {
        name: name.trim(), description: description.trim(), referenceKey: referenceKey.trim(), scope,
      })
      setBases((current) => [value, ...current]); setSelectedId(value.id); setName(''); setDescription(''); setReferenceKey('')
    } catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }

  const removeBase = async () => {
    if (!selected || busy || !window.confirm(`删除知识库“${selected.name}”及其中全部文档？`)) return
    setBusy(true); setError('')
    try {
      await deleteKnowledgeBase(endpoint, employeeId, teamId, accessToken, selected.id)
      setBases((current) => current.filter((item) => item.id !== selected.id)); setSelectedId(''); setDocuments([]); setHits([])
    } catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }

  const upload = async (file: File | undefined) => {
    if (!selectedId || !file || busy) return
    setBusy(true); setError('')
    try {
      const value = await uploadKnowledgeDocument(endpoint, employeeId, teamId, accessToken, selectedId, file)
      setDocuments((current) => [value, ...current])
    } catch (reason) { setError(message(reason)) } finally {
      setBusy(false); if (fileInput.current) fileInput.current.value = ''
    }
  }

  const removeDocument = async (document: KnowledgeDocumentEntry) => {
    if (busy || !window.confirm(`删除文档“${document.filename}”？`)) return
    setBusy(true); setError('')
    try {
      await deleteKnowledgeDocument(endpoint, employeeId, teamId, accessToken, document.knowledgeBaseId, document.id)
      setDocuments((current) => current.filter((item) => item.id !== document.id))
    } catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }

  const reindex = async (document: KnowledgeDocumentEntry) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const value = await reindexKnowledgeDocument(endpoint, employeeId, teamId, accessToken, document.knowledgeBaseId, document.id)
      setDocuments((current) => current.map((item) => item.id === value.id ? value : item))
    } catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }

  const search = async (event: FormEvent) => {
    event.preventDefault()
    if (!query.trim() || busy) return
    setBusy(true); setError('')
    try { setHits(await searchKnowledge(endpoint, employeeId, teamId, accessToken, query.trim(), selectedId ? [selectedId] : [])) }
    catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }

  return <div className="knowledge-page">
    <aside className="knowledge-sidebar">
      <form onSubmit={create}>
        <strong><Plus size={14} />新建知识库</strong>
        <input aria-label="知识库名称" maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="例如：跨境运营 SOP" value={name} />
        <input aria-label="知识库引用标识" maxLength={64} onChange={(event) => setReferenceKey(event.target.value.toLowerCase())} pattern="[a-z][a-z0-9-]{2,63}" placeholder="引用标识，如 operations-sop" value={referenceKey} />
        <select aria-label="知识库范围" onChange={(event) => setScope(event.target.value as KnowledgeBaseEntry['scope'])} value={scope}>
          <option value="PERSONAL">个人</option><option disabled={!teamId.trim()} value="TEAM">团队 · {teamId || '未识别'}</option><option value="ORGANIZATION">全公司</option>
        </select>
        <textarea aria-label="知识库说明" maxLength={1000} onChange={(event) => setDescription(event.target.value)} placeholder="说明该知识库包含什么内容" value={description} />
        <button disabled={busy || !name.trim()} type="submit">创建</button>
      </form>
      <div className="knowledge-base-list">
        <small>可见知识库 · {bases.length}</small>
        {bases.map((item) => <button className={item.id === selectedId ? 'active' : ''} key={item.id} onClick={() => { setSelectedId(item.id); setHits([]) }} type="button">
          <BookOpenCheck size={15} /><span><strong>{item.name}</strong><small>{scopeLabel(item.scope)} · {item.reference}</small></span>
        </button>)}
        {bases.length === 0 && <div className="kit-empty">先创建一个知识库</div>}
      </div>
    </aside>
    <section className="knowledge-main">
      {!selected ? <div className="knowledge-welcome"><BookOpenCheck size={30} /><h2>企业知识库</h2><p>上传公司资料，让小胤在回答时引用可追溯的原文。</p></div> : <>
        <header><div><h2>{selected.name}</h2><p>{selected.description || '集中管理该主题的公司资料。'}</p></div><div>
          <input accept=".pdf,.docx,.xlsx,.txt,.md,.markdown" onChange={(event) => void upload(event.target.files?.[0])} ref={fileInput} type="file" />
          <button disabled={busy} onClick={() => fileInput.current?.click()} type="button"><Upload size={14} />上传文档</button>
          <button className="danger" disabled={busy} onClick={() => void removeBase()} title="删除知识库" type="button"><Trash2 size={14} /></button>
        </div></header>
        <form className="knowledge-search" onSubmit={search}><Search size={14} /><input onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前知识库，验证索引与引用" value={query} /><button disabled={busy || !query.trim()} type="submit">检索</button></form>
        {hits.length > 0 && <div className="knowledge-hits">{hits.map((hit, index) => <article key={`${hit.documentId}-${index}`}><small>{hit.filename} · {hit.locator}</small><p>{hit.content}</p></article>)}</div>}
        <div className="knowledge-documents"><div><strong>文档</strong><small>{documents.length} 个</small></div>
          {documents.map((document) => <article key={document.id}><FileText size={17} /><span><strong>{document.filename}</strong><small>{formatBytes(document.sizeBytes)} · {document.chunkCount} 个片段{document.failureMessage ? ` · ${document.failureMessage}` : ''}</small></span><em className={document.status.toLowerCase()}>{statusLabel(document.status)}</em><button disabled={busy || document.status === 'PROCESSING'} onClick={() => void reindex(document)} title="重建索引" type="button"><RefreshCw size={13} /></button><button className="danger" disabled={busy} onClick={() => void removeDocument(document)} title="删除文档" type="button"><Trash2 size={13} /></button></article>)}
          {documents.length === 0 && <div className="kit-empty">支持 PDF、DOCX、XLSX、TXT 和 Markdown，单个文件不超过 25 MiB</div>}
        </div>
      </>}
      {error && <div className="kit-error">{error}</div>}
    </section>
  </div>
}

function statusLabel(status: KnowledgeDocumentEntry['status']): string {
  return ({ QUEUED: '等待索引', PROCESSING: '解析中', READY: '可检索', FAILED: '索引失败' })[status]
}
function scopeLabel(scope: KnowledgeBaseEntry['scope']): string { return ({ PERSONAL: '个人', TEAM: '团队', ORGANIZATION: '公司' })[scope] }
function formatBytes(bytes: number): string { return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB` }
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
