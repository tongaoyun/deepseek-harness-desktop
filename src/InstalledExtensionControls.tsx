import { FolderOpen, Share2, ChevronDown, Download } from 'lucide-react'
import { useRef, useState } from 'react'
import { revealExtensionDirectory, setExtensionEnabled } from './expertKits'
import type { InstalledExpertKit } from './types'

export function ExtensionEnableSwitch({ extension, onChanged }: { extension: InstalledExpertKit; onChanged?: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const enabled = extension.enabled !== false
  return <span className="extension-activation"><button aria-label={`在聊天中启用 ${extension.manifest.name}`} aria-checked={enabled} className="extension-switch" disabled={busy} role="switch" type="button" onClick={async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try { await setExtensionEnabled(extension, !enabled); await onChanged?.() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { pending.current = false; setBusy(false) }
  }}><span /></button>{error && <span className="extension-action-error" role="alert">{error}</span>}</span>
}

export function InstalledExtensionControls({ extension, onChanged, onCustomize, onExport }: {
  extension: InstalledExpertKit; onChanged?: () => Promise<void> | void; onCustomize?: () => void; onExport?: () => void
}) {
  const [error, setError] = useState('')
  return <>
    <button aria-label="在文件夹中显示" className="secondary" onClick={async () => {
      setError('')
      try { await revealExtensionDirectory(extension) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    }} title="在文件夹中显示" type="button"><FolderOpen size={15} /></button>
    {onCustomize && <button className="secondary" onClick={onCustomize} title="创建可编辑副本，在对话中定制" type="button">定制</button>}
    {onExport && <details className="extension-share-menu"><summary><Share2 size={14} />分享<ChevronDown size={13} /></summary><div><button onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); onExport() }} type="button"><Download size={14} />导出为 ZIP 包</button><p>导出后可发送给同事导入使用</p></div></details>}
    <span className="extension-enable-label">在聊天中启用<ExtensionEnableSwitch extension={extension} onChanged={onChanged} /></span>
    {error && <span className="extension-action-error" role="alert">{error}</span>}
  </>
}
