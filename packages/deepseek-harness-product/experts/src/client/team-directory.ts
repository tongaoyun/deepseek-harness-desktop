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
 * this mounted view. Every refresh rereads teams and their member catalog.
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
  refresh(): Promise<void>
  getSignal(): AbortSignal | undefined
} {
  const { cache, remote } = options
  const snapshot = React.useSyncExternalStore(cache.teams.subscribe, cache.teams.getSnapshot)
  const catalog = React.useSyncExternalStore(cache.catalog.subscribe, cache.catalog.getSnapshot)
  const experts = React.useMemo(() => catalog.revision < 0 ? [] : [...catalog.experts], [catalog])
  const lifetime = React.useRef<AbortController | undefined>(undefined)
  const callbacks = React.useRef(options)
  callbacks.current = options

  const refresh = React.useCallback(async () => {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted) return
    try {
      await cache.teams.refresh()
      if (signal.aborted) return
      await cache.catalog.refresh()
      if (!signal.aborted) callbacks.current.onSuccess?.()
    } catch (cause) {
      if (!signal.aborted) callbacks.current.onError?.(cause)
    }
  }, [cache])

  React.useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void refresh()
    return () => {
      controller.abort()
      if (lifetime.current === controller) lifetime.current = undefined
    }
  }, [cache, remote, refresh])

  const getSignal = React.useCallback(() => lifetime.current?.signal, [])
  return React.useMemo(() => ({
    snapshot,
    experts,
    refresh,
    getSignal,
  }), [snapshot, experts, refresh, getSignal])
}

/** Shared localized view model for the compact menu and full team library. */
export function useTeamDirectoryView(options: {
  cache: ExpertClientState
  remote: AgencyTeamsRemote
  fallback: string
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
    onError: cause => setError(cause instanceof Error ? tx(cause.message) : tx(options.fallback)),
    onSuccess: () => setError(''),
  })
  return {
    locale,
    tx,
    error,
    setError,
    directory,
    snapshot: directory.snapshot,
    experts: localizedExperts(directory.experts, locale),
  }
}
