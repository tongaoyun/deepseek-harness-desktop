import { useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, FileArchive, LoaderCircle, X } from 'lucide-react'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { isTauri } from '@tauri-apps/api/core'
import { selectDeveloperExtension } from './expertKits'
import { AddDialog } from './AddDialog'

interface UploadItem {
  path: string
  state: 'pending' | 'installing' | 'installed' | 'failed' | 'warning'
  message?: string
}

export interface ExtensionInstallResult { warning?: string }

export function ExtensionUploadDialog({ kind, onClose, onInstall }: {
  kind: 'skill' | 'expert-kit'
  onClose: () => void
  onInstall: (path: string) => Promise<ExtensionInstallResult | void>
}) {
  const [items, setItems] = useState<UploadItem[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const lock = useRef(false)
  const latestInstall = useRef(onInstall)
  useEffect(() => { latestInstall.current = onInstall }, [onInstall])

  const append = (paths: string[]) => {
    setItems((current) => {
      const existing = new Set(current.map((item) => item.path))
      return [...current, ...[...new Set(paths)].filter((path) => !existing.has(path)).map((path): UploadItem => ({ path, state: 'pending' }))]
    })
    setError('')
  }

  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let unlisten = () => {}
    void getCurrentWebviewWindow().onDragDropEvent(({ payload }) => {
      if (disposed || lock.current) return
      setDragging(payload.type === 'over' || payload.type === 'enter')
      if (payload.type === 'drop') append(payload.paths)
    }).then((stop) => { if (disposed) stop(); else unlisten = stop }).catch(() => {
      if (!disposed) setError('拖拽暂不可用，请点击选择文件')
    })
    return () => { disposed = true; unlisten() }
  }, [])

  const select = async (input: 'archive' | 'directory') => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try { append(await selectDeveloperExtension(kind, input)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { lock.current = false; setBusy(false) }
  }

  const pending = items.filter((item) => item.state === 'pending' || item.state === 'failed')
  const install = async () => {
    if (lock.current || !pending.length) return
    lock.current = true
    setBusy(true)
    setError('')
    let allSucceeded = !items.some((item) => item.state === 'warning')
    const update = (path: string, state: UploadItem['state'], message?: string) => {
      setItems((current) => current.map((item) => item.path === path ? { path, state, message } : item))
    }
    try {
      for (const item of pending) {
        update(item.path, 'installing')
        try {
          const result = await latestInstall.current(item.path)
          update(item.path, result?.warning ? 'warning' : 'installed', result?.warning)
          if (result?.warning) allSucceeded = false
        } catch (reason) {
          allSucceeded = false
          update(item.path, 'failed', reason instanceof Error ? reason.message : String(reason))
        }
      }
      if (allSucceeded) onClose()
    } finally { lock.current = false; setBusy(false) }
  }

  return <AddDialog title={kind === 'skill' ? '安装技能' : '上传套件'} className="upload-extension-dialog" busy={busy} onClose={onClose}>
    <button type="button" disabled={busy} className={`extension-dropzone${dragging ? ' dragging' : ''}`} onClick={() => void select('archive')}>
      <FileArchive size={30} /><span>{items.length ? '添加文件' : kind === 'skill' ? '选择或拖放技能文件' : '选择或拖放套件压缩包'}</span>
    </button>
    {items.length > 0 && <ul className="extension-upload-queue" aria-label="待导入扩展">{items.map((item) => <li key={item.path} className={item.state}>
      {item.state === 'installed' ? <Check size={16} /> : item.state === 'installing' ? <LoaderCircle className="spin" size={16} /> : item.state === 'failed' || item.state === 'warning' ? <CircleAlert size={16} /> : <FileArchive size={16} />}
      <div><strong title={item.path}>{item.path.split(/[/\\]/).pop()}</strong><small role={item.message ? 'alert' : 'status'}>{item.message ?? ({ pending: '待安装', installing: '正在安装', installed: '已安装', failed: '安装失败', warning: '已安装，需处理连接器' }[item.state])}</small></div>
      <button aria-label={`移除 ${item.path.split(/[/\\]/).pop()}`} title="从列表移除" type="button" disabled={busy} onClick={() => setItems((current) => current.filter((entry) => entry.path !== item.path))}><X size={15} /></button>
    </li>)}</ul>}
    <div className="upload-requirements"><strong>文件要求</strong><ul><li>{kind === 'skill' ? 'SKILL.md、ZIP / tar.gz' : '小胤、Qoder、Claude、Qwen 套件 ZIP / tar.gz'}</li><li>每个文件不超过 32 MiB</li></ul></div>
    <button className="upload-folder-button" type="button" disabled={busy} onClick={() => void select('directory')}>选择本地文件夹</button>
    {error && <p className="add-error" role="alert">{error}</p>}
    <footer><button type="button" disabled={busy || !pending.length} onClick={() => void install()}>{busy ? '正在处理…' : pending.some((item) => item.state === 'failed') ? `重试并安装 (${pending.length})` : pending.length > 1 ? `安装 (${pending.length})` : '安装'}</button></footer>
  </AddDialog>
}
