import { Image, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { loadHarnessImagePreview } from './localArtifactPreview'
import type { TaskVisualArtifact } from './types'

export function TaskVisuals({ visuals }: { visuals: TaskVisualArtifact[] }) {
  const [sources, setSources] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<TaskVisualArtifact>()
  const [error, setError] = useState('')
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let disposed = false
    void Promise.all(visuals.map(async (visual) => [visual.id, await loadHarnessImagePreview(visual.attachmentId, visual.mediaType)] as const))
      .then((values) => { if (!disposed) setSources(Object.fromEntries(values)) })
      .catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { disposed = true }
  }, [visuals])

  useEffect(() => {
    if (!selected) return
    closeButtonRef.current?.focus()
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(undefined) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [selected])

  if (visuals.length === 0) return null
  return <section className="task-visuals">
    <header><Image size={17} /><strong>{visuals.length === 1 ? visuals[0].name : `${visuals.length} 张操作截图`}</strong></header>
    <div>{visuals.map((visual) => <button key={visual.id} onClick={() => setSelected(visual)} type="button">
      {sources[visual.id] ? <img alt={visual.name} src={sources[visual.id]} /> : <span>正在加载截图…</span>}
      <small>{visual.width} × {visual.height}</small>
    </button>)}</div>
    {error && <p>{error}</p>}
    {selected && sources[selected.id] && <div aria-label={`查看 ${selected.name}`} aria-modal="true" className="task-visual-lightbox" onClick={() => setSelected(undefined)} role="dialog">
      <button aria-label="关闭截图" onClick={() => setSelected(undefined)} ref={closeButtonRef} type="button"><X size={18} /></button>
      <img alt={selected.name} onClick={(event) => event.stopPropagation()} src={sources[selected.id]} />
    </div>}
  </section>
}
