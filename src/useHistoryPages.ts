import { useEffect, useRef, useState } from 'react'
import { loadTaskHistoryPage } from './taskHistory'
import type { LocalTaskRun } from './types'

/** Fetch older/search results without replacing live task state. */
export function useHistoryPages(owner: string | undefined, query: string, merge: (items: LocalTaskRun[]) => void, loadedIds: string[] = []) {
  const [ids, setIds] = useState<string[]>([])
  const [more, setMore] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const state = useRef({ owner, query, seen: [] as string[], busy: false, controller: new AbortController() })
  const mergeRef = useRef(merge); mergeRef.current = merge
  const loadedRef = useRef(loadedIds); loadedRef.current = loadedIds
  async function load() {
    const current = state.current
    if (!current.owner || current.busy) return
    current.busy = true; setBusy(true); setError('')
    try {
      const excluded = current.query.trim() ? current.seen : [...new Set([...loadedRef.current, ...current.seen])]
      const page = await loadTaskHistoryPage(current.owner, current.query, 0, excluded, current.controller.signal)
      if (state.current !== current) return
      current.seen = [...new Set([...current.seen, ...page.items.map((item) => item.id)])]
      mergeRef.current(page.items)
      setIds((values) => [...new Set([...values, ...page.items.map((item) => item.id)])])
      setMore(page.items.length < page.total)
    } catch (reason) {
      if (state.current === current && !current.controller.signal.aborted) setError(`无法加载历史：${String(reason)}`)
    } finally {
      current.busy = false
      if (state.current === current) setBusy(false)
    }
  }
  useEffect(() => {
    state.current.controller.abort()
    const current = { owner, query, seen: [], busy: false, controller: new AbortController() }
    state.current = current
    setIds([]); setMore(true); setBusy(false); setError('')
    const timer = query.trim() ? window.setTimeout(() => void load(), 250) : undefined
    return () => {
      clearTimeout(timer)
      current.controller.abort()
      if (state.current === current) state.current = { ...current }
    }
    // load reads the request identity and merge callback from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, query])
  return { ids, more, busy, error, load }
}
