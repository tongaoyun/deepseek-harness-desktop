import type { ProductApi } from '../src/client/product-api.ts'
import { productFailure, ProductError } from '@deepseek-harness/product/errors'
import { ConnectorDraftSchema } from '@deepseek-harness/product/connector-draft'
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  ConnectorsPanel, KnowledgePanel,
} from '../src/client/DeepSeekHarnessCatalogSection.tsx'
import {
  CAPABILITY_PANELS, EXTENSION_PANELS, CapabilitiesHeading, CapabilityChildIcon,
} from '../src/client/DeepSeekHarnessCapabilitiesNavigation.tsx'
import { ExtensionPage } from '../src/client/ExtensionPage.tsx'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { apply } from '../src/client/index.ts'
import { DeepSeekHarnessSettingsMenu } from '../src/client/DeepSeekHarnessSettingsMenu.tsx'
import { zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'
import { createPreviewFixture, originalFromFixture, originalMetadata, renderKnowledgePreview } from './knowledge-preview-fixture.client.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Reflect.deleteProperty(globalThis, 'dshDesktop')
})

function installProductApi(api: Partial<ProductApi> & Pick<ProductApi, 'invoke'>): void {
  const preview = createPreviewFixture()
  Object.defineProperty(globalThis, 'dshDesktop', { configurable: true, value: { extensions: {
    invoke: async (_namespace: string, method: string, payload?: unknown, requestId?: string) => {
      try {
        if (method === 'knowledge.documents.previewMetadata') return { ok: true, result: originalMetadata('orders', 'document-1', '订单政策.md') }
        const result = await (method === 'auth.getSession' ? api.getSession?.() ?? Promise.resolve({ authenticated: true })
          : preview(method, payload, (operation, input) => requestId === undefined
            ? api.invoke(operation, input) : api.invoke(operation, input, requestId)))
        return { ok: true, result: method === 'knowledge.documents.preview' ? originalFromFixture(result) : result }
      } catch (error) { return { ok: false, failure: productFailure(error) } }
    },
    cancel: (_namespace: string, requestId: string) => api.cancel?.(requestId),
    subscribe: (_namespace: string, listener: (event: { type: string }) => void) => api.subscribe?.(listener) ?? (() => {}),
  } } })
}

const t = (key: DeepSeekHarnessProductKey): string => zh[key]
const actions = () => ({ renderFactorySlot: renderKnowledgePreview })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail })
  return { promise, resolve, reject }
}

function castClientContext(value: object): ClientContext {
  return value as ClientContext
}

describe('DeepSeekHarness capability navigation', () => {
  it('opens personal connectors after saving and keeps shared connectors under All', async () => {
    const shared = { id: 'shared-mcp', name: 'Shared MCP', version: '1.0.0', visibility: 'COMPANY', canEdit: false }
    const invoke = vi.fn(async (method: string, payload?: unknown) => {
      if (method === 'connectors.list') return [shared]
      const value = ConnectorDraftSchema.parse(payload)
      return { kind: 'connector', id: value.id, version: value.version, visibility: 'PERSONAL' }
    })
    installProductApi({ invoke })
    render(<ConnectorsPanel t={t} {...actions()} />)
    await screen.findByRole('button', { name: new RegExp(shared.name) })
    fireEvent.click(screen.getByRole('button', { name: zh.addExtension }))
    fireEvent.change(screen.getByLabelText(zh.mcpServerName), { target: { value: 'My MCP' } })
    fireEvent.change(screen.getByLabelText(zh.mcpCommand), { target: { value: 'node server.js' } })
    fireEvent.click(within(screen.getByRole('dialog', { name: zh.addMcpServer })).getByRole('button', { name: zh.addMcp }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: zh.addMcpServer })).toBeNull() })
    const mine = screen.getByRole('tab', { name: zh.mineExtensions })
    expect(mine.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(mine.id)
    fireEvent.click(screen.getByRole('tab', { name: zh.connectorFilterAll }))
    expect(screen.getByRole('button', { name: new RegExp(shared.name) })).toBeTruthy()
  })
  it('configures private values for a shared connector without editing its resource or version', async () => {
    const entry = { id: 'shared-orders', name: '共享订单连接器', version: '1.0.0', visibility: 'COMPANY',
      status: 'needs-configuration', ready: false, canEdit: false, canConfigure: true, authMode: 'none', tools: [] }
    let fail = true
    const invoke = vi.fn(async (method: string, _payload?: unknown, _requestId?: string) => {
      if (method === 'connectors.list') return [entry]
      if (method === 'extensions.connector.configuration.read') return { id: entry.id, version: entry.version, transport: 'streamable-http',
        url: 'https://mcp.example.test', arguments: [], headers: ['Authorization'], environment: [], configured: false, timeoutSeconds: 60 }
      if (method === 'extensions.connector.configuration.save') {
        if (fail) throw new ProductError('CONNECTOR_DISCOVERY_FAILED', 'Discovery failed', true)
        return { id: entry.id, version: entry.version, configured: true }
      }
      return []
    })
    installProductApi({ invoke, cancel: vi.fn(), getSession: async () => ({ authenticated: true, employeeId: 'recipient' }) })
    render(<ConnectorsPanel t={t} {...actions()} />)
    fireEvent.click(await screen.findByRole('button', { name: /共享订单连接器/ }))
    fireEvent.click(await screen.findByRole('button', { name: zh.configureDevice }))
    expect(screen.queryByRole('button', { name: zh.editConnector })).toBeNull()
    const secret = await screen.findByLabelText<HTMLInputElement>('Authorization')
    const input = screen.getByDisplayValue<HTMLInputElement>('https://mcp.example.test')
    fireEvent.change(secret, { target: { value: 'recipient-private-key' } })
    expect(secret.type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
    await screen.findByRole('alert')
    expect(secret.value).toBe('recipient-private-key')
    expect(input.readOnly).toBe(true)
    fail = false
    fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: zh.configureDevice })).toBeNull() })
    expect(invoke).toHaveBeenCalledWith('extensions.connector.configuration.save', { id: entry.id, version: '1.0.0',
      configuration: { headers: { Authorization: 'recipient-private-key' }, environment: {}, timeoutSeconds: 60 } }, expect.any(String))
    expect(invoke.mock.calls.some(([method]) => method === 'extensions.connector.update' || method === 'extensions.save')).toBe(false)
  })

  it('opens official settings and product feedback from the more menu', () => {
    const openSettings = vi.fn()
    render(<DeepSeekHarnessSettingsMenu t={t} wide settingsOpen={false} openSettings={openSettings}
      openOnboarding={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: zh.menu }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([zh.settings, zh.feedbackTitle])
    fireEvent.click(screen.getByRole('menuitem', { name: zh.settings }))
    expect(openSettings).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: zh.menu }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh.feedbackTitle }))
    expect(screen.getByRole('dialog', { name: zh.feedbackTitle })).not.toBeNull()
    expect(openSettings).toHaveBeenCalledOnce()
  })

  it('opens the native software updater from the more menu and permits retry after failure', async () => {
    const pending = deferred<undefined>()
    const openSoftwareUpdate = vi.fn().mockRejectedValueOnce(new Error('private updater diagnostic'))
      .mockImplementationOnce(() => pending.promise)
    render(<DeepSeekHarnessSettingsMenu t={t} wide settingsOpen={false} openSettings={vi.fn()}
      openOnboarding={vi.fn()} openSoftwareUpdate={openSoftwareUpdate} />)
    fireEvent.click(screen.getByRole('button', { name: zh.menu }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([zh.settings, zh.softwareUpdate, zh.feedbackTitle])
    fireEvent.click(screen.getByRole('menuitem', { name: zh.softwareUpdate }))
    expect((await screen.findByRole('alert')).textContent).toBe(zh.softwareUpdateFailed)
    expect(document.body.textContent).not.toContain('private updater diagnostic')
    fireEvent.click(screen.getByRole('button', { name: zh.menu }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh.softwareUpdate }))
    fireEvent.click(screen.getByRole('button', { name: zh.menu }))
    expect(screen.getByRole('menuitem', { name: zh.softwareUpdate })).toHaveProperty('disabled', true)
    await act(async () => { pending.resolve(undefined) })
    expect(openSoftwareUpdate).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('registers capability panels in the sidebar and none in Settings', () => {
    const openUpdate = vi.fn(async () => {})
    Object.defineProperty(globalThis, 'dshDesktop', { configurable: true, value: { protocolVersion: 1, updates: { check: openUpdate } } })
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const selectPanel = vi.fn()
    const registerCommand = vi.fn((_command: CommandContribution) => () => {})
    const ctx = {
      effect: (effect: () => unknown) => effect(),
      commandUi: { register: registerCommand },
      sessions: { subagentAddress: vi.fn(() => undefined) },
      locale: { register: vi.fn(() => () => {}), bind: vi.fn(() => t) },
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
    }

    apply(castClientContext(ctx))

    expect(registrations.filter(entry => entry.options.name === 'settings.section')).toEqual([])
    expect(registrations.filter(entry => entry.options.name === 'sidebar.panelheading')
      .map(entry => entry.options.id)).toEqual(['deepseek-harness-capabilities'])
    expect(registrations.filter(entry => entry.options.name === 'sidebar.panellist')
      .map(entry => entry.options.id)).toEqual([...EXTENSION_PANELS, ...CAPABILITY_PANELS].map(panel => panel.id))
    expect(registrations.filter(entry => entry.options.name === 'main')
      .map(entry => entry.options.key)).toEqual([...EXTENSION_PANELS, ...CAPABILITY_PANELS].map(panel => panel.id))
    const settingsLaunchers = registrations.filter(entry => entry.options.name === 'settings.launcher')
    expect(settingsLaunchers).toHaveLength(1)
    // Let the browser slot facade allocate the shadowing rank so this product
    // launcher replaces the official account launcher after a reload.
    expect(settingsLaunchers[0]?.options.priority).toBeUndefined()
    const injectLauncher = settingsLaunchers[0]?.options.inject as () => { openSoftwareUpdate(): Promise<void> }
    void injectLauncher().openSoftwareUpdate()
    expect(openUpdate).toHaveBeenCalledOnce()
    expect(registrations.filter(entry => entry.options.name === 'conversation.input.left')
      .map(entry => entry.options.id)).toEqual(['product-knowledge'])
    expect(registrations.filter(entry => entry.options.name === 'conversation.hero.agentPreset')).toEqual([])
    expect(registrations.filter(entry => entry.options.name === 'conversation.hero.actions')
      .map(entry => entry.options.id)).toEqual([])
    expect(registrations.filter(entry => entry.options.name === 'conversation.session.header.actions')
      .map(entry => entry.options.id)).toEqual([])
    expect(registerCommand).toHaveBeenCalledOnce()
    expect(registerCommand.mock.calls[0]?.[0].name).toBe('knowledge')
    expect(registerCommand.mock.calls[0]?.[0].label?.()).toBe(zh.referenceKnowledge)
    expect(selectPanel).not.toHaveBeenCalled()
  })

  it('opens knowledge selection only in its mounted Session and releases the command with the plugin', () => {
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const disposers: Array<() => void> = []
    const unregisterCommand = vi.fn()
    const registerCommand = vi.fn((_command: CommandContribution) => unregisterCommand)
    const sessionA = 'session-a' as SessionId
    const sessionB = 'session-b' as SessionId
    const subagent = 'subagent' as SessionId
    const ctx = {
      effect: (effect: () => unknown) => {
        const dispose = effect()
        if (typeof dispose === 'function') disposers.push(dispose as () => void)
        return dispose
      },
      commandUi: { register: registerCommand },
      sessions: { subagentAddress: vi.fn((id: SessionId) => id === subagent ? {} : undefined) },
      locale: { register: vi.fn(() => () => {}), bind: vi.fn(() => t) },
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
    }
    apply(castClientContext(ctx))
    const command = registerCommand.mock.calls[0][0]
    const knowledge = registrations.find(entry => entry.options.id === 'product-knowledge')!
    const injectKnowledge = knowledge.options.inject as (sessionId: SessionId) => {
      subscribeOpen(listener: () => void): () => void
    }
    const openA = vi.fn()
    const openB = vi.fn()
    expect(command.available({ sessionId: sessionA })).toBe(false)
    const releaseA = injectKnowledge(sessionA).subscribeOpen(openA)
    const releaseB = injectKnowledge(sessionB).subscribeOpen(openB)
    const releaseSubagent = injectKnowledge(subagent).subscribeOpen(vi.fn())
    expect(command.available({ sessionId: sessionA })).toBe(true)
    expect(command.available({ sessionId: subagent })).toBe(false)
    if (command.ui.kind !== 'action') throw new Error('Knowledge selection must be an action')
    command.ui.run({ sessionId: sessionA })
    expect(openA).toHaveBeenCalledOnce()
    expect(openB).not.toHaveBeenCalled()
    command.ui.run({ sessionId: sessionB })
    expect(openB).toHaveBeenCalledOnce()
    releaseA()
    expect(command.available({ sessionId: sessionA })).toBe(false)
    command.ui.run({ sessionId: sessionA })
    expect(openA).toHaveBeenCalledOnce()
    releaseSubagent()
    for (const dispose of disposers.reverse()) dispose()
    expect(unregisterCommand).toHaveBeenCalledOnce()
    expect(command.available({ sessionId: sessionB })).toBe(false)
    command.ui.run({ sessionId: sessionB })
    expect(openB).toHaveBeenCalledOnce()
    releaseB()
  })

  it('renders Capability as a non-interactive group heading', () => {
    render(<CapabilitiesHeading wide t={t} />)
    expect(screen.getByText(zh.capabilities)).not.toBeNull()
    expect(screen.queryByRole('button', { name: zh.capabilities })).toBeNull()
  })

  it('embeds the exact shared page and reports an unavailable plugin without rendering another section', () => {
    const close = vi.fn()
    const renderFactorySlot = vi.fn((() => <div>Plugin page</div>) as PropsRenderFactories['renderFactorySlot'])
    const props = { sectionId: 'agency-agents', close, t, renderFactorySlot, useAvailable: (<T,>(select: (value: boolean) => T): T => select(true)) }
    const { rerender } = render(<ExtensionPage {...props} />)
    expect(screen.getByText('Plugin page')).toBeTruthy()
    expect(renderFactorySlot).toHaveBeenCalledWith('settings.section-view', {
      sectionId: 'agency-agents', close, presentation: 'embedded',
    })
    renderFactorySlot.mockClear()
    rerender(<ExtensionPage {...props} useAvailable={select => select(false)} />)
    expect(screen.getByRole('alert').textContent).toBe(zh.extensionUnavailable)
    expect(renderFactorySlot).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    rerender(<CapabilitiesHeading wide={false} t={t} />)
    expect(screen.queryByText(zh.capabilities)).toBeNull()
  })

  it('removes tree branches while retaining useful collapsed-rail icons', () => {
    const { container, rerender } = render(<CapabilityChildIcon
      size={16} active={false} wide icon={CAPABILITY_PANELS[0].icon} />)
    expect(container.querySelector('svg')).toBeNull()
    rerender(<CapabilityChildIcon size={18} active={false} wide={false} icon={CAPABILITY_PANELS[0].icon} />)
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('explains a missing employee mapping in the knowledge directory', async () => {
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })),
      invoke: vi.fn(async () => { throw new ProductError('ORGANIZATION_EMPLOYEE_UNMAPPED', 'private upstream diagnostic') }),
      cancel: vi.fn(),
    })
    render(<KnowledgePanel t={t} {...actions()} />)
    expect((await screen.findByRole('alert')).textContent)
      .toBe(`${zh.organizationEmployeeUnmapped} (ORGANIZATION_EMPLOYEE_UNMAPPED)`)
    expect(screen.queryByText('private upstream diagnostic')).toBeNull()
    expect(screen.queryByText(zh.authRequired)).toBeNull()
  })

  it.each([
    ['ORGANIZATION_SERVICE_UNAVAILABLE', false],
    ['ORGANIZATION_SYNC_EXPIRED', false],
    ['KNOWLEDGE_ACCESS_DENIED', true],
    ['KNOWLEDGE_ACCESS_REVOKED', true],
    ['ORGANIZATION_EMPLOYEE_INACTIVE', true],
    ['ORGANIZATION_EMPLOYEE_UNMAPPED', true],
    ['ORGANIZATION_SOURCE_INVALID', true],
  ] as const)('preserves knowledge drafts only for temporary directory failures: %s', async (code, denied) => {
    let failed = false
    const invoke = vi.fn(async (method: string) => {
      if (method === 'knowledge.bases.list') {
        if (failed) throw new ProductError(code, 'private upstream diagnostic', !denied)
        return [{ id: 'personal', name: '我的资料', scope: 'PERSONAL', canManage: true }]
      }
      return { items: [], page: 1, size: 20, total: 0 }
    })
    installProductApi({ invoke, getSession: async () => ({ authenticated: true, employeeId: 'employee' }) })
    const { container } = render(<KnowledgePanel t={t} {...actions()} />)
    fireEvent.click(await screen.findByRole('button', { name: zh.knowledgeAddMaterial }))
    const navigation = within(container.querySelector('[data-knowledge-navigation]') as HTMLElement)
    const refresh = navigation.getByRole('button', { name: zh.refresh })
    fireEvent.click(await screen.findByRole('menuitem', { name: zh.knowledgeNewDocument }))
    const body = screen.getByRole<HTMLTextAreaElement>('textbox', { name: zh.knowledgeMarkdownContent })
    fireEvent.change(body, { target: { value: '保留编辑内容' } })
    failed = true
    fireEvent.click(refresh)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(code) })
    expect(screen.queryByText('private upstream diagnostic')).toBeNull()
    if (denied) {
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.queryByRole('button', { name: '我的资料', exact: true })).toBeNull()
      expect(invoke.mock.calls.some(([method]) => method === 'knowledge.documents.save')).toBe(false)
    } else {
      expect(screen.getByRole('dialog').contains(body)).toBe(true)
      expect(body.value).toBe('保留编辑内容')
    }
  })

  it('does not close another connector detail when a cancelled revocation returns late', async () => {
    const pending = deferred<unknown>()
    const cancel = vi.fn()
    const invoke = vi.fn(async (method: string) => {
      if (method === 'connectors.list') return ['first', 'second'].map(id => ({ id, name: `连接器 ${id}`,
        authMode: 'oauth', authorizationStatus: 'AUTHORIZED', tools: [] }))
      if (method === 'connectors.authorization.revoke') return pending.promise
      return []
    })
    installProductApi({ invoke, cancel })
    render(<ConnectorsPanel t={t} {...actions()} />)
    fireEvent.click(await screen.findByRole('button', { name: /连接器 first/ }))
    fireEvent.click(screen.getByRole('button', { name: zh.revokeAuthorization }))
    await waitFor(() => { expect(invoke.mock.calls.some(([method]) => method === 'connectors.authorization.revoke')).toBe(true) })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.close }))
    expect(cancel).toHaveBeenCalledWith(expect.any(String))
    fireEvent.click(screen.getByRole('button', { name: /连接器 second/ }))
    await screen.findByRole('dialog', { name: zh.connectorDetails })
    const reads = invoke.mock.calls.filter(([method]) => method === 'connectors.list').length
    await act(async () => { pending.resolve({ status: 'REQUIRED' }) })
    expect(screen.getByRole('dialog', { name: zh.connectorDetails }).textContent).toContain('连接器 second')
    expect(invoke.mock.calls.filter(([method]) => method === 'connectors.list')).toHaveLength(reads)
  })

  it('allows retrying a failed connector revocation after StrictMode effect reactivation', async () => {
    let fail = true
    let authorized = true
    const invoke = vi.fn(async (method: string) => {
      if (method === 'connectors.list') return [{ id: 'erp', name: 'ERP 连接器',
        authMode: 'oauth', authorizationStatus: authorized ? 'AUTHORIZED' : 'REQUIRED', tools: [] }]
      if (method === 'connectors.authorization.revoke') {
        if (fail) throw new Error('network unavailable')
        authorized = false
        return { connectorId: 'erp', status: 'REQUIRED' }
      }
      return []
    })
    installProductApi({ invoke })
    render(<StrictMode><ConnectorsPanel t={t} {...actions()} /></StrictMode>)
    fireEvent.click(await screen.findByRole('button', { name: /ERP 连接器/ }))
    fireEvent.click(screen.getByRole('button', { name: zh.revokeAuthorization }))
    expect((await screen.findByRole('alert')).textContent).toBe(zh.authorizationFailed)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.revokeAuthorization }).disabled).toBe(false)
    fail = false
    fireEvent.click(screen.getByRole('button', { name: zh.revokeAuthorization }))
    const dialog = screen.getByRole('dialog', { name: zh.connectorDetails })
    await within(dialog).findByRole('button', { name: zh.authorize })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('presents configured state and business tools without technical connection facts', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => [
      { id: 'erp', name: 'erp-mcp', displayName: 'ERP 连接器', summary: '订单数据', category: 'industry-data',
        status: 'ready', scope: 'COMPANY', transport: 'stdio', version: '0.4.0',
        availabilityStatus: 'AVAILABLE',
        tools: [
          { name: 'orders_read', displayName: '查询订单', description: '读取订单', access: 'READ' },
          { name: 'orders_update', displayName: '更新订单', description: '修改订单', access: 'WRITE' },
        ], authMode: 'employee-bearer' },
      { id: 'docs', name: '文档', summary: '企业文档', category: 'knowledge-documents', status: 'ready',
        availabilityStatus: 'AVAILABLE', tools: [] },
    ])
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
    })

    render(<ConnectorsPanel t={t} {...actions()} />)
    expect(await screen.findByRole('region', { name: zh.categoryIndustryData })).not.toBeNull()
    expect(screen.getByRole('region', { name: zh.categoryKnowledgeDocuments })).not.toBeNull()
    expect(screen.getByRole('button', { name: zh.categoryFilter })).not.toBeNull()
    expect(screen.getByText(zh.allCategories)).not.toBeNull()
    const results = document.querySelector('#deepseek-harness-catalog-results')
    expect(results).not.toBeNull()
    expect(results?.textContent?.match(new RegExp(zh.connectorConfigured, 'gu'))).toHaveLength(2)
    expect(screen.getByText(zh.readCapabilityShort.replace('{count}', '1'))).not.toBeNull()
    expect(screen.getByText(zh.writeCapabilityShort.replace('{count}', '1'))).not.toBeNull()
    expect(screen.queryByText(zh.scopeCompany)).toBeNull()
    expect(screen.queryByText(zh.transportStdio)).toBeNull()
    expect(screen.queryByText('0.4.0')).toBeNull()
    expect(screen.getByText('ERP 连接器')).not.toBeNull()
    expect(screen.queryByText('erp-mcp')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: zh.categoryFilter }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh.categoryIndustryData }))
    expect(screen.getByText('ERP 连接器')).not.toBeNull()
    expect(screen.queryByText('文档')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /ERP 连接器/ }))
    expect(await screen.findByRole('dialog', { name: zh.connectorDetails })).not.toBeNull()
    expect(await screen.findByText(zh.connectorTools)).not.toBeNull()
    expect(screen.getByText(zh.readCapabilityCount.replace('{count}', '1'))).not.toBeNull()
    expect(screen.getByText(zh.writeCapabilityCount.replace('{count}', '1'))).not.toBeNull()
    expect(screen.queryByText(zh.scopeCompany)).toBeNull()
    const capability = screen.getByText(zh.viewConnectorTools.replace('{count}', '2')).closest('details')
    expect(screen.queryByText('高级信息')).toBeNull()
    expect(screen.queryByText(zh.transportStdio)).toBeNull()
    expect(capability?.open).toBe(false)
    fireEvent.click(screen.getByText(zh.viewConnectorTools.replace('{count}', '2')))
    expect(capability?.open).toBe(true)
    expect(screen.getByText('查询订单', { selector: 'strong' })).not.toBeNull()
    expect(screen.getByText(zh.readOnlyLabel)).not.toBeNull()
    expect(screen.getByText(zh.writeLabel)).not.toBeNull()
    expect(screen.queryByText('orders_read')).toBeNull()
    expect(screen.queryByText(zh.transportStdio)).toBeNull()
  })

  it('refreshes the catalog after a managed connector is authorized', async () => {
    let subscriber: ((event: { readonly type: string }) => void) | undefined
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'connectors.list') return [{ id: 'erp', displayName: 'ERP 连接器',
        authMode: 'oauth', authorizationStatus: 'REQUIRED', tools: [] }]
      if (method === 'connectors.authorization.begin') return { connectorId: 'erp', status: 'PENDING', authorizationUrl: 'https://auth.example/' }
      if (method === 'connectors.authorization.status') {
        subscriber?.({ type: 'catalog.changed' })
        return { connectorId: 'erp', status: 'AUTHORIZED' }
      }
      throw new Error(`unexpected method: ${method}`)
    })
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
      subscribe: (listener: (event: { readonly type: string }) => void) => { subscriber = listener; return () => {} },
    })

    render(<ConnectorsPanel t={t} {...actions()} />)
    fireEvent.click(await screen.findByRole('button', { name: /ERP 连接器/ }))
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: zh.authorize }))
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => { expect(invoke).toHaveBeenCalledWith(
      'connectors.authorization.status', { id: 'erp' }, expect.any(String),
    ) })
    await vi.waitFor(() => { expect(invoke.mock.calls.filter(call => call[0] === 'connectors.list').length).toBeGreaterThan(1) })
  })

  it('stops managed authorization polling when the detail drawer closes', async () => {
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'connectors.list') return [{ id: 'erp', displayName: 'ERP 连接器',
        authMode: 'oauth', authorizationStatus: 'REQUIRED', tools: [] }]
      if (method === 'connectors.authorization.begin') return { connectorId: 'erp', status: 'PENDING', authorizationUrl: 'https://auth.example/' }
      if (method === 'connectors.authorization.status') return { connectorId: 'erp', status: 'PENDING' }
      throw new Error(`unexpected method: ${method}`)
    })
    const cancel = vi.fn()
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel,
    })

    render(<ConnectorsPanel t={t} {...actions()} />)
    fireEvent.click(await screen.findByRole('button', { name: /ERP 连接器/ }))
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: zh.authorize }))
    await vi.waitFor(() => { expect(invoke).toHaveBeenCalledWith(
      'connectors.authorization.begin', { id: 'erp' }, expect.any(String),
    ) })
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    await vi.advanceTimersByTimeAsync(2_000)

    expect(invoke.mock.calls.some(call => call[0] === 'connectors.authorization.status')).toBe(false)
  })

  it('shows reauthorization for an expired connector', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => [{ id: 'erp', displayName: 'ERP 连接器',
      authMode: 'oauth', authorizationStatus: 'EXPIRED', tools: [] }])
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
    })

    render(<ConnectorsPanel t={t} {...actions()} />)
    fireEvent.click(await screen.findByRole('button', { name: /ERP 连接器/ }))

    expect(within(screen.getByRole('dialog')).getByText(zh.connectorAccountExpired)).not.toBeNull()
    expect(screen.getByRole('button', { name: zh.reauthorize })).not.toBeNull()
  })

  it('revokes a managed connector and refreshes the catalog', async () => {
    let subscriber: ((event: { readonly type: string }) => void) | undefined
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'connectors.list') return [{ id: 'erp', displayName: 'ERP 连接器',
        authMode: 'oauth', authorizationStatus: 'AUTHORIZED', tools: [] }]
      if (method === 'connectors.authorization.revoke') {
        subscriber?.({ type: 'catalog.changed' })
        return { connectorId: 'erp', status: 'REQUIRED' }
      }
      throw new Error(`unexpected method: ${method}`)
    })
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
      subscribe: (listener: (event: { readonly type: string }) => void) => { subscriber = listener; return () => {} },
    })

    render(<ConnectorsPanel t={t} {...actions()} />)
    fireEvent.click(await screen.findByRole('button', { name: /ERP 连接器/ }))
    fireEvent.click(screen.getByRole('button', { name: zh.revokeAuthorization }))

    await waitFor(() => { expect(invoke).toHaveBeenCalledWith(
      'connectors.authorization.revoke', { id: 'erp' }, expect.any(String),
    ) })
    await waitFor(() => { expect(invoke.mock.calls.filter(call => call[0] === 'connectors.list').length).toBeGreaterThan(1) })
  })

  it.each(['authorize', 'revoke'] as const)('rereads only the connector directory after %s succeeds', async (action) => {
    let authorized = action === 'revoke'
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'connectors.list') return [{ id: 'erp', displayName: 'ERP 连接器', authMode: 'oauth',
        authorizationStatus: authorized ? 'AUTHORIZED' : 'REQUIRED', tools: [] }]
      if (method === 'connectors.authorization.begin') return { connectorId: 'erp', status: 'PENDING', authorizationUrl: 'https://auth.example/' }
      if (method === 'connectors.authorization.status') { authorized = true; return { connectorId: 'erp', status: 'AUTHORIZED' } }
      if (method === 'connectors.authorization.revoke') { authorized = false; return { connectorId: 'erp', status: 'REQUIRED' } }
      throw new Error('Organization directory unavailable')
    })
    installProductApi({ getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn() })
    render(<ConnectorsPanel t={t} {...actions()} />)
    fireEvent.click(await screen.findByRole('button', { name: /ERP 连接器/ }))
    if (action === 'authorize') vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: action === 'authorize' ? zh.authorize : zh.revokeAuthorization }))
    if (action === 'authorize') await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => { expect(invoke.mock.calls.filter(call => call[0] === 'connectors.list')).toHaveLength(2) })
    expect(invoke.mock.calls.some(call => call[0] === 'catalog.refresh')).toBe(false)
    expect(screen.queryByText(zh.authorizationFailed)).toBeNull()
    vi.useRealTimers()
    fireEvent.click(screen.getByRole('button', { name: /ERP 连接器/ }))
    expect(await screen.findByRole('button', { name: authorized ? zh.revokeAuthorization : zh.authorize })).not.toBeNull()
  })
})
