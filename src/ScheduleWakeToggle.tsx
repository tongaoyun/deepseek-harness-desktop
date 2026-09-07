import { invoke, isTauri } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'

export function ScheduleWakeToggle() {
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (isTauri()) void invoke<boolean>('schedule_keep_awake').then(setEnabled).catch(() => {}) }, [])
  return <div className="schedule-wake"><label><input type="checkbox" checked={enabled} disabled={busy || !isTauri()} onChange={() => {
    setBusy(true); setError('')
    void invoke<boolean>('schedule_keep_awake', { enabled: !enabled }).then(setEnabled, (reason) => setError(String(reason))).finally(() => setBusy(false))
  }} />保持系统唤醒</label>{error && <small role="alert">{error}</small>}</div>
}
