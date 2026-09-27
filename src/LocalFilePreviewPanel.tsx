import { ExternalLink, Eye, FileCode2, FileDiff, FileText, FolderSearch, Image, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { codeDiffRows } from './codeDiff'
import { highlightedCode } from './codeHighlight'
import { authorizeLocalDirectory, authorizeLocalFiles } from './harness'
import {
  loadLocalArtifactPreview,
  htmlArtifactPreviewUrl,
  artifactFailure,
  revealLocalArtifact,
  openLocalArtifact,
  type LocalArtifactPreview,
  type LocalArtifactTarget,
} from './localArtifactPreview'

const MAX_RENDERED_LINES = 5_000

export function LocalFilePreviewPanel({ onClose, onSelect, onOpenSelected, tabs = [], target }: {
  onClose: () => void
  onSelect?: (target: LocalArtifactTarget) => void
  onOpenSelected?: (target: LocalArtifactTarget) => void
  tabs?: LocalArtifactTarget[]
  target: LocalArtifactTarget
}) {
  const [preview, setPreview] = useState<LocalArtifactPreview>()
  const [previousPreview, setPreviousPreview] = useState<LocalArtifactPreview>()
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [loading, setLoading] = useState(true)
  const [pdfUrl, setPdfUrl] = useState('')
  const [htmlUrl, setHtmlUrl] = useState('')
  const [view, setView] = useState<'review' | 'file' | 'preview'>(target.initialView ?? 'preview')
  const [revision, setRevision] = useState(0)
  const [reviewWarning, setReviewWarning] = useState('')
  const [recovering, setRecovering] = useState(false)
  const recoveryLock = useRef(false)
  const active = useRef<LocalArtifactTarget | undefined>(target); active.current = target
  useEffect(() => { active.current = target; return () => { active.current = undefined } }, [target])
  const panel = useRef<HTMLElement>(null)

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { if (opener?.isConnected) opener.focus() }
  }, [])

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError('')
    setActionError('')
    setReviewWarning('')
    setPreview(undefined)
    setPreviousPreview(undefined)
    setView(target.initialView ?? 'preview')
    const previousTarget = target.review?.backupPath
      ? { ...target, path: target.review.backupPath, review: undefined }
      : undefined
    void Promise.all([
      target.review?.action === 'deleted' ? Promise.resolve(undefined) : loadLocalArtifactPreview(target),
      previousTarget ? loadLocalArtifactPreview(previousTarget).catch((reason) => {
        if (target.review?.action === 'deleted') throw reason
        if (!disposed) setReviewWarning(`无法读取修改前的备份：${message(reason)}。下方展示当前文件。`)
        return undefined
      }) : Promise.resolve(undefined),
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
  }, [target, revision])

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
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const lines = useMemo(() => preview?.content?.split('\n').slice(0, MAX_RENDERED_LINES) ?? [], [preview?.content])
  const canPreviewHtml = preview?.kind === 'code' && /\.html?$/i.test(target.path) && !preview.truncated && target.review?.action !== 'deleted'
  const canReadMarkdown = preview?.kind === 'markdown' && target.review?.action !== 'deleted'
  const hasText = preview?.kind === 'code' || preview?.kind === 'text' || preview?.kind === 'markdown'
  useEffect(() => {
    let disposed = false
    setHtmlUrl('')
    if (canPreviewHtml) void htmlArtifactPreviewUrl(target).then((url) => { if (!disposed) setHtmlUrl(url) })
      .catch((reason) => { if (!disposed) { setActionError(message(reason)); setView('file') } })
    return () => { disposed = true }
  }, [canPreviewHtml, target, revision])
  const canReview = Boolean(target.review && preview?.content !== undefined && hasText && !preview.truncated && !previousPreview?.truncated
    && (target.review.action === 'created' || (target.review.action === 'copied' && !target.review.backupPath) || previousPreview?.content !== undefined))
  const diffCounts = useMemo(() => {
    if (!canReview) return undefined
    const rows = codeDiffRows(previousPreview?.content ?? '', preview?.content ?? '')
    return { added: rows.filter((row) => row.kind === 'added').length, deleted: rows.filter((row) => row.kind === 'removed').length }
  }, [canReview, previousPreview?.content, preview?.content])

  const reveal = async () => {
    const original = target
    setActionError('')
    try { await revealLocalArtifact(target) }
    catch (reason) { if (active.current === original) setActionError(message(reason)) }
  }

  const openOriginal = async () => {
    const original = target
    setActionError('')
    try { await openLocalArtifact(target) }
    catch (reason) { if (active.current === original) setActionError(message(reason)) }
  }

  const recover = async (directory: boolean) => {
    if (recoveryLock.current) return
    const original = target
    recoveryLock.current = true; setRecovering(true)
    try {
      if (directory) {
        const selected = await authorizeLocalDirectory()
        if (!selected || active.current !== original) return
        if (selected.id !== original.rootId) throw new Error(`请选择原目录“${original.rootName}”；若文件已移走，请选择文件打开。`)
        setRevision((value) => value + 1)
      } else {
        const selected = await authorizeLocalFiles()
        if (!selected.attachments.length || active.current !== original) return
        if (selected.attachments.length !== 1) throw new Error('请只选择一个要打开的文件')
        const file = selected.attachments[0]
        onOpenSelected?.({ rootId: file.rootId, rootName: file.rootName, path: file.path, name: file.name })
      }
    } catch (reason) { if (active.current === original) setError(message(reason)) }
    finally { recoveryLock.current = false; if (active.current) setRecovering(false) }
  }
  const failure = artifactFailure(error)

  return <aside aria-label={`预览 ${target.name}`} className="local-file-preview" ref={panel}>
    <header className="local-file-preview-tabbar">
      <div className="local-file-preview-tabs">{tabs.map((tab) => <button className={tab.rootId === target.rootId && tab.path === target.path ? 'active' : ''} key={`${tab.rootId}:${tab.path}`} onClick={() => onSelect?.(tab)} title={tab.path} type="button"><FileIcon kind={tab === target ? preview?.kind : undefined} /><strong>{tab.name}</strong></button>)}</div>
      <span className="local-file-preview-tab-actions">
        {(canReview || canPreviewHtml || canReadMarkdown) && <span className="local-preview-view-switch" role="group" aria-label="文件视图">
          {canReadMarkdown && <button aria-label="阅读视图" title="阅读视图" aria-pressed={view === 'preview'} className={view === 'preview' ? 'active' : ''} onClick={() => setView('preview')} type="button"><Eye size={14} /></button>}
          {canPreviewHtml && <button aria-label="交互预览" title="交互预览" aria-pressed={view === 'preview'} className={view === 'preview' ? 'active' : ''} onClick={() => setView('preview')} type="button"><Eye size={14} /></button>}
          {canReview && <button aria-label="查看改动" title="查看改动" aria-pressed={view === 'review'} className={view === 'review' ? 'active' : ''} onClick={() => setView('review')} type="button"><FileDiff size={14} /></button>}
          {target.review?.action !== 'deleted' && <button aria-label="查看源码" title="查看源码" aria-pressed={view === 'file'} className={view === 'file' ? 'active' : ''} onClick={() => setView('file')} type="button"><FileCode2 size={14} /></button>}
        </span>}
        <button aria-label="关闭预览" onClick={onClose} title="关闭" type="button"><X size={17} /></button>
      </span>
    </header>
    <div className="local-file-preview-toolbar">
      <span><strong>{target.name}</strong><small>{target.rootName} / {target.path}</small></span>
      {view === 'review' && canReview
        ? <em className="local-review-counts"><ins>+{diffCounts?.added}</ins><del>-{diffCounts?.deleted}</del></em>
        : preview && <em>{formatBytes(preview.sizeBytes)}{preview.language ? ` · ${preview.language.toUpperCase()}` : ''}</em>}
      <button aria-label="刷新文件" disabled={loading} onClick={() => setRevision((value) => value + 1)} title="重新读取磁盘内容" type="button"><RefreshCw size={15} /></button>
      <button aria-label="使用本机应用打开" disabled={target.review?.action === 'deleted'} onClick={() => void openOriginal()} title="使用本机应用打开" type="button"><ExternalLink size={15} /></button>
      <button aria-label="在文件夹中显示" disabled={target.review?.action === 'deleted'} onClick={() => void reveal()} title={target.review?.action === 'deleted' ? '文件已删除' : '在文件夹中显示'} type="button"><FolderSearch size={15} /></button>
    </div>
    <div className="local-file-preview-body">
      {actionError && <p className="local-preview-action-error" role="alert">{actionError}</p>}
      {loading && <div className="local-file-preview-state"><LoaderCircle className="spin" size={22} /><strong>正在读取文件</strong></div>}
      {!loading && error && <div className="local-file-preview-state error" role="alert"><FileText size={25} /><strong>{failure.title}</strong><p>{failure.hint}</p><details><summary>查看详细原因</summary><p>{error}</p></details><div className="file-recovery-actions"><button disabled={recovering} type="button" onClick={() => setRevision((value) => value + 1)}>重新读取</button>{failure.kind === 'authorization' && <button disabled={recovering} type="button" onClick={() => void recover(true)}>重新授权目录</button>}{onOpenSelected && <button disabled={recovering} type="button" onClick={() => void recover(false)}>{recovering ? '正在选择…' : '选择文件打开'}</button>}</div>{onOpenSelected && <small>所选文件会在新标签中打开，不改写历史成果路径与撤销记录。</small>}</div>}
      {!loading && preview && target.review && hasText && !canReview && view === 'review' && <p className="local-preview-truncated">{reviewWarning || (preview.truncated || previousPreview?.truncated ? '文件过大，无法展示完整差异；下方仅为内容预览。' : '此文件没有可用的文本对比基线，下方展示文件内容。')}</p>}
      {!loading && preview?.kind === 'image' && preview.dataUrl && <div className="local-image-preview"><img alt={preview.name} src={preview.dataUrl} onError={() => setActionError('图片无法解码，请使用本机应用检查原文件')} /></div>}
      {!loading && preview?.kind === 'pdf' && pdfUrl && <iframe className="local-pdf-preview" src={pdfUrl} title={preview.name} />}
      {!loading && preview && hasText && view === 'review' && canReview
        && <CodeReview key={`${target.rootId}:${target.path}:${revision}`} current={preview.content ?? ''} language={preview.language} previous={previousPreview?.content ?? ''} />}
      {!loading && htmlUrl && canPreviewHtml && view === 'preview' && <iframe key={`${htmlUrl}:${revision}`} className="local-html-preview" src={htmlUrl} sandbox="allow-scripts" referrerPolicy="no-referrer" title={`交互预览 ${target.name}`} />}
      {!loading && canReadMarkdown && view === 'preview' && <div className="markdown-content-preview message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{lines.join('\n')}</ReactMarkdown></div>}
      {!loading && preview && hasText && !((canPreviewHtml || canReadMarkdown) && view === 'preview') && (view !== 'review' || !canReview) && <CodePreview language={preview.language} lines={lines} />}
      {!loading && preview && (preview.kind === 'audio' || preview.kind === 'video') && preview.dataUrl && <div className="local-media-preview">{preview.kind === 'audio' ? <audio controls preload="metadata" src={preview.dataUrl} aria-label={preview.name} onError={() => setActionError('音频无法解码，请使用本机应用打开')} /> : <video controls preload="metadata" src={preview.dataUrl} aria-label={preview.name} onError={() => setActionError('视频无法解码，请使用本机应用打开')} />}</div>}
      {!loading && preview && (preview.truncated || (hasText && (preview.content?.split('\n').length ?? 0) > MAX_RENDERED_LINES)) && <div className="local-preview-truncated">文件较大，仅展示部分内容</div>}
      {!loading && preview && ((preview.kind === 'image' || preview.kind === 'pdf') && !preview.dataUrl) && <PreviewUnavailable preview={preview} />}
      {!loading && preview && (preview.kind === 'file' || ((preview.kind === 'audio' || preview.kind === 'video') && !preview.dataUrl)) && <PreviewUnavailable preview={preview} />}
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const allRows = useMemo(() => codeDiffRows(previous, current, expanded), [current, previous, expanded])
  const rows = allRows.slice(0, MAX_RENDERED_LINES)
  return <div className="local-code-review">
    {rows.map((row) => row.kind === 'fold'
      ? <button className="local-diff-fold" key={row.id} onClick={() => setExpanded((value) => new Set([...value, row.id]))} type="button">展开 {row.foldedLines} 行未修改内容</button>
      : <div className={`local-diff-line ${row.kind}`} key={row.id}>
        <span>{row.oldLine ?? ''}</span><span>{row.newLine ?? ''}</span><i>{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ''}</i>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightedCode(row.text || ' ', language) }} />
      </div>)}
    {allRows.length > MAX_RENDERED_LINES && <p className="local-preview-truncated">差异较长，仅展示前 {MAX_RENDERED_LINES} 行，请在编辑器中查看完整文件。</p>}
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

function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
