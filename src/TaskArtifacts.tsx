import { FileSliders, FileSpreadsheet, FileText, FolderSearch } from 'lucide-react'
import { useState } from 'react'
import { revealLocalArtifact, type LocalArtifactTarget } from './localArtifactPreview'
import type { TaskArtifact } from './types'

export function TaskArtifacts({ artifacts, conversation = false, onOpen }: { artifacts: TaskArtifact[]; conversation?: boolean; onOpen?: (target: LocalArtifactTarget) => void }) {
  const [error, setError] = useState('')
  if (artifacts.length === 0) return null
  return <section className={conversation ? 'turn-files' : undefined}>
    {conversation && <header><FileText size={19} /><strong>{artifactSummary(artifacts)}</strong></header>}
    <div className="monitor-artifacts">{artifacts.map((artifact) => <ArtifactCard artifact={artifact} key={artifact.id} onError={setError} onOpen={onOpen} />)}</div>
    {error && <p className="monitor-error">{error}</p>}
  </section>
}

function ArtifactCard({ artifact, onError, onOpen }: { artifact: TaskArtifact; onError: (message: string) => void; onOpen?: (target: LocalArtifactTarget) => void }) {
  const Icon = artifact.kind === 'spreadsheet' ? FileSpreadsheet : artifact.kind === 'presentation' ? FileSliders : FileText
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
    }
  }
  return <article>
    <span><Icon size={17} /></span>
    <div><strong>{artifact.name}</strong><small>{actionLabel(artifact.action)} · {artifact.rootName} / {artifact.path}</small></div>
    <button disabled={!onOpen} onClick={() => onOpen?.(target)} title="在小胤中打开" type="button">打开</button>
    <button aria-label={`在文件夹中显示 ${artifact.name}`} onClick={() => void reveal()} title="在文件夹中显示" type="button"><FolderSearch size={13} /></button>
  </article>
}

function artifactSummary(artifacts: TaskArtifact[]): string {
  const updated = artifacts.filter((item) => item.action === 'updated').length
  const created = artifacts.length - updated
  if (updated > 0 && created > 0) return `创建 ${created} 个、修改 ${updated} 个文件`
  if (updated > 0) return `修改了 ${updated} 个文件`
  return `生成了 ${created} 个文件`
}

function actionLabel(action: TaskArtifact['action']): string {
  return ({ created: '已创建', updated: '已修改，可恢复原文件', copied: '已复制', moved: '已移动' } as const)[action ?? 'created']
}
