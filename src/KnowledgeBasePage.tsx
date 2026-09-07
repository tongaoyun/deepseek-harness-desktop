import { BookOpenCheck, FileText, Plus, RefreshCw, Search, Trash2, Upload } from 'lucide-react'
import { type DragEvent, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { useDesktopDialog } from './DesktopDialog'
import { XiaoyinMascot } from './XiaoyinMascot'
import { CapabilityHero } from './CapabilityHero'
import { KnowledgeSources } from './KnowledgeSources'
import { AddDialog } from './AddDialog'

interface KnowledgeBasePageProps {
  endpoint: string
  employeeId: string
  teamId: string
  accessToken: string
  onChanged?: () => void
}

export function KnowledgeBasePage({ endpoint, employeeId, teamId, accessToken, onChanged }: KnowledgeBasePageProps) {
  const { confirm, dialog } = useDesktopDialog()
  const [bases, setBases] = useState<KnowledgeBaseEntry[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [documents, setDocuments] = useState<KnowledgeDocumentEntry[]>([])
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [description, setDescription] = useState('')
  const [scope, setScope] = useState<KnowledgeBaseEntry['scope']>('PERSONAL')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<KnowledgeSearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [loadingBases, setLoadingBases] = useState(true)
  const [loadingDocuments, setLoadingDocuments] = useState(false)
  const [searched, setSearched] = useState(false)
  const context = JSON.stringify([endpoint, employeeId, teamId, accessToken])
  const current = useRef({ context, selectedId })
  current.current = { context, selectedId }
  const documentRequest = useRef(0)
  const searchRequest = useRef(0)
  const operation = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; documentRequest.current += 1; searchRequest.current += 1 } }, [])
  const fileInput = useRef<HTMLInputElement>(null)
  const selected = bases.find((item) => item.id === selectedId)

  const refreshBases = useCallback(async (signal?: AbortSignal) => {
    const values = await loadKnowledgeBases(endpoint, employeeId, teamId, accessToken, signal)
    if (signal?.aborted || current.current.context !== context) return
    setBases(values)
    setSelectedId((current) => values.some((item) => item.id === current) ? current : values[0]?.id ?? '')
  }, [accessToken, context, employeeId, endpoint, teamId])

  const refreshDocuments = useCallback(async (signal?: AbortSignal) => {
    if (!selectedId) { setDocuments([]); return }
    const request = ++documentRequest.current
    const values = await loadKnowledgeDocuments(endpoint, employeeId, teamId, accessToken, selectedId, signal)
    if (!signal?.aborted && request === documentRequest.current && current.current.context === context && current.current.selectedId === selectedId) setDocuments(values)
  }, [accessToken, context, employeeId, endpoint, selectedId, teamId])

  useEffect(() => {
    const controller = new AbortController()
    setLoadingBases(true); setError('')
    void refreshBases(controller.signal).catch((reason) => {
      if (!controller.signal.aborted) setError(message(reason))
    }).finally(() => { if (!controller.signal.aborted) setLoadingBases(false) })
    return () => controller.abort()
  }, [refreshBases])

  useEffect(() => {
    const controller = new AbortController()
    setDocuments([]); setHits([]); setSearched(false); setLoadingDocuments(Boolean(selectedId))
    searchRequest.current += 1
    void refreshDocuments(controller.signal).catch((reason) => {
      if (!controller.signal.aborted) setError(message(reason))
    }).finally(() => { if (!controller.signal.aborted) setLoadingDocuments(false) })
    return () => controller.abort()
  }, [refreshDocuments])

  const indexing = useMemo(() => documents.some((item) => item.status === 'QUEUED' || item.status === 'PROCESSING'), [documents])
  useEffect(() => {
    if (!indexing) return
    const controller = new AbortController()
    let polling = false
    const timer = window.setInterval(() => {
      if (polling || operation.current) return
      polling = true
      void refreshDocuments(controller.signal).catch((reason) => {
        if (!controller.signal.aborted) setError(`索引状态更新失败：${message(reason)}，可点击刷新重试。`)
      }).finally(() => { polling = false })
    }, 2_500)
    return () => { window.clearInterval(timer); controller.abort() }
  }, [indexing, refreshDocuments])

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || busy || operation.current) return
    operation.current = true
    setBusy(true); setError('')
    try {
      const value = await createKnowledgeBase(endpoint, employeeId, teamId, accessToken, {
        name: name.trim(), description: description.trim(), referenceKey: '', scope,
      })
      setBases((current) => [value, ...current]); setSelectedId(value.id); setName(''); setDescription('')
      setCreating(false)
      onChanged?.()
    } catch (reason) { setError(message(reason)) } finally { operation.current = false; setBusy(false) }
  }

  const removeBase = async () => {
    if (!selected || busy || !await confirm({
      title: `删除知识库“${selected.name}”？`,
      message: '其中的全部文档和索引都会一并删除。',
      confirmLabel: '删除',
      danger: true,
    })) return
    setBusy(true); setError('')
    try {
      await deleteKnowledgeBase(endpoint, employeeId, teamId, accessToken, selected.id)
      setBases((current) => current.filter((item) => item.id !== selected.id))
      if (current.current.selectedId === selected.id) { setSelectedId(''); setDocuments([]); setHits([]) }
      onChanged?.()
    } catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }

  const upload = async (files: File[]) => {
    if (!selectedId || files.length === 0 || operation.current || busy) return
    if (files.length > 20) { setError('一次最多上传 20 个文件，请分批上传；本次未上传任何文件。'); return }
    operation.current = true
    documentRequest.current += 1
    setBusy(true); setError('')
    const failures: string[] = []
    try {
      for (const file of files) {
        if (!mounted.current || current.current.context !== context) break
        try {
          if (!/\.(pdf|docx|xlsx|txt|md|markdown)$/i.test(file.name)) throw new Error('不支持的文件类型')
          if (!file.size || file.size > 25 * 1024 * 1024) throw new Error('文件不能为空或超过 25 MiB')
          const value = await uploadKnowledgeDocument(endpoint, employeeId, teamId, accessToken, selectedId, file)
          if (current.current.context === context && current.current.selectedId === selectedId) {
            setDocuments((values) => [value, ...values.filter((item) => item.id !== value.id)])
          }
        } catch (reason) { failures.push(`${file.name}：${message(reason)}`) }
      }
      if (current.current.context === context && failures.length) setError(`以下文件上传失败，其余成功项已保留：${failures.join('；')}`)
    } finally {
      operation.current = false
      setBusy(false); if (fileInput.current) fileInput.current.value = ''
    }
  }

  const dropFiles = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    void upload([...event.dataTransfer.files])
  }

  const removeDocument = async (document: KnowledgeDocumentEntry) => {
    if (busy || !await confirm({
      title: `删除文档“${document.filename}”？`,
      message: '删除后需要重新上传才能恢复。',
      confirmLabel: '删除',
      danger: true,
    })) return
    setBusy(true); setError('')
    try {
      await deleteKnowledgeDocument(endpoint, employeeId, teamId, accessToken, document.knowledgeBaseId, document.id)
      documentRequest.current += 1; searchRequest.current += 1
      setDocuments((current) => current.filter((item) => item.id !== document.id))
      setHits((current) => current.filter((item) => item.documentId !== document.id))
    } catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }

  const reindex = async (document: KnowledgeDocumentEntry) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const value = await reindexKnowledgeDocument(endpoint, employeeId, teamId, accessToken, document.knowledgeBaseId, document.id)
      documentRequest.current += 1; searchRequest.current += 1
      setDocuments((current) => current.map((item) => item.id === value.id ? value : item))
      setHits((current) => current.filter((item) => item.documentId !== value.id))
    } catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }

  const search = async (event: FormEvent) => {
    event.preventDefault()
    if (!query.trim() || busy) return
    setBusy(true); setError('')
    const request = ++searchRequest.current
    setHits([]); setSearched(false)
    try {
      const values = await searchKnowledge(endpoint, employeeId, teamId, accessToken, query.trim(), selectedId ? [selectedId] : [])
      if (request === searchRequest.current && current.current.context === context && current.current.selectedId === selectedId) { setHits(values); setSearched(true) }
    }
    catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }

  return <>
    <CapabilityHero kind="knowledge" />
    <div className="knowledge-page">
    <aside className="knowledge-sidebar">
      <button className="knowledge-create-trigger" type="button" onClick={() => setCreating(true)}><Plus size={14} />新建知识库</button>
      {creating && <AddDialog title="新建知识库" description="整理资料，让小胤在回答中检索并引用原文。" busy={busy} onClose={() => setCreating(false)}><form onSubmit={create}><fieldset disabled={busy}>
        <label>名称
        <input aria-label="知识库名称" maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="例如：跨境运营 SOP" value={name} />
        </label><label>可见范围
        <select aria-label="知识库范围" onChange={(event) => setScope(event.target.value as KnowledgeBaseEntry['scope'])} value={scope}>
          <option value="PERSONAL">个人</option><option disabled={!teamId.trim()} value="TEAM">团队 · {teamId || '未识别'}</option><option value="ORGANIZATION">全公司</option>
        </select>
        </label><label>说明（可选）
        <textarea aria-label="知识库说明" maxLength={1000} onChange={(event) => setDescription(event.target.value)} placeholder="说明该知识库包含什么内容" value={description} />
        </label></fieldset>{error && <p role="alert" className="add-error">{error}</p>}<footer><button disabled={busy || !name.trim()} type="submit">{busy ? '正在创建…' : '创建'}</button></footer>
      </form></AddDialog>}
      <div className="knowledge-base-list">
        <small>可见知识库 · {bases.length}</small>
        {bases.map((item) => <button className={item.id === selectedId ? 'active' : ''} key={item.id} onClick={() => { setSelectedId(item.id); setHits([]) }} type="button">
          <BookOpenCheck size={15} /><span><strong>{item.name}</strong><small>{scopeLabel(item.scope)} · {item.reference}</small></span>
        </button>)}
        {loadingBases ? <div className="kit-empty" role="status">正在读取知识库…</div> : bases.length === 0 && !error && <div className="kit-empty">先创建一个知识库</div>}
      </div>
    </aside>
    <section className="knowledge-main">
      {!selected ? <div className="knowledge-welcome"><XiaoyinMascot size={92} variant="knowledge" /><h2>{loadingBases ? '正在读取知识库' : error ? '知识库暂不可用' : '创建第一个知识库'}</h2><p>把公司资料交给小胤，搜索和引用都有原文依据。</p><button type="button" disabled={busy || loadingBases} onClick={() => { setError(''); void refreshBases().catch((reason) => setError(message(reason))) }}>重新加载</button></div> : <>
        <header><div><h2>{selected.name}</h2><p>{selected.description || '集中管理该主题的公司资料。'}</p></div><div>
          <input accept=".pdf,.docx,.xlsx,.txt,.md,.markdown" multiple onChange={(event) => void upload([...(event.target.files ?? [])])} ref={fileInput} type="file" />
          <button disabled={busy} onClick={() => fileInput.current?.click()} type="button"><Upload size={14} />上传文档</button>
          <button disabled={busy || loadingDocuments} onClick={() => { setError(''); void refreshDocuments().catch((reason) => setError(message(reason))) }} type="button"><RefreshCw size={14} />刷新</button>
          <button className="danger" disabled={busy} onClick={() => void removeBase()} title="删除知识库" type="button"><Trash2 size={14} /></button>
        </div></header>
        <form className="knowledge-search" onSubmit={search}><Search size={14} /><input onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前知识库，验证索引与引用" value={query} /><button disabled={busy || !query.trim()} type="submit">检索</button></form>
        {hits.length > 0 && <div className="knowledge-hits"><KnowledgeSources sources={hits} context={{ endpoint, employeeId, teamId, accessToken }} excerpts /></div>}
        {searched && hits.length === 0 && <p className="kit-empty" role="status">未找到匹配原文。请检查文档是否已可检索，或换个关键词。</p>}
        <div className={`knowledge-drop-zone${dragging ? ' dragging' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }} onDragOver={(event) => event.preventDefault()} onDrop={dropFiles}>
          <Upload size={17} /><span><strong>拖入文件即可上传</strong><small>一次最多 20 个文件，上传后自动索引</small></span>
        </div>
        <div className="knowledge-documents"><div><strong>文档</strong><small>{documents.length} 个</small></div>
          {documents.map((document) => <article key={document.id}><FileText size={17} /><span><strong>{document.filename}</strong><small>{formatBytes(document.sizeBytes)} · {document.chunkCount} 个片段{document.failureMessage ? ` · ${document.failureMessage}` : ''}</small></span><em className={document.status.toLowerCase()}>{statusLabel(document.status)}</em><button disabled={busy || document.status === 'PROCESSING' || document.status === 'QUEUED'} onClick={() => void reindex(document)} title="重建索引" type="button"><RefreshCw size={13} /></button><button className="danger" disabled={busy} onClick={() => void removeDocument(document)} title="删除文档" type="button"><Trash2 size={13} /></button></article>)}
          {loadingDocuments ? <div className="kit-empty" role="status">正在读取文档…</div> : documents.length === 0 && <div className="kit-empty">支持 PDF、DOCX、XLSX、TXT 和 Markdown，单个文件不超过 25 MiB</div>}
        </div>
      </>}
      {error && <div className="kit-error" role="alert">{error}</div>}
    </section>
    {dialog}
    </div>
  </>
}

function statusLabel(status: KnowledgeDocumentEntry['status']): string {
  return ({ QUEUED: '等待索引', PROCESSING: '解析中', READY: '可检索', FAILED: '索引失败' })[status]
}
function scopeLabel(scope: KnowledgeBaseEntry['scope']): string { return ({ PERSONAL: '个人', TEAM: '团队', ORGANIZATION: '公司' })[scope] }
function formatBytes(bytes: number): string { return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB` }
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
