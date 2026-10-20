import type { ProductApi } from '../src/client/product-api.ts'
import { productFailure, ProductError } from '@deepseek-harness/product/errors'
import { ExtensionDraftSchema } from '@deepseek-harness/product/extension-draft'
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ProductContentIdentity } from '@deepseek-harness/product/protocol'
import type { DraftInitializationOptions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  ConnectorsPanel, ExpertKitsPanel, KnowledgePanel, SkillsPanel, DeepSeekHarnessCatalogSection,
} from '../src/client/DeepSeekHarnessCatalogSection.tsx'
import {
  CAPABILITY_PANELS, CapabilitiesHeading, CapabilityChildIcon,
} from '../src/client/DeepSeekHarnessCapabilitiesNavigation.tsx'
import { apply } from '../src/client/index.ts'
import { DeepSeekHarnessSettingsMenu } from '../src/client/DeepSeekHarnessSettingsMenu.tsx'
import { en, zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'
import { createPreviewFixture, originalFromFixture, originalMetadata, originalPreview, renderKnowledgePreview } from './knowledge-preview-fixture.client.tsx'

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
const actions = () => ({
  renderFactorySlot: renderKnowledgePreview,
  startExpertKit: vi.fn(async () => {}),
  installSkill: vi.fn(async () => {}),
  readInstalledSkills: vi.fn(async () => ({ installed: [], available: [], frozen: false })),
  installExpertKit: vi.fn(async () => {}),
  readInstalledExpertKits: vi.fn(async () => ({ installed: [] })),
})

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
  it('keeps shared connectors visible after saving a personal connector', async () => {
    const shared = { id: 'shared-mcp', name: 'Shared MCP', version: '1.0.0', visibility: 'COMPANY', canEdit: false }
    const invoke = vi.fn(async (method: string, payload?: unknown) => {
      if (method === 'connectors.list') return [shared]
      const value = ExtensionDraftSchema.parse(payload)
      return { kind: 'connector', id: value.id, version: value.version, visibility: 'PERSONAL', installed: false }
    })
    installProductApi({ invoke })
    render(<ConnectorsPanel t={t} {...actions()} />)
    await screen.findByRole('button', { name: shared.name, exact: true })
    fireEvent.click(screen.getByRole('button', { name: zh.addExtension }))
    fireEvent.change(screen.getByLabelText(zh.mcpServerName), { target: { value: 'My MCP' } })
    fireEvent.change(screen.getByLabelText(zh.mcpCommand), { target: { value: 'node server.js' } })
    fireEvent.click(within(screen.getByRole('dialog', { name: zh.addMcpServer })).getByRole('button', { name: zh.addMcp }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: zh.addMcpServer })).toBeNull() })
    expect(screen.getByRole('button', { name: shared.name, exact: true })).toBeTruthy()
    const mine = screen.getByRole('tab', { name: zh.mineExtensions })
    fireEvent.click(mine)
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(mine.id)
  })

  it('keeps import staging after conversation preparation fails and releases it after a successful retry', async () => {
    const stageId = '00000000-0000-4000-8000-000000000001'
    const invoke = vi.fn(async (method: string) => method === 'extensions.import.inspect'
      ? { stageId, missingFields: ['category'], files: [], draft: { kind: 'skill', name: 'Incomplete import' } } : [])
    const preparing = deferred<undefined>()
    const startExtensionAuthoring = vi.fn(() => preparing.promise)
    installProductApi({ invoke })
    const view = render(<SkillsPanel t={t} {...actions()} startExtensionAuthoring={startExtensionAuthoring} />)
    fireEvent.click(await screen.findByRole('button', { name: zh.addExtension }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh.importSkill }))
    fireEvent.click(screen.getByRole('button', { name: zh.choosePackageFile }))
    await screen.findByRole('dialog', { name: zh.contentPreview })
    fireEvent.click(screen.getByRole('button', { name: zh.continueInConversation }))
    fireEvent.click(screen.getAllByRole('button', { name: zh.close })[0])
    expect(screen.getByRole('dialog', { name: zh.contentPreview })).toBeTruthy()
    await act(async () => { preparing.reject(new Error('offline')) })
    await screen.findByRole('alert')
    expect(screen.getByText('Incomplete import')).toBeTruthy()
    expect(invoke.mock.calls.some(([method]) => method === 'extensions.import.release')).toBe(false)
    startExtensionAuthoring.mockImplementation(async () => undefined)
    fireEvent.click(screen.getByRole('button', { name: zh.continueInConversation }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: zh.contentPreview })).toBeNull() })
    view.unmount()
    expect(invoke.mock.calls.filter(([method]) => method === 'extensions.import.release')).toHaveLength(1)
  })

  it.each(['close', 'save', 'conversation', 'catalog', 'identity', 'unmount'] as const)(
    'retains live import staging through StrictMode and releases it once on %s', async (action) => {
      const stageId = '00000000-0000-4000-8000-000000000001'
      let employeeId = 'employee-one'
      let listener: Parameters<ProductApi['subscribe']>[0] | undefined
      const invoke = vi.fn(async (method: string) => {
        if (method === 'extensions.import.inspect') return { stageId, missingFields: [], files: [{ path: 'SKILL.md', bytes: 40 }],
          draft: { kind: 'skill', id: 'review-policy', name: 'Review policy', summary: 'Review facts', version: '1.0.0',
            category: 'legal', triggers: ['Policy review'], body: 'Retained Markdown' } }
        if (method === 'extensions.save') return { kind: 'skill', id: 'review-policy', version: '1.0.0', visibility: 'PERSONAL', installed: true }
        return []
      })
      const startExtensionAuthoring = vi.fn(async () => {})
      installProductApi({ invoke, getSession: async () => ({ authenticated: true, employeeId }),
        subscribe: (callback) => { listener = callback; return () => { listener = undefined } } })
      const renderPanel = (catalog: 'skills' | 'expertKits') => <StrictMode><DeepSeekHarnessCatalogSection catalog={catalog}
        labelKey={catalog === 'skills' ? 'skills' : 'expertKits'} t={t} {...actions()} startExtensionAuthoring={startExtensionAuthoring} /></StrictMode>
      const view = render(renderPanel('skills'))
      fireEvent.click(await screen.findByRole('button', { name: zh.addExtension }))
      fireEvent.click(screen.getByRole('menuitem', { name: zh.importSkill }))
      fireEvent.click(screen.getByRole('button', { name: zh.choosePackageFile }))
      await screen.findByRole('dialog', { name: zh.contentPreview })
      expect(invoke.mock.calls.filter(([method]) => method === 'extensions.import.release')).toHaveLength(0)
      if (action === 'close') fireEvent.click(screen.getAllByRole('button', { name: zh.close })[0])
      else if (action === 'save') fireEvent.click(screen.getByRole('button', { name: zh.saveAndInstall }))
      else if (action === 'conversation') fireEvent.click(screen.getByRole('button', { name: zh.continueInConversation }))
      else if (action === 'catalog') view.rerender(renderPanel('expertKits'))
      else if (action === 'identity') {
        employeeId = 'employee-two'
        await act(async () => { listener?.({ type: 'session.changed', payload: { authenticated: true, employeeId } }) })
      } else view.unmount()
      await waitFor(() => { expect(screen.queryByRole('dialog', { name: zh.contentPreview })).toBeNull() })
      expect(invoke).toHaveBeenCalledWith('extensions.import.release', { stageId }, expect.any(String))
      view.unmount()
      expect(invoke.mock.calls.filter(([method]) => method === 'extensions.import.release')).toHaveLength(1)
      if (action === 'conversation') expect(startExtensionAuthoring).toHaveBeenCalledWith('skill', expect.objectContaining({ stageId }))
    },
  )

  it.each([SkillsPanel, ExpertKitsPanel, ConnectorsPanel])('refreshes only the displayed directory when another directory is unavailable', async (Panel) => {
    let version = '1.0.0'
    const invoke = vi.fn(async (method: string) => {
      if (method === 'catalog.refresh' || method === 'knowledge.bases.list') throw new ProductError('ORGANIZATION_UNAVAILABLE', 'Offline', true)
      return [{ id: 'entry', name: `Resource ${version}`, version }]
    })
    installProductApi({ invoke })
    render(<Panel t={t} {...actions()} />)
    await screen.findByText('Resource 1.0.0')
    version = '1.0.1'
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    await screen.findByText('Resource 1.0.1')
    expect(invoke.mock.calls.some(([method]) => method === 'catalog.refresh')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
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

  it.each([
    ['skills', 'catalog.changed', SkillsPanel], ['skills', 'session.changed', SkillsPanel],
    ['expertKits', 'catalog.changed', ExpertKitsPanel], ['expertKits', 'session.changed', ExpertKitsPanel],
  ] as const)('finishes loading %s detail during %s without cancelling its requests', async (prefix, eventType, Panel) => {
    let listener: Parameters<ProductApi['subscribe']>[0] | undefined
    const pending = deferred<unknown>()
    const entry = { id: 'review-resource', name: '详情资源', version: '1.0.0' }
    const invoke = vi.fn(async (method: string, _payload?: unknown, _requestId?: string) => method === `${prefix}.list` ? [entry]
      : method === `${prefix}.readme` ? pending.promise : method === `${prefix}.get` ? entry : [])
    const cancel = vi.fn()
    installProductApi({ invoke, cancel, getSession: async () => ({ authenticated: true, employeeId: 'employee-one' }),
      subscribe: (callback) => { listener = callback; return () => {} } })
    render(<Panel t={t} {...actions()} />)
    fireEvent.click(await screen.findByRole('button', { name: entry.name, exact: true }))
    await waitFor(() => { expect(invoke.mock.calls.some(([method]) => method === `${prefix}.readme`)).toBe(true) })
    const detailRequests = invoke.mock.calls.filter(([method]) => method === `${prefix}.readme` || method === `${prefix}.get`)
    await act(async () => { listener?.({ type: eventType, payload: { authenticated: true, employeeId: 'employee-one' } }) })
    for (const request of detailRequests) expect(cancel).not.toHaveBeenCalledWith(request[2])
    await act(async () => { pending.resolve({ readme: '# 详情正文' }) })
    await screen.findByRole('heading', { name: '详情正文' })
    expect(screen.queryByText(zh.loading)).toBeNull()
    if (prefix === 'expertKits') expect(screen.getByRole('button', { name: zh.backToCatalog })).not.toBeNull()
  })

  it('shows a detail failure and return action after a catalog refresh', async () => {
    let listener: Parameters<ProductApi['subscribe']>[0] | undefined
    const pending = deferred<unknown>()
    const invoke = vi.fn(async (method: string) => method === 'expertKits.list' ? [{ id: 'kit', name: '待加载套件' }]
      : method === 'expertKits.get' ? pending.promise : [])
    installProductApi({ invoke, getSession: async () => ({ authenticated: true, employeeId: 'employee-one' }),
      subscribe: (callback) => { listener = callback; return () => {} } })
    render(<ExpertKitsPanel t={t} {...actions()} />)
    fireEvent.click(await screen.findByRole('button', { name: '待加载套件', exact: true }))
    await act(async () => { listener?.({ type: 'catalog.changed' }) })
    await act(async () => { pending.resolve(null) })
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: zh.backToCatalog }))
    await screen.findByRole('button', { name: '待加载套件', exact: true })
  })

  it.each(['close', 'unmount'] as const)('cancels detail reads on %s while respecting the catalog lifetime', async (action) => {
    let listener: Parameters<ProductApi['subscribe']>[0] | undefined
    const catalog = deferred<unknown>()
    const readme = deferred<unknown>()
    const entry = { id: 'skill', name: '待加载技能', version: '1.0.0' }
    let refresh = false
    const invoke = vi.fn(async (method: string, _payload?: unknown, _requestId?: string) => method === 'skills.list'
      ? refresh ? catalog.promise : [entry] : method === 'skills.readme' ? readme.promise : entry)
    const cancel = vi.fn()
    installProductApi({ invoke, cancel, getSession: async () => ({ authenticated: true, employeeId: 'employee-one' }),
      subscribe: (callback) => { listener = callback; return () => {} } })
    const view = render(<SkillsPanel t={t} {...actions()} />)
    fireEvent.click(await screen.findByRole('button', { name: entry.name, exact: true }))
    await waitFor(() => { expect(invoke.mock.calls.some(([method]) => method === 'skills.readme')).toBe(true) })
    refresh = true
    await act(async () => { listener?.({ type: 'catalog.changed' }) })
    const detailId = invoke.mock.calls.find(([method]) => method === 'skills.readme')![2]
    const catalogId = invoke.mock.calls.filter(([method]) => method === 'skills.list').at(-1)![2]
    if (action === 'unmount') view.unmount()
    else fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(cancel).toHaveBeenCalledWith(detailId)
    if (action === 'unmount') expect(cancel).toHaveBeenCalledWith(catalogId)
    else expect(cancel).not.toHaveBeenCalledWith(catalogId)
    await act(async () => {
      readme.resolve({ readme: '# 关闭后的正文' })
      catalog.resolve([{ id: 'new-skill', name: '刷新后的技能' }])
    })
    expect(screen.queryByText('关闭后的正文')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    if (action === 'close') await screen.findByRole('button', { name: '刷新后的技能', exact: true })
  })

  it.each([
    ['skills', SkillsPanel], ['expertKits', ExpertKitsPanel], ['connectors', ConnectorsPanel],
  ] as const)('clears %s private details and confirmations on identity change but retains them on token refresh', async (prefix, Panel) => {
    let employeeId: string | undefined = 'employee-one'
    let listener: Parameters<ProductApi['subscribe']>[0] | undefined
    const entry = { id: 'private-resource', name: '上一员工的私有资源', version: '1.0.0', canEdit: true, canDelete: true }
    const detailName = prefix === 'connectors' ? entry.name : '私有内容'
    installProductApi({
      getSession: async () => ({ authenticated: employeeId !== undefined, employeeId }),
      subscribe: (callback) => { listener = callback; return () => { listener = undefined } },
      invoke: async method => method.endsWith('.list') ? employeeId === 'employee-one' ? [entry] : []
        : method.endsWith('.readme') ? { readme: '# 私有内容' } : entry,
    })
    render(<Panel t={t} {...actions()} />)
    fireEvent.click(await screen.findByRole('button', { name: entry.name, exact: true }))
    await screen.findAllByRole('heading', { name: detailName, exact: true })
    await act(async () => { listener?.({ type: 'session.changed', payload: { authenticated: true, employeeId } }) })
    expect(screen.getAllByRole('heading', { name: detailName, exact: true }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByRole('button', { name: zh.resourceActions }).at(-1)!)
    fireEvent.click(screen.getByRole('menuitem', { name: zh.deleteResource }))
    expect(screen.getByRole('dialog', { name: zh.resourceDeleteTitle.replace('{name}', entry.name) })).not.toBeNull()
    employeeId = 'employee-two'
    await act(async () => { listener?.({ type: 'session.changed', payload: { authenticated: true, employeeId } }) })
    await waitFor(() => { expect(screen.queryByText(entry.name)).toBeNull() })
    expect(screen.queryByRole('dialog')).toBeNull()
    employeeId = 'employee-one'
    await act(async () => { listener?.({ type: 'session.changed', payload: { authenticated: true, employeeId } }) })
    fireEvent.click(await screen.findByRole('button', { name: entry.name, exact: true }))
    await screen.findAllByRole('heading', { name: detailName, exact: true })
    employeeId = undefined
    await act(async () => { listener?.({ type: 'session.changed', payload: { authenticated: false } }) })
    await waitFor(() => { expect(screen.queryByText(entry.name)).toBeNull() })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText(zh.authRequired)).not.toBeNull()
  })

  it('ignores an older session read after a newer authenticated catalog refresh', async () => {
    const earlier = deferred<{ authenticated: boolean }>()
    let first = true
    let listener: Parameters<ProductApi['subscribe']>[0] | undefined
    installProductApi({
      getSession: () => {
        if (first) { first = false; return earlier.promise }
        return Promise.resolve({ authenticated: true, employeeId: 'employee-two' })
      },
      subscribe: (callback) => { listener = callback; return () => {} },
      invoke: async () => [{ id: 'current', name: '当前员工资源' }],
    })
    render(<SkillsPanel t={t} {...actions()} />)
    await act(async () => { listener?.({ type: 'session.changed', payload: { authenticated: true, employeeId: 'employee-two' } }) })
    await screen.findByText('当前员工资源')
    await act(async () => { earlier.resolve({ authenticated: false }) })
    expect(screen.queryByText(zh.authRequired)).toBeNull()
    expect(screen.getByText('当前员工资源')).not.toBeNull()
  })

  it.each(['skills.readme', 'extensions.import.inspect'] as const)('ignores a late %s response after switching employees', async (pendingMethod) => {
    let employeeId = 'employee-one'
    let listener: Parameters<ProductApi['subscribe']>[0] | undefined
    const pending = deferred<unknown>()
    const invoke = vi.fn(async (method: string) => method === pendingMethod ? pending.promise
      : method === 'skills.list' ? employeeId === 'employee-one'
        ? [{ id: 'private-skill', name: '私有技能', version: '1.0.0', canEdit: true }] : []
        : { id: 'private-skill', name: '私有技能', version: '1.0.0' })
    const startExtensionAuthoring = vi.fn(async () => {})
    const cancel = vi.fn()
    installProductApi({ invoke, cancel, getSession: async () => ({ authenticated: true, employeeId }),
      subscribe: (callback) => { listener = callback; return () => {} } })
    render(<SkillsPanel t={t} {...actions()} startExtensionAuthoring={startExtensionAuthoring} />)
    await screen.findByText('私有技能')
    if (pendingMethod === 'skills.readme') fireEvent.click(screen.getByRole('button', { name: '私有技能', exact: true }))
    else {
      fireEvent.click(screen.getByRole('button', { name: zh.resourceActions }))
      fireEvent.click(screen.getByRole('menuitem', { name: zh.modifyResource }))
    }
    await waitFor(() => { expect(invoke.mock.calls.some(([method]) => method === pendingMethod)).toBe(true) })
    employeeId = 'employee-two'
    await act(async () => { listener?.({ type: 'session.changed', payload: { authenticated: true, employeeId } }) })
    expect(cancel).toHaveBeenCalled()
    await act(async () => { pending.resolve(pendingMethod === 'skills.readme' ? { readme: '# 旧员工正文' }
      : { stageId: '00000000-0000-4000-8000-000000000001', draft: { kind: 'skill', id: 'private-skill', name: '私有技能', version: '1.0.1' }, files: [] }) })
    expect(screen.queryByText('旧员工正文')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(startExtensionAuthoring).not.toHaveBeenCalled()
    if (pendingMethod === 'extensions.import.inspect') expect(invoke).toHaveBeenCalledWith('extensions.import.release',
      { stageId: '00000000-0000-4000-8000-000000000001' }, expect.any(String))
  })

  it('rejects malformed catalog content before starting modification and releases the unused import', async () => {
    const stageId = '00000000-0000-4000-8000-000000000001'
    const invoke = vi.fn(async (method: string) => {
      if (method === 'skills.list') return [{ id: 'personal', name: '我的技能', version: '1.0.0', canEdit: true }]
      if (method === 'extensions.import.inspect') return { stageId, draft: { kind: 'skill', name: '我的技能' },
        files: [null], missingFields: [] }
      return undefined
    })
    const startExtensionAuthoring = vi.fn(async () => {})
    installProductApi({ invoke })
    render(<SkillsPanel t={t} {...actions()} startExtensionAuthoring={startExtensionAuthoring} />)
    fireEvent.click(await screen.findByRole('button', { name: zh.resourceActions }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh.modifyResource }))
    await screen.findByRole('alert')
    expect(startExtensionAuthoring).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('extensions.import.release', { stageId }, expect.any(String))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports an unavailable identity transport without claiming the employee signed out', async () => {
    installProductApi({ getSession: async () => { throw new Error('IPC unavailable') }, invoke: async () => [] })
    render(<SkillsPanel t={t} {...actions()} />)
    await screen.findByText(zh.loadFailed)
    expect(screen.queryByText(zh.authRequired)).toBeNull()
  })

  it.each([
    ['skills.list', SkillsPanel, 'skill', zh, '请修改技能「文档 $& 洞察」。'],
    ['expertKits.list', ExpertKitsPanel, 'expert-kit', zh, '请修改专家套件「文档 $& 洞察」。'],
    ['skills.list', SkillsPanel, 'skill', en, 'Please modify the skill "文档 $& 洞察".'],
    ['expertKits.list', ExpertKitsPanel, 'expert-kit', en, 'Please modify the expert kit "文档 $& 洞察".'],
  ] as const)('identifies the loaded modification target in the %s draft', async (method, Panel, kind, locale, prefix) => {
    const stageId = '00000000-0000-4000-8000-000000000001'
    const invoke = vi.fn(async (operation: string): Promise<unknown> => {
      if (operation === method) return [{ id: 'my-resource', name: '目录名称', version: '1.0.0', canEdit: true }]
      if (operation === 'extensions.import.inspect') return {
        stageId, draft: { kind, id: 'my-resource', name: '文档 $& 洞察', version: '1.0.1' }, files: [], missingFields: [],
      }
      return undefined
    })
    const startExtensionAuthoring = vi.fn(async () => undefined)
    installProductApi({ invoke })
    render(<Panel t={(key: DeepSeekHarnessProductKey): string => locale[key]} {...actions()}
      startExtensionAuthoring={startExtensionAuthoring} />)
    fireEvent.click(await screen.findByRole('button', { name: locale.resourceActions }))
    fireEvent.click(screen.getByRole('menuitem', { name: locale.modifyResource }))
    await waitFor(() => { expect(startExtensionAuthoring).toHaveBeenCalledOnce() })
    expect(startExtensionAuthoring).toHaveBeenCalledWith(kind, {
      prompt: prefix + (locale === zh ? '先读取现有内容，和我确认要调整的地方，完成后直接保存新版本。'
        : ' Read its existing content, confirm the requested changes with me, then save the new version directly.'),
      stageId, edit: true,
    })
    expect(invoke).toHaveBeenCalledWith('extensions.import.inspect', { kind, source: 'catalog', id: 'my-resource' }, expect.any(String))
  })

  it.each([
    ['skills.list', SkillsPanel, 'skill', 'extensions.delete'],
    ['expertKits.list', ExpertKitsPanel, 'expert-kit', 'extensions.delete'],
    ['connectors.list', ConnectorsPanel, 'connector', 'extensions.connector.delete'],
  ] as const)('confirms owner deletion and retains the resource on failure in %s', async (method, Panel, kind, deletion) => {
    let removed = false
    let fail = true
    const entry = { id: 'my-resource', name: '我的资源', version: '1.0.0', canEdit: true, canSubmit: true, canDelete: true, visibility: 'PERSONAL' }
    const invoke = vi.fn(async (operation: string): Promise<unknown> => {
      if (operation === method) return removed ? [] : [entry]
      if (operation === deletion) {
        if (fail) throw new Error('network')
        removed = true
        return { removed: true, id: entry.id }
      }
      return undefined
    })
    installProductApi({ invoke })
    render(<Panel t={t} {...actions()} />)
    fireEvent.click(await screen.findByRole('button', { name: zh.resourceActions }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([zh.modifyResource, zh.submitShared, zh.deleteResource])
    fireEvent.click(screen.getByRole('menuitem', { name: zh.deleteResource }))
    const confirmation = screen.getByRole('dialog', { name: zh.resourceDeleteTitle.replace('{name}', entry.name) })
    expect(within(confirmation).getByText(zh.resourceDeleteConfirmation)).not.toBeNull()
    expect(invoke).not.toHaveBeenCalledWith(deletion, expect.anything(), expect.anything())
    fireEvent.click(within(confirmation).getByRole('button', { name: zh.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.resourceActions }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh.deleteResource }))
    fireEvent.click(screen.getByRole('button', { name: zh.deleteResource, exact: true }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.deleteFailed) })
    expect(screen.getByText(entry.name)).not.toBeNull()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: zh.deleteResource, exact: true }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(invoke).toHaveBeenCalledWith(deletion, { kind, id: entry.id, version: entry.version }, expect.any(String))
    expect(screen.queryByText(entry.name)).toBeNull()
  })

  it('explains sharing, shows review status and blocks deletion of an already shared resource', async () => {
    let submitted = false
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'skills.list') return [{ id: 'my-skill', name: '我的技能', version: '1.0.1', canEdit: true,
        canSubmit: !submitted, canDelete: false, visibility: 'PERSONAL', reviewStatus: submitted ? 'SUBMITTED' : 'DRAFT' }]
      if (method === 'extensions.submit') { submitted = true; return { submitted: true, id: 'my-skill', version: '1.0.1' } }
      return undefined
    })
    installProductApi({ invoke })
    render(<SkillsPanel t={t} {...actions()} />)
    fireEvent.click(await screen.findByRole('button', { name: zh.resourceActions }))
    expect(screen.getByRole('menuitem', { name: zh.deleteResource }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(zh.resourceDeleteShared)).not.toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: zh.submitShared }))
    const dialog = screen.getByRole('dialog', { name: zh.submitResourceTitle })
    expect(within(dialog).getByText(zh.submitResourceConfirmation.replace('{name}', '我的技能'))).not.toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: zh.submitShared }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.resourceActions }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: zh.resourceActions }))
    expect(screen.getByText(zh.reviewPending)).not.toBeNull()
    expect(screen.queryByRole('menuitem', { name: zh.submitShared })).toBeNull()
  })

  it('keeps the owner menu in the skill footer and hides it for shared resources', async () => {
    const invoke = vi.fn(async (method: string): Promise<unknown> => method === 'skills.list'
      ? [{ id: 'mine', name: '我的技能', version: '1.0.0', canEdit: true, canSubmit: true, canDelete: true },
        { id: 'shared', name: '共享技能', version: '1.0.0', canEdit: false }]
      : method === 'skills.readme.read' ? { readme: '# Skill\n\nInstructions' }
        : { id: 'mine', name: '我的技能', version: '1.0.0', canEdit: true, canSubmit: true, canDelete: true })
    installProductApi({ invoke })
    render(<SkillsPanel t={t} {...actions()} />)
    await screen.findByText('我的技能')
    expect(screen.getAllByRole('button', { name: zh.resourceActions })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '我的技能', exact: true }))
    const dialog = screen.getByRole('dialog', { name: zh.skillDetails })
    const more = await within(dialog).findByRole('button', { name: zh.resourceActions })
    expect(more.closest('[data-skill-detail-body]')).toBeNull()
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
      .map(entry => entry.options.id)).toEqual(CAPABILITY_PANELS.map(panel => panel.id))
    expect(registrations.filter(entry => entry.options.name === 'main')
      .map(entry => entry.options.key)).toEqual(CAPABILITY_PANELS.map(panel => panel.id))
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
      .map(entry => entry.options.id)).toEqual(['product-expert-kit'])
    expect(registrations.filter(entry => entry.options.name === 'conversation.session.header.actions')
      .map(entry => entry.options.id)).toEqual(['product-expert-kit'])
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

  it('uses official Sessions and composer state for expert kits and skills', async () => {
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const initializeDraft = vi.fn((_binding: object, _options: DraftInitializationOptions) => 'applied' as const)
    const focus = vi.fn()
    const openSession = vi.fn()
    const create = vi.fn().mockResolvedValueOnce('expert-session').mockResolvedValueOnce('derived-skill-session')
    const select = vi.fn(async () => ({ ok: true as const }))
    const skillExecution: Record<string, unknown> = { kind: 'NEW_SESSION', skillName: 'writing' }
    const invoke = vi.fn(async (method: string) => method === 'tasks.capabilities.prepare'
      ? { ...skillExecution, invocation: skillExecution.skillName, presetId: skillExecution.presetId ?? 'deepseek-harness-expert-kit-orders' }
      : { connectorIds: [], requiredConnectorIds: [], knowledgeBaseIds: [], requiredKnowledgeBaseIds: [] })
    installProductApi({ invoke })
    const ctx = {
      effect: (effect: () => unknown) => effect(),
      commandUi: { register: vi.fn((_command: CommandContribution) => () => {}) },
      locale: { register: vi.fn(() => () => {}), bind: vi.fn(() => t) },
      slots: {
        inject: (_name: string, register: () => unknown) => register(),
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
      sessions: {
        subagentAddress: vi.fn(() => undefined),
        list: { getSnapshot: () => ({ byId: {
          current: { id: 'current-session', retainedBy: { mainView: 1 } },
        } }) }, create,
        retain: (sessionId: string) => ({ ready: Promise.resolve(), release: vi.fn(), binding: { ctx: { sessionId } } }),
        using: async (sessionId: string, _options: unknown, action: (reference: object) => Promise<void>) =>
          action({ binding: { ctx: { sessionId } } }),
        binding: (sessionId: string) => ({ sessionId, ctx: { sessionId } }),
      },
      workspaces: {
        list: { getSnapshot: () => ({ items: [{ workspaceId: 'workspace-1', sessionIds: ['current-session'] }] }) },
        initializeDefault: vi.fn(),
      },
      layout: { beginNavigation: () => new AbortController().signal },
      uiWorkspace: { openSession },
      uiSkills: { refresh: vi.fn() },
      remote: { agentPresets: { select } },
      conversation: { input: { requestDraftInitialization: initializeDraft, for: (bindingContext: { sessionId: string }) => ({ focus,
        state: { getSnapshot: () => ({ draft: bindingContext.sessionId === 'current-session'
          ? '继续优化这份内容'
          : '', occurrences: [] }) } }) } },
    }

    apply(castClientContext(ctx))
    const expertKitRegistration = registrations.find(entry => entry.options.key === 'deepseek-harness-expert-kits')
    const skillRegistration = registrations.find(entry => entry.options.key === 'deepseek-harness-skills')
    const expertKitActions = (expertKitRegistration?.options.inject as (() => ReturnType<typeof actions>))()
    const skillActions = (skillRegistration?.options.inject as (() => ReturnType<typeof actions>))()

    await expertKitActions.startExpertKit('orders')
    await skillActions.installSkill('writing')
    await skillActions.installSkill('order-query')

    expect(invoke).toHaveBeenNthCalledWith(1, 'tasks.capabilities.prepare', { expertKitId: 'orders', sessionId: 'current-session' }, expect.any(String))
    expect(invoke).toHaveBeenNthCalledWith(2, 'skills.install', { id: 'writing' }, expect.any(String))
    expect(invoke).toHaveBeenNthCalledWith(3, 'skills.install', { id: 'order-query' }, expect.any(String))
    expect(create).toHaveBeenNthCalledWith(1, { workspaceId: 'workspace-1' })
    expect(create).toHaveBeenCalledOnce()
    expect(select).toHaveBeenNthCalledWith(1, 'expert-session', 'deepseek-harness-expert-kit-orders')
    expect(select).toHaveBeenCalledOnce()
    expect(openSession).toHaveBeenNthCalledWith(1, 'expert-session')
    expect(openSession).toHaveBeenCalledOnce()
    expect(initializeDraft).toHaveBeenCalledExactlyOnceWith({ ctx: { sessionId: 'expert-session' } },
      { prompt: { text: '继续优化这份内容', references: [] }, clearPreviousDraft: true })
    expect(focus).toHaveBeenCalledOnce()
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
    const invoke = vi.fn(async (operation: string): Promise<unknown> => operation === method
      ? [{ id: 'kit-1', name: '全栈开发专家', summary: '默认套件' }]
      : { items: [], page: 1, size: 20, total: 0 })
    const cancel = vi.fn()
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel,
    })

    render(<Panel t={t} {...actions()} />)
    if (method === 'knowledge.bases.list') {
      await waitFor(() => { expect(within(screen.getByRole('navigation', { name: zh.knowledge }))
        .getByRole('button', { name: '全栈开发专家', exact: true })).not.toBeNull() })
      expect(screen.queryByRole('dialog')).toBeNull()
    } else {
      expect(await screen.findByText('全栈开发专家')).not.toBeNull()
      expect(screen.getByText('默认套件')).not.toBeNull()
    }
    expect(invoke).toHaveBeenCalledWith(method, undefined, expect.any(String))
  })

  it('shows a safe failure without exposing server details', async () => {
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })),
      invoke: vi.fn(async () => { throw new Error('internal detail') }),
      cancel: vi.fn(),
    })

    render(<ExpertKitsPanel t={t} {...actions()} />)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.loadFailed) })
    expect(screen.queryByText(/internal detail/)).toBeNull()
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

  it('shows an expired-login action instead of reporting a catalog outage', async () => {
    const getSession = vi.fn()
      .mockResolvedValueOnce({ authenticated: true })
      .mockResolvedValue({ authenticated: false })
    installProductApi({
      getSession,
      invoke: vi.fn(async () => { throw new Error('Error invoking remote method') }),
      cancel: vi.fn(),
    })

    render(<SkillsPanel t={t} {...actions()} />)
    expect(await screen.findByText(zh.authRequired)).not.toBeNull()
    expect(screen.getByRole('button', { name: zh.signIn })).not.toBeNull()
    expect(screen.queryByText(zh.itemCount.replace('{count}', '0'))).toBeNull()
    expect(screen.queryByText(zh.loadFailed)).toBeNull()
  })

  it('reloads the catalog after DingTalk reauthentication', async () => {
    let authenticated = false
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'auth.ensureDingTalk') { authenticated = true; return { authenticated: true } }
      if (method === 'skills.list') return [{ id: 'writing', name: 'AI文本优化' }]
      throw new Error(`unexpected method: ${method}`)
    })
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated })), invoke, cancel: vi.fn(),
    })

    render(<SkillsPanel t={t} {...actions()} />)
    fireEvent.click(await screen.findByRole('button', { name: zh.signIn }))
    expect(await screen.findByText('AI文本优化')).not.toBeNull()
    expect(invoke).toHaveBeenCalledWith('auth.ensureDingTalk', undefined, expect.any(String))
    expect(invoke).toHaveBeenCalledWith('skills.list', undefined, expect.any(String))
  })

  it('renders only the SKILL.md body, retaining its title and formatting', async () => {
    const source = '---\nname: writing\n---\n# AI文本优化\n\n## 文档中的适用场景\n\n- 校对文字\n\n**保留格式**'
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'skills.list') return [{ id: 'writing', name: 'AI文本优化', summary: '让文本更自然' }]
      if (method === 'skills.get') return { id: 'writing', name: 'AI文本优化', author: 'DeepSeekHarness',
        version: '1.0.0', summary: '让文本更自然', triggers: ['元数据中的触发场景'], sha256: 'a'.repeat(64) }
      if (method === 'skills.readme') return { id: 'writing', version: '1.0.0', readme: source }
      throw new Error(`unexpected method: ${method}`)
    })
    const cancel = vi.fn()
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel,
    })

    const productActions = actions()
    render(<SkillsPanel t={t} {...productActions} />)
    const opener = await screen.findByRole('button', { name: /AI文本优化/ })
    opener.focus()
    fireEvent.click(opener)
    expect(await screen.findByRole('dialog', { name: zh.skillDetails })).not.toBeNull()
    const dialog = screen.getByRole('dialog', { name: zh.skillDetails })
    expect(await within(dialog).findByRole('heading', { name: 'AI文本优化', level: 1 })).not.toBeNull()
    expect(within(dialog).getByRole('heading', { name: '文档中的适用场景' })).not.toBeNull()
    expect(within(dialog).getByRole('listitem').textContent).toBe('校对文字')
    expect(within(dialog).getByText('保留格式').tagName).toBe('STRONG')
    expect(within(dialog).queryByText('让文本更自然')).toBeNull()
    expect(within(dialog).queryByText('DeepSeekHarness')).toBeNull()
    expect(within(dialog).queryByText('元数据中的触发场景')).toBeNull()
    expect(within(dialog).queryByText(zh.applicableScenarios)).toBeNull()
    expect(within(dialog).queryByText(zh.usageGuide)).toBeNull()
    expect(within(dialog).queryByText(zh.skillSource)).toBeNull()
    expect(document.body.textContent).not.toContain('name: writing')
    expect(within(dialog).getAllByText('AI文本优化')).toHaveLength(1)
    expect(invoke).toHaveBeenCalledWith('skills.get', { id: 'writing' }, expect.any(String))
    expect(invoke).toHaveBeenCalledWith('skills.readme', { id: 'writing' }, expect.any(String))
    fireEvent.click(screen.getAllByRole('button', { name: zh.installSkill }).at(-1)!)
    await waitFor(() => { expect(productActions.installSkill).toHaveBeenCalledExactlyOnceWith('writing') })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('shows an unavailable document while retaining the skill install action', async () => {
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'skills.list') return [{ id: 'writing', name: 'AI文本优化', summary: '让文本更自然' }]
      if (method === 'skills.get') return { id: 'writing', name: 'AI文本优化', author: 'DeepSeekHarness',
        version: '1.0.0', summary: '让文本更自然', sha256: 'a'.repeat(64) }
      if (method === 'skills.readme') throw new Error('resource not found')
      throw new Error(`unexpected method: ${method}`)
    })
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
    })

    const productActions = actions()
    render(<SkillsPanel t={t} {...productActions} />)
    fireEvent.click(await screen.findByRole('button', { name: /AI文本优化/ }))
    expect(await screen.findByText(zh.sourceUnavailable)).not.toBeNull()
    expect(screen.queryByText(/resource not found/)).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: zh.installSkill }).at(-1)!)
    await waitFor(() => { expect(productActions.installSkill).toHaveBeenCalledExactlyOnceWith('writing') })
  })

  it('starts an expert kit without exposing shortcut commands or Skill IDs', async () => {
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'expertKits.list') return [{ id: 'product-design', name: '产品设计', summary: '设计师全流程工具箱' }]
      if (method === 'expertKits.get') return {
        id: 'product-design', name: '产品设计', author: 'DeepSeekHarness', version: '1.0.0',
        summary: '设计师全流程工具箱', sha256: 'b'.repeat(64),
        minimumDesktopVersion: '0.2.0', requiredTools: ['browser_navigate'],
        skillDetails: [{ id: 'accessibility', name: '无障碍审查', summary: '检查界面可访问性' }],
        connectorRefs: ['erp', 'missing-connector'], knowledgeBaseRefs: ['design-guide', 'missing-knowledge'],
      }
      if (method === 'expertKits.readme') return { id: 'product-design', version: '1.0.0', readme: '# 套件说明\n\n使用设计流程。' }
      if (method === 'connectors.list') return [{ id: 'erp', displayName: 'ERP 连接器', summary: '订单数据' }]
      if (method === 'knowledge.bases.list') return [{ id: 'design-guide', name: '设计规范', summary: '企业设计规则' }]
      if (method === 'knowledge.references.resolve') return [
        { reference: 'design-guide', status: 'RESOLVED', base: { id: 'design-guide', name: '设计规范', scope: 'COMPANY' } },
        { reference: 'missing-knowledge', status: 'NOT_FOUND' },
      ]
      throw new Error(`unexpected method: ${method}`)
    })
    const cancel = vi.fn()
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel,
    })

    const productActions = { ...actions(), readInstalledExpertKits: vi.fn(async () => ({ installed: [
      { id: 'product-design', version: '1.0.0', sha256: 'b'.repeat(64) },
    ] })) }
    render(<ExpertKitsPanel t={t} {...productActions} />)
    fireEvent.click(await screen.findByRole('button', { name: /产品设计/ }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await screen.findByRole('button', { name: zh.startUsing })
    expect(screen.queryByText('无障碍检查')).toBeNull()
    expect(screen.queryByText(/accessibility/)).toBeNull()
    expect(screen.queryByText('/ 无障碍检查')).toBeNull()
    expect(screen.getAllByText('ERP 连接器')).toHaveLength(1)
    expect(screen.getAllByText('设计规范')).toHaveLength(1)
    expect(screen.getAllByText('missing-connector')).toHaveLength(1)
    expect(screen.getAllByText('missing-knowledge')).toHaveLength(1)
    expect(screen.getAllByText(zh.referenceNotFound)).toHaveLength(2)
    expect(screen.queryByText(zh.toolPermissionCount.replace('{count}', '1'))).toBeNull()
    const guideHeading = screen.getByRole('heading', { level: 2, name: zh.kitGuide })
    expect(screen.getAllByText(zh.kitGuide)).toHaveLength(1)
    expect(screen.getByText('使用设计流程。')).not.toBeNull()
    expect(screen.queryByText('product-design')).toBeNull()
    expect(screen.queryByText('b'.repeat(64))).toBeNull()
    const knowledgeHeading = screen.getByRole('heading', { level: 2, name: new RegExp(zh.knowledgeScope, 'u') })
    expect(knowledgeHeading.compareDocumentPosition(guideHeading) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(screen.getByRole('button', { name: zh.backToCatalog })).not.toBeNull()
    const reader = screen.getByRole('button', { name: zh.viewFullGuide })
    reader.focus()
    fireEvent.click(reader)
    const dialog = screen.getByRole('dialog', { name: zh.kitGuide })
    expect(within(dialog).getByRole('heading', { name: '产品设计' })).not.toBeNull()
    expect(within(dialog).getByRole('heading', { name: zh.kitGuide, level: 1 })).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(reader)
    fireEvent.click(screen.getByRole('button', { name: zh.startUsing }))
    await waitFor(() => { expect(productActions.startExpertKit)
      .toHaveBeenNthCalledWith(1, 'product-design') })
    expect(productActions.startExpertKit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /无障碍检查/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.backToCatalog }))
    expect(screen.queryByRole('heading', { name: '产品设计' })).toBeNull()
  })

  it('filters the loaded catalog without another server request', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => [
      { id: 'writing', name: 'AI文本优化', summary: '让文本更自然', category: '内容' },
      { id: 'analysis', name: '数据分析', summary: '分析业务数据', category: '数据' },
    ])
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
    })

    render(<SkillsPanel t={t} {...actions()} />)
    expect(await screen.findByText('AI文本优化')).not.toBeNull()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '数据' } })

    expect(screen.queryByText('AI文本优化')).toBeNull()
    expect(screen.getByText('数据分析')).not.toBeNull()
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('installs a skill from its card and reports an installation failure', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => [
      { id: 'writing', name: 'AI文本优化', summary: '让文本更自然', availabilityStatus: 'AVAILABLE' },
    ])
    const installSkill = vi.fn(async () => { throw new Error('prepare failed') })
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
    })

    render(<SkillsPanel t={t} startExpertKit={vi.fn(async () => {})} installSkill={installSkill} />)
    fireEvent.click(await screen.findByRole('button', { name: zh.installSkill }))
    expect(screen.queryByText(zh.availabilityAvailable)).toBeNull()

    await waitFor(() => { expect(installSkill).toHaveBeenCalledExactlyOnceWith('writing') })
    expect((await screen.findByRole('alert')).textContent).toBe(zh.installFailed)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each(['success', 'failure'] as const)('ignores an old employee card installation %s after switching accounts', async (outcome) => {
    let employeeId = 'employee-one'
    let listener: Parameters<ProductApi['subscribe']>[0] | undefined
    const pending = deferred<undefined>()
    const productActions = { ...actions(), installSkill: vi.fn(() => pending.promise) }
    const invoke = vi.fn(async () => [{ id: 'writing', name: '文本技能', version: '1.0.0' }])
    installProductApi({ invoke, getSession: async () => ({ authenticated: true, employeeId }),
      subscribe: (callback) => { listener = callback; return () => {} } })
    render(<SkillsPanel t={t} {...productActions} />)
    fireEvent.click(await screen.findByRole('button', { name: zh.installSkill }))
    await waitFor(() => { expect(productActions.installSkill).toHaveBeenCalledOnce() })
    employeeId = 'employee-two'
    await act(async () => { listener?.({ type: 'session.changed', payload: { authenticated: true, employeeId } }) })
    await screen.findByRole('button', { name: zh.installSkill })
    const reads = productActions.readInstalledSkills.mock.calls.length
    await act(async () => { if (outcome === 'success') pending.resolve(undefined); else pending.reject(new Error('old installation failed')) })
    expect(productActions.readInstalledSkills).toHaveBeenCalledTimes(reads)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.installSkill }).disabled).toBe(false)
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
    const invoke = vi.fn(async (method: string) => {
      if (method === 'connectors.list') return [{ id: 'erp', name: 'ERP 连接器',
        authMode: 'oauth', authorizationStatus: 'AUTHORIZED', tools: [] }]
      if (method === 'connectors.authorization.revoke') {
        if (fail) throw new Error('network unavailable')
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
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it.each(['card', 'detail'] as const)('uninstalls and reinstalls a shared skill from its %s with confirmation and retry', async (surface) => {
    const identity = { id: 'writing', name: 'AI文本优化', version: '1.0.0', sha256: 'a'.repeat(64) }
    const installed: ProductContentIdentity[] = [identity]
    const entry = { ...identity, visibility: 'SHARED', canEdit: false, canSubmit: false, canDelete: false }
    let failUninstall = true
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'skills.list') return [entry]
      if (method === 'skills.get') return entry
      if (method === 'skills.readme') return { readme: '# AI文本优化\n\n让文本更自然。' }
      if (method === 'skills.uninstall') {
        if (failUninstall) { failUninstall = false; throw new Error('network') }
        installed.splice(0, installed.length)
        return { id: identity.id }
      }
      return []
    })
    const productActions = {
      ...actions(),
      installSkill: vi.fn(async () => { installed.push(identity) }),
      readInstalledSkills: vi.fn(async () => ({ installed: [...installed], available: [...installed], frozen: false })),
    }
    installProductApi({ invoke })
    render(<SkillsPanel t={t} {...productActions} />)
    await screen.findByText(zh.skillInstalled)
    if (surface === 'detail') fireEvent.click(screen.getByRole('button', { name: identity.name, exact: true }))
    const scope = surface === 'detail' ? within(await screen.findByRole('dialog', { name: zh.skillDetails })) : screen
    const more = await scope.findByRole('button', { name: zh.resourceActions })
    fireEvent.click(more)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([zh.uninstallResource])
    fireEvent.click(screen.getByRole('menuitem', { name: zh.uninstallResource }))
    const title = zh.resourceUninstallTitle.replace('{name}', identity.name)
    const confirmation = screen.getByRole('dialog', { name: title })
    expect(within(confirmation).getByText(zh.skillUninstallConfirmation)).not.toBeNull()
    expect(invoke.mock.calls.some(([method]) => method === 'skills.uninstall')).toBe(false)
    fireEvent.click(within(confirmation).getByRole('button', { name: zh.cancel }))
    expect(screen.queryByRole('dialog', { name: title })).toBeNull()
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: zh.uninstallResource }))
    fireEvent.click(within(screen.getByRole('dialog', { name: title })).getByRole('button', { name: zh.uninstallResource, exact: true }))
    const failureDialog = within(await screen.findByRole('dialog', { name: title }))
    expect((await failureDialog.findByRole('alert')).textContent).toBe(zh.resourceUninstallFailed)
    expect(installed).toEqual([identity])
    fireEvent.click(failureDialog.getByRole('button', { name: zh.uninstallResource, exact: true }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: title })).toBeNull() })
    const install = await scope.findByRole('button', { name: zh.installSkill })
    expect(scope.queryByText(zh.skillInstalled)).toBeNull()
    expect(scope.queryByRole('button', { name: zh.resourceActions })).toBeNull()
    expect(invoke.mock.calls.filter(([method]) => method === 'skills.uninstall')).toHaveLength(2)
    expect(invoke).toHaveBeenCalledWith('skills.uninstall', {
      kind: 'skill', id: identity.id, version: identity.version,
    }, expect.any(String))
    expect(productActions.startExpertKit).not.toHaveBeenCalled()
    expect(invoke.mock.calls.some(([method]) => method === 'extensions.delete')).toBe(false)
    expect(scope.getByText(identity.name, { selector: surface === 'detail' ? 'h1' : 'span' })).not.toBeNull()
    fireEvent.click(install)
    await scope.findByText(zh.skillInstalled)
    expect(productActions.installSkill).toHaveBeenCalledExactlyOnceWith(identity.id)
    fireEvent.click(scope.getByRole('button', { name: zh.resourceActions }))
    expect(screen.getByRole('menuitem', { name: zh.uninstallResource })).not.toBeNull()
  })

  it('keeps an older installed skill removable while offering its latest version for installation', async () => {
    let version = '1.0.0'
    const installed: ProductContentIdentity[] = [{ id: 'writing', version, sha256: 'a'.repeat(64) }]
    const productActions = { ...actions(),
      readInstalledSkills: vi.fn(async () => ({ installed: [...installed], available: [...installed], frozen: false })),
    }
    const invoke = vi.fn(async () => [{ id: 'writing', name: 'AI文本优化', version, sha256: 'a'.repeat(64) }])
    installProductApi({ invoke })
    render(<SkillsPanel t={t} {...productActions} />)
    await screen.findByText(zh.skillInstalled)
    version = '1.0.1'
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    expect((await screen.findByRole('button', { name: zh.installSkill })).disabled).toBe(false)
    expect(screen.queryByText(zh.skillInstalled)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.resourceActions }))
    expect(screen.getByRole('menuitem', { name: zh.uninstallResource })).not.toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('skills.uninstall', expect.anything(), expect.anything())
  })

  it('installs an expert kit without preparing a task and keeps dependency authorization visible', async () => {
    const installed: ProductContentIdentity[] = []
    const identity = { id: 'operations', name: '订单专家', version: '1.0.0', sha256: 'a'.repeat(64) }
    const productActions = {
      ...actions(),
      installExpertKit: vi.fn(async (_id: string) => { installed.push(identity) }),
      readInstalledExpertKits: vi.fn(async () => ({ installed: [...installed] })),
    }
    productActions.installExpertKit.mockRejectedValueOnce(new Error('network'))
    installProductApi({ invoke: async () => [{ ...identity, availabilityStatus: 'AUTHORIZATION_REQUIRED' }] })
    render(<ExpertKitsPanel t={t} {...productActions} />)
    const install = await screen.findByRole('button', { name: zh.installExpertKit })
    expect(install.disabled).toBe(false)
    fireEvent.click(install)
    expect((await screen.findByRole('alert')).textContent).toBe(zh.installFailed)
    expect(installed).toEqual([])
    await waitFor(() => { expect(install.disabled).toBe(false) })
    fireEvent.click(install)
    await screen.findByText(zh.expertKitInstalled)
    expect(screen.queryByRole('button', { name: zh.expertKitInstalled })).toBeNull()
    expect(screen.getByText(zh.availabilityAuthorizationRequired)).not.toBeNull()
    expect(productActions.installExpertKit).toHaveBeenNthCalledWith(1, identity.id)
    expect(productActions.installExpertKit).toHaveBeenNthCalledWith(2, identity.id)
    expect(productActions.startExpertKit).not.toHaveBeenCalled()
  })

  it('requires an explicit installation before using the kit', async () => {
    const identity = { id: 'operations', name: '订单专家', version: '1.0.0', sha256: 'a'.repeat(64) }
    const installed: ProductContentIdentity[] = []
    const entry = identity
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'expertKits.list') return [entry]
      if (method === 'expertKits.get') return entry
      if (method === 'expertKits.readme') return { readme: '# 订单专家' }
      throw new Error(`Unexpected call: ${method}`)
    })
    const productActions = { ...actions(),
      readInstalledExpertKits: vi.fn(async () => ({ installed: [...installed] })),
      installExpertKit: vi.fn(async () => { installed.push(identity) }),
    }
    productActions.installExpertKit.mockRejectedValueOnce(new Error('Install failed'))
    installProductApi({ invoke })
    render(<ExpertKitsPanel t={t} {...productActions} />)
    fireEvent.click(await screen.findByRole('button', { name: identity.name, exact: true }))
    expect(screen.queryByRole('button', { name: zh.startUsing })).toBeNull()
    expect(productActions.startExpertKit).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: zh.installExpertKit }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: zh.startUsing })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: zh.installExpertKit }))
    await screen.findByRole('button', { name: zh.startUsing })
    expect(screen.getByRole('button', { name: zh.startUsing }).disabled).toBe(false)
    expect(productActions.startExpertKit).not.toHaveBeenCalled()
    const readsBeforeUse = productActions.readInstalledExpertKits.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: zh.startUsing }))
    await waitFor(() => { expect(productActions.startExpertKit).toHaveBeenCalledWith(identity.id) })
    expect(productActions.readInstalledExpertKits).toHaveBeenCalledTimes(readsBeforeUse)
  })

  it.each(['card', 'detail'] as const)('uninstalls a shared expert kit from its %s with confirmation and retry', async (surface) => {
    const identity = { id: 'operations', name: '订单专家', version: '1.0.0', sha256: 'a'.repeat(64) }
    const installed: ProductContentIdentity[] = [identity]
    const entry = { ...identity, visibility: 'SHARED', canEdit: false, canSubmit: false, canDelete: false }
    let failUninstall = true
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'expertKits.list') return [entry]
      if (method === 'expertKits.get') return entry
      if (method === 'expertKits.readme') return { readme: '# 订单专家\n\n核对订单。' }
      if (method === 'expertKits.uninstall') {
        if (failUninstall) { failUninstall = false; throw new Error('network') }
        installed.splice(0, installed.length)
        return { id: identity.id }
      }
      return []
    })
    const productActions = {
      ...actions(),
      readInstalledExpertKits: vi.fn(async () => ({ installed: [...installed] })),
    }
    installProductApi({ invoke })
    render(<ExpertKitsPanel t={t} {...productActions} />)
    await screen.findByText(zh.expertKitInstalled)
    if (surface === 'detail') fireEvent.click(screen.getByRole('button', { name: identity.name, exact: true }))
    const more = await screen.findByRole('button', { name: zh.resourceActions })
    fireEvent.click(more)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([zh.uninstallResource])
    fireEvent.click(screen.getByRole('menuitem', { name: zh.uninstallResource }))
    const title = zh.resourceUninstallTitle.replace('{name}', identity.name)
    const confirmation = screen.getByRole('dialog', { name: title })
    expect(within(confirmation).getByText(zh.expertKitUninstallConfirmation)).not.toBeNull()
    expect(invoke.mock.calls.some(([method]) => method === 'expertKits.uninstall')).toBe(false)
    fireEvent.click(within(confirmation).getByRole('button', { name: zh.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: zh.uninstallResource }))
    fireEvent.click(screen.getByRole('button', { name: zh.uninstallResource, exact: true }))
    const failureDialog = within(await screen.findByRole('dialog', { name: title }))
    expect((await failureDialog.findByRole('alert')).textContent).toBe(zh.resourceUninstallFailed)
    expect(installed).toEqual([identity])
    fireEvent.click(failureDialog.getByRole('button', { name: zh.uninstallResource, exact: true }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    await screen.findByRole('button', { name: zh.installExpertKit })
    expect(screen.queryByText(zh.expertKitInstalled)).toBeNull()
    expect(invoke.mock.calls.filter(([method]) => method === 'expertKits.uninstall')).toHaveLength(2)
    expect(invoke).toHaveBeenCalledWith('expertKits.uninstall', {
      kind: 'expert-kit', id: identity.id, version: identity.version,
    }, expect.any(String))
    expect(productActions.startExpertKit).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: zh.resourceActions })).toBeNull()
    expect(invoke.mock.calls.some(([method]) => method === 'extensions.delete')).toBe(false)
    expect(screen.getByText(identity.name, { selector: surface === 'detail' ? 'h1' : 'span' })).not.toBeNull()
  })

  it('offers the latest kit version for installation while the previous version remains removable', async () => {
    let version = '1.0.0'
    const installed: ProductContentIdentity[] = [{ id: 'operations', version, sha256: 'a'.repeat(64) }]
    const productActions = { ...actions(), readInstalledExpertKits: vi.fn(async () => ({ installed: [...installed] })) }
    const invoke = vi.fn(async () => [{ id: 'operations', name: '订单专家', version, sha256: 'a'.repeat(64) }])
    installProductApi({ invoke })
    render(<ExpertKitsPanel t={t} {...productActions} />)
    await screen.findByText(zh.expertKitInstalled)
    version = '1.0.1'
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    expect((await screen.findByRole('button', { name: zh.installExpertKit })).disabled).toBe(false)
    expect(screen.queryByText(zh.expertKitInstalled)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.resourceActions }))
    expect(screen.getByRole('menuitem', { name: zh.uninstallResource })).not.toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('expertKits.uninstall', expect.anything(), expect.anything())
  })

  it('allows installation before connector authorization and distinguishes published versions', async () => {
    let version = '1'
    const installed: { id: string; version: string; sha256: string }[] = []
    const installSkill = vi.fn(async () => { installed.splice(0, installed.length, { id: 'writing', version, sha256: 'a'.repeat(64) }) })
    installProductApi({ invoke: async () => [{ id: 'writing', name: 'AI文本优化', version,
      sha256: 'a'.repeat(64), availabilityStatus: 'AUTHORIZATION_REQUIRED' }] })
    render(<SkillsPanel t={t} startExpertKit={vi.fn(async () => {})} installSkill={installSkill}
      readInstalledSkills={async () => ({ installed, available: [], frozen: false })} />)
    const button = await screen.findByRole('button', { name: zh.installSkill })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    expect(await screen.findByText(zh.skillInstalled)).not.toBeNull()
    expect(screen.queryByRole('button', { name: zh.skillInstalled })).toBeNull()
    expect(screen.getByText(zh.availabilityAuthorizationRequired)).not.toBeNull()
    version = '2'
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    expect((await screen.findByRole('button', { name: zh.installSkill })).disabled).toBe(false)
    expect(screen.queryByRole('button', { name: /启用|停用/ })).toBeNull()
  })

  it('groups and filters skills by the product category without changing Harness skills', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => [
      { id: 'writing', name: 'AI文本优化', summary: '让文本更自然', category: 'content-creation' },
      { id: 'analysis', name: '数据分析', summary: '分析业务数据', category: 'database-analysis' },
    ])
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
    })

    render(<SkillsPanel t={t} {...actions()} />)
    expect(await screen.findByRole('region', { name: zh.categoryContentCreation })).not.toBeNull()
    expect(screen.getByRole('region', { name: zh.categoryDatabaseAnalysis })).not.toBeNull()
    expect(screen.getAllByText(zh.categoryContentCreation)).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: zh.categoryFilter }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh.categoryDatabaseAnalysis }))

    expect(screen.queryByText('AI文本优化')).toBeNull()
    expect(screen.getByText('数据分析')).not.toBeNull()
    expect(screen.getByText(zh.itemCount.replace('{count}', '1'))).not.toBeNull()
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('keeps directory metadata out of the skill document', async () => {
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'skills.list') return [{ id: 'insight', name: '文档洞察', category: 'knowledge-research' }]
      if (method === 'skills.get') return { id: 'insight', name: '文档洞察', category: 'knowledge-research' }
      if (method === 'skills.readme') return { readme: '# 文档洞察\n\n先读取文件，再输出结论。' }
      throw new Error(`unexpected method: ${method}`)
    })
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
    })

    render(<SkillsPanel t={t} {...actions()} />)
    expect(await screen.findByRole('button', { name: zh.categoryFilter })).not.toBeNull()
    expect(screen.getByText(zh.allCategories)).not.toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: /文档洞察/ }))
    expect(await screen.findByRole('heading', { name: '文档洞察' })).not.toBeNull()
    const dialog = screen.getByRole('dialog', { name: zh.skillDetails })
    expect(within(dialog).queryByText(zh.categoryKnowledgeResearch)).toBeNull()
    expect(screen.queryByText('knowledge-research')).toBeNull()
    expect(screen.getByText('先读取文件，再输出结论。')).not.toBeNull()
    expect(screen.queryByText(zh.fullUsageGuide)).toBeNull()
    expect(screen.queryByText(zh.advancedInformation)).toBeNull()
  })

  it('does not expose global Expert Kit enablement controls', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => [
      { id: 'orders', name: '订单专家', category: 'ecommerce-retail' },
    ])
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
    })

    render(<ExpertKitsPanel t={t} {...actions()} />)
    expect(await screen.findByText('订单专家')).not.toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(document.body.textContent).not.toContain('在聊天中启用')
  })

  it('presents connector business metadata while retaining operational details', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => [
      { id: 'erp', name: 'erp-mcp', displayName: 'ERP 连接器', summary: '订单数据', category: 'industry-data',
        status: 'ACTIVE', scope: 'COMPANY', transport: 'stdio', version: '0.4.0',
        availabilityStatus: 'AVAILABLE',
        tools: [
          { name: 'orders_read', displayName: '查询订单', description: '读取订单', access: 'READ' },
          { name: 'orders_update', displayName: '更新订单', description: '修改订单', access: 'WRITE' },
        ], authMode: 'employee-bearer' },
      { id: 'docs', name: '文档', summary: '企业文档', category: 'knowledge-research', status: 'ACTIVE',
        availabilityStatus: 'AVAILABLE', tools: [] },
    ])
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
    })

    render(<ConnectorsPanel t={t} {...actions()} />)
    expect(await screen.findByRole('region', { name: zh.categoryIndustryData })).not.toBeNull()
    expect(screen.getByRole('region', { name: zh.categoryKnowledgeResearch })).not.toBeNull()
    expect(screen.getByRole('button', { name: zh.categoryFilter })).not.toBeNull()
    expect(screen.getByText(zh.allCategories)).not.toBeNull()
    const results = document.querySelector('#deepseek-harness-catalog-results')
    expect(results).not.toBeNull()
    expect(results?.textContent?.match(new RegExp(zh.connectorConnected, 'gu'))).toHaveLength(2)
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
    expect(screen.getByText(zh.scopeCompany)).not.toBeNull()
    const capability = screen.getByText(zh.viewConnectorTools.replace('{count}', '2')).closest('details')
    expect(screen.queryByText(zh.advancedInformation)).toBeNull()
    expect(screen.getByText(zh.transportStdio).closest('details')).toBeNull()
    expect(capability?.open).toBe(false)
    fireEvent.click(screen.getByText(zh.viewConnectorTools.replace('{count}', '2')))
    expect(capability?.open).toBe(true)
    expect(screen.getByText('查询订单', { selector: 'strong' })).not.toBeNull()
    expect(screen.getByText(zh.readOnlyLabel)).not.toBeNull()
    expect(screen.getByText(zh.writeLabel)).not.toBeNull()
    expect(screen.queryByText('orders_read')).toBeNull()
    expect(screen.getByText(zh.transportStdio)).not.toBeNull()
  })

  it('separates connected accounts from the catalog without reloading or changing the task', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => [
      { id: 'ready', displayName: '订单连接器', availabilityStatus: 'AVAILABLE', tools: [] },
      { id: 'oauth', displayName: '客户连接器', authMode: 'oauth', authorizationStatus: 'REQUIRED', availabilityStatus: 'AUTHORIZATION_REQUIRED', tools: [] },
      { id: 'offline', displayName: '暂不可用连接器', authMode: 'oauth', authorizationStatus: 'AUTHORIZED', availabilityStatus: 'UNAVAILABLE', tools: [] },
      { id: 'expired', displayName: '授权过期连接器', authMode: 'oauth', authorizationStatus: 'EXPIRED', availabilityStatus: 'AUTHORIZATION_REQUIRED', tools: [] },
      { id: 'unconfigured', displayName: '待配置连接器', status: 'needs-configuration', ready: false,
        authMode: 'none', authorizationStatus: 'AUTHORIZED', availabilityStatus: 'AVAILABLE', tools: [] },
    ])
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
    })

    const productActions = actions()
    render(<ConnectorsPanel t={t} {...productActions} />)
    expect(await screen.findByText('订单连接器')).not.toBeNull()
    expect(screen.getByText(zh.statusNeedsConfiguration)).not.toBeNull()
    const connected = screen.getByRole('tab', { name: new RegExp(`^${zh.connectorFilterConnected}\\s*2$`, 'u') })
    expect(screen.getByText(zh.statusExpired)).not.toBeNull()
    fireEvent.click(connected)
    expect(screen.getByText('订单连接器')).not.toBeNull()
    expect(screen.getByText('暂不可用连接器')).not.toBeNull()
    expect(screen.queryByText('客户连接器')).toBeNull()
    expect(screen.queryByText('授权过期连接器')).toBeNull()
    expect(screen.queryByText('待配置连接器')).toBeNull()
    expect(connected.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(connected, { key: 'ArrowLeft' })
    expect(screen.getByText('客户连接器')).not.toBeNull()
    expect(screen.getAllByRole('tab', { name: zh.connectorFilterAll }).some(tab => tab.getAttribute('aria-selected') === 'true')).toBe(true)
    expect(invoke).toHaveBeenCalledOnce()
    expect(productActions.startExpertKit).not.toHaveBeenCalled()
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

    expect(within(screen.getByRole('dialog')).getByText(zh.statusExpired)).not.toBeNull()
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

  it('opens knowledge documents in its main workspace without changing the task', async () => {
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'knowledge.documents.list') return { items: [{ id: 'document-1', knowledgeBaseId: 'orders', filename: 'orders.md',
        mediaType: 'text/markdown', sizeBytes: 120, status: 'READY', chunkCount: 1, updatedAt: '2026-09-30T00:00:00Z' }], page: 1, size: 20, total: 1 }
      if (method === 'knowledge.documents.preview.open') return originalPreview('订单退款规则')
      if (method === 'knowledge.folders.list') return { items: [], page: 1, size: 20, total: 0 }
      return [{ id: 'orders', name: '订单知识库', description: '订单规则', scope: 'COMPANY', updatedAt: '2026-09-30T00:00:00Z' }]
    })
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
    })

    const taskActions = actions()
    const { container } = render(<KnowledgePanel t={t} {...taskActions} />)
    const documentButton = await screen.findByRole('button', { name: 'orders.md', exact: true })
    expect(within(screen.getByRole('navigation', { name: zh.knowledge }))
      .queryByRole('button', { name: 'orders.md', exact: true })).toBeNull()
    fireEvent.click(documentButton)
    expect(await screen.findByText('订单退款规则')).not.toBeNull()
    expect(container.querySelector('[data-knowledge-inline-reader]')).not.toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: zh.categoryFilter })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(invoke).toHaveBeenCalledWith('knowledge.documents.preview.open', {
      knowledgeBaseId: 'orders', documentId: 'document-1',
    }, expect.any(String))
    expect(taskActions.startExpertKit).not.toHaveBeenCalled()
  })

  it('shows a safe error when an Expert Kit Session cannot start', async () => {
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'expertKits.list') return [{ id: 'orders', name: '订单专家' }]
      if (method === 'expertKits.get') return { id: 'orders', name: '订单专家', sha256: 'c'.repeat(64) }
      if (method === 'expertKits.readme') return { readme: '订单处理' }
      throw new Error(`unexpected method: ${method}`)
    })
    const cancel = vi.fn()
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel,
    })
    const productActions = { ...actions(), readInstalledExpertKits: vi.fn(async () => ({ installed: [
      { id: 'orders', version: '1.0.0', sha256: 'c'.repeat(64) },
    ] })) }
    productActions.startExpertKit.mockRejectedValueOnce(new Error('runtime unavailable'))

    render(<ExpertKitsPanel t={t} {...productActions} />)
    fireEvent.click(await screen.findByRole('button', { name: /订单专家/ }))
    fireEvent.click(await screen.findByRole('button', { name: zh.startUsing }))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.useFailed) })
  })

  it('cancels an active catalog read when its panel unmounts', async () => {
    const pending = new Promise<unknown>(() => {})
    const invoke = vi.fn((_method: string, _payload?: unknown, _requestId?: string) => pending)
    const cancel = vi.fn()
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel,
    })

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
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel,
    })

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
