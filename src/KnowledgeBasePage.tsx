import { BookOpenCheck, Plus, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react'
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
import { KnowledgeDocumentList } from './KnowledgeDocumentList'
import { KnowledgeSources } from './KnowledgeSources'
import { AddDialog } from './AddDialog'
import { CapabilityHero } from './CapabilityHero'
import './knowledge.css'

interface KnowledgeBasePageProps {
  endpoint: string
  employeeId: string
  teamId: string
  sessionToken: string
  onChanged?: () => void
}

export function KnowledgeBasePage(props: KnowledgeBasePageProps) {
  return <KnowledgeWorkspace key={JSON.stringify([props.endpoint, props.employeeId, props.teamId, props.sessionToken])} {...props} />
}

function KnowledgeWorkspace({ endpoint, employeeId, teamId, sessionToken, onChanged }: KnowledgeBasePageProps) {
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
  const [uploadProgress, setUploadProgress] = useState<{ completed: number; total: number; filename: string }>()
  const [failedUploads, setFailedUploads] = useState<{ baseId: string; files: File[] }>()
  const context = JSON.stringify([endpoint, employeeId, teamId, sessionToken])
  const current = useRef({ context, selectedId })
  current.current = { context, selectedId }
  const documentRequest = useRef(0)
  const searchRequest = useRef(0)
  const operation = useRef(false)
  const mounted = useRef(true)
  const uploadController = useRef<AbortController | undefined>(undefined)
  const createIdempotencyKey = useRef<string | undefined>(undefined)
  const uploadIdempotencyKeys = useRef(new Map<string, string>())
  const reindexIdempotencyKeys = useRef(new Map<string, string>())
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; documentRequest.current += 1; searchRequest.current += 1 } }, [])
  useEffect(() => () => uploadController.current?.abort(), [])
  const fileInput = useRef<HTMLInputElement>(null)
  const selected = bases.find((item) => item.id === selectedId)
  const isCurrent = (baseId = selectedId) => mounted.current && current.current.context === context && current.current.selectedId === baseId

  const refreshBases = useCallback(async (signal?: AbortSignal) => {
    const values = await loadKnowledgeBases(endpoint, employeeId, teamId, sessionToken, signal)
    if (signal?.aborted || current.current.context !== context) return
    setBases(values)
    setSelectedId((current) => values.some((item) => item.id === current) ? current : values[0]?.id ?? '')
  }, [sessionToken, context, employeeId, endpoint, teamId])

  const refreshDocuments = useCallback(async (signal?: AbortSignal) => {
    if (!selectedId) { setDocuments([]); return }
    const request = ++documentRequest.current
    const values = await loadKnowledgeDocuments(endpoint, employeeId, teamId, sessionToken, selectedId, signal)
    if (!signal?.aborted && request === documentRequest.current && current.current.context === context && current.current.selectedId === selectedId) setDocuments(values)
  }, [sessionToken, context, employeeId, endpoint, selectedId, teamId])

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
    setDocuments([]); setHits([]); setQuery(''); setSearched(false); setError(''); setLoadingDocuments(Boolean(selectedId))
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
      createIdempotencyKey.current ??= crypto.randomUUID()
      const value = await createKnowledgeBase(endpoint, employeeId, teamId, sessionToken, {
        name: name.trim(), description: description.trim(), referenceKey: '', scope,
      }, createIdempotencyKey.current)
      if (!mounted.current) return
      createIdempotencyKey.current = undefined
      setBases((current) => [value, ...current]); setSelectedId(value.id); setName(''); setDescription('')
      setCreating(false)
      onChanged?.()
    } catch (reason) { setError(message(reason)) } finally { operation.current = false; setBusy(false) }
  }

  const removeBase = async () => {
    if (!selected || busy || operation.current || !await confirm({
      title: `删除知识库“${selected.name}”？`,
      message: '其中的全部文档和索引都会一并删除。',
      confirmLabel: '删除',
      danger: true,
    }) || !isCurrent(selected.id) || operation.current) return
    operation.current = true
    setBusy(true); setError('')
    try {
      await deleteKnowledgeBase(endpoint, employeeId, teamId, sessionToken, selected.id)
      if (!mounted.current) return
      setBases((current) => current.filter((item) => item.id !== selected.id))
      if (current.current.selectedId === selected.id) { setSelectedId(''); setDocuments([]); setHits([]) }
      onChanged?.()
    } catch (reason) { if (isCurrent()) setError(message(reason)) } finally { operation.current = false; setBusy(false) }
  }

  const upload = async (files: File[]) => {
    if (!selectedId || files.length === 0 || operation.current || busy) return
    if (files.length > 20) { setError('一次最多上传 20 个文件，请分批上传；本次未上传任何文件。'); return }
    operation.current = true
    const controller = new AbortController()
    uploadController.current = controller
    documentRequest.current += 1
    setBusy(true); setError('')
    const failures: string[] = []
    const retryFiles: File[] = []
    setFailedUploads(undefined)
    setUploadProgress({ completed: 0, total: files.length, filename: files[0].name })
    try {
      for (const [index, file] of files.entries()) {
        if (!mounted.current || current.current.context !== context) break
        setUploadProgress({ completed: index, total: files.length, filename: file.name })
        try {
          if (!/\.(pdf|docx|xlsx|txt|md|markdown)$/i.test(file.name)) throw new Error('不支持的文件类型')
          if (!file.size || file.size > 25 * 1024 * 1024) throw new Error('文件不能为空或超过 25 MiB')
          const fileKey = `${selectedId}|${file.name}|${file.size}|${file.lastModified}`
          const idempotencyKey = uploadIdempotencyKeys.current.get(fileKey) ?? crypto.randomUUID()
          uploadIdempotencyKeys.current.set(fileKey, idempotencyKey)
          const value = await uploadKnowledgeDocument(endpoint, employeeId, teamId, sessionToken, selectedId, file, controller.signal, idempotencyKey)
          if (current.current.context === context && current.current.selectedId === selectedId) {
            setDocuments((values) => [value, ...values.filter((item) => item.id !== value.id)])
          }
          uploadIdempotencyKeys.current.delete(fileKey)
        } catch (reason) { failures.push(`${file.name}：${message(reason)}`); retryFiles.push(file) }
      }
      if (mounted.current && retryFiles.length) setFailedUploads({ baseId: selectedId, files: retryFiles })
      if (isCurrent() && failures.length) setError(`以下文件上传失败，其余成功项已保留：${failures.join('；')}`)
    } finally {
      operation.current = false
      if (uploadController.current === controller) uploadController.current = undefined
      setUploadProgress(undefined)
      setBusy(false); if (fileInput.current) fileInput.current.value = ''
    }
  }

  const dropFiles = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    void upload([...event.dataTransfer.files])
  }

  const removeDocument = async (document: KnowledgeDocumentEntry) => {
    if (busy || operation.current || !await confirm({
      title: `删除文档“${document.filename}”？`,
      message: '删除后需要重新上传才能恢复。',
      confirmLabel: '删除',
      danger: true,
    }) || !isCurrent(document.knowledgeBaseId) || operation.current) return
    operation.current = true
    setBusy(true); setError('')
    try {
      await deleteKnowledgeDocument(endpoint, employeeId, teamId, sessionToken, document.knowledgeBaseId, document.id)
      if (!isCurrent(document.knowledgeBaseId)) return
      documentRequest.current += 1; searchRequest.current += 1
      setDocuments((current) => current.filter((item) => item.id !== document.id))
      setHits((current) => current.filter((item) => item.documentId !== document.id))
    } catch (reason) { if (isCurrent(document.knowledgeBaseId)) setError(message(reason)) } finally { operation.current = false; setBusy(false) }
  }

  const reindex = async (document: KnowledgeDocumentEntry) => {
    if (busy || operation.current) return
    operation.current = true
    setBusy(true); setError('')
    try {
      const key = `${document.knowledgeBaseId}|${document.id}`
      const idempotencyKey = reindexIdempotencyKeys.current.get(key) ?? crypto.randomUUID()
      reindexIdempotencyKeys.current.set(key, idempotencyKey)
      const value = await reindexKnowledgeDocument(endpoint, employeeId, teamId, sessionToken, document.knowledgeBaseId, document.id, idempotencyKey)
      if (!isCurrent(document.knowledgeBaseId)) return
      reindexIdempotencyKeys.current.delete(key)
      documentRequest.current += 1; searchRequest.current += 1
      setDocuments((current) => current.map((item) => item.id === value.id ? value : item))
      setHits((current) => current.filter((item) => item.documentId !== value.id))
    } catch (reason) { if (isCurrent(document.knowledgeBaseId)) setError(message(reason)) } finally { operation.current = false; setBusy(false) }
  }

  const search = async (event: FormEvent) => {
    event.preventDefault()
    if (!query.trim() || busy) return
    setBusy(true); setError('')
    const request = ++searchRequest.current
    setHits([]); setSearched(false)
    try {
      const values = await searchKnowledge(endpoint, employeeId, teamId, sessionToken, query.trim(), selectedId ? [selectedId] : [])
      if (request === searchRequest.current && current.current.context === context && current.current.selectedId === selectedId) { setHits(values); setSearched(true) }
    }
    catch (reason) { if (request === searchRequest.current && isCurrent()) setError(message(reason)) } finally { setBusy(false) }
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
          <BookOpenCheck size={15} /><span><strong>{item.name}</strong><small>{scopeLabel(item.scope)}</small></span>
        </button>)}
        {loadingBases && <div className="kit-empty" role="status">正在读取知识库…</div>}
      </div>
    </aside>
    <section className="knowledge-main">
      {!selected ? <div className="knowledge-welcome">
        <XiaoyinMascot size={92} variant="knowledge" />
        <h2>{loadingBases ? '正在读取知识库' : error ? '知识库暂不可用' : '创建第一个知识库'}</h2>
        <p>把公司资料交给小胤，搜索和引用都有原文依据。</p>
        {!loadingBases && (error
          ? <button type="button" onClick={() => { setError(''); setLoadingBases(true); void refreshBases().catch((reason) => setError(message(reason))).finally(() => setLoadingBases(false)) }}>重新加载</button>
          : <button type="button" onClick={() => setCreating(true)}><Plus size={14} />新建知识库</button>)}
      </div> : <>
        <header><div><h2>{selected.name}</h2><p>{scopeLabel(selected.scope)}{selected.description ? ` · ${selected.description}` : ''}</p></div><div>
          <input accept=".pdf,.docx,.xlsx,.txt,.md,.markdown" multiple onChange={(event) => void upload([...(event.target.files ?? [])])} ref={fileInput} type="file" />
          <button disabled={busy} onClick={() => fileInput.current?.click()} type="button"><Upload size={14} />上传文档</button>
          <button aria-label="刷新文档" disabled={busy || loadingDocuments} onClick={() => { setError(''); void refreshDocuments().catch((reason) => { if (isCurrent()) setError(message(reason)) }) }} title="刷新文档" type="button"><RefreshCw size={14} /></button>
          <button aria-label="删除知识库" className="danger" disabled={busy} onClick={() => void removeBase()} title="删除知识库" type="button"><Trash2 size={14} /></button>
        </div></header>
        <form className="knowledge-search" onSubmit={search}><Search size={16} /><input aria-label="搜索知识库内容" onChange={(event) => { setQuery(event.target.value); searchRequest.current += 1; setHits([]); setSearched(false) }} placeholder="搜索知识库内容" value={query} />{query && <button aria-label="清空检索" title="清空检索" type="button" onClick={() => { setQuery(''); setHits([]); setSearched(false); searchRequest.current += 1 }}><X size={14} /></button>}<button disabled={busy || !query.trim()} type="submit">检索</button></form>
        {hits.length > 0 && <div className="knowledge-hits"><KnowledgeSources sources={hits} context={{ endpoint, employeeId, teamId, sessionToken }} excerpts /></div>}
        {searched && hits.length === 0 && <p className="kit-empty" role="status">未找到匹配原文。请检查文档是否已可检索，或换个关键词。</p>}
        <div className={`knowledge-drop-zone${dragging ? ' dragging' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }} onDragOver={(event) => event.preventDefault()} onDrop={dropFiles}>
          <Upload size={17} /><span><strong>拖入文件即可上传</strong><small>一次最多 20 个文件，上传后自动索引</small></span>
        </div>
        {uploadProgress && <div className="knowledge-upload-progress" role="status"><span>正在上传 {uploadProgress.completed + 1}/{uploadProgress.total} · {uploadProgress.filename}</span><progress max={uploadProgress.total} value={uploadProgress.completed} /></div>}
        {failedUploads?.baseId === selectedId && <div className="knowledge-upload-retry"><span>{failedUploads.files.length} 个文件上传失败</span><button disabled={busy} type="button" onClick={() => void upload(failedUploads.files)}><RefreshCw size={14} />重试失败文件</button></div>}
        <KnowledgeDocumentList key={selectedId} documents={documents} loading={loadingDocuments} busy={busy} onReindex={(document) => void reindex(document)} onRemove={(document) => void removeDocument(document)} />
      </>}
      {error && <div className="kit-error" role="alert">{error}</div>}
    </section>
    {dialog}
    </div>
  </>
}

function scopeLabel(scope: KnowledgeBaseEntry['scope']): string { return ({ PERSONAL: '个人', TEAM: '团队', ORGANIZATION: '公司' })[scope] }
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
