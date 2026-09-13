// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { connectorDiagnosticsAvailable, probeHarnessHost } from './harness'
import { useHarnessHealth } from './useHarnessHealth'

vi.mock('./harness', () => ({ connectorDiagnosticsAvailable: vi.fn(), probeHarnessHost: vi.fn(), selfTestLocalCapabilities: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('reprobes Harness capabilities for the selected tools mode', async () => {
  vi.mocked(connectorDiagnosticsAvailable).mockReturnValue(true)
  vi.mocked(probeHarnessHost).mockResolvedValue({ status: 'ready', runtime: 'deepseek-harness', version: 'test', capabilities: {} })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  function Probe({ mode }: { mode: 'native' | 'ptc' | 'both' }) {
    const { health } = useHarnessHealth(true, true, true, false, false, false, mode)
    return <span>{health}</span>
  }
  try {
    await act(async () => root.render(<Probe mode="native" />))
    expect(probeHarnessHost).toHaveBeenLastCalledWith(true, true, false, false, false, 'native')
    await act(async () => root.render(<Probe mode="ptc" />))
    expect(probeHarnessHost).toHaveBeenLastCalledWith(true, true, false, false, false, 'ptc')
    expect(container.textContent).toBe('ready')
  } finally { await act(async () => root.unmount()); container.remove() }
})
