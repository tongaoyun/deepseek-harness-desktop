import { describe, expect, it } from 'vitest'
import { buildDeviceCapabilityReport } from './deviceCapabilities'

describe('device capability report', () => {
  it('contains only structured readiness facts', () => {
    const report = buildDeviceCapabilityReport({
      deviceId: '7a925f18-df33-4aad-8c9e-24742940a864', desktopVersion: '0.1.11',
      platform: 'windows', architecture: 'x86_64', displayCount: 2, displayScalePercents: [100, 125],
    }, {
      authorizedDirectoryCount: 1, runtimeStatus: 'ready', connectors: [{
        id: 'erp-mcp', name: 'ERP', summary: '', kind: 'mcp', scope: 'company', status: 'ready',
        managed: true, toolNames: [],
      }],
    })
    expect(report.capabilities).toContainEqual({
      key: 'computer.use', status: 'READY', detail: 'Windows Computer Use 能力已内置',
    })
    expect(report.capabilities).toContainEqual({
      key: 'connector.erp-mcp', status: 'READY', detail: '公司连接器已就绪',
    })
    expect(JSON.stringify(report)).not.toContain('ERP')
  })

  it('marks optional platform boundaries and missing authorization explicitly', () => {
    const report = buildDeviceCapabilityReport({
      deviceId: '7a925f18-df33-4aad-8c9e-24742940a864', desktopVersion: '0.1.11',
      platform: 'macos', architecture: 'aarch64', displayCount: 1, displayScalePercents: [200],
    }, { authorizedDirectoryCount: 0, runtimeStatus: 'offline', connectors: [] })
    expect(report.capabilities.find(({ key }) => key === 'computer.use')?.status).toBe('UNSUPPORTED')
    expect(report.capabilities.find(({ key }) => key === 'local.files')?.status).toBe('DEGRADED')
    expect(report.capabilities.find(({ key }) => key === 'control.plane')?.status).toBe('DEGRADED')
  })
})
