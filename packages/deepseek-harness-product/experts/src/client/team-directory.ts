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
 * native stores. Keeping subscriptions, refresh coalescing and cancellation
 * here prevents one view from drifting from the other when it is remounted.
 */
export function useTeamDirectory(options: {
  cache: ExpertClientState
  /** Rebind the lifecycle when the native Remote instance changes. */
  remote: AgencyTeamsRemote
  onError?(cause: unknown): void
}): {
  snapshot: TeamSnapshot | null
  experts: ExpertSummary[]
  refresh(): Promise<void>
  getSignal(): AbortSignal | undefined
} {
  const { cache, remote, onError } = options
  const [snapshot, setSnapshot] = React.useState<TeamSnapshot | null>(() => cache.teams.getSnapshot())
  const [experts, setExperts] = React.useState<ExpertSummary[]>(() => {
    const catalog = cache.catalog.getSnapshot()
    return catalog.revision < 0 ? [] : [...catalog.experts]
  })
  const lifetime = React.useRef<AbortController | undefined>(undefined)
  const onErrorRef = React.useRef(onError)
  onErrorRef.current = onError

  const refresh = React.useCallback(async () => {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted) return
    try {
      await cache.teams.refresh()
      if (signal.aborted) return
      if (cache.catalog.getSnapshot().revision < 0) await cache.catalog.refresh()
    } catch (cause) {
      if (!signal.aborted) onErrorRef.current?.(cause)
    }
  }, [cache])

  React.useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    const updateTeams = () => setSnapshot(cache.teams.getSnapshot())
    const updateExperts = () => setExperts([...cache.catalog.getSnapshot().experts])
    const unsubscribeTeams = cache.teams.subscribe(updateTeams)
    const unsubscribeExperts = cache.catalog.subscribe(updateExperts)
    updateTeams()
    updateExperts()
    void refresh()
    return () => {
      controller.abort()
      if (lifetime.current === controller) lifetime.current = undefined
      unsubscribeTeams()
      unsubscribeExperts()
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
