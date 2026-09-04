import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useEffect, useRef, useState } from 'react'
import { authorizeDroppedPaths, type DroppedPathAuthorization } from './harness'

export function useDesktopDrop({
  enabled,
  onAuthorized,
  onError,
  running,
}: {
  enabled: boolean
  onAuthorized: (value: DroppedPathAuthorization) => void
  onError: (message: string) => void
  running: boolean
}) {
  const [active, setActive] = useState(false)
  const latest = useRef({ onAuthorized, onError, running })
  latest.current = { onAuthorized, onError, running }

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let unlisten: () => void = () => undefined
    void getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (disposed) return
      if (event.payload.type === 'over') setActive(true)
      if (event.payload.type === 'leave') setActive(false)
      if (event.payload.type !== 'drop') return
      setActive(false)
      if (latest.current.running) {
        latest.current.onError('请先取消或等待当前任务完成，再拖入文件')
        return
      }
      void authorizeDroppedPaths(event.payload.paths)
        .then((value) => latest.current.onAuthorized(value))
        .catch((reason) => latest.current.onError(message(reason)))
    }).then((dispose) => { if (disposed) disposeSilently(dispose); else unlisten = dispose })
    return () => { disposed = true; disposeSilently(unlisten) }
  }, [enabled])

  return active
}

function disposeSilently(dispose: () => void): void {
  try { dispose() } catch { /* Tauri may already have disposed the listener during hot reload. */ }
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
