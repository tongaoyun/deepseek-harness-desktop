import { Image } from 'lucide-react'
import { useCallback, useState } from 'react'
import { loadHarnessImagePreview } from './localArtifactPreview'
import { TaskImagePreview } from './TaskImagePreview'
import type { TaskVisualArtifact } from './types'

export function TaskVisuals({ employeeId, visuals }: { employeeId: string; visuals: TaskVisualArtifact[] }) {
  const [count, setCount] = useState(6)
  if (!visuals.length) return null
  return <section className="task-visuals">
    <header><Image size={17} /><strong>{visuals.length === 1 ? visuals[0].name : `${visuals.length} 张图片`}</strong></header>
    <div>{visuals.slice(0, count).map((visual) => <VisualCard employeeId={employeeId} key={`${visual.id}:${visual.attachmentId}`} visual={visual} />)}</div>
    {count < visuals.length && <button className="visuals-load-more" type="button" onClick={() => setCount((value) => value + 6)}>显示更多图片（还有 {visuals.length - count} 张）</button>}
  </section>
}

function VisualCard({ employeeId, visual }: { employeeId: string; visual: TaskVisualArtifact }) {
  const load = useCallback(() => loadHarnessImagePreview(employeeId, visual.attachmentId, visual.mediaType), [employeeId, visual.attachmentId, visual.mediaType])
  return <TaskImagePreview name={visual.name} load={load} dimensions={`${visual.width} × ${visual.height}`} />
}
