import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DesktopSettingsPage } from './DesktopSettingsPage'

describe('desktop settings navigation', () => {
  it('keeps practical company settings without Qoder-only experimental entries', () => {
    const html = renderToStaticMarkup(<DesktopSettingsPage
      accessToken=""
      companyName="示例企业"
      department="研发部"
      displayName="测试员工"
      employeeId="employee-1"
      memoryEndpoint="/memory"
      onMemorySaved={() => undefined}
      position="工程师"
    />)

    expect(html).toContain('个人资料')
    expect(html).toContain('快捷键')
    expect(html).toContain('记忆')
    expect(html).not.toContain('更新应用')
    expect(html).not.toContain('应用快照')
    expect(html).not.toContain('系统设置')
    expect(html).not.toContain('设备能力')
    expect(html).not.toContain('设备管理')
    expect(html).not.toContain('工作台')
    expect(html).not.toContain('安全工作环境')
    expect(html).not.toContain('实验特性')
  })
})
