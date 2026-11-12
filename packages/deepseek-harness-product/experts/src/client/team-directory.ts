import React from 'react'
import type { ExpertClientState } from './client-state.ts'
import type { ExpertSummary } from '../expert-contract.ts'
import type { TeamSnapshot } from '../team-contract.ts'
import type { AgencyTeamsRemote } from './remote.ts'
import { useTeamLocale, localizedExperts } from './team-locale.ts'

/**
 * Shared lifecycle for team and expert catalog data.
 *
 * TeamMenu and TeamsPanel are different views, but they consume the same
 * native stores. React observes their current snapshots directly, including
 * the first commit after replacing a store; refresh cancellation belongs to
 * this mounted view. Concurrent refreshes share one request and report busy
 * until both teams and their member catalog are confirmed.
 */
export function useTeamDirectory(options: {
  cache: ExpertClientState
  /** Rebind the lifecycle when the native Remote instance changes. */
  remote: AgencyTeamsRemote
  onError?(cause: unknown): void
  onSuccess?(): void
}): {
  snapshot: TeamSnapshot | null
  experts: ExpertSummary[]
  refreshing: boolean
  refresh(): Promise<void>
  getSignal(): AbortSignal | undefined
} {
  const { cache, remote } = options
  const snapshot = React.useSyncExternalStore(cache.teams.subscribe, cache.teams.getSnapshot)
  const catalog = React.useSyncExternalStore(cache.catalog.subscribe, cache.catalog.getSnapshot)
  const experts = React.useMemo(() => catalog.revision < 0 ? [] : [...catalog.experts], [catalog])
  const lifetime = React.useRef<AbortController | undefined>(undefined)
  const refreshRequest = React.useRef<{ signal: AbortSignal; promise: Promise<void> }>()
  const [pending, setPending] = React.useState<AbortSignal>()
  const callbacks = React.useRef(options)
  callbacks.current = options
  const getSignal = React.useCallback(() => {
    const signal = lifetime.current?.signal
    return signal && AbortSignal.any([signal, cache.teams.signal, cache.catalog.signal])
  }, [cache])

  const refresh = React.useCallback((): Promise<void> => {
    const signal = getSignal()
    if (!signal || signal.aborted) return Promise.resolve()
    if (refreshRequest.current && !refreshRequest.current.signal.aborted) return refreshRequest.current.promise
    const request = { signal, promise: Promise.resolve().then(async () => {
      try {
        signal.throwIfAborted()
        await cache.teams.refresh()
        if (signal.aborted) return
        await cache.catalog.refresh()
        if (!signal.aborted) callbacks.current.onSuccess?.()
      } catch (cause) {
        if (!signal.aborted) callbacks.current.onError?.(cause)
      } finally {
        if (refreshRequest.current === request) {
          refreshRequest.current = undefined
          if (!signal.aborted) setPending(undefined)
        }
      }
    }) }
    refreshRequest.current = request
    setPending(signal)
    return request.promise
  }, [cache, getSignal])

  React.useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void refresh()
    return () => {
      controller.abort()
      if (lifetime.current === controller) lifetime.current = undefined
    }
  }, [cache, remote, refresh])

  return React.useMemo(() => ({
    snapshot,
    experts,
    refreshing: pending !== undefined && !pending.aborted,
    refresh,
    getSignal,
  }), [snapshot, experts, pending, refresh, getSignal])
}

/** Shared localized view model for the compact menu and full team library. */
export function useTeamDirectoryView(options: {
  cache: ExpertClientState
  remote: AgencyTeamsRemote
  fallback: string
  /** Run after both directories are confirmed, before removing the refresh error control. */
  onRefreshSuccess?(): void
}): {
  locale: ReturnType<typeof useTeamLocale>['locale']
  tx: ReturnType<typeof useTeamLocale>['tx']
  error: string
  setError: React.Dispatch<React.SetStateAction<string>>
  directory: ReturnType<typeof useTeamDirectory>
  snapshot: TeamSnapshot | null
  experts: ExpertSummary[]
} {
  const { locale, tx } = useTeamLocale()
  const [error, setError] = React.useState('')
  const directory = useTeamDirectory({
    cache: options.cache,
    remote: options.remote,
    onError: cause => setError(cause instanceof Error ? cause.message : options.fallback),
    onSuccess: () => { options.onRefreshSuccess?.(); setError('') },
  })
  return {
    locale,
    tx,
    error: tx(error),
    setError,
    directory,
    snapshot: directory.snapshot,
    experts: localizedExperts(directory.experts, locale),
  }
}
