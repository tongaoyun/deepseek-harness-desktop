// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { ConnectorDraftSchema } from '@deepseek-harness/product/connector-draft'
import { ConnectorEditor } from '../src/client/ConnectorEditor.tsx'
import { ConnectorDetail } from '../src/client/ConnectorView.tsx'
import { items, localDetail } from '../src/client/catalog-shared.tsx'
import { en, zh } from '../src/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const t = (key: keyof typeof zh) => zh[key]
const editing = { id: 'personal-mcp', version: '1.0.0' }
const draft = ConnectorDraftSchema.parse({ ...editing, version: '1.0.1', kind: 'connector', name: 'MCP',
  summary: 'Tools', category: 'other', transport: 'streamable-http', url: 'https://mcp.example.test' })
const template = { ...editing, transport: 'streamable-http', url: draft.url, arguments: [],
  headers: ['Authorization'], environment: [], configured: false, timeoutSeconds: 60 }

it.each([
  { mode: 'edit', elsewhere: false }, { mode: 'device', elsewhere: false }, { mode: 'provider', elsewhere: false },
  { mode: 'edit', elsewhere: true }, { mode: 'device', elsewhere: true }, { mode: 'provider', elsewhere: true },
] as const)('recovers a removed $mode read retry without taking focus elsewhere ($elsewhere)', async ({ mode, elsewhere }) => {
  const response = Promise.withResolvers<unknown>()
  const method = mode === 'edit' ? 'extensions.connector.read' : mode === 'device' ? 'extensions.connector.configuration.read' : 'connectors.list'
  let reads = 0
  const invoke = vi.fn(async (_namespace: string, name: string) => {
    if (name !== method) return { ok: true, result: [] }
    if (++reads === 1) throw new Error('Connector unavailable')
    return { ok: true, result: await response.promise }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const product = localDetail(items([{ ...editing, name: 'Company MCP', authMode: 'none', canConfigure: true,
    status: 'needs-configuration', visibility: 'COMPANY', tools: [] }])[0]!)
  const view = mode === 'device' ? render(<ConnectorDetail product={product} onCatalogChanged={async () => {}} t={t} />)
    : render(<ConnectorEditor editing={mode === 'edit' ? editing : undefined} onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
  onTestFinished(() => { view.unmount(); response.resolve([]) })
  if (mode === 'device') fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
  if (mode === 'provider') fireEvent.change(screen.getByLabelText(zh.mcpServerType), { target: { value: 'streamable-http' } })
  const retry = await screen.findByRole('button', { name: zh.retry })
  retry.focus(); fireEvent.click(retry)
  expect(reads).toBe(2)
  const other = screen.getByRole('button', { name: zh.close })
  if (elsewhere) other.focus()
  await act(async () => { response.resolve(mode === 'edit' ? { draft, configured: true, savePending: false } : mode === 'device' ? template
    : [{ id: 'company-oauth', version: '1.0.0', name: 'Company OAuth', authMode: 'oauth', visibility: 'COMPANY', tools: [] }]) })
  expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
  const target = elsewhere ? other : screen.getByLabelText(mode === 'device' ? zh.connectorTimeout : zh.mcpServerType)
  expect(document.activeElement).toBe(target)
  expect({ focused: target.getAttribute('aria-label'), retryVisible: screen.queryByRole('button', { name: zh.retry }) !== null,
    failure: screen.queryByRole('alert')?.textContent ?? null }).toMatchSnapshot('Recovered connector read focus')
})

it.each(['edit', 'device'] as const)('runs one %s read retry and keeps the recovered draft editable', async (mode) => {
  const pending = Promise.withResolvers<unknown>()
  const recovered = Promise.withResolvers<unknown>()
  const method = mode === 'edit' ? 'extensions.connector.read' : 'extensions.connector.configuration.read'
  let reads = 0
  const invoke = vi.fn(async (_namespace: string, name: string) => {
    if (name !== method) return { ok: true, result: [] }
    if (++reads === 1) throw new Error('Connector unavailable')
    return { ok: true, result: await (reads === 2 ? pending.promise : recovered.promise) }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  if (mode === 'edit') render(<ConnectorEditor editing={editing} onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
  else {
    const product = localDetail(items([{ ...editing, name: 'Company MCP', authMode: 'none', canConfigure: true,
      status: 'needs-configuration', visibility: 'COMPANY', tools: [] }])[0]!)
    render(<ConnectorDetail product={product} onCatalogChanged={async () => {}} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
  }
  const failure = await screen.findByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.retry })
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(reads).toBe(2)
  expect(screen.getByRole('alert')).toBe(failure)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  expect({ failure: failure.textContent, retry: retry.textContent, canRetry: retry.getAttribute('aria-disabled') !== 'true',
    loadingIndicator: screen.queryByRole('status', { name: zh.loading }) !== null }).toMatchSnapshot()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.saveConnector }).disabled).toBe(true)
  await act(async () => { pending.reject(new Error('Connector still unavailable')) })
  expect(screen.getByRole('alert')).toBe(failure)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(retry.disabled).toBe(false)
  fireEvent.click(await screen.findByRole('button', { name: zh.retry }))
  await act(async () => { recovered.resolve(mode === 'edit' ? { draft, configured: true, savePending: false } : template) })
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.change(screen.getByLabelText(zh.connectorTimeout), { target: { value: '120' } })
  expect(screen.getByLabelText<HTMLInputElement>(zh.connectorTimeout).value).toBe('120')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.saveConnector }).disabled).toBe(false)
  expect(invoke.mock.calls.filter(call => call[1] === method)).toHaveLength(3)
})

it('runs one OAuth provider retry and keeps the selected provider and private inputs', async () => {
  const pending = Promise.withResolvers<unknown>()
  const saving = Promise.withResolvers<undefined>()
  let reads = 0
  const invoke = vi.fn(async (_namespace: string, method: string, payload: unknown) => {
    if (method === 'extensions.save') {
      await saving.promise
      const saved = ConnectorDraftSchema.parse(payload)
      return { ok: true, result: { kind: 'connector', id: saved.id, version: saved.version, visibility: 'PERSONAL' } }
    }
    if (++reads === 1) throw new Error('Provider unavailable')
    return { ok: true, result: await pending.promise }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  render(<ConnectorEditor onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
  fireEvent.change(screen.getByLabelText(zh.mcpServerType), { target: { value: 'streamable-http' } })
  fireEvent.change(screen.getByLabelText(zh.mcpServerName), { target: { value: 'Retained HTTP MCP' } })
  fireEvent.change(screen.getByLabelText(zh.connectorEndpoint), { target: { value: draft.url } })
  fireEvent.click(screen.getByRole('button', { name: zh.addConfigurationEntry }))
  fireEvent.change(screen.getByLabelText(`${zh.configurationKey} 1`), { target: { value: 'Authorization' } })
  fireEvent.change(screen.getByLabelText(`${zh.configurationValue} 1`), { target: { value: 'private-fixture-value' } })
  const failure = await screen.findByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.retry })
  fireEvent.click(screen.getByRole('button', { name: zh.addMcp }))
  expect(retry.disabled).toBe(true)
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(retry.getAttribute('aria-busy')).toBe('false')
  retry.click()
  expect(reads).toBe(1)
  await act(async () => { saving.resolve(undefined) })
  expect(retry.disabled).toBe(false)
  expect(retry.classList.contains('product-control-pending')).toBe(false)
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(reads).toBe(2)
  expect(screen.getByRole('alert')).toBe(failure)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  expect({ failure: failure.textContent, retry: retry.textContent, canRetry: retry.getAttribute('aria-disabled') !== 'true',
    loadingIndicator: screen.queryByRole('status', { name: zh.loading }) !== null }).toMatchSnapshot()
  await act(async () => { pending.resolve([{ id: 'company-oauth', version: '1.0.0', name: 'Company OAuth',
    authMode: 'oauth', visibility: 'COMPANY', reviewStatus: 'PUBLISHED', tools: [] }]) })
  expect(screen.getByLabelText<HTMLInputElement>(`${zh.configurationValue} 1`).value).toBe('private-fixture-value')
  fireEvent.change(screen.getByLabelText(zh.authentication), { target: { value: 'company-oauth' } })
  expect(screen.getByLabelText<HTMLSelectElement>(zh.authentication).value).toBe('company-oauth')
  expect(screen.getByLabelText<HTMLInputElement>(zh.mcpServerName).value).toBe('Retained HTTP MCP')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(invoke).toHaveBeenCalledTimes(3)
})

it.each(['loading', 'empty', 'missing', 'failed'] as const)('allows replacing saved OAuth with local settings when providers are %s', async (state) => {
  const providers = Promise.withResolvers<unknown>()
  const saved = { ...draft, oauthProviderId: 'saved-oauth', url: '' }
  const onSaved = vi.fn()
  const invoke = vi.fn(async (_namespace: string, method: string, _payload: unknown) => {
    if (method === 'extensions.connector.read') return { ok: true, result: { draft: saved, configured: true, savePending: false } }
    if (method === 'connectors.list') return { ok: true, result: await providers.promise }
    return { ok: true, result: { kind: 'connector', id: saved.id, version: saved.version, visibility: 'PERSONAL' } }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const props = { editing, onClose: vi.fn(), onSaved }
  const view = render(<ConnectorEditor {...props} t={t} />)
  await screen.findByLabelText(zh.mcpServerName)
  if (state !== 'loading') await act(async () => {
    if (state === 'failed') providers.reject(new Error('Provider unavailable'))
    else providers.resolve(state === 'empty' ? [] : [{ id: 'other-oauth', version: '1.0.0', name: 'Other OAuth',
      authMode: 'oauth', visibility: 'COMPANY', tools: [] }])
  })
  const authentication = screen.getByLabelText<HTMLSelectElement>(zh.authentication)
  expect(authentication.value).toBe(saved.oauthProviderId)
  expect(authentication.selectedOptions[0]?.disabled).toBe(true)
  expect(screen.queryByLabelText(zh.connectorEndpoint)).toBeNull()
  expect([...authentication.options].map(option => ({ label: option.text, disabled: option.disabled }))).toMatchSnapshot()
  view.rerender(<ConnectorEditor {...props} t={key => en[key]} />)
  expect(screen.getByLabelText<HTMLSelectElement>(en.authentication).value).toBe(saved.oauthProviderId)
  expect([...authentication.options].map(option => option.text)).toMatchSnapshot('English authentication choices')
  view.rerender(<ConnectorEditor {...props} t={t} />)
  fireEvent.change(authentication, { target: { value: '' } })
  fireEvent.change(screen.getByLabelText(zh.connectorEndpoint), { target: { value: draft.url } })
  fireEvent.change(screen.getByLabelText(zh.connectorTimeout), { target: { value: '120' } })
  fireEvent.click(screen.getByRole('button', { name: zh.addConfigurationEntry }))
  fireEvent.change(screen.getByLabelText(`${zh.configurationKey} 1`), { target: { value: 'X-Token' } })
  fireEvent.change(screen.getByLabelText(`${zh.configurationValue} 1`), { target: { value: 'local-fixture-value' } })
  if (state === 'loading') await act(async () => { providers.resolve([{ id: saved.oauthProviderId, version: '1.0.0',
    name: 'Recovered OAuth', authMode: 'oauth', visibility: 'COMPANY', tools: [] }]) })
  expect(screen.getByLabelText<HTMLInputElement>(zh.connectorEndpoint).value).toBe(draft.url)
  fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
  await act(async () => {})
  const update = invoke.mock.calls.find(call => call[1] === 'extensions.connector.update')
  expect(update?.[2]).toEqual({ ...editing, draft: { ...draft, url: draft.url, headers: { 'X-Token': 'local-fixture-value' }, timeoutSeconds: 120 } })
  expect(onSaved).toHaveBeenCalledOnce()
})

it('recovers the saved OAuth choice after retry and saves an explicitly selected replacement', async () => {
  const saved = { ...draft, oauthProviderId: 'saved-oauth', url: '' }
  let reads = 0
  const onSaved = vi.fn()
  const invoke = vi.fn(async (_namespace: string, method: string, _payload: unknown) => {
    if (method === 'extensions.connector.read') return { ok: true, result: { draft: saved, configured: true, savePending: false } }
    if (method === 'connectors.list') {
      if (++reads === 1) throw new Error('Provider unavailable')
      return { ok: true, result: [saved.oauthProviderId, 'replacement-oauth'].map(id => ({ id, version: '1.0.0',
        name: id === saved.oauthProviderId ? 'Recovered OAuth' : 'Replacement OAuth', authMode: 'oauth', visibility: 'COMPANY', tools: [] })) }
    }
    return { ok: true, result: { kind: 'connector', id: saved.id, version: saved.version, visibility: 'PERSONAL' } }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  render(<ConnectorEditor editing={editing} onClose={vi.fn()} onSaved={onSaved} t={t} />)
  await screen.findByRole('alert')
  fireEvent.change(screen.getByLabelText(zh.mcpServerName), { target: { value: 'Retained MCP' } })
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await act(async () => {})
  const authentication = screen.getByLabelText<HTMLSelectElement>(zh.authentication)
  expect(authentication.value).toBe(saved.oauthProviderId)
  expect(authentication.selectedOptions[0]?.disabled).toBe(false)
  expect(authentication.selectedOptions[0]?.text).toBe('Recovered OAuth · OAuth')
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.change(authentication, { target: { value: 'replacement-oauth' } })
  fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
  await act(async () => {})
  expect(invoke.mock.calls.find(call => call[1] === 'extensions.connector.update')?.[2])
    .toEqual({ ...editing, draft: { ...saved, oauthProviderId: 'replacement-oauth', name: 'Retained MCP' } })
  expect(onSaved).toHaveBeenCalledOnce()
})

it.each(['edit', 'providers'] as const)('ignores an abandoned %s read without blocking the reactivated editor', async (mode) => {
  const abandoned = Promise.withResolvers<unknown>(), current = Promise.withResolvers<unknown>()
  const method = mode === 'edit' ? 'extensions.connector.read' : 'connectors.list'
  let reads = 0
  const invoke = vi.fn(async (_namespace: string, name: string, _payload: unknown, _request: string) => ({ ok: true,
    result: name === method ? await (++reads === 1 ? abandoned.promise : current.promise) : [] }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  render(<StrictMode><ConnectorEditor {...mode === 'edit' ? { editing } : {}} onClose={vi.fn()} onSaved={vi.fn()} t={t} /></StrictMode>)
  expect(reads).toBe(2)
  if (mode === 'providers') fireEvent.change(screen.getByLabelText(zh.mcpServerType), { target: { value: 'streamable-http' } })
  await act(async () => { current.resolve(mode === 'edit' ? { draft, configured: true, savePending: false }
    : [{ id: 'current-oauth', version: '1.0.0', name: 'Current OAuth', authMode: 'oauth', visibility: 'COMPANY', tools: [] }]) })
  fireEvent.change(screen.getByLabelText(zh.mcpServerName), { target: { value: 'Retained MCP' } })
  await act(async () => { abandoned.resolve(mode === 'edit' ? { draft, configured: true, savePending: false } : []) })
  expect(screen.getByLabelText<HTMLInputElement>(zh.mcpServerName).value).toBe('Retained MCP')
  if (mode === 'providers') expect(screen.getByLabelText<HTMLSelectElement>(zh.authentication).options[1]?.value).toBe('current-oauth')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(cancel).toHaveBeenCalledWith('product', invoke.mock.calls.find(call => call[1] === method)?.[3])
})

it.each((['edit', 'device'] as const).flatMap(mode => (['error', 'close'] as const).map(focus => ({ mode, focus }))))(
  'recovers removed $mode footer feedback focus after a read retry without taking $focus focus', async ({ mode, focus }) => {
    const response = Promise.withResolvers<unknown>()
    const method = mode === 'edit' ? 'extensions.connector.read' : 'extensions.connector.configuration.read'
    let reads = 0
    vi.stubGlobal('dshDesktop', { extensions: { invoke: async (_namespace: string, name: string) => {
      if (name !== method) return { ok: true, result: [] }
      if (++reads === 1) return { ok: false, failure: { code: 'ORGANIZATION_SYNC_EXPIRED', message: 'Organization unavailable', retryable: true, resources: [] } }
      return { ok: true, result: await response.promise }
    }, cancel: vi.fn() } })
    const product = localDetail(items([{ ...editing, name: 'Company MCP', authMode: 'none', canConfigure: true,
      status: 'needs-configuration', visibility: 'COMPANY', tools: [] }])[0]!)
    const view = mode === 'device' ? render(<ConnectorDetail product={product} onCatalogChanged={async () => {}} t={t} />)
      : render(<ConnectorEditor editing={editing} onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
    onTestFinished(() => { view.unmount(); response.resolve([]) })
    if (mode === 'device') fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
    const alert = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
    fireEvent.click(retry); fireEvent.click(retry)
    expect(reads).toBe(2)
    const close = screen.getByRole('button', { name: zh.close })
    const target = focus === 'error' ? alert : close
    target.focus()
    expect(document.activeElement).toBe(target)
    await act(async () => { response.resolve(mode === 'edit' ? { draft, configured: true, savePending: false } : template) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(focus === 'close' ? close : screen.getByLabelText(mode === 'edit' ? zh.mcpServerType : zh.connectorTimeout))
    expect(screen.getByRole('button', { name: zh.close })).toBe(close)
  },
)
