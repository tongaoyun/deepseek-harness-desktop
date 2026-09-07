import { invoke, isTauri } from '@tauri-apps/api/core'
import { HardDrive } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface Usage { files: number; bytes: number; reclaimableFiles: number; reclaimableBytes: number; removedFiles: number; removedBytes: number }
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
export function attachmentStorageReferences(storage: Storage = localStorage): unknown[] {
  const values: unknown[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index) ?? ''
    if (/^xiaoyin(?:\.task-(?:drafts|history)\.|:local-schedules:|:task-queue:)/.test(key)) {
      // Fail closed if any account's references cannot be read.
      values.push(JSON.parse(storage.getItem(key) ?? 'null'))
    }
  }
  return values
}
export function AttachmentStoragePanel() {
  const [usage, setUsage] = useState<Usage>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [notice, setNotice] = useState('')
  const locked = useRef(false)
  const mounted = useRef(true)
  async function inspect(clean = false) {
    if (locked.current) return
    locked.current = true; setBusy(true); setError('')
    try {
      const result = await invoke<Usage>('attachment_storage', { references: attachmentStorageReferences(), clean })
      if (!mounted.current) return
      setConfirm(false)
      setUsage(clean ? { ...result, files: result.files - result.removedFiles, bytes: result.bytes - result.removedBytes, reclaimableFiles: 0, reclaimableBytes: 0 } : result)
      if (clean) setNotice(`已清理 ${result.removedFiles} 个未引用附件，释放 ${size(result.removedBytes)}。缓存文件已删除，无法撤销；原始文件不受影响。`)
    } catch (reason) { if (mounted.current) setError(`存储检查未完成：${String(reason)}`) }
    finally { locked.current = false; if (mounted.current) setBusy(false) }
  }
  useEffect(() => { mounted.current = true; if (isTauri()) void inspect(); return () => { mounted.current = false } }, [])
  return <section className="settings-panel storage-settings"><header><span><HardDrive size={18} /></span><div><h2>附件存储</h2><p>管理粘贴图片与文件产生的本地缓存。</p></div></header>
    {!isTauri() ? <p>请在桌面应用中管理本地附件。</p> : <>
      <p>保留所有账号的任务、归档、草稿和定时计划引用的附件，以及最近 24 小时的缓存。不会清理原始文件和交付成果。</p>
      {usage && <dl><div><dt>缓存总量</dt><dd>{usage.files} 个文件 · {size(usage.bytes)}</dd></div><div><dt>可清理</dt><dd>{usage.reclaimableFiles} 个文件 · {size(usage.reclaimableBytes)}</dd></div></dl>}
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      <div className="storage-actions"><button disabled={busy} onClick={() => void inspect()} type="button">{busy ? '处理中…' : '重新检查'}</button>
        {!confirm ? <button disabled={busy || !usage?.reclaimableFiles} onClick={() => setConfirm(true)} type="button">清理未引用附件</button> : <><span>删除这些缓存后无法撤销，确认清理？</span><button disabled={busy} onClick={() => setConfirm(false)} type="button">取消</button><button disabled={busy} onClick={() => void inspect(true)} type="button">确认清理</button></>}
      </div>
    </>}
  </section>
}
