import { isTauri } from '@tauri-apps/api/core'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'
import { useCallback, useEffect, useRef, useState } from 'react'

export type UpdaterPhase = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'error'

export interface DownloadProgress {
  downloadedBytes: number
  totalBytes?: number
  percent?: number
}

export interface DesktopUpdaterState extends DownloadProgress {
  phase: UpdaterPhase
  currentVersion?: string
  version?: string
  notes?: string
  error?: string
}

const initialState: DesktopUpdaterState = {
  phase: 'idle',
  downloadedBytes: 0,
}

export function updateDownloadProgress(
  current: DownloadProgress,
  event: DownloadEvent,
): DownloadProgress {
  if (event.event === 'Started') {
    return {
      downloadedBytes: 0,
      ...(event.data.contentLength ? { totalBytes: event.data.contentLength, percent: 0 } : {}),
    }
  }
  if (event.event === 'Finished') {
    return {
      ...current,
      ...(current.totalBytes ? { downloadedBytes: current.totalBytes, percent: 100 } : {}),
    }
  }
  const downloadedBytes = current.downloadedBytes + event.data.chunkLength
  return {
    ...current,
    downloadedBytes,
    ...(current.totalBytes
      ? { percent: Math.min(100, Math.round(downloadedBytes / current.totalBytes * 100)) }
      : {}),
  }
}

export function useDesktopUpdater() {
  const [state, setState] = useState<DesktopUpdaterState>(initialState)
  const updateRef = useRef<Update | null>(null)
  const checkingRef = useRef(false)

  const checkForUpdates = useCallback(async (silent = false) => {
    if (!isTauri() || checkingRef.current) return
    checkingRef.current = true
    if (!silent) setState((current) => ({ ...current, phase: 'checking', error: undefined }))
    try {
      const available = await check({ timeout: 15_000, allowDowngrades: true })
      if (updateRef.current && updateRef.current !== available) await updateRef.current.close()
      updateRef.current = available
      if (!available) {
        setState({ phase: 'current', downloadedBytes: 0 })
        return
      }
      setState({
        phase: 'available',
        downloadedBytes: 0,
        currentVersion: available.currentVersion,
        version: available.version,
        notes: available.body,
      })
    } catch (error) {
      if (!silent) {
        setState({
          phase: 'error',
          downloadedBytes: 0,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      checkingRef.current = false
    }
  }, [])

  const install = useCallback(async () => {
    const available = updateRef.current
    if (!available || state.phase === 'downloading' || state.phase === 'installing') return
    let progress: DownloadProgress = { downloadedBytes: 0 }
    setState((current) => ({ ...current, phase: 'downloading', ...progress, error: undefined }))
    try {
      await available.downloadAndInstall((event) => {
        progress = updateDownloadProgress(progress, event)
        setState((current) => ({
          ...current,
          phase: event.event === 'Finished' ? 'installing' : 'downloading',
          ...progress,
        }))
      }, { timeout: 10 * 60_000 })
      setState((current) => ({ ...current, phase: 'installing' }))
      await relaunch()
    } catch (error) {
      setState((current) => ({
        ...current,
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }, [state.phase])

  useEffect(() => {
    if (!isTauri()) return
    const timer = window.setTimeout(() => void checkForUpdates(true), 2_000)
    return () => window.clearTimeout(timer)
  }, [checkForUpdates])

  return {
    state,
    checkForUpdates: () => checkForUpdates(false),
    install,
  }
}
