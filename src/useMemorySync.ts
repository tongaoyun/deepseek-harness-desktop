import { useEffect, useRef } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { syncMemoryProfile } from './memory'

export function useMemorySync(employeeId: string | undefined, endpoint: string, sessionToken: string, onConflict: () => void) {
  const notify = useRef(onConflict)
  notify.current = onConflict
  useEffect(() => {
    if (!employeeId || !isTauri()) return
    let disposed = false
    let busy = false
    let notified = false
    const sync = async () => {
      if (busy || disposed) return
      busy = true
      try {
        const profile = await syncMemoryProfile(employeeId, endpoint, sessionToken)
        if (!disposed && profile.syncConflict && !notified) notify.current()
        notified = Boolean(profile.syncConflict)
      } catch { /* Offline/local read failures are shown when the memory page is opened. */ }
      finally { busy = false }
    }
    void sync()
    window.addEventListener('online', sync)
    window.addEventListener('focus', sync)
    const timer = window.setInterval(() => void sync(), 60_000)
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener('online', sync); window.removeEventListener('focus', sync) }
  }, [employeeId, endpoint, sessionToken])
}
