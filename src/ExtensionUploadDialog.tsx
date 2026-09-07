import { useEffect, useRef, useState } from 'react'
import { FileArchive } from 'lucide-react'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { isTauri } from '@tauri-apps/api/core'
import { selectDeveloperExtension } from './expertKits'
import { AddDialog } from './AddDialog'

export function ExtensionUploadDialog({ kind, onClose, onInstall }: { kind: 'skill' | 'expert-kit'; onClose: () => void; onInstall: (path: string) => Promise<void> }) {
  const [path, setPath] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [dragging, setDragging] = useState(false)
  const lock = useRef(false)
  useEffect(() => {
    if (!isTauri()) return
    let disposed = false; let unlisten = () => {}
    void getCurrentWebviewWindow().onDragDropEvent(({ payload }) => {
      if (disposed || lock.current) return
      setDragging(payload.type === 'over' || payload.type === 'enter')
      if (payload.type === 'drop') {
        if (payload.paths.length !== 1) { setError('请一次选择一个扩展包或文件夹'); return }
        setPath(payload.paths[0]); setError('')
      }
    }).then((stop) => { if (disposed) stop(); else unlisten = stop }).catch(() => { if (!disposed) setError('拖拽暂不可用，请点击选择文件') })
    return () => { disposed = true; unlisten() }
  }, [])
  const select = async (input: 'archive' | 'directory') => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { const selected = await selectDeveloperExtension(kind, input); if (selected) setPath(selected) }
    catch (reason) { setError(String(reason)) } finally { lock.current = false; setBusy(false) }
  }
  return <AddDialog title={kind === 'skill' ? '安装技能' : '上传套件'} className="upload-extension-dialog" busy={busy} onClose={onClose}>
    <button type="button" disabled={busy} className={`extension-dropzone${dragging ? ' dragging' : ''}`} onClick={() => void select('archive')}><FileArchive size={30} /><span>{path ? path.split(/[/\\]/).pop() : kind === 'skill' ? '拖放 ZIP 或 SKILL.md 文件，或点击选择' : '点击或拖拽套件压缩包到此处'}</span>{path && <small>已选择，点击可更换 · 安装前不会写入扩展目录</small>}</button>
    <div className="upload-requirements"><strong>文件要求</strong><ul><li>{kind === 'skill' ? '包含 SKILL.md 和辅助资源的 ZIP / tar.gz，或单个 SKILL.md' : '支持小胤、Qoder、Claude 套件 ZIP / tar.gz'}</li><li>文件不超过 32 MiB，安装时校验包结构与内容</li></ul></div>
    <button className="upload-folder-button" type="button" disabled={busy} onClick={() => void select('directory')}>或选择本地文件夹</button>
    {error && <p className="add-error" role="alert">{error}</p>}<footer><button type="button" disabled={busy || !path} onClick={async () => {
      if (lock.current) return
      lock.current = true; setBusy(true); setError('')
      try { await onInstall(path); onClose() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { lock.current = false; setBusy(false) }
    }}>{busy ? '正在处理…' : '安装'}</button></footer>
  </AddDialog>
}
