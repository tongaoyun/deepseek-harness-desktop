import { FolderOpen, Share2, Download, Pencil, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
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

export function InstalledExtensionControls({ extension, onChanged, onCustomize, onExport, showLabels = false }: {
  extension: InstalledExpertKit; onChanged?: () => Promise<void> | void; onCustomize?: () => void; onExport?: () => void; showLabels?: boolean
}) {
  const [error, setError] = useState('')
  return <>
    <button aria-label="在文件夹中显示" className="secondary" onClick={async () => {
      setError('')
      try { await revealExtensionDirectory(extension) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    }} title="在文件夹中显示" type="button"><FolderOpen size={15} /></button>
    {onCustomize && <button aria-label={showLabels ? '编辑' : '自定义修改'} className={`secondary${showLabels ? ' extension-labelled-action' : ''}`} onClick={onCustomize} title={showLabels ? '编辑套件' : '自定义修改'} type="button"><Pencil size={15} />{showLabels && '编辑'}</button>}
    {onExport && <ExtensionActionMenu label={showLabels ? '分享此套件' : '分享'} showLabel={showLabels} icon={<Share2 size={15} />}><button onClick={onExport} type="button"><Download size={14} />导出为 ZIP 包</button></ExtensionActionMenu>}
    <span className="extension-enable-label">在聊天中启用<ExtensionEnableSwitch extension={extension} onChanged={onChanged} /></span>
    {error && <span className="extension-action-error" role="alert">{error}</span>}
  </>
}

export function ExtensionActionMenu({ label, icon, children, showLabel = false }: { label: string; icon: ReactNode; children: ReactNode; showLabel?: boolean }) {
  const menu = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const dismiss = (event: MouseEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menu.current?.open) {
        event.preventDefault(); event.stopImmediatePropagation()
        menu.current.open = false; menu.current.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('mousedown', dismiss); document.removeEventListener('keydown', escape, true) }
  }, [])
  return <details ref={menu} className={`extension-share-menu${showLabel ? ' extension-labelled-menu' : ''}`} data-popover><summary aria-label={label} title={label}>{icon}{showLabel && <><span>{label}</span><ChevronDown size={13} /></>}</summary><div onClick={(event) => {
    if ((event.target as HTMLElement).closest('button:not(:disabled)') && menu.current) menu.current.open = false
  }}>{children}</div></details>
}
