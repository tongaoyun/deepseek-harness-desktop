import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useEffect, useRef, useState } from 'react'

export function useDesktopDrop({
  enabled,
  onPaths,
  onError,
  running,
  scope = 'task',
}: {
  enabled: boolean
  onPaths: (paths: string[]) => Promise<unknown>
  onError: (message: string) => void
  running: boolean
  scope?: 'task' | 'feedback'
}) {
  const [active, setActive] = useState(false)
  const latest = useRef({ onPaths, onError, running })
  latest.current = { onPaths, onError, running }

  useEffect(() => {
    setActive(false)
    if (!enabled) return
    let disposed = false
    let unlisten: () => void = () => undefined
    void getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (disposed) return
      if (scope === 'task' && document.querySelector('[data-feedback-drop]')) { setActive(false); return }
      if (event.payload.type === 'over' || event.payload.type === 'enter') setActive(true)
      if (event.payload.type === 'leave') setActive(false)
      if (event.payload.type !== 'drop') return
      setActive(false)
      if (latest.current.running) {
        latest.current.onError('请先取消或等待当前任务完成，再拖入文件')
        return
      }
      void latest.current.onPaths(event.payload.paths)
        .catch((reason) => { if (!disposed) latest.current.onError(message(reason)) })
    }).then((dispose) => { if (disposed) disposeSilently(dispose); else unlisten = dispose }).catch((reason) => { if (!disposed) latest.current.onError(`拖拽暂不可用，请通过「＋」添加文件：${message(reason)}`) })
    return () => { disposed = true; disposeSilently(unlisten) }
  }, [enabled, scope])

  return enabled && active
}

function disposeSilently(dispose: () => void): void {
  try { dispose() } catch { /* Tauri may already have disposed the listener during hot reload. */ }
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
