import { describe, expect, it } from 'vitest'
import { capabilityReportEntry } from './useDeviceHeartbeat'

describe('device capability report', () => {
  const capabilities = { sessionPersistence: 'enabled' as const, codeRuntime: 'gated' as const, lsp: 'unconfigured' as const }

  it('reports the aggregate Harness state separately from component capabilities', () => {
    expect(capabilityReportEntry('harness', 'ready', capabilities)).toEqual({ key: 'harness', status: 'READY', detail: '本地 Agent 已检查可用' })
    expect(capabilityReportEntry('harness', 'idle', capabilities)).toEqual({ key: 'harness', status: 'READY', detail: '本地 Agent 将在任务开始时按需启动' })
    expect(capabilityReportEntry('harness', 'degraded', capabilities).status).toBe('DEGRADED')
  })

  it('preserves enabled, gated and unconfigured states after transport key normalization', () => {
    expect(capabilityReportEntry('harness.sessionpersistence', 'ready', capabilities).status).toBe('READY')
    expect(capabilityReportEntry('harness.coderuntime', 'ready', capabilities).status).toBe('DEGRADED')
    expect(capabilityReportEntry('harness.lsp', 'ready', capabilities).status).toBe('UNSUPPORTED')
  })
})
