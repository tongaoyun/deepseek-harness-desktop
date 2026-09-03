import { invoke, isTauri } from '@tauri-apps/api/core'
import { FileSpreadsheet, FileText, FolderSearch } from 'lucide-react'
import { useState } from 'react'
import type { TaskArtifact } from './types'

export function TaskArtifacts({ artifacts }: { artifacts: TaskArtifact[] }) {
  const [error, setError] = useState('')
  if (artifacts.length === 0) return null
  return <>
    <div className="monitor-artifacts">{artifacts.map((artifact) => <ArtifactCard artifact={artifact} key={artifact.id} onError={setError} />)}</div>
    {error && <p className="monitor-error">{error}</p>}
  </>
}

function ArtifactCard({ artifact, onError }: { artifact: TaskArtifact; onError: (message: string) => void }) {
  const Icon = artifact.kind === 'spreadsheet' ? FileSpreadsheet : FileText
  const open = async (reveal: boolean) => {
    onError('')
    if (!isTauri()) return
    try {
      await invoke('open_local_artifact', { rootId: artifact.rootId, path: artifact.path, reveal })
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  return <article>
    <span><Icon size={17} /></span>
    <div><strong>{artifact.name}</strong><small>{artifact.rootName} / {artifact.path}</small></div>
    <button onClick={() => void open(false)} type="button">打开</button>
    <button aria-label={`在文件夹中显示 ${artifact.name}`} onClick={() => void open(true)} title="在文件夹中显示" type="button"><FolderSearch size={13} /></button>
  </article>
}
