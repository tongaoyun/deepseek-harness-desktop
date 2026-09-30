// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
  ConnectorsPanel, ExpertKitsPanel, KnowledgePanel, SkillsPanel, DeepSeekHarnessCatalogSection,
} from '../src/client/DeepSeekHarnessCatalogSection.tsx'
import {
  CAPABILITY_PANELS, CapabilitiesHeading, CapabilityChildIcon,
} from '../src/client/DeepSeekHarnessCapabilitiesNavigation.tsx'
import { apply } from '../src/client/index.ts'
import { DeepSeekHarnessSettingsMenu } from '../src/client/DeepSeekHarnessSettingsMenu.tsx'
import { zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(globalThis, 'deepseekHarness')
})

const t = (key: DeepSeekHarnessProductKey): string => zh[key]
const actions = () => ({
  setExpertKitEnabled: vi.fn(async () => {}),
  useExpertKitCommand: vi.fn(async () => {}),
  useSkill: vi.fn(async () => {}),
})

describe('DeepSeekHarness capability navigation', () => {
  it('keeps only the official settings action in the more menu', () => {
    const openSettings = vi.fn()
    render(<DeepSeekHarnessSettingsMenu t={t} wide settingsOpen={false} openSettings={openSettings}
      openOnboarding={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: zh.menu }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([zh.settings])
    fireEvent.click(screen.getByRole('menuitem', { name: zh.settings }))
    expect(openSettings).toHaveBeenCalledOnce()
  })

  it('registers capability panels in the sidebar and none in Settings', () => {
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const selectPanel = vi.fn()
    const ctx = {
      effect: (effect: () => unknown) => effect(),
      locale: { register: vi.fn(() => () => {}), bind: vi.fn(() => t) },
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
    }

    apply(ctx as unknown as ClientContext)

    expect(registrations.filter(entry => entry.options.name === 'settings.section')).toEqual([])
    expect(registrations.filter(entry => entry.options.name === 'sidebar.panelheading')
      .map(entry => entry.options.id)).toEqual(['deepseek-harness-capabilities'])
    expect(registrations.filter(entry => entry.options.name === 'sidebar.panellist')
      .map(entry => entry.options.id)).toEqual(CAPABILITY_PANELS.map(panel => panel.id))
    expect(registrations.filter(entry => entry.options.name === 'main')
      .map(entry => entry.options.key)).toEqual(CAPABILITY_PANELS.map(panel => panel.id))
    expect(registrations.filter(entry => entry.options.name === 'settings.launcher')).toHaveLength(1)
    expect(selectPanel).not.toHaveBeenCalled()
  })

  it('uses official Sessions and composer state for expert kits and skills', async () => {
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const setDraft = vi.fn()
    const focus = vi.fn()
    const openSession = vi.fn()
    const create = vi.fn(async () => 'ordinary-session')
    const ctx = {
      effect: (effect: () => unknown) => effect(),
      locale: { register: vi.fn(() => () => {}), bind: vi.fn(() => t) },
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
      sessions: {
        list: { getSnapshot: () => ({ byId: {} }) }, create,
        binding: (sessionId: string) => ({ sessionId, ctx: {} }),
      },
      workspaces: {
        list: { getSnapshot: () => ({ items: [{ workspaceId: 'workspace-1', sessionIds: [] }] }) },
        initializeDefault: vi.fn(),
      },
      uiWorkspace: { openSession },
      conversation: { input: { for: () => ({
        state: { getSnapshot: () => ({ draft: '已有内容  ' }) }, setDraft, focus,
      }) } },
    }

    apply(ctx as unknown as ClientContext)
    const expertKitRegistration = registrations.find(entry => entry.options.key === 'deepseek-harness-expert-kits')
    const skillRegistration = registrations.find(entry => entry.options.key === 'deepseek-harness-skills')
    const expertKitActions = (expertKitRegistration?.options.inject as (() => ReturnType<typeof actions>))()
    const skillActions = (skillRegistration?.options.inject as (() => ReturnType<typeof actions>))()

    await expertKitActions.useExpertKitCommand('order-intake', '检查订单信息')
    await skillActions.useSkill('writing')

    expect(create).toHaveBeenNthCalledWith(1, { workspaceId: 'workspace-1' })
    expect(create).toHaveBeenNthCalledWith(2, { workspaceId: 'workspace-1' })
    expect(openSession).toHaveBeenNthCalledWith(1, 'ordinary-session')
    expect(openSession).toHaveBeenNthCalledWith(2, 'ordinary-session')
    expect(setDraft).toHaveBeenNthCalledWith(1, '已有内容\n/order-intake 检查订单信息')
    expect(setDraft).toHaveBeenNthCalledWith(2, '已有内容\n/writing ')
    expect(focus).toHaveBeenCalledTimes(2)
  })

  it('renders Capability as a non-interactive group heading', () => {
    render(<CapabilitiesHeading wide t={t} />)
    expect(screen.getByText(zh.capabilities)).not.toBeNull()
    expect(screen.queryByRole('button', { name: zh.capabilities })).toBeNull()
  })

  it('removes tree branches while retaining useful collapsed-rail icons', () => {
    const { container, rerender } = render(<CapabilityChildIcon
      size={16} active={false} wide icon={CAPABILITY_PANELS[0].icon} />)
    expect(container.querySelector('svg')).toBeNull()
    rerender(<CapabilityChildIcon size={18} active={false} wide={false} icon={CAPABILITY_PANELS[0].icon} />)
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it.each([
    ['expertKits.list', ExpertKitsPanel],
    ['skills.list', SkillsPanel],
    ['connectors.list', ConnectorsPanel],
    ['knowledge.bases.list', KnowledgePanel],
  ] as const)('loads the protected %s catalog from its main panel', async (method, Panel) => {
    const invoke = vi.fn(async (calledMethod: string): Promise<unknown> => calledMethod === 'expertKits.enablement.list'
      ? [] : [{ id: 'kit-1', name: '全栈开发专家', summary: '默认套件' }])
    const cancel = vi.fn()
    Object.defineProperty(globalThis, 'deepseekHarness', { configurable: true, value: { product: {
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel,
    } } })

    render(<Panel t={t} {...actions()} />)
    expect(await screen.findByText('全栈开发专家')).not.toBeNull()
    expect(screen.getByText('默认套件')).not.toBeNull()
    expect(invoke).toHaveBeenCalledWith(method, undefined, expect.any(String))
  })

  it('shows a safe failure without exposing server details', async () => {
    Object.defineProperty(globalThis, 'deepseekHarness', { configurable: true, value: { product: {
      getSession: vi.fn(async () => ({ authenticated: true })),
      invoke: vi.fn(async () => { throw new Error('internal detail') }),
      cancel: vi.fn(),
    } } })

    render(<ExpertKitsPanel t={t} {...actions()} />)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.loadFailed) })
    expect(screen.queryByText(/internal detail/)).toBeNull()
  })

  it('shows an expired-login action instead of reporting a catalog outage', async () => {
    const getSession = vi.fn()
      .mockResolvedValueOnce({ authenticated: true })
      .mockResolvedValue({ authenticated: false })
    Object.defineProperty(globalThis, 'deepseekHarness', { configurable: true, value: { product: {
      getSession,
      invoke: vi.fn(async () => { throw new Error('Error invoking remote method') }),
      cancel: vi.fn(),
    } } })

    render(<SkillsPanel t={t} {...actions()} />)
    expect(await screen.findByText(zh.authRequired)).not.toBeNull()
    expect(screen.getByRole('button', { name: zh.signIn })).not.toBeNull()
    expect(screen.queryByText(zh.loadFailed)).toBeNull()
  })

  it('reloads the catalog after DingTalk reauthentication', async () => {
    let authenticated = false
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'auth.ensureDingTalk') { authenticated = true; return { authenticated: true } }
      if (method === 'skills.list') return [{ id: 'writing', name: 'AI文本优化' }]
      throw new Error(`unexpected method: ${method}`)
    })
    Object.defineProperty(globalThis, 'deepseekHarness', { configurable: true, value: { product: {
      getSession: vi.fn(async () => ({ authenticated })), invoke, cancel: vi.fn(),
    } } })

    render(<SkillsPanel t={t} {...actions()} />)
    fireEvent.click(await screen.findByRole('button', { name: zh.signIn }))
    expect(await screen.findByText('AI文本优化')).not.toBeNull()
    expect(invoke).toHaveBeenCalledWith('auth.ensureDingTalk')
    expect(invoke).toHaveBeenCalledWith('skills.list', undefined, expect.any(String))
  })

  it('opens a standalone skill and shows its original SKILL.md', async () => {
    const source = '---\nname: writing\n---\n# 文本优化'
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'skills.list') return [{ id: 'writing', name: 'AI文本优化', summary: '让文本更自然' }]
      if (method === 'skills.get') return { id: 'writing', name: 'AI文本优化', author: 'DeepSeekHarness',
        version: '1.0.0', summary: '让文本更自然', sha256: 'a'.repeat(64), commandDetails: [] }
      if (method === 'skills.readme') return { id: 'writing', version: '1.0.0', readme: source }
      throw new Error(`unexpected method: ${method}`)
    })
    const cancel = vi.fn()
    Object.defineProperty(globalThis, 'deepseekHarness', { configurable: true, value: { product: {
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel,
    } } })

    const productActions = actions()
    render(<SkillsPanel t={t} {...productActions} />)
    fireEvent.click(await screen.findByRole('button', { name: /AI文本优化/ }))
    expect(await screen.findByRole('heading', { name: 'AI文本优化' })).not.toBeNull()
    expect(screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === source)).not.toBeNull()
    expect(invoke).toHaveBeenCalledWith('skills.get', { id: 'writing' }, expect.any(String))
    expect(invoke).toHaveBeenCalledWith('skills.readme', { id: 'writing' }, expect.any(String))
    fireEvent.click(screen.getByRole('button', { name: zh.useSkill }))
    await waitFor(() => { expect(productActions.useSkill).toHaveBeenCalledExactlyOnceWith('writing') })
    fireEvent.keyDown(globalThis, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps skill metadata usable when only its SKILL.md resource is unavailable', async () => {
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'skills.list') return [{ id: 'writing', name: 'AI文本优化', summary: '让文本更自然' }]
      if (method === 'skills.get') return { id: 'writing', name: 'AI文本优化', author: 'DeepSeekHarness',
        version: '1.0.0', summary: '让文本更自然', sha256: 'a'.repeat(64), commandDetails: [] }
      if (method === 'skills.readme') throw new Error('resource not found')
      throw new Error(`unexpected method: ${method}`)
    })
    Object.defineProperty(globalThis, 'deepseekHarness', { configurable: true, value: { product: {
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
    } } })

    const productActions = actions()
    render(<SkillsPanel t={t} {...productActions} />)
    fireEvent.click(await screen.findByRole('button', { name: /AI文本优化/ }))
    expect(await screen.findByRole('heading', { name: 'AI文本优化' })).not.toBeNull()
    expect(screen.getByText(zh.sourceUnavailable)).not.toBeNull()
    expect(screen.queryByText(/resource not found/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.useSkill }))
    await waitFor(() => { expect(productActions.useSkill).toHaveBeenCalledExactlyOnceWith('writing') })
  })

  it('opens an expert kit with quick commands and its guide', async () => {
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'expertKits.enablement.list') return []
      if (method === 'expertKits.list') return [{ id: 'product-design', name: '产品设计', summary: '设计师全流程工具箱' }]
      if (method === 'expertKits.get') return {
        id: 'product-design', name: '产品设计', author: 'DeepSeekHarness', version: '1.0.0',
        summary: '设计师全流程工具箱', sha256: 'b'.repeat(64),
        commandDetails: [{ id: 'access', name: '无障碍检查', description: '输入要审计的页面', skillId: 'accessibility' }],
      }
      if (method === 'expertKits.readme') return { id: 'product-design', version: '1.0.0', readme: '# 套件说明' }
      throw new Error(`unexpected method: ${method}`)
    })
    const cancel = vi.fn()
    Object.defineProperty(globalThis, 'deepseekHarness', { configurable: true, value: { product: {
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel,
    } } })

    const productActions = actions()
    render(<ExpertKitsPanel t={t} {...productActions} />)
    fireEvent.click(await screen.findByRole('button', { name: /产品设计/ }))
    expect(await screen.findByText('/ 无障碍检查')).not.toBeNull()
    expect(screen.getByText('输入要审计的页面')).not.toBeNull()
    expect(screen.getByRole('button', { name: zh.close })).not.toBeNull()
    const command = screen.getByRole('button', { name: /无障碍检查/ })
    expect((command as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('switch', { name: zh.enableInChat }))
    await waitFor(() => { expect(productActions.setExpertKitEnabled)
      .toHaveBeenCalledExactlyOnceWith('product-design', true) })
    expect(screen.getByRole('switch', { name: zh.enableInChat }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /无障碍检查/ }))
    await waitFor(() => { expect(productActions.useExpertKitCommand)
      .toHaveBeenCalledWith('accessibility', '输入要审计的页面') })
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(screen.queryByRole('heading', { name: '产品设计' })).toBeNull()
  })

  it('filters the loaded catalog without another server request', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => [
      { id: 'writing', name: 'AI文本优化', summary: '让文本更自然', category: '内容' },
      { id: 'analysis', name: '数据分析', summary: '分析业务数据', category: '数据' },
    ])
    Object.defineProperty(globalThis, 'deepseekHarness', { configurable: true, value: { product: {
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
    } } })

    render(<SkillsPanel t={t} {...actions()} />)
    expect(await screen.findByText('AI文本优化')).not.toBeNull()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '数据' } })

    expect(screen.queryByText('AI文本优化')).toBeNull()
    expect(screen.getByText('数据分析')).not.toBeNull()
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('filters expert kits by their real enabled state', async () => {
    const invoke = vi.fn(async (method: string): Promise<unknown> => method === 'expertKits.enablement.list'
      ? ['orders']
      : [{ id: 'orders', name: '订单专家' }, { id: 'development', name: '开发专家' }])
    Object.defineProperty(globalThis, 'deepseekHarness', { configurable: true, value: { product: {
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
    } } })

    render(<ExpertKitsPanel t={t} {...actions()} />)
    expect(await screen.findByText('开发专家')).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: zh.enabled }))

    expect(screen.getByText('订单专家')).not.toBeNull()
    expect(screen.queryByText('开发专家')).toBeNull()
  })

  it('groups connectors by the category returned by the server', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => [
      { id: 'erp', name: 'ERP', summary: '订单数据', category: '业务系统', status: 'ACTIVE', transport: 'stdio' },
      { id: 'docs', name: '文档', summary: '企业文档', category: '知识文档', status: 'ACTIVE' },
    ])
    Object.defineProperty(globalThis, 'deepseekHarness', { configurable: true, value: { product: {
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
    } } })

    render(<ConnectorsPanel t={t} {...actions()} />)
    expect(await screen.findByRole('region', { name: '业务系统' })).not.toBeNull()
    expect(screen.getByRole('region', { name: '知识文档' })).not.toBeNull()
    expect(screen.getAllByText(zh.statusActive)).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /ERP/ })).toBeNull()
  })

  it('restores expert kit enablement when the runtime update fails', async () => {
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'expertKits.enablement.list') return []
      if (method === 'expertKits.list') return [{ id: 'orders', name: '订单专家' }]
      if (method === 'expertKits.get') return { id: 'orders', name: '订单专家', sha256: 'c'.repeat(64), commandDetails: [] }
      if (method === 'expertKits.readme') return { readme: '订单处理' }
      throw new Error(`unexpected method: ${method}`)
    })
    const cancel = vi.fn()
    Object.defineProperty(globalThis, 'deepseekHarness', { configurable: true, value: { product: {
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel,
    } } })
    const productActions = actions()
    productActions.setExpertKitEnabled.mockRejectedValueOnce(new Error('runtime unavailable'))

    render(<ExpertKitsPanel t={t} {...productActions} />)
    fireEvent.click(await screen.findByRole('button', { name: /订单专家/ }))
    const toggle = await screen.findByRole('switch', { name: zh.enableInChat })
    fireEvent.click(toggle)

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.enableFailed) })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('cancels an active catalog read when its panel unmounts', async () => {
    const pending = new Promise<unknown>(() => {})
    const invoke = vi.fn((_method: string, _payload?: unknown, _requestId?: string) => pending)
    const cancel = vi.fn()
    Object.defineProperty(globalThis, 'deepseekHarness', { configurable: true, value: { product: {
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel,
    } } })

    const view = render(<SkillsPanel t={t} {...actions()} />)
    await waitFor(() => { expect(invoke).toHaveBeenCalledOnce() })
    const requestId = invoke.mock.calls[0]?.[2]
    expect(requestId).toEqual(expect.any(String))

    view.unmount()
    expect(cancel).toHaveBeenCalledExactlyOnceWith(requestId)
  })

  it('does not render an older catalog response after the selected catalog changes', async () => {
    let resolveSkills: ((value: unknown) => void) | undefined
    const pendingSkills = new Promise<unknown>((resolve) => { resolveSkills = resolve })
    const invoke = vi.fn((method: string): Promise<unknown> => method === 'skills.list'
      ? pendingSkills
      : Promise.resolve([{ id: 'erp', name: 'ERP 连接器' }]))
    const cancel = vi.fn()
    Object.defineProperty(globalThis, 'deepseekHarness', { configurable: true, value: { product: {
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel,
    } } })

    const view = render(<DeepSeekHarnessCatalogSection t={t} {...actions()} catalog="skills" labelKey="skills" />)
    await waitFor(() => { expect(invoke).toHaveBeenCalledWith('skills.list', undefined, expect.any(String)) })
    const skillsRequestId = invoke.mock.calls.find(call => call[0] === 'skills.list')?.[2]

    view.rerender(<DeepSeekHarnessCatalogSection t={t} {...actions()} catalog="connectors" labelKey="connectors" />)
    expect(await screen.findByText('ERP 连接器')).not.toBeNull()
    resolveSkills?.([{ id: 'writing', name: '旧技能' }])
    await Promise.resolve()

    expect(cancel).toHaveBeenCalledWith(skillsRequestId)
    expect(screen.queryByText('旧技能')).toBeNull()
  })
})
