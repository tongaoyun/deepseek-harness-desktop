import React from 'react'
import type { ExpertClientState } from './client-state.ts'
import type { ExpertSummary } from '../expert-contract.ts'
import type { TeamSnapshot } from '../team-contract.ts'
import type { AgencyTeamsRemote } from './remote.ts'
import { useTeamLocale, localizedExperts } from './team-locale.ts'

interface TeamDirectoryFeedback {
  onError?(cause: unknown): void
  onSuccess?(): void
}

/**
 * Shared lifecycle for team and expert catalog data.
 *
 * TeamMenu and TeamsPanel are different views, but they consume the same
 * native stores. React observes their current snapshots directly, including
 * the first commit after replacing a store; refresh cancellation belongs to
 * this mounted view. Concurrent refreshes share one request and report busy
 * until both teams and their member catalog are confirmed.
 */
export function useTeamDirectory(options: TeamDirectoryFeedback & {
  cache: ExpertClientState
  /** Rebind the lifecycle when the native Remote instance changes. */
  remote: AgencyTeamsRemote
  /** Capture feedback ownership once per shared refresh. */
  onStart?(): TeamDirectoryFeedback
}): {
  snapshot: TeamSnapshot | null
  experts: ExpertSummary[]
  refreshing: boolean
  /** A preceding member read can supply feedback captured before that read. */
  refresh(feedback?: TeamDirectoryFeedback): Promise<void>
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
  React.useLayoutEffect(() => { callbacks.current = options })
  const getSignal = React.useCallback(() => {
    const signal = lifetime.current?.signal
    return signal && AbortSignal.any([signal, cache.teams.signal, cache.catalog.signal])
  }, [cache])

  const refresh = React.useCallback((feedback?: TeamDirectoryFeedback): Promise<void> => {
    const signal = getSignal()
    if (!signal || signal.aborted) return Promise.resolve()
    if (refreshRequest.current && !refreshRequest.current.signal.aborted) return refreshRequest.current.promise
    const completion = feedback ?? callbacks.current.onStart?.() ?? callbacks.current
    const request = { signal, promise: Promise.resolve().then(async () => {
      try {
        signal.throwIfAborted()
        await cache.teams.refresh()
        if (signal.aborted) return
        await cache.catalog.refresh()
        if (!signal.aborted) completion.onSuccess?.()
      } catch (cause) {
        if (!signal.aborted) completion.onError?.(cause)
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

/** Shared localized feedback; directory reads cannot replace later operation feedback. */
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
  setError(message: string): void
  /** Retain feedback ownership across member and team directory reads. */
  captureFeedback(): TeamDirectoryFeedback
  directory: ReturnType<typeof useTeamDirectory>
  snapshot: TeamSnapshot | null
  experts: ExpertSummary[]
} {
  const { locale, tx } = useTeamLocale()
  const [error, updateError] = React.useState({ message: '', cache: options.cache, remote: options.remote })
  const currentError = React.useRef(error)
  const viewOptions = React.useRef(options)
  React.useLayoutEffect(() => { viewOptions.current = options })
  const setError = React.useCallback((message: string) => {
    const { cache, remote } = viewOptions.current
    if (!message && !currentError.current.message && currentError.current.cache === cache && currentError.current.remote === remote) return
    const next = { message, cache, remote }
    currentError.current = next
    updateError(next)
  }, [])
  const captureFeedback = React.useCallback((): TeamDirectoryFeedback => {
    const started = currentError.current
    return {
      onError: cause => {
        if (started === currentError.current) setError(cause instanceof Error ? cause.message : viewOptions.current.fallback)
      },
      onSuccess: () => {
        if (started !== currentError.current) return
        viewOptions.current.onRefreshSuccess?.()
        setError('')
      },
    }
  }, [setError])
  const directory = useTeamDirectory({ cache: options.cache, remote: options.remote, onStart: captureFeedback })
  return {
    locale,
    tx,
    error: error.cache === options.cache && error.remote === options.remote ? tx(error.message) : '',
    setError,
    captureFeedback,
    directory,
    snapshot: directory.snapshot,
    experts: localizedExperts(directory.experts, locale),
  }
}
