import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DesktopSettingsPage } from './DesktopSettingsPage'

describe('desktop settings navigation', () => {
  it('keeps practical company settings without Qoder-only experimental entries', () => {
    const html = renderToStaticMarkup(<DesktopSettingsPage
      accessToken=""
      authorizedDirectoryCount={0}
      companyName="示例企业"
      connectors={[]}
      department="研发部"
      deviceEndpoint="/devices"
      displayName="测试员工"
      employeeId="employee-1"
      memoryEndpoint="/memory"
      onMemorySaved={() => undefined}
      position="工程师"
      runtimeConnectors={[]}
      runtimeStatus="ready"
    />)

    expect(html).toContain('个人资料')
    expect(html).toContain('系统设置')
    expect(html).toContain('快捷键')
    expect(html).toContain('记忆')
    expect(html).toContain('更新应用')
    expect(html).not.toContain('应用快照')
    expect(html).not.toContain('工作台')
    expect(html).not.toContain('安全工作环境')
    expect(html).not.toContain('实验特性')
  })
})
