// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { connectorDiagnosticsAvailable, probeHarnessHost, selfTestLocalCapabilities } from './harness'
import { useHarnessHealth } from './useHarnessHealth'

vi.mock('./harness', () => ({ connectorDiagnosticsAvailable: vi.fn(), probeHarnessHost: vi.fn(), selfTestLocalCapabilities: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('starts Harness diagnostics only when explicitly requested', async () => {
  vi.mocked(connectorDiagnosticsAvailable).mockReturnValue(true)
  vi.mocked(probeHarnessHost).mockResolvedValue({ status: 'ready', runtime: 'deepseek-harness', version: 'test', capabilities: {} })
  vi.mocked(selfTestLocalCapabilities).mockResolvedValue({ status: 'passed', checks: [{ key: 'local-files', passed: true, detail: 'ok' }] })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  function Probe() {
    const { health, recover } = useHarnessHealth(true, true, true, false, false, false)
    return <button onClick={() => void recover()}>{health}</button>
  }
  try {
    await act(async () => root.render(<Probe />))
    expect(probeHarnessHost).not.toHaveBeenCalled()
    expect(container.textContent).toBe('idle')
    await act(async () => root.render(<Probe />))
    expect(probeHarnessHost).not.toHaveBeenCalled()
    expect(container.textContent).toBe('idle')
    await act(async () => container.querySelector('button')!.click())
    expect(probeHarnessHost).toHaveBeenLastCalledWith(true, true, false, false, false)
    expect(selfTestLocalCapabilities).toHaveBeenCalledOnce()
    expect(container.textContent).toBe('ready')
  } finally { await act(async () => root.unmount()); container.remove() }
})
