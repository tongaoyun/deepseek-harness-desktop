import { invoke, isTauri } from '@tauri-apps/api/core'
import { Copy, FileSpreadsheet, FileText, FolderSearch, RotateCcw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  text: string
  assistant: boolean
  onRegenerate?: () => void
}

export function RichMessage({ text, assistant, onRegenerate }: Props) {
  const artifacts = assistant ? extractArtifactReferences(text) : []
  return <>
    <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
    {artifacts.length > 0 && <div className="artifact-list">{artifacts.map((artifact) => <article key={artifact.path}>
      <span>{artifact.kind === 'sheet' ? <FileSpreadsheet size={18} /> : <FileText size={18} />}</span>
      <div><strong>{artifact.name}</strong><small>{artifact.label}</small></div>
      <button onClick={() => void openArtifact(artifact.path, false)} type="button">打开</button>
      <button aria-label={`在文件夹中显示 ${artifact.name}`} onClick={() => void openArtifact(artifact.path, true)} title="在文件夹中显示" type="button"><FolderSearch size={14} /></button>
    </article>)}</div>}
    {assistant && !text.startsWith('正在') && <div className="message-actions">
      <button onClick={() => void navigator.clipboard.writeText(text)} type="button"><Copy size={13} />复制</button>
      {onRegenerate && <button onClick={onRegenerate} type="button"><RotateCcw size={13} />重新生成</button>}
    </div>}
  </>
}

export function extractArtifactReferences(text: string): Array<{ path: string; name: string; kind: 'document' | 'sheet'; label: string }> {
  const matches = text.match(/(?:[A-Za-z]:\\[^\s"'<>|?*]+|\/(?:[^\s"'<>]+\/)*[^\s"'<>]+)\.(?:docx?|xlsx?|pdf|csv|txt|md)\b/gi) ?? []
  return [...new Set(matches.map((value) => value.replace(/[),.;，。；]+$/, '')))].slice(0, 12).map((path) => {
    const name = path.split(/[\\/]/).pop() ?? path
    const extension = name.split('.').pop()?.toLowerCase() ?? ''
    const sheet = ['xls', 'xlsx', 'csv'].includes(extension)
    return { path, name, kind: sheet ? 'sheet' : 'document', label: sheet ? '表格产物' : extension === 'pdf' ? 'PDF 产物' : '文档产物' }
  })
}

async function openArtifact(path: string, reveal: boolean) {
  if (!isTauri()) return
  await invoke('open_local_artifact', { path, reveal })
}
