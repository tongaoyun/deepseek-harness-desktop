import { BookOpen, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { loadKnowledgeSource, type KnowledgeSourceContext } from './api'
import type { KnowledgeSearchHit } from './types'
import { useDialogFocus } from './useDialogFocus'

export function KnowledgeSources({ sources, context, excerpts = false }: {
  sources: KnowledgeSearchHit[]; context?: KnowledgeSourceContext; excerpts?: boolean
}) {
  const [selected, setSelected] = useState<KnowledgeSearchHit>()
  if (!sources.length) return null
  return <section className="knowledge-sources" aria-label="检索原文">
    <small>检索原文 · {sources.length} 个片段</small>
    <div>{sources.map((hit, index) => <article key={hit.sourceId ?? `${hit.documentId}-${index}`}>
      <button type="button" disabled={!context || !hit.sourceId} onClick={() => setSelected(hit)}><BookOpen size={14} /><span>{hit.filename} · {hit.locator}</span></button>
      {excerpts && <p>{hit.content}</p>}
    </article>)}</div>
    {selected?.sourceId && context && <SourceDialog key={`${selected.sourceId}:${context.endpoint}:${context.employeeId}:${context.teamId}:${context.sessionToken}`} sourceId={selected.sourceId} context={context} onClose={() => setSelected(undefined)} />}
  </section>
}

function SourceDialog({ sourceId, context, onClose }: { sourceId: string; context: KnowledgeSourceContext; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null)
  const [source, setSource] = useState<KnowledgeSearchHit>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const { endpoint, employeeId, teamId, sessionToken } = context
  useDialogFocus(ref, sourceId, onClose)
  useEffect(() => {
    const controller = new AbortController()
    setSource(undefined); setLoading(true); setError('')
    void loadKnowledgeSource({ endpoint, employeeId, teamId, sessionToken }, sourceId, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setSource(value) })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [sourceId, endpoint, employeeId, teamId, sessionToken, attempt])
  return createPortal(<div className="knowledge-source-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={ref} className="knowledge-source-dialog" role="dialog" aria-modal="true" aria-label="原文片段">
      <header><h2>原文片段</h2><button type="button" aria-label="关闭原文" onClick={onClose}><X size={18} /></button></header>
      {loading && <p role="status">正在核实原文…</p>}
      {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>重新读取</button></div>}
      {source && <><h3>{source.filename}</h3><small>{source.knowledgeBaseName} · {source.locator}</small><pre>{source.content}</pre></>}
    </section>
  </div>, document.body)
}
