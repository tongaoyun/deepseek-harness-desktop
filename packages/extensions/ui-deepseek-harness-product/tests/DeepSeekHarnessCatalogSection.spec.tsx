import type { ProductApi } from '../src/client/product-api.ts'
import { productFailure, ProductError } from '@deepseek-harness/product/errors'
import { ConnectorDraftSchema } from '@deepseek-harness/product/connector-draft'
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { StrictMode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  ConnectorsPanel,
} from '../src/client/DeepSeekHarnessCatalogSection.tsx'
import {
  CAPABILITY_PANELS, EXTENSION_PANELS, CapabilitiesHeading, CapabilityChildIcon,
} from '../src/client/DeepSeekHarnessCapabilitiesNavigation.tsx'
import { apply } from '../src/client/index.ts'
import { DeepSeekHarnessSettingsMenu } from '../src/client/DeepSeekHarnessSettingsMenu.tsx'
import { en, zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Reflect.deleteProperty(globalThis, 'dshDesktop')
})

function installProductApi(api: Partial<ProductApi> & Pick<ProductApi, 'invoke'>): void {

  Object.defineProperty(globalThis, 'dshDesktop', { configurable: true, value: { extensions: {
    invoke: async (_namespace: string, method: string, payload?: unknown, requestId?: string) => {
      try {
        const result = await (method === 'auth.getSession' ? api.getSession?.() ?? Promise.resolve({ authenticated: true })
          : requestId === undefined ? api.invoke(method, payload) : api.invoke(method, payload, requestId))
        // Existing visible catalog fixtures represent published releases. Individual tests override this for drafts.
        const catalogResult = method === 'connectors.list' && Array.isArray(result)
          ? result.map((entry: Record<string, unknown>) => ({ visibility: entry.canEdit === true ? 'PERSONAL' : 'COMPANY', reviewStatus: 'PUBLISHED', ...entry })) : result
        return { ok: true, result: catalogResult }
      } catch (error) { return { ok: false, failure: productFailure(error) } }
    },
    cancel: (_namespace: string, requestId: string) => api.cancel?.(requestId),
    subscribe: (_namespace: string, listener: (event: { type: string }) => void) => api.subscribe?.(listener) ?? (() => {}),
  } } })
}

const t = (key: DeepSeekHarnessProductKey): string => zh[key]
const english = (key: DeepSeekHarnessProductKey): string => en[key]
const actions = () => ({ renderFactorySlot: (() => null), openEmployeeSignIn: vi.fn() })

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
  it('retains confirmed partial connection feedback while a catalog read fails and retries', async () => {
    let mode: 'ready' | 'failed' | 'pending' = 'ready'
    const pending = deferred<unknown>()
    let notify: Parameters<ProductApi['subscribe']>[0] | undefined
    const entry = { id: 'orders', name: '订单工作台', version: '1.0.0', tools: [] }
    installProductApi({
      getSession: async () => ({ authenticated: true, employeeId: 'alice' }),
      subscribe: (listener) => { notify = listener; return () => { notify = undefined } },
      invoke: async (method) => {
        if (method === 'connectors.refresh') return { connectedIds: [], unavailableIds: ['orders'] }
        if (mode === 'failed') throw new Error('Directory temporarily unavailable')
        if (mode === 'pending') return pending.promise
        return [entry]
      },
    })
    const view = render(<ConnectorsPanel t={t} {...actions()} />)
    onTestFinished(() => { view.unmount(); pending.resolve([]) })
    await screen.findByRole('button', { name: '订单工作台' })
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    const warning = await screen.findByText(zh.connectorPartialRefreshFailed.replace('{names}', '订单工作台'))
    mode = 'failed'
    act(() => { notify?.({ type: 'catalog.changed' }) })
    await waitFor(() => { expect(screen.getAllByRole('alert')).toHaveLength(2) })
    expect(screen.getByText(zh.connectorPartialRefreshFailed.replace('{names}', '订单工作台'))).toBe(warning)
    expect(screen.getByRole('button', { name: '订单工作台' }).isConnected).toBe(true)
    mode = 'pending'
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    expect(warning.isConnected).toBe(true)
    await act(async () => { pending.resolve([entry]) })
    expect(screen.getAllByRole('alert')).toEqual([warning])
  })
  it.each(['ORGANIZATION_EMPLOYEE_INACTIVE', 'PRODUCT_HOST_IDENTITY_CHANGED'])(
    'invalidates confirmed connector cards after %s until an authoritative read succeeds', async (code) => {
      let failure: Error | undefined
      const entry = { id: 'orders', name: '订单工作台', version: '1.0.0', tools: [] }
      installProductApi({
        getSession: async () => ({ authenticated: true, employeeId: 'alice' }),
        invoke: async (method) => {
          if (method === 'connectors.refresh') return { connectedIds: [], unavailableIds: [] }
          if (failure) throw failure
          return [entry]
        },
      })
      render(<ConnectorsPanel t={t} {...actions()} />)
      await screen.findByRole('button', { name: '订单工作台' })
      const refresh = screen.getByRole('button', { name: zh.refresh })
      failure = new ProductError(code, 'Authority unavailable', true)
      fireEvent.click(refresh)
      await screen.findByRole('alert')
      expect(screen.queryByRole('button', { name: '订单工作台' })).toBeNull()
      expect(screen.queryByRole('tabpanel')).toBeNull()
      failure = new Error('Directory temporarily unavailable')
      fireEvent.click(refresh)
      await waitFor(() => { expect(refresh.getAttribute('aria-busy')).toBe('false') })
      expect(screen.queryByRole('tabpanel')).toBeNull()
      failure = undefined
      fireEvent.click(refresh)
      await screen.findByRole('button', { name: '订单工作台' })
      expect(screen.queryByRole('alert')).toBeNull()
    },
  )
  it.each([false, true].flatMap(removed => [false, true].map(elsewhere => ({ removed, elsewhere }))))(
    'retains confirmed connector cards and tabs after a refresh failure (removed=$removed, elsewhere=$elsewhere)', async ({ removed, elsewhere }) => {
      const pending = deferred<unknown>()
      const entry = { id: 'orders', name: '订单工作台', version: '1.0.0', summary: '订单处理说明', category: 'business', tools: [] }
      let reads = 0
      let notify: Parameters<ProductApi['subscribe']>[0] | undefined
      installProductApi({
        getSession: async () => ({ authenticated: true, employeeId: 'alice' }),
        subscribe: (listener) => { notify = listener; return () => { notify = undefined } },
        invoke: async (method) => {
          if (method === 'connectors.refresh') return { connectedIds: [], unavailableIds: [] }
          if (++reads === 1) return [entry]
          if (reads === 2) throw new Error('Directory temporarily unavailable')
          return pending.promise
        },
      })
      const view = render(<><ConnectorsPanel t={t} {...actions()} /><button>其他操作</button></>)
      onTestFinished(() => { view.unmount(); pending.resolve([]) })
      const card = await screen.findByRole('button', { name: /订单工作台/ })
      const tab = screen.getByRole('tab', { name: zh.extensionMarket })
      const panel = screen.getByRole('tabpanel')
      const search = screen.getByRole<HTMLInputElement>('searchbox')
      fireEvent.change(search, { target: { value: '订单' } })
      search.setSelectionRange(0, 1)
      const other = screen.getByRole('button', { name: '其他操作' })
      const focused = elsewhere ? other : card
      focused.focus()
      act(() => { notify?.({ type: 'catalog.changed' }) })
      const alert = await screen.findByRole('alert')
      expect(screen.getByRole('tab', { name: zh.extensionMarket })).toBe(tab)
      expect(screen.getByRole('tabpanel')).toBe(panel)
      expect(screen.getByRole('button', { name: /订单工作台/ })).toBe(card)
      expect(document.activeElement).toBe(focused)
      const refresh = screen.getByRole('button', { name: zh.refresh })
      fireEvent.click(refresh); fireEvent.click(refresh)
      await waitFor(() => { expect(reads).toBe(3) })
      expect(screen.getByRole('alert')).toBe(alert)
      expect(screen.getByRole('tabpanel')).toBe(panel)
      expect(card.isConnected).toBe(true)
      expect(document.activeElement).toBe(focused)
      expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['订单', 0, 1])
      await act(async () => { pending.resolve(removed ? [] : [entry]) })
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getByRole('tab', { name: zh.extensionMarket })).toBe(tab)
      expect(screen.getByRole('tabpanel')).toBe(panel)
      expect(document.activeElement).toBe(elsewhere ? other : removed ? screen.getByRole('region', { name: zh.connectors }) : card)
      expect(card.isConnected).toBe(!removed)
      expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['订单', 0, 1])
      expect({ removed, elsewhere, retainedTab: tab.isConnected, retainedCard: card.isConnected,
        focused: document.activeElement === focused ? 'retained' : 'directory', query: search.value }).toMatchSnapshot()
    },
  )

  it.each(([
    ['connectors', 'identity'], ['connectors', 'removed'], ['connectors', 'failed'],
  ] as const).flatMap(([catalog, transition]) => [false, true].map(elsewhere => ({ catalog, transition, elsewhere }))))(
    'recovers $catalog focus after $transition with elsewhere=$elsewhere', async ({ transition, elsewhere }) => {
      const response = deferred<unknown>()
      const identity = deferred<{ authenticated: boolean; employeeId: string }>()
      const failure = new ProductError('ORGANIZATION_SYNC_EXPIRED', 'Directory unavailable', true)
      let sessions = 0
      let reads = 0
      installProductApi({
        getSession: async () => {
          if (transition === 'identity') {
            if (++sessions <= 2) throw failure
            return identity.promise
          }
          return { authenticated: true, employeeId: 'employee' }
        },
        invoke: async (method) => {
          if (method === 'connectors.refresh') return { connectedIds: [], unavailableIds: [] }
          if (++reads === 1 && transition !== 'identity') {
            if (transition === 'retry') throw failure
            return [{ id: 'focus-entry', name: '目录资源', scope: 'PERSONAL', canRead: true }]
          }
          return response.promise
        },
      })
      const Panel = ConnectorsPanel
      const label = zh.connectors
      const view = render(<><button>其他操作</button><Panel t={t} {...actions()} /></>)
      onTestFinished(() => { view.unmount(); identity.resolve({ authenticated: true, employeeId: 'employee' }); response.resolve([]) })
      const retrying = transition === 'identity' || transition === 'retry'
      if (retrying) await screen.findByRole('alert')
      else await screen.findByRole('button', { name: '目录资源', exact: true })
      const control = screen.getByRole<HTMLButtonElement>('button', { name: retrying ? zh.retry : zh.refresh })
      control.focus()
      act(() => { control.click(); control.click() })
      if (transition === 'identity') await waitFor(() => { expect(sessions).toBe(3) })
      else await waitFor(() => { expect(reads).toBe(2) })
      expect(control.isConnected).toBe(true)
      expect(control.getAttribute('aria-disabled')).toBe('true')
      expect(control.disabled).toBe(false)
      if (!retrying) screen.getByRole<HTMLButtonElement>('button', { name: '目录资源', exact: true }).focus()
      const other = screen.getByRole<HTMLButtonElement>('button', { name: '其他操作' })
      if (elsewhere) other.focus()
      if (transition === 'identity') {
        await act(async () => { identity.resolve({ authenticated: true, employeeId: 'employee' }); await identity.promise })
        await waitFor(() => { expect(reads).toBe(1) })
        expect(document.activeElement).toBe(elsewhere ? other : screen.getByRole('region', { name: label, exact: true }))
      }
      await act(async () => {
        if (transition === 'failed') response.reject(failure)
        else response.resolve([])
        await response.promise.catch(() => undefined)
      })
      if (transition === 'failed') await screen.findByRole('alert')
      else await screen.findByText(zh.noConnectors)
      const region = screen.getByRole('region', { name: label, exact: true })
      expect(document.activeElement).toBe(elsewhere ? other : region)
      expect({ catalog: region.getAttribute('aria-label'), focus: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent,
        error: screen.queryByRole('alert') !== null, cards: screen.queryByRole('button', { name: '目录资源', exact: true }) !== null }).toMatchSnapshot()
    },
  )

  it.each(['connectors'] as const)('keeps a failed %s catalog and its retry control mounted until a read succeeds', async () => {
    const pending = deferred<unknown>()
    let failed = true
    let reads = 0
    installProductApi({ invoke: async (method) => {
      if (method === 'connectors.refresh') return { connectedIds: [], unavailableIds: [] }
      reads++
      if (failed) throw new ProductError('ORGANIZATION_SYNC_EXPIRED', 'Directory unavailable', true)
      return pending.promise
    } })
    const Panel = ConnectorsPanel
    const view = render(<Panel t={t} {...actions()} />)
    onTestFinished(() => { view.unmount(); pending.resolve([]) })
    const alert = await screen.findByRole('alert')
    const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.refresh })
    const label = retry.getAttribute('aria-label') ?? retry.textContent
    failed = false
    retry.focus()
    act(() => { retry.click(); retry.click() })
    await waitFor(() => { expect(reads).toBe(2) })
    expect(screen.getByRole('alert')).toBe(alert)
    expect(retry.isConnected).toBe(true)
    expect(retry.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(retry)
    expect(retry.classList.contains('product-control-pending')).toBe(true)
    expect(document.querySelector('.product-capability-pending')).toBeNull()
    fireEvent.click(retry)
    expect(reads).toBe(2)
    expect({ message: alert.querySelector('p')?.textContent ?? alert.textContent, retry: label,
      canRetry: retry.getAttribute('aria-disabled') !== 'true', loadingIndicator: document.querySelector('.product-capability-pending') !== null }).toMatchSnapshot()
    await act(async () => { pending.resolve([]); await pending.promise })
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(screen.getByText(zh.noConnectors)).toBeTruthy()
  })

  it('keeps the initial identity-read error visible while retrying the same panel', async () => {
    const pending = deferred<{ authenticated: boolean; employeeId: string }>()
    const session = vi.fn<NonNullable<ProductApi['getSession']>>()
      .mockRejectedValueOnce(new Error('Offline')).mockRejectedValueOnce(new Error('Offline'))
      .mockReturnValue(pending.promise)
    installProductApi({ getSession: session, invoke: async () => [] })
    const view = render(<ConnectorsPanel t={t} {...actions()} />)
    onTestFinished(() => { view.unmount(); pending.resolve({ authenticated: true, employeeId: 'employee' }) })
    const alert = await screen.findByRole('alert')
    const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.retry })
    fireEvent.click(retry)
    expect(screen.getByRole('alert')).toBe(alert)
    expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
    expect(retry.getAttribute('aria-disabled')).toBe('true')
    expect(retry.classList.contains('product-control-pending')).toBe(true)
    expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
    fireEvent.click(retry)
    expect(session).toHaveBeenCalledTimes(3)
    await act(async () => { pending.resolve({ authenticated: true, employeeId: 'employee' }); await pending.promise })
    await screen.findByText(zh.noConnectors)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['connectors'] as const)('clears a previous employee error before reading their replacement %s catalog', async () => {
    const pending = deferred<unknown>()
    let employeeId = 'employee-one'
    let listener: Parameters<ProductApi['subscribe']>[0] | undefined
    installProductApi({ getSession: async () => ({ authenticated: true, employeeId }),
      subscribe: (callback) => { listener = callback; return () => {} },
      invoke: async () => {
        if (employeeId === 'employee-one') throw new ProductError('ORGANIZATION_SYNC_EXPIRED', 'Directory unavailable', true)
        return pending.promise
      } })
    const Panel = ConnectorsPanel
    const view = render(<Panel t={t} {...actions()} />)
    onTestFinished(() => { view.unmount(); pending.resolve([]) })
    await screen.findByRole('alert')
    act(() => {
      employeeId = 'employee-two'
      listener?.({ type: 'session.changed', payload: { authenticated: true, employeeId } })
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
    await act(async () => { pending.resolve([]); await pending.promise })
    await screen.findByText(zh.noConnectors)
  })

  it.each(['connectors'] as const)('translates a failed %s catalog without rereading resources', async () => {
    const invoke = vi.fn(async () => { throw new ProductError('ORGANIZATION_SYNC_EXPIRED', 'Private directory diagnostic', true) })
    installProductApi({ invoke })
    const Panel = ConnectorsPanel
    const props = actions()
    const view = render(<Panel t={t} {...props} />)
    expect((await screen.findByRole('alert')).textContent).toContain(zh.organizationSyncExpired)
    const reads = invoke.mock.calls.length
    view.rerender(<Panel t={english} {...props} />)
    expect(screen.getByRole('alert').textContent).toContain(en.organizationSyncExpired)
    expect(screen.getByRole('alert').textContent).not.toContain('Private directory diagnostic')
    expect(invoke).toHaveBeenCalledTimes(reads)
  })

  it('translates an unavailable desktop bridge while keeping its retry action', async () => {
    Reflect.deleteProperty(globalThis, 'dshDesktop')
    const props = actions()
    const view = render(<ConnectorsPanel t={t} {...props} />)
    expect((await screen.findByRole('alert')).textContent).toContain(zh.unavailable)
    view.rerender(<ConnectorsPanel t={english} {...props} />)
    expect(screen.getByRole('alert').textContent).toContain(en.unavailable)
    expect(screen.getByRole('button', { name: en.retry })).toBeTruthy()
  })

  it.each([
    { entries: { data: [] }, problem: 'a non-array catalog' },
    { entries: [null], problem: 'a malformed entry' },
    { entries: [{ name: 'Missing identity' }], problem: 'a missing resource ID' },
    { entries: [{ id: 'erp' }], problem: 'a missing resource name' },
    { entries: [{ id: 'erp', name: 'ERP', tools: {} }], problem: 'a malformed tool list' },
    { entries: [{ id: 'erp', name: 'ERP', tools: [{ name: 'write', displayName: 'Write', access: 'UNKNOWN' }] }], problem: 'an unknown tool access policy' },
    { entries: [{ id: 'erp', name: 'ERP', canEdit: 'true' }], problem: 'a malformed permission' },
    { entries: [{ id: 'erp', name: 'ERP' }, { id: 'erp', name: 'Another ERP' }], problem: 'duplicate resource IDs' },
  ])('reports $problem instead of an empty or partial successful catalog', async ({ entries }) => {
    installProductApi({ invoke: async () => entries })
    render(<ConnectorsPanel t={t} {...actions()} />)
    expect((await screen.findByRole('alert')).textContent).toContain(zh.loadFailed)
    expect(screen.queryByText(zh.noConnectors)).toBeNull()
    expect(screen.queryByRole('button', { name: /Missing identity|Another ERP/ })).toBeNull()
  })

  it.each([false, true])('keeps connector content mounted during refresh (empty: %s)', async (empty) => {
    const initial = deferred<unknown>()
    const reconnect = deferred<unknown>()
    const entries = empty ? [] : [{ id: 'erp', name: 'ERP', category: 'business-systems' }]
    let loaded = false
    installProductApi({ invoke: async (method) => {
      if (method === 'connectors.refresh') return reconnect.promise
      return loaded ? entries : initial.promise
    } })
    render(<ConnectorsPanel t={t} {...actions()} />)
    expect(screen.getByRole('status', { name: zh.loading }).textContent).toBe('')
    expect(screen.queryByText(zh.loading)).toBeNull()
    expect(screen.queryByText(zh.noConnectors)).toBeNull()
    expect(screen.queryByRole('tabpanel')).toBeNull()
    loaded = true
    await act(async () => { initial.resolve(entries) })
    const panel = screen.getByRole('tabpanel')
    const content = empty ? screen.getByText(zh.noConnectors) : screen.getByRole('heading', { name: /业务系统/ })

    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    expect(screen.getByRole('tabpanel')).toBe(panel)
    expect(panel.getAttribute('aria-busy')).toBe('true')
    expect(panel.contains(content)).toBe(true)
    expect(screen.queryByText(zh.loading)).toBeNull()
    expect(screen.getByRole('status', { name: zh.loading }).closest('button')).toBe(screen.getByRole('button', { name: zh.refresh }))

    await act(async () => { reconnect.resolve({ connectedIds: ['erp'], unavailableIds: [] }) })
    expect(panel.getAttribute('aria-busy')).toBe('false')
    expect(panel.contains(content)).toBe(true)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps unpublished personal releases out of the marketplace and published owned releases in both scopes', async () => {
    const entries = [
      { id: 'shared', name: 'Published shared', canEdit: false, visibility: 'COMPANY', reviewStatus: 'PUBLISHED' },
      { id: 'owned', name: 'Published owned', canEdit: true, visibility: 'PERSONAL', reviewStatus: 'PUBLISHED' },
      ...['DRAFT', 'SUBMITTED', 'REJECTED'].map(status => ({ id: status, name: `Personal ${status}`, canEdit: true, visibility: 'PERSONAL', reviewStatus: status })),
    ]
    installProductApi({ invoke: async () => entries })
    render(<ConnectorsPanel t={t} {...actions()} />)
    await screen.findByRole('button', { name: /Published shared/ })
    expect(screen.getByRole('tab', { name: zh.extensionMarket, selected: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Published owned/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Personal DRAFT/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Personal SUBMITTED/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Personal REJECTED/ })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: zh.mineExtensions }))
    expect(screen.queryByRole('button', { name: /Published shared/ })).toBeNull()
    for (const name of ['Published owned', 'Personal DRAFT', 'Personal SUBMITTED', 'Personal REJECTED']) {
      expect(screen.getByRole('button', { name: new RegExp(name) })).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('tab', { name: zh.extensionMarket }))
    expect(screen.queryByRole('button', { name: /Personal DRAFT/ })).toBeNull()
  })

  it('refreshes Host connector tools only on explicit refresh and keeps failures retryable', async () => {
    let unavailable = true
    const invoke = vi.fn(async (method: string) => {
      if (method === 'connectors.refresh') {
        if (unavailable) throw new ProductError('CONNECTOR_STARTUP_FAILED', '连接器加载失败，请重试', true)
        return { connectedIds: ['crm'], unavailableIds: [] }
      }
      return [{ id: 'crm', name: 'CRM', version: '1.0.0' }]
    })
    installProductApi({ invoke })
    render(<ConnectorsPanel t={t} {...actions()} />)
    await screen.findByRole('button', { name: /CRM/ })
    expect(invoke.mock.calls.filter(([method]) => method === 'connectors.refresh')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    expect((await screen.findByRole('alert')).textContent).toContain('连接器加载失败')
    unavailable = false
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    await screen.findByRole('button', { name: /CRM/ })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(invoke.mock.calls.filter(([method]) => method === 'connectors.refresh')).toHaveLength(2)
  })

  it('opens personal connectors after saving and keeps published connectors in the marketplace', async () => {
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
    fireEvent.click(screen.getByRole('tab', { name: zh.extensionMarket }))
    expect(screen.getByRole('button', { name: new RegExp(shared.name) })).toBeTruthy()
  })

  it('reports partial reconnect failures by name without hiding working connectors and clears them after retry', async () => {
    let available = false
    const pending = deferred<{ connectedIds: string[]; unavailableIds: string[] }>()
    const entries = [{ id: 'erp', name: 'ERP' }, { id: 'crm', name: 'CRM' }]
    installProductApi({ invoke: async method => method === 'connectors.refresh'
      ? available ? pending.promise : { connectedIds: ['erp'], unavailableIds: ['crm'] } : entries })
    const view = render(<ConnectorsPanel t={t} {...actions()} />)
    onTestFinished(() => { view.unmount(); pending.resolve({ connectedIds: [], unavailableIds: [] }) })
    await screen.findByRole('button', { name: /ERP/ })
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    const warning = await screen.findByRole('alert')
    expect(warning.textContent).toBe(zh.connectorPartialRefreshFailed.replace('{names}', 'CRM'))
    expect(screen.getByRole('button', { name: /ERP/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /CRM/ })).toBeTruthy()
    available = true
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    expect(screen.getByRole('alert')).toBe(warning)
    expect(screen.getByRole('button', { name: /CRM/ })).toBeTruthy()
    await act(async () => { pending.resolve({ connectedIds: ['erp', 'crm'], unavailableIds: [] }); await pending.promise })
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByRole('button', { name: /ERP/ })).toBeTruthy() })
  })

  it('does not report malformed reconnect results as successful refreshes', async () => {
    installProductApi({ invoke: async method => method === 'connectors.refresh' ? {} : [{ id: 'erp', name: 'ERP' }] })
    render(<ConnectorsPanel t={t} {...actions()} />)
    await screen.findByRole('button', { name: /ERP/ })
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    await screen.findByRole('alert')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.refresh }).disabled).toBe(false)
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

  it('opens official settings while signed out and routes feedback through employee sign-in', async () => {
    installProductApi({ getSession: async () => ({ authenticated: false }), invoke: async () => [] })
    const openSettings = vi.fn()
    const openEmployeeSignIn = vi.fn()
    render(<DeepSeekHarnessSettingsMenu t={t} wide settingsOpen={false} openEmployeeSignIn={openEmployeeSignIn}
      subscribeEmployeeSignIn={() => () => {}} openSettings={openSettings} openOnboarding={vi.fn()} />)
    await screen.findByRole('dialog', { name: zh.authTitle })
    fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
    const employee = await screen.findByRole('button', { name: zh.employeeSignedOut })
    fireEvent.click(employee)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([zh.signIn, zh.settings, zh.feedbackTitle])
    fireEvent.click(screen.getByRole('menuitem', { name: zh.settings }))
    expect(openSettings).toHaveBeenCalledOnce()
    fireEvent.click(employee)
    fireEvent.click(screen.getByRole('menuitem', { name: zh.feedbackTitle }))
    expect(screen.queryByRole('dialog', { name: zh.feedbackTitle })).toBeNull()
    expect(openEmployeeSignIn).toHaveBeenCalledOnce()
    expect(openSettings).toHaveBeenCalledOnce()
  })

  it('opens the native software updater from the employee menu and permits retry after failure', async () => {
    installProductApi({ getSession: async () => ({ authenticated: false }), invoke: async () => [] })
    const pending = deferred<undefined>()
    const openSoftwareUpdate = vi.fn().mockRejectedValueOnce(new Error('private updater diagnostic'))
      .mockImplementationOnce(() => pending.promise)
    render(<DeepSeekHarnessSettingsMenu t={t} wide settingsOpen={false} openEmployeeSignIn={vi.fn()}
      subscribeEmployeeSignIn={() => () => {}} openSettings={vi.fn()} openOnboarding={vi.fn()} openSoftwareUpdate={openSoftwareUpdate} />)
    await screen.findByRole('dialog', { name: zh.authTitle })
    fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
    const employee = await screen.findByRole('button', { name: zh.employeeSignedOut })
    fireEvent.click(employee)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([zh.signIn, zh.settings, zh.softwareUpdate, zh.feedbackTitle])
    fireEvent.click(screen.getByRole('menuitem', { name: zh.softwareUpdate }))
    expect((await screen.findByRole('alert')).textContent).toBe(zh.softwareUpdateFailed)
    expect(document.body.textContent).not.toContain('private updater diagnostic')
    fireEvent.click(employee)
    fireEvent.click(screen.getByRole('menuitem', { name: zh.softwareUpdate }))
    fireEvent.click(employee)
    expect(screen.getByRole('menuitem', { name: zh.softwareUpdate })).toHaveProperty('disabled', true)
    await act(async () => { pending.resolve(undefined) })
    expect(openSoftwareUpdate).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('registers capability panels in the sidebar and none in Settings', () => {
    const openUpdate = vi.fn(async () => {})
    Object.defineProperty(globalThis, 'dshDesktop', { configurable: true, value: { protocolVersion: 1, updates: { open: openUpdate } } })
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const selectPanel = vi.fn()
    const registerCommand = vi.fn((_command: CommandContribution) => () => {})
    const ctx = {
      plugin: vi.fn(),
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
      .map(entry => entry.options.key)).toEqual(CAPABILITY_PANELS.map(panel => panel.id))
    const settingsLaunchers = registrations.filter(entry => entry.options.name === 'settings.launcher')
    expect(settingsLaunchers).toHaveLength(1)
    // Let the browser slot facade allocate the shadowing rank so this product
    // launcher replaces the official account launcher after a reload.
    expect(settingsLaunchers[0]?.options.priority).toBeUndefined()
    const injectLauncher = settingsLaunchers[0]?.options.inject as () => { openSoftwareUpdate(): Promise<void> }
    void injectLauncher().openSoftwareUpdate()
    expect(openUpdate).toHaveBeenCalledOnce()
    expect(registrations.filter(entry => entry.options.name === 'conversation.input.references')
      .map(entry => entry.options.id)).toEqual(['product-library'])
    expect(registrations.filter(entry => entry.options.name === 'conversation.hero.agentPreset')).toEqual([])
    expect(registrations.filter(entry => entry.options.name === 'conversation.hero.actions')
      .map(entry => entry.options.id)).toEqual([])
    expect(registrations.filter(entry => entry.options.name === 'conversation.session.header.actions')
      .map(entry => entry.options.id)).toEqual([])
    expect(registerCommand).toHaveBeenCalledOnce()
    expect(registerCommand.mock.calls[0]?.[0].name).toBe('library')
    expect(registerCommand.mock.calls[0]?.[0].label?.()).toBe(zh.libraryChooseFiles)
    expect(selectPanel).not.toHaveBeenCalled()
  })

  it('opens library selection only in its mounted Session and releases the command with the plugin', () => {
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const disposers: Array<() => void> = []
    const unregisterCommand = vi.fn()
    const registerCommand = vi.fn((_command: CommandContribution) => unregisterCommand)
    const sessionA = 'session-a' as SessionId
    const sessionB = 'session-b' as SessionId
    const subagent = 'subagent' as SessionId
    const ctx = {
      plugin: vi.fn(),
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
    const library = registrations.find(entry => entry.options.id === 'product-library')!
    const injectLibrary = library.options.inject as (sessionId: SessionId) => {
      subscribeOpen(listener: () => void): () => void
    }
    const openA = vi.fn()
    const openB = vi.fn()
    expect(command.available({ sessionId: sessionA })).toBe(false)
    const releaseA = injectLibrary(sessionA).subscribeOpen(openA)
    const releaseB = injectLibrary(sessionB).subscribeOpen(openB)
    const releaseSubagent = injectLibrary(subagent).subscribeOpen(vi.fn())
    expect(command.available({ sessionId: sessionA })).toBe(true)
    expect(command.available({ sessionId: subagent })).toBe(false)
    if (command.ui.kind !== 'action') throw new Error('Library selection must be an action')
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

  it('removes tree branches while retaining useful collapsed-rail icons', () => {
    const { container, rerender } = render(<CapabilityChildIcon
      size={16} active={false} wide icon={CAPABILITY_PANELS[0].icon} />)
    expect(container.querySelector('svg')).toBeNull()
    rerender(<CapabilityChildIcon size={18} active={false} wide={false} icon={CAPABILITY_PANELS[0].icon} />)
    expect(container.querySelector('svg')).not.toBeNull()
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

  it('groups uncategorized and unknown connectors together under Other', async () => {
    installProductApi({ invoke: async () => [
      { id: 'missing', name: 'Uncategorized MCP' },
      { id: 'custom', name: 'Custom MCP', category: 'unregistered' },
      { id: 'other', name: 'Other MCP', category: 'other' },
      { id: 'erp', name: 'ERP MCP', category: 'business-systems' },
    ] })
    render(<ConnectorsPanel t={t} {...actions()} />)
    await screen.findByRole('button', { name: /Uncategorized MCP/ })
    expect(screen.getAllByRole('region', { name: zh.categoryOther })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: zh.categoryFilter }))
    expect(screen.getAllByRole('menuitem', { name: zh.categoryOther })).toHaveLength(1)
    fireEvent.click(screen.getByRole('menuitem', { name: zh.categoryOther }))
    for (const name of ['Uncategorized MCP', 'Custom MCP', 'Other MCP']) {
      expect(screen.getByRole('button', { name: new RegExp(name) })).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: /ERP MCP/ })).toBeNull()
  })

  it('shows all categories in enterprise order and retains a way to clear a disappearing category', async () => {
    let entries = [
      { id: 'git', name: 'Git MCP', category: 'development-operations' },
      { id: 'erp', name: 'ERP MCP', category: 'business-systems' },
      { id: 'shop', name: 'Shop MCP', category: 'ecommerce-platforms' },
    ]
    installProductApi({ invoke: async method => method === 'connectors.refresh'
      ? { connectedIds: entries.map(entry => entry.id), unavailableIds: [] } : entries })
    render(<ConnectorsPanel t={t} {...actions()} />)
    await screen.findByRole('button', { name: /ERP MCP/ })
    fireEvent.click(screen.getByRole('button', { name: zh.categoryFilter }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toMatchSnapshot()
    expect(screen.getByRole('menuitem', { name: zh.categoryDataAnalysis })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: zh.categoryEcommercePlatforms }))
    entries = [{ id: 'erp', name: 'ERP MCP', category: 'business-systems' }]
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(screen.queryByRole('button', { name: /Shop MCP/ })).toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: zh.categoryFilter }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh.allCategories }))
    expect(screen.getByRole('button', { name: /ERP MCP/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.categoryFilter }).textContent).toBe(zh.allCategories)
  })

  it('keeps all categories selectable with one populated category and allows clearing an empty selection', async () => {
    installProductApi({ invoke: async () => [{ id: 'erp', name: 'ERP MCP', category: 'business-systems' }] })
    render(<ConnectorsPanel t={t} {...actions()} />)
    await screen.findByRole('button', { name: /ERP MCP/ })
    expect(screen.getByRole('region', { name: zh.categoryBusinessSystems })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.categoryFilter }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(7)
    fireEvent.click(screen.getByRole('menuitem', { name: zh.categoryDataAnalysis }))
    expect(screen.queryByRole('button', { name: /ERP MCP/ })).toBeNull()
    expect(screen.getByText(zh.noSearchResults)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.categoryFilter }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh.allCategories }))
    expect(screen.getByRole('button', { name: /ERP MCP/ })).toBeTruthy()
  })

  it('clears the category when switching to Mine and keeps all categories selectable', async () => {
    installProductApi({ invoke: async () => [
      { id: 'erp', name: 'ERP MCP', category: 'business-systems' },
      { id: 'shop', name: 'My shop MCP', category: 'ecommerce-platforms', canEdit: true },
    ] })
    render(<ConnectorsPanel t={t} {...actions()} />)
    await screen.findByRole('button', { name: /ERP MCP/ })
    fireEvent.click(screen.getByRole('button', { name: zh.categoryFilter }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh.categoryBusinessSystems }))
    fireEvent.click(screen.getByRole('tab', { name: zh.mineExtensions }))
    expect(screen.getByRole('button', { name: /My shop MCP/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /ERP MCP/ })).toBeNull()
    expect(screen.getByRole('button', { name: zh.categoryFilter }).textContent).toBe(zh.allCategories)
    fireEvent.click(screen.getByRole('button', { name: zh.categoryFilter }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(7)
    expect(screen.getByRole('menuitem', { name: zh.categoryBusinessSystems })).toBeTruthy()
  })

  it('searches translated categories and clears an empty selection without leaving Mine', async () => {
    installProductApi({ invoke: async () => [
      { id: 'erp', name: 'ERP MCP', category: 'business-systems', canEdit: true },
      { id: 'docs', name: 'Docs MCP', category: 'collaboration' },
    ] })
    render(<ConnectorsPanel t={t} {...actions()} />)
    await screen.findByRole('button', { name: /ERP MCP/ })
    fireEvent.change(screen.getByRole('searchbox', { name: zh.search }), { target: { value: zh.categoryBusinessSystems } })
    expect(screen.getByRole('button', { name: /ERP MCP/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Docs MCP/ })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: zh.mineExtensions }))
    fireEvent.click(screen.getByRole('button', { name: zh.categoryFilter }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh.categoryCollaboration }))
    const clear = screen.getByRole('button', { name: zh.clearConnectorFilters })
    clear.focus()
    fireEvent.click(clear)
    expect(screen.getByRole('tab', { name: zh.mineExtensions, selected: true })).toBeTruthy()
    expect(screen.getByRole<HTMLInputElement>('searchbox', { name: zh.search }).value).toBe('')
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: zh.search }))
    expect(screen.getByRole('button', { name: /ERP MCP/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Docs MCP/ })).toBeNull()
  })

  it('keeps Marketplace and Mine mutually exclusive during keyboard navigation', async () => {
    installProductApi({ invoke: async () => [
      { id: 'shared', name: 'Shared MCP', status: 'ready', ready: true, authMode: 'none' },
      { id: 'personal', name: 'Personal MCP', status: 'needs-configuration', canEdit: true },
    ] })
    render(<ConnectorsPanel t={t} {...actions()} />)
    await screen.findByRole('button', { name: /Shared MCP/ })
    fireEvent.keyDown(screen.getByRole('tab', { name: zh.extensionMarket }), { key: 'End' })
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe(zh.mineExtensions)
    expect(screen.queryByRole('button', { name: /Shared MCP/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Personal MCP/ })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'ArrowLeft' })
    expect(screen.getByRole('button', { name: /Shared MCP/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Personal MCP/ })).toBeTruthy()
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'Home' })
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe(zh.extensionMarket)
    expect(screen.getByRole('button', { name: /Personal MCP/ })).toBeTruthy()
  })

  it('presents business tools without directory status or technical connection facts', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => [
      { id: 'erp', name: 'erp-mcp', displayName: 'ERP 连接器', summary: '订单数据', category: 'business-systems',
        status: 'ready', scope: 'COMPANY', transport: 'stdio', version: '0.4.0',
        tools: [
          { name: 'orders_read', displayName: '查询订单', description: '读取订单', access: 'READ' },
          { name: 'orders_update', displayName: '更新订单', description: '修改订单', access: 'WRITE' },
        ], authMode: 'employee-bearer' },
      { id: 'docs', name: '文档', summary: '企业文档', category: 'collaboration', status: 'ready',
        tools: [] },
    ])
    installProductApi({
      getSession: vi.fn(async () => ({ authenticated: true })), invoke, cancel: vi.fn(),
    })

    render(<ConnectorsPanel t={t} {...actions()} />)
    expect(await screen.findByRole('region', { name: zh.categoryBusinessSystems })).not.toBeNull()
    expect(screen.getByRole('region', { name: zh.categoryCollaboration })).not.toBeNull()
    expect(screen.getByRole('button', { name: zh.categoryFilter })).not.toBeNull()
    expect(screen.getByText(zh.allCategories)).not.toBeNull()
    const results = document.querySelector('#deepseek-harness-catalog-results')
    expect(results).not.toBeNull()
    expect(results?.textContent).not.toMatch(/已配置|就绪|待配置|停用|不可用/)
    expect(screen.getByText(zh.readCapabilityShort.replace('{count}', '1'))).not.toBeNull()
    expect(screen.getByText(zh.writeCapabilityShort.replace('{count}', '1'))).not.toBeNull()
    expect(screen.queryByText(zh.scopeCompany)).toBeNull()
    expect(screen.queryByText(zh.transportStdio)).toBeNull()
    expect(screen.queryByText('0.4.0')).toBeNull()
    expect(screen.getByText('ERP 连接器')).not.toBeNull()
    expect(screen.queryByText('erp-mcp')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: zh.categoryFilter }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh.categoryBusinessSystems }))
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
    expect(screen.getByText(zh.readOnlyLabel, { selector: 'span[data-access="READ"]' })).not.toBeNull()
    expect(screen.getByText(zh.writeLabel, { selector: 'span[data-access="WRITE"]' })).not.toBeNull()
    expect(screen.getByText('orders_read').closest('details')?.open).toBe(false)
    fireEvent.click(screen.getByText('查询订单', { selector: 'strong' }))
    expect(screen.getByText('orders_read').closest('details')?.open).toBe(true)
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
    expect(screen.queryByRole('alert')).toBeNull()
    vi.useRealTimers()
    fireEvent.click(screen.getByRole('button', { name: /ERP 连接器/ }))
    expect(await screen.findByRole('button', { name: authorized ? zh.revokeAuthorization : zh.authorize })).not.toBeNull()
  })
})
