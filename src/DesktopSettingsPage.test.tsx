// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { DesktopSettingsPage } from './DesktopSettingsPage'
import { buildRuntimeDiagnostics, runtimeDiagnosticsFilename } from './runtimeDiagnostics'

describe('desktop settings navigation', () => {
  it('builds shareable diagnostics without accepting arbitrary sensitive fields', () => {
    const diagnostics = buildRuntimeDiagnostics({
      runtime: 'sk-runtime-secret', version: 'Bearer version-secret', capabilities: {
        sessionQuery: 'enabled', sessionReference: 'gated', leakedPrompt: 'enabled' as never,
      }, generatedAt: '2026-09-12T00:00:00.000Z',
    })
    expect(diagnostics).toEqual({
      schemaVersion: 1, runtime: 'unknown', version: 'unknown',
      capabilities: { sessionQuery: 'enabled', sessionReference: 'gated' }, generatedAt: '2026-09-12T00:00:00.000Z',
    })
    expect(JSON.stringify(diagnostics)).not.toMatch(/prompt|secret/iu)
    expect(runtimeDiagnosticsFilename(new Date('2026-09-12T00:00:00.000Z'))).toContain('2026-09-12T00-00-00.000Z')
  })

  it('keeps practical company settings without Qoder-only experimental entries', () => {
    const html = renderToStaticMarkup(<DesktopSettingsPage
      sessionToken=""
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

  it('keeps local settings available while disabling enterprise memory offline', () => {
    const html = renderToStaticMarkup(<DesktopSettingsPage
      sessionToken=""
      companyName="示例企业"
      department="研发部"
      displayName="测试员工"
      employeeId="employee-1"
      memoryAvailable={false}
      memoryEndpoint="/memory"
      onMemorySaved={() => undefined}
      position="工程师"
    />)

    expect(html).toContain('偏好设置')
    expect(html).toContain('快捷键')
    expect(html).toContain('附件存储')
    expect(html).toContain('企业服务连接后可用')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?<strong>记忆<\/strong>/u)
  })

  it('keeps Harness internals hidden and exposes only configured product controls', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const checkHarness = vi.fn()
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    const renderPage = (lsp: 'enabled' | 'unconfigured', codexHooks: 'enabled' | 'unconfigured') => <DesktopSettingsPage
      sessionToken=""
      companyName="示例企业"
      department="研发部"
      displayName="测试员工"
      employeeId="employee-1"
      harnessCapabilities={{ webSearch: 'enabled', sessionQuery: 'gated', sessionReference: 'enabled', lsp, codexHooks }}
      harnessHealth="idle"
      harnessHealthDetail="本地执行环境将在任务开始时按需启动"
      memoryEndpoint="/memory"
      onCheckHarness={checkHarness}
      onMemorySaved={() => undefined}
      position="工程师"
    />
    try {
      await act(async () => root.render(renderPage('unconfigured', 'unconfigured')))
      const runtimeNavigation = [...container.querySelectorAll<HTMLButtonElement>('.settings-navigation button')]
        .find((item) => item.textContent?.includes('本地能力'))
      await act(async () => runtimeNavigation!.click())

      expect(container.textContent).toContain('允许本地命令执行')
      expect(container.textContent).toContain('高级设置与诊断')
      expect(container.textContent).toContain('按需启动')
      expect(container.textContent).not.toContain('代码语言服务')
      expect(container.textContent).not.toContain('自动化 Hooks')
      expect(container.innerHTML).not.toMatch(/SDK Profile|Agent Loop|Ralph|sessionQuery/u)

      await act(async () => root.render(renderPage('enabled', 'enabled')))
      expect(container.textContent).toContain('代码语言服务')
      expect(container.textContent).toContain('自动化 Hooks')
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((item) => item.textContent === '检查本地能力')!.click())
      expect(checkHarness).toHaveBeenCalledOnce()
    } finally { await act(async () => root.unmount()); container.remove() }
  })

  it('reports a failed model check and permits retry', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const check = async () => { throw new Error('model host unavailable') }
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    try {
      await act(async () => root.render(<DesktopSettingsPage sessionToken="" companyName="公司" department="" displayName="员工" employeeId="one" memoryEndpoint="" onMemorySaved={() => undefined} position="" onCheckModelProvider={check} />))
      await act(async () => container.querySelector<HTMLButtonElement>('.settings-navigation button:last-child')!.click())
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '检查模型服务')!.click())
      expect(container.querySelector('.runtime-provider-check')?.textContent).toContain('model host unavailable')
      expect([...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '检查模型服务')?.disabled).toBe(false)
    } finally { await act(async () => root.unmount()); container.remove() }
  })

})
