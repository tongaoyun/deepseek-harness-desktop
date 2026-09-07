import { Image, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { loadHarnessImagePreview } from './localArtifactPreview'
import { useDialogFocus } from './useDialogFocus'
import type { TaskVisualArtifact } from './types'

export function TaskVisuals({ visuals }: { visuals: TaskVisualArtifact[] }) {
  const [count, setCount] = useState(6)
  if (!visuals.length) return null
  return <section className="task-visuals">
    <header><Image size={17} /><strong>{visuals.length === 1 ? visuals[0].name : `${visuals.length} 张操作截图`}</strong></header>
    <div>{visuals.slice(0, count).map((visual) => <VisualCard key={`${visual.id}:${visual.attachmentId}`} visual={visual} />)}</div>
    {count < visuals.length && <button className="visuals-load-more" type="button" onClick={() => setCount((value) => value + 6)}>显示更多截图（还有 {visuals.length - count} 张）</button>}
  </section>
}

function VisualCard({ visual }: { visual: TaskVisualArtifact }) {
  const card = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined')
  const [selected, setSelected] = useState(false)
  const [source, setSource] = useState('')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useDialogFocus(dialog, selected && source ? visual.id : '', () => setSelected(false))

  useEffect(() => {
    if (!card.current || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
    observer.observe(card.current)
    return () => observer.disconnect()
  }, [])

  const active = visible || selected
  useEffect(() => {
    setSource(''); setError('')
    if (!active) return
    let disposed = false
    let url = ''
    void loadHarnessImagePreview(visual.attachmentId, visual.mediaType).then((data) => {
      if (disposed) return
      // Keep a revocable URL, not a full base64 screenshot in component state.
      const prefix = `data:${visual.mediaType};base64,`
      if (!data.startsWith(prefix)) throw new Error('截图数据格式无效')
      const bytes = Uint8Array.from(atob(data.slice(prefix.length)), (character) => character.charCodeAt(0))
      const blob = new Blob([bytes], { type: visual.mediaType })
      url = URL.createObjectURL(blob)
      setSource(url)
    }).catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { disposed = true; if (url) URL.revokeObjectURL(url) }
  }, [active, visual.attachmentId, visual.mediaType, revision])

  return <>
    <button ref={card} onClick={() => { if (error) setRevision((value) => value + 1); else if (source) setSelected(true) }} aria-label={error ? `重新加载 ${visual.name}` : `查看 ${visual.name}`} title={error || visual.name} type="button">
      {source ? <img alt={visual.name} src={source} decoding="async" /> : <span>{error ? '截图加载失败，点击重试' : visible ? '正在加载截图…' : '滚动到此处查看截图'}</span>}
      <small>{visual.width} × {visual.height}</small>
    </button>
    {selected && source && <div ref={dialog} aria-label={`查看 ${visual.name}`} aria-modal="true" className="task-visual-lightbox" onClick={() => setSelected(false)} role="dialog">
      <button aria-label="关闭截图" onClick={() => setSelected(false)} type="button"><X size={18} /></button>
      <img alt={visual.name} onClick={(event) => event.stopPropagation()} src={source} />
    </div>}
  </>
}
