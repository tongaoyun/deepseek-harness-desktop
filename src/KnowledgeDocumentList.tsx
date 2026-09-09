import { FileText, RefreshCw, Search, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { KnowledgeDocumentEntry } from './types'

const statusLabels = { QUEUED: '等待索引', PROCESSING: '解析中', READY: '可检索', FAILED: '索引失败' }

export function KnowledgeDocumentList({ documents, loading, busy, onReindex, onRemove }: {
  documents: KnowledgeDocumentEntry[]
  loading: boolean
  busy: boolean
  onReindex: (document: KnowledgeDocumentEntry) => void
  onRemove: (document: KnowledgeDocumentEntry) => void
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('ALL')
  const visible = documents.filter((document) => (status === 'ALL' || document.status === status)
    && document.filename.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const ready = documents.filter((document) => document.status === 'READY').length
  const failed = documents.filter((document) => document.status === 'FAILED').length
  return <section className="knowledge-documents" aria-label="文档列表">
    <header><div><h3>文档 <small>{documents.length}</small></h3><p>{ready} 个可检索{failed > 0 ? ` · ${failed} 个索引失败` : ''}</p></div>
      <div className="knowledge-document-filters"><label><Search size={14} /><input aria-label="按文档名称筛选" placeholder="查找文档" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <select aria-label="文档状态" value={status} onChange={(event) => setStatus(event.target.value)}><option value="ALL">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </div>
    </header>
    {visible.map((document) => <article key={document.id}>
      <FileText size={18} /><span><strong title={document.filename}>{document.filename}</strong><small>{formatBytes(document.sizeBytes)} · {document.chunkCount} 个片段</small>
        {document.failureMessage && <p className="knowledge-document-failure">{document.failureMessage}</p>}
      </span><em className={document.status.toLowerCase()}>{statusLabels[document.status]}</em>
      <button aria-label={`重新索引 ${document.filename}`} disabled={busy || document.status === 'PROCESSING' || document.status === 'QUEUED'} onClick={() => onReindex(document)} title="重建索引" type="button"><RefreshCw size={15} /></button>
      <button aria-label={`删除 ${document.filename}`} className="danger" disabled={busy} onClick={() => onRemove(document)} title="删除文档" type="button"><Trash2 size={15} /></button>
    </article>)}
    {loading ? <p className="kit-empty" role="status">正在读取文档…</p> : visible.length === 0 && <p className="kit-empty">{documents.length ? '没有符合筛选条件的文档' : '支持 PDF、DOCX、XLSX、TXT 和 Markdown，单个文件不超过 25 MiB'}</p>}
  </section>
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}
