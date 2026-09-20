// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionContentsPanel } from './ExtensionContentsPanel'
import { ExtensionEnableSwitch } from './InstalledExtensionControls'
import { readExtensionContents, setExtensionEnabled } from './expertKits'
import type { InstalledExpertKit } from './types'

vi.mock('./expertKits', () => ({ readExtensionContents: vi.fn(), setExtensionEnabled: vi.fn(), revealExtensionDirectory: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => vi.resetAllMocks())
const extension = { enabled: true, installPath: '/extensions/demo', source: 'developer', manifest: { kind: 'expert-kit', id: 'demo', version: '1.0.0', name: '测试套件' } } as InstalledExpertKit

it('reads real installed sources and opens individual skill instructions', async () => {
  vi.mocked(readExtensionContents).mockResolvedValue({ readme: '# 套件介绍', commands: [], skills: [{ id: 'ext-123456', name: '审查步骤', summary: '检查实际变更', userInvocable: true, path: 'skills/review/SKILL.md', content: '---\nname: review\n---\n# 审查步骤\n\n检查实际变更。' }] })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ExtensionContentsPanel extension={extension} />))
    expect(readExtensionContents).toHaveBeenCalledWith('expert-kit', 'demo', '1.0.0')
    const opener = container.querySelector<HTMLButtonElement>('.extension-source-list button')!
    expect(opener.textContent).toContain('审查步骤')
    expect(opener.textContent).not.toContain('ext-123456')
    expect(opener.textContent).toContain('检查实际变更')
    expect(opener.textContent).not.toContain('SKILL.md')
    expect(container.querySelector('.extension-readme details')).toBeNull()
    opener.focus()
    await act(async () => opener.click())
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('审查步骤')
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('审查步骤')
    expect(container.querySelector('[role="dialog"] .extension-markdown')?.textContent).not.toContain('name: review')
    expect(document.activeElement).toBe(container.querySelector('[aria-label="关闭原文"]'))
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(container.querySelector('[aria-label="关闭原文"]'))
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('shows kit commands once with one slash and keeps the README as the kit description', async () => {
  const command = { id: 'order-intake-check', name: '/订单排查', summary: '排查订单为什么没有进入 ERP', userInvocable: true, path: 'commands/order-intake-check.md', content: '# /订单排查' }
  const skill = { id: 'order-intake', name: '订单入库排查', summary: '诊断订单入库问题', userInvocable: true, path: 'skills/order-intake/SKILL.md', content: '# 订单入库排查' }
  vi.mocked(readExtensionContents).mockResolvedValue({ readme: '# 订单专家\n\n处理跨境订单问题。', commands: [command], skills: [skill] })
  const useCommand = vi.fn()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ExtensionContentsPanel extension={extension} onUseCommand={useCommand} />))
    const shortcuts = [...container.querySelectorAll('.detail-command-list code')].map((item) => item.textContent)
    expect(shortcuts).toEqual(['/订单排查'])
    expect(container.textContent).not.toContain('命令说明')
    expect(container.querySelector('[aria-label="查看完整套件说明"]')?.textContent).toContain('处理跨境订单问题')
    await act(async () => container.querySelector<HTMLButtonElement>('.detail-command-list button')!.click())
    expect(useCommand).toHaveBeenCalledWith('order-intake-check')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('shows read errors instead of fabricating source content', async () => {
  vi.mocked(readExtensionContents).mockRejectedValue(new Error('扩展文件不可用'))
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ExtensionContentsPanel extension={extension} />))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('扩展文件不可用')
    expect(container.querySelector('.extension-markdown')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('persists activation before refreshing and leaves failures visibly enabled', async () => {
  const refresh = vi.fn()
  vi.mocked(setExtensionEnabled).mockResolvedValue(undefined)
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ExtensionEnableSwitch extension={extension} onChanged={refresh} />))
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!
    await act(async () => toggle.click())
    expect(setExtensionEnabled).toHaveBeenCalledWith(extension, false)
    expect(refresh).toHaveBeenCalledOnce()
    vi.mocked(setExtensionEnabled).mockRejectedValue(new Error('无法保存设置'))
    await act(async () => toggle.click())
    expect(refresh).toHaveBeenCalledOnce()
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('无法保存设置')
    await act(async () => root.render(<ExtensionEnableSwitch extension={{ ...extension, enabled: false }} onChanged={refresh} />))
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  } finally { await act(async () => root.unmount()); container.remove() }
})
