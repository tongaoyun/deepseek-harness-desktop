import { FileCode2, FileDiff, FileText, FolderSearch, Image, LoaderCircle, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { codeDiffRows } from './codeDiff'
import { highlightedCode } from './codeHighlight'
import {
  loadLocalArtifactPreview,
  revealLocalArtifact,
  type LocalArtifactPreview,
  type LocalArtifactTarget,
} from './localArtifactPreview'

const MAX_RENDERED_LINES = 5_000

export function LocalFilePreviewPanel({ onClose, onSelect, tabs = [], target }: {
  onClose: () => void
  onSelect?: (target: LocalArtifactTarget) => void
  tabs?: LocalArtifactTarget[]
  target: LocalArtifactTarget
}) {
  const [preview, setPreview] = useState<LocalArtifactPreview>()
  const [previousPreview, setPreviousPreview] = useState<LocalArtifactPreview>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [pdfUrl, setPdfUrl] = useState('')
  const [view, setView] = useState<'review' | 'file'>(target.review ? 'review' : 'file')

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError('')
    setPreview(undefined)
    setPreviousPreview(undefined)
    setView(target.review ? 'review' : 'file')
    const previousTarget = target.review?.backupPath
      ? { ...target, path: target.review.backupPath, review: undefined }
      : undefined
    void Promise.all([
      target.review?.action === 'deleted' ? Promise.resolve(undefined) : loadLocalArtifactPreview(target),
      previousTarget ? loadLocalArtifactPreview(previousTarget) : Promise.resolve(undefined),
    ])
      .then(([current, previous]) => {
        if (disposed) return
        setPreview(target.review?.action === 'deleted' && previous
          ? { ...previous, name: target.name, path: target.path, content: '', dataUrl: undefined, sizeBytes: 0, truncated: false }
          : current)
        setPreviousPreview(previous)
      })
      .catch((reason) => { if (!disposed) setError(message(reason)) })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [target])

  useEffect(() => {
    setPdfUrl('')
    if (preview?.kind !== 'pdf' || !preview.dataUrl) return
    try {
      const encoded = preview.dataUrl.slice(preview.dataUrl.indexOf(',') + 1)
      const binary = window.atob(encoded)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
      setPdfUrl(url)
      return () => URL.revokeObjectURL(url)
    } catch {
      setError('PDF 预览数据无法解析')
    }
  }, [preview])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const lines = useMemo(() => preview?.content?.split('\n').slice(0, MAX_RENDERED_LINES) ?? [], [preview?.content])
  const canReview = Boolean(target.review && preview?.content !== undefined
    && (target.review.action === 'created' || previousPreview?.content !== undefined))

  const reveal = async () => {
    setError('')
    try { await revealLocalArtifact(target) }
    catch (reason) { setError(message(reason)) }
  }

  return <aside aria-label={`预览 ${target.name}`} className="local-file-preview">
    <header className="local-file-preview-tabbar">
      <div className="local-file-preview-tabs">{tabs.map((tab) => <button className={tab.rootId === target.rootId && tab.path === target.path ? 'active' : ''} key={`${tab.rootId}:${tab.path}`} onClick={() => onSelect?.(tab)} title={tab.path} type="button"><FileIcon kind={tab === target ? preview?.kind : undefined} /><strong>{tab.name}</strong></button>)}</div>
      <span className="local-file-preview-tab-actions">
        {canReview && <span className="local-preview-view-switch">
          <button className={view === 'review' ? 'active' : ''} onClick={() => setView('review')} type="button"><FileDiff size={14} />改动</button>
          {target.review?.action !== 'deleted' && <button className={view === 'file' ? 'active' : ''} onClick={() => setView('file')} type="button"><FileCode2 size={14} />文件</button>}
        </span>}
        <button aria-label="关闭预览" onClick={onClose} title="关闭" type="button"><X size={17} /></button>
      </span>
    </header>
    <div className="local-file-preview-toolbar">
      <span><strong>{target.name}</strong><small>{target.rootName} / {target.path}</small></span>
      {view === 'review' && canReview
        ? <em className="local-review-counts"><ins>+{target.review?.addedLines ?? addedLineCount(previousPreview?.content ?? '', preview?.content ?? '')}</ins><del>-{target.review?.deletedLines ?? deletedLineCount(previousPreview?.content ?? '', preview?.content ?? '')}</del></em>
        : preview && <em>{formatBytes(preview.sizeBytes)}{preview.language ? ` · ${preview.language.toUpperCase()}` : ''}</em>}
      <button disabled={target.review?.action === 'deleted'} onClick={() => void reveal()} title={target.review?.action === 'deleted' ? '文件已删除' : '在文件夹中显示'} type="button"><FolderSearch size={15} /></button>
    </div>
    <div className="local-file-preview-body">
      {loading && <div className="local-file-preview-state"><LoaderCircle className="spin" size={22} /><strong>正在读取文件</strong></div>}
      {!loading && error && <div className="local-file-preview-state error"><FileText size={25} /><strong>无法预览文件</strong><p>{error}</p></div>}
      {!loading && preview?.kind === 'image' && preview.dataUrl && <div className="local-image-preview"><img alt={preview.name} src={preview.dataUrl} /></div>}
      {!loading && preview?.kind === 'pdf' && pdfUrl && <iframe className="local-pdf-preview" src={pdfUrl} title={preview.name} />}
      {!loading && preview && (preview.kind === 'code' || preview.kind === 'text') && view === 'review' && canReview
        && <CodeReview current={preview.content ?? ''} language={preview.language} previous={previousPreview?.content ?? ''} />}
      {!loading && preview && (preview.kind === 'code' || preview.kind === 'text') && (view === 'file' || !canReview) && <CodePreview language={preview.language} lines={lines} />}
      {!loading && preview?.kind === 'office' && preview.content && <div className={`local-office-preview ${preview.language ?? ''}`}><pre>{preview.content}</pre></div>}
      {!loading && preview && (preview.kind === 'code' || preview.kind === 'text') && (preview.truncated || (preview.content?.split('\n').length ?? 0) > MAX_RENDERED_LINES) && <div className="local-preview-truncated">文件较大，仅展示前面的内容</div>}
      {!loading && preview && ((preview.kind === 'image' || preview.kind === 'pdf') && !preview.dataUrl) && <PreviewUnavailable preview={preview} />}
      {!loading && preview && ((preview.kind === 'office' && !preview.content) || preview.kind === 'file') && <PreviewUnavailable preview={preview} />}
    </div>
  </aside>
}

function CodePreview({ language, lines }: { language?: string; lines: string[] }) {
  const content = lines.join('\n')
  const highlighted = useMemo(() => highlightedCode(content, language), [content, language])
  return <div className="local-code-preview">
    <div className="local-code-gutter">{lines.map((_line, index) => <span key={index}>{index + 1}</span>)}</div>
    <pre><code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted || ' ' }} /></pre>
  </div>
}

function CodeReview({ current, language, previous }: { current: string; language?: string; previous: string }) {
  const rows = useMemo(() => codeDiffRows(previous, current).slice(0, MAX_RENDERED_LINES), [current, previous])
  return <div className="local-code-review">
    {rows.map((row) => row.kind === 'fold'
      ? <div className="local-diff-fold" key={row.id}>{row.foldedLines} 行未修改</div>
      : <div className={`local-diff-line ${row.kind}`} key={row.id}>
        <span>{row.oldLine ?? ''}</span><span>{row.newLine ?? ''}</span><i>{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ''}</i>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightedCode(row.text || ' ', language) }} />
      </div>)}
  </div>
}

function FileIcon({ kind }: { kind?: LocalArtifactPreview['kind'] }) {
  if (kind === 'image') return <Image size={16} />
  if (kind === 'code') return <FileCode2 size={16} />
  return <FileText size={16} />
}

function PreviewUnavailable({ preview }: { preview: LocalArtifactPreview }) {
  return <div className="local-file-preview-state"><FileText size={28} /><strong>{preview.truncated ? '文件太大，无法内嵌预览' : '当前格式暂不支持内嵌预览'}</strong><p>文件仍在原目录中。可以在对话中让小胤读取和处理，也可以使用上方文件夹按钮定位。</p></div>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function addedLineCount(previous: string, current: string): number {
  return codeDiffRows(previous, current).filter((row) => row.kind === 'added').length
}

function deletedLineCount(previous: string, current: string): number {
  return codeDiffRows(previous, current).filter((row) => row.kind === 'removed').length
}

function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
