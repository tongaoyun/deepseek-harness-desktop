import { FileSliders, FileSpreadsheet, FileText, FolderSearch, Image } from 'lucide-react'
import { useCallback, useState } from 'react'
import { loadLocalArtifactPreview, revealLocalArtifact, type LocalArtifactTarget } from './localArtifactPreview'
import { TaskImagePreview } from './TaskImagePreview'
import type { TaskArtifact } from './types'

export function TaskArtifacts({ artifacts, conversation = false, onOpen }: { artifacts: TaskArtifact[]; conversation?: boolean; onOpen?: (target: LocalArtifactTarget) => void }) {
  const [error, setError] = useState('')
  if (artifacts.length === 0) return null
  return <section className={conversation ? 'turn-files' : undefined}>
    {conversation && <header className="sr-only"><strong>{artifactSummary(artifacts)}</strong></header>}
    <div className="monitor-artifacts">{artifacts.map((artifact) => <ArtifactCard artifact={artifact} key={artifact.id} onError={setError} onOpen={onOpen} />)}</div>
    {error && <p className="monitor-error" role="alert">{error}</p>}
  </section>
}

function ArtifactCard({ artifact, onError, onOpen }: { artifact: TaskArtifact; onError: (message: string) => void; onOpen?: (target: LocalArtifactTarget) => void }) {
  const isImage = artifact.kind === 'image' || /\.(png|jpe?g|webp|gif|bmp)$/i.test(artifact.path)
  const Icon = isImage ? Image : artifact.kind === 'spreadsheet' ? FileSpreadsheet : artifact.kind === 'presentation' ? FileSliders : FileText
  const { rootId, rootName, path, name } = artifact
  const loadImage = useCallback(async () => {
    const preview = await loadLocalArtifactPreview({ rootId, rootName, path, name })
    if (preview.kind !== 'image' || !preview.dataUrl) throw new Error(preview.truncated ? '图片过大，请打开原文件查看' : '图片暂不可预览')
    return preview.dataUrl
  }, [rootId, rootName, path, name])
  const action = artifact.action ?? 'created'
  const target: LocalArtifactTarget = {
    rootId: artifact.rootId, rootName: artifact.rootName, path: artifact.path, name: artifact.name,
    ...((action === 'created' || action === 'updated') ? { review: { action, ...(artifact.backupPath ? { backupPath: artifact.backupPath } : {}) } } : {}),
  }
  const reveal = async () => {
    onError('')
    try {
      await revealLocalArtifact(target)
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason))
      onOpen?.(target)
    }
  }
  return <article className={`artifact-${isImage ? 'image' : artifact.kind}`}>
    {isImage && <TaskImagePreview key={`${artifact.id}:${artifact.createdAt}`} name={artifact.name} load={loadImage} />}
    <span><Icon size={17} /></span>
    <div><button className="artifact-name" disabled={!onOpen} onClick={() => onOpen?.(target)} type="button">{artifact.name}</button><small>{actionLabel(artifact.action)}{artifact.sizeBytes !== undefined ? ` · ${formatFileSize(artifact.sizeBytes)}` : ''} · {artifact.rootName} / {artifact.path}</small></div>
    <button disabled={!onOpen} onClick={() => onOpen?.(target)} title="在小胤中打开" type="button">打开</button>
    <button aria-label={`在文件夹中显示 ${artifact.name}`} onClick={() => void reveal()} title="在文件夹中显示" type="button"><FolderSearch size={13} /></button>
  </article>
}

function artifactSummary(artifacts: TaskArtifact[]): string {
  if (artifacts.some((item) => item.action === 'published')) return `交付了 ${artifacts.length} 个文件`
  const updated = artifacts.filter((item) => item.action === 'updated').length
  const created = artifacts.length - updated
  if (updated > 0 && created > 0) return `创建 ${created} 个、修改 ${updated} 个文件`
  if (updated > 0) return `修改了 ${updated} 个文件`
  return `生成了 ${created} 个文件`
}

function actionLabel(action: TaskArtifact['action']): string {
  return ({ created: '已创建', updated: '已修改', copied: '已复制', moved: '已移动', published: '已就绪' } as const)[action ?? 'created']
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
