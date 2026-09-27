import { describe, expect, it } from 'vitest'
import { capabilityReportEntry } from './useDeviceHeartbeat'

describe('device capability report', () => {
  it('requires real checks for policy capabilities and never assumes unknown capabilities are ready', () => {
    const selfTest = { status: 'passed' as const, checks: ['local-files', 'native-shell', 'office-runtime', 'office-skills', 'libreoffice-kit'].map((key) => ({ key, passed: true, detail: '' })) }
    for (const key of ['desktop.runtime', 'office.documents']) {
      expect(capabilityReportEntry(key, 'idle', undefined, selfTest).status).toBe('READY')
      expect(capabilityReportEntry(key, 'idle').status).toBe('DEGRADED')
      expect(capabilityReportEntry(key, 'idle', undefined, { ...selfTest, checks: [] }).status).toBe('DEGRADED')
      expect(capabilityReportEntry(key, 'idle', undefined, { ...selfTest, checks: selfTest.checks.map((check) => ({ ...check, passed: false })) }).status).toBe('DEGRADED')
    }
    expect(capabilityReportEntry('control.plane', 'idle').status).toBe('READY')
    expect(capabilityReportEntry('unknown', 'ready').status).toBe('UNSUPPORTED')
  })
  const capabilities = { sessionPersistence: 'enabled' as const, lsp: 'unconfigured' as const }

  it('reports the aggregate Harness state separately from component capabilities', () => {
    expect(capabilityReportEntry('harness', 'ready', capabilities)).toEqual({ key: 'harness', status: 'READY', detail: '本地 Agent 已检查可用' })
    expect(capabilityReportEntry('harness', 'idle', capabilities)).toEqual({ key: 'harness', status: 'READY', detail: '本地 Agent 将在任务开始时按需启动' })
    expect(capabilityReportEntry('harness', 'degraded', capabilities).status).toBe('DEGRADED')
  })

  it('preserves enabled, gated and unconfigured states after transport key normalization', () => {
    expect(capabilityReportEntry('harness.sessionpersistence', 'ready', capabilities).status).toBe('READY')
    expect(capabilityReportEntry('harness.lsp', 'ready', capabilities).status).toBe('UNSUPPORTED')
  })

  it('does not report an unprobed Harness capability as unsupported', () => {
    expect(capabilityReportEntry('harness.websearch', 'idle').status).toBe('DEGRADED')
  })
})
