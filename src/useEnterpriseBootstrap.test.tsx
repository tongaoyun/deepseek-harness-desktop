// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { loadBootstrap } from './api'
import { useEnterpriseBootstrap } from './useEnterpriseBootstrap'
import type { BootstrapResponse } from './types'

vi.mock('./api', () => ({ loadBootstrap: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers() })
const config = (models = ['model-a']) => ({ models, employeeId: 'one', endpoints: {}, modelApiKey: 'fixture-only' }) as BootstrapResponse

it('refreshes on focus and timer, keeps unchanged identity, and recovers from transient failures', async () => {
  vi.useFakeTimers()
  vi.mocked(loadBootstrap).mockResolvedValue(config())
  let state!: ReturnType<typeof useEnterpriseBootstrap>
  function Probe() { state = useEnterpriseBootstrap('one', 'token', 0); return null }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(<Probe />))
    const original = state.bootstrap
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(state.bootstrap).toBe(original)
    vi.mocked(loadBootstrap).mockRejectedValueOnce(new Error('offline'))
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(state.runtimeStatus).toBe('ready')
    expect(state.bootstrap).toBe(original)
    expect(state.error).toContain('暂用上次配置')
    vi.mocked(loadBootstrap).mockResolvedValue(config(['model-b']))
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(state.bootstrap?.models).toEqual(['model-b'])
    expect(state.error).toBe('')
  } finally { await act(async () => root.unmount()) }
})

it('ignores stale employee responses and coalesces refresh while a request is pending', async () => {
  let resolve!: (value: BootstrapResponse) => void
  vi.mocked(loadBootstrap).mockReturnValueOnce(new Promise((yes) => { resolve = yes }))
    .mockResolvedValue({ ...config(['model-two']), employeeId: 'two' })
  let state!: ReturnType<typeof useEnterpriseBootstrap>
  function Probe({ owner }: { owner?: string }) { state = useEnterpriseBootstrap(owner, 'token', 0); return null }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(<Probe owner="one" />))
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(loadBootstrap).toHaveBeenCalledTimes(1)
    await act(async () => root.render(<Probe owner="two" />))
    await act(async () => resolve(config()))
    expect(state.bootstrap?.employeeId).toBe('two')
    await act(async () => root.render(<Probe />))
    expect(state.bootstrap).toBeUndefined()
  } finally { await act(async () => root.unmount()) }
})

it('automatically retries an unavailable initial connection', async () => {
  vi.useFakeTimers()
  vi.mocked(loadBootstrap).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(config())
  let state!: ReturnType<typeof useEnterpriseBootstrap>
  function Probe() { state = useEnterpriseBootstrap('one', '', 0); return null }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(<Probe />))
    expect(state.runtimeStatus).toBe('offline')
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(state.runtimeStatus).toBe('ready')
  } finally { await act(async () => root.unmount()) }
})
