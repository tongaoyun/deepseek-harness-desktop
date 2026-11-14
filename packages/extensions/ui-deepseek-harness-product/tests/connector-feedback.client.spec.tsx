// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { ConnectorDraftSchema } from '@deepseek-harness/product/connector-draft'
import { productFailure, ProductError } from '@deepseek-harness/product/errors'
import { ConnectorEditor } from '../src/client/ConnectorEditor.tsx'
import { ConnectorDetail } from '../src/client/ConnectorView.tsx'
import { items, localDetail } from '../src/client/catalog-shared.tsx'
import { en, zh, NS } from '../src/locales.ts'

const localeContext = new Context()
const locale = new LocaleRuntime(localeContext)
locale.register(NS, { en, zh })
locale.setLocale('zh')
afterEach(() => { cleanup(); vi.unstubAllGlobals(); locale.setLocale('zh') })
afterAll(async () => { await localeContext.fiber.dispose() })

const editing = { id: 'personal-mcp', version: '1.0.0' }
const draft = ConnectorDraftSchema.parse({ ...editing, version: '1.0.1', kind: 'connector', name: 'MCP',
  summary: 'Tools', category: 'other', transport: 'streamable-http', url: 'https://mcp.example.test' })
const loaded = { draft, configured: true, savePending: false }
const product = localDetail(items([{ ...editing, name: 'Shared MCP', authMode: 'none', canConfigure: true,
  status: 'needs-configuration', visibility: 'COMPANY', tools: [] }])[0]!)
const configuration = { ...editing, transport: 'streamable-http', url: draft.url, arguments: [],
  headers: ['Authorization'], environment: [], configured: false, timeoutSeconds: 60 }

function transport(handler: (method: string) => Promise<unknown>) {
  const invoke = vi.fn(async (_namespace: string, method: string, _payload?: unknown) => {
    try { return { ok: true, result: await handler(method) } }
    catch (error) { return { ok: false, failure: productFailure(error) } }
  })
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  return { invoke, cancel }
}

it.each([
  ['stdio', 'zh'], ['stdio', 'en'], ['streamable-http', 'zh'], ['streamable-http', 'en'],
] as const)('keeps %s configuration focus beside deleted rows and in newly added rows in %s', async (kind, language) => {
  const api = transport(async () => [])
  locale.setLocale(language)
  const text = language === 'zh' ? zh : en
  render(<ConnectorEditor onClose={vi.fn()} onSaved={vi.fn()} t={locale.bind(NS)} />)
  if (kind === 'streamable-http') fireEvent.change(screen.getByLabelText(text.mcpServerType), { target: { value: kind } })
  const add = screen.getByRole('button', { name: kind === 'stdio' ? text.addVariable : text.addConfigurationEntry })
  for (let index = kind === 'stdio' ? 2 : 1; index <= 3; index++) {
    add.focus()
    fireEvent.click(add)
    expect(document.activeElement).toBe(screen.getByLabelText(`${text.configurationKey} ${index}`))
  }
  const first = screen.getByLabelText<HTMLInputElement>(`${text.configurationKey} 1`)
  const last = screen.getByLabelText<HTMLInputElement>(`${text.configurationKey} 3`)
  const secret = screen.getByLabelText<HTMLInputElement>(`${text.configurationValue} 3`)
  fireEvent.change(last, { target: { value: 'RETAINED_KEY' } })
  fireEvent.change(secret, { target: { value: 'private-value' } })
  for (const [index, target] of [[2, last], [2, first], [1, add]] as const) {
    const remove = screen.getByRole('button', { name: `${text.remove} ${index}` })
    remove.focus()
    fireEvent.click(remove)
    expect(document.activeElement).toBe(target)
    if (target === last) {
      expect(screen.getByLabelText(`${text.configurationKey} 2`)).toBe(last)
      expect(screen.getByLabelText(`${text.configurationValue} 2`)).toBe(secret)
      expect(last.value).toBe('RETAINED_KEY')
      expect(secret.value).toBe('private-value')
    }
  }
  expect({ focused: document.activeElement?.textContent, rows: screen.queryAllByLabelText(new RegExp(`^${text.configurationKey} `)).length }).toMatchSnapshot()
  await act(async () => {})
  expect(api.invoke).toHaveBeenCalledOnce()
})

it.each((['stdio', 'streamable-http'] as const).flatMap(kind =>
  (['append', 'update', 'empty'] as const).map(action => ({ kind, action })),
))('retains $kind configuration inputs and focus when delayed clipboard $action completes', async ({ kind, action }) => {
  transport(async () => [])
  const clipboard = Promise.withResolvers<string>()
  vi.stubGlobal('navigator', { clipboard: { readText: () => clipboard.promise } })
  render(<ConnectorEditor onClose={vi.fn()} onSaved={vi.fn()} t={locale.bind(NS)} />)
  if (kind === 'streamable-http') {
    fireEvent.change(screen.getByLabelText(zh.mcpServerType), { target: { value: kind } })
    fireEvent.click(screen.getByRole('button', { name: zh.addConfigurationEntry }))
  }
  const key = screen.getByLabelText<HTMLInputElement>(`${zh.configurationKey} 1`)
  const value = screen.getByLabelText<HTMLInputElement>(`${zh.configurationValue} 1`)
  if (action !== 'empty') {
    fireEvent.change(key, { target: { value: 'RETAINED_KEY' } })
    fireEvent.change(value, { target: { value: 'private-fixture-value' } })
  }
  fireEvent.click(screen.getByRole('button', { name: zh.pasteConfiguration }))
  const focused = action === 'append' ? value : key
  focused.focus()
  focused.setSelectionRange(action === 'empty' ? 0 : 1, action === 'empty' ? 0 : 4)
  await act(async () => { clipboard.resolve(action === 'update' ? 'RETAINED_KEY=updated-value' : 'NEW_KEY=new-value') })
  expect(screen.getByLabelText(`${zh.configurationKey} 1`)).toBe(key)
  expect(screen.getByLabelText(`${zh.configurationValue} 1`)).toBe(value)
  expect(document.activeElement).toBe(focused)
  if (action !== 'empty') expect([focused.selectionStart, focused.selectionEnd]).toEqual([1, 4])
  expect(key.value).toBe(action === 'empty' ? 'NEW_KEY' : 'RETAINED_KEY')
  expect(value.value).toBe(action === 'append' ? 'private-fixture-value' : action === 'update' ? 'updated-value' : 'new-value')
  expect(screen.queryAllByLabelText(new RegExp(`^${zh.configurationKey} `))).toHaveLength(action === 'append' ? 2 : 1)
  expect({ focused: document.activeElement === focused, key: key.value, value: value.value,
    selection: [focused.selectionStart, focused.selectionEnd] }).toMatchSnapshot()
})

it.each(['streamable-http', 'stdio'] as const)('shows retained private values only for the saved %s target and matching keys', async (kind) => {
  const source = ConnectorDraftSchema.parse({ ...draft, transport: kind,
    ...(kind === 'stdio' ? { url: undefined, command: 'node', arguments: ['server.js'], environment: { API_KEY: '' } }
      : { headers: { Authorization: '' } }) })
  const api = transport(async method => method === 'extensions.connector.read' ? { ...loaded, draft: source } : [])
  const props = { editing, onClose: vi.fn(), onSaved: vi.fn(), t: locale.bind(NS) }
  const view = render(<ConnectorEditor {...props} />)
  const key = await screen.findByLabelText<HTMLInputElement>(`${zh.configurationKey} 1`)
  const value = screen.getByLabelText<HTMLInputElement>(`${zh.configurationValue} 1`)
  const hints = [value.placeholder]
  expect(value.placeholder).toBe(zh.privateValueRetained)
  fireEvent.change(key, { target: { value: kind === 'stdio' ? 'api_key' : ' authorization ' } })
  hints.push(value.placeholder)
  expect(value.placeholder).toBe(kind === 'stdio' ? zh.configurationValue : zh.privateValueRetained)
  fireEvent.change(key, { target: { value: kind === 'stdio' ? ' API_KEY ' : 'Authorization' } })
  const target = screen.getByLabelText<HTMLInputElement | HTMLTextAreaElement>(kind === 'stdio' ? zh.mcpCommand : zh.connectorEndpoint)
  fireEvent.change(target, { target: { value: kind === 'stdio' ? "node  'server.js'" : source.url } })
  expect(value.placeholder).toBe(zh.privateValueRetained)
  fireEvent.change(target, { target: { value: kind === 'stdio' ? 'node other.js' : 'https://other.example.test' } })
  hints.push(value.placeholder)
  expect(value.placeholder).toBe(zh.configurationValue)
  expect(hints).toMatchSnapshot()
  locale.setLocale('en')
  view.rerender(<ConnectorEditor {...props} />)
  expect(value.placeholder).toBe(en.configurationValue)
  expect(value.value).toBe('')
  expect(api.invoke).toHaveBeenCalledTimes(2)
})

it('does not offer to retain masked private fields without a saved device configuration', async () => {
  transport(async method => method === 'extensions.connector.read'
    ? { ...loaded, configured: false, draft: { ...draft, headers: { Authorization: '' } } } : [])
  render(<ConnectorEditor editing={editing} onClose={vi.fn()} onSaved={vi.fn()} t={locale.bind(NS)} />)
  const value = await screen.findByLabelText<HTMLInputElement>(`${zh.configurationValue} 1`)
  expect(value.placeholder).toBe(zh.configurationValue)
  expect(value.placeholder).toMatchSnapshot()
})

it('keeps private-value retention tied to the saved device target after importing MCP JSON', async () => {
  transport(async method => method === 'extensions.connector.read'
    ? { ...loaded, draft: { ...draft, headers: { Authorization: '' } } } : [])
  render(<ConnectorEditor editing={editing} onClose={vi.fn()} onSaved={vi.fn()} t={locale.bind(NS)} />)
  await screen.findByLabelText(zh.mcpServerName)
  fireEvent.click(screen.getByRole('tab', { name: zh.jsonConfiguration }))
  fireEvent.change(screen.getByLabelText(zh.mcpJsonConfiguration), { target: { value: JSON.stringify({
    url: 'https://other.example.test', headers: { authorization: '', 'X-New': '' },
  }) } })
  fireEvent.click(screen.getByRole('button', { name: zh.applyConfiguration }))
  const saved = screen.getByLabelText<HTMLInputElement>(`${zh.configurationValue} 1`)
  const added = screen.getByLabelText<HTMLInputElement>(`${zh.configurationValue} 2`)
  expect(saved.placeholder).toBe(zh.configurationValue)
  expect(added.placeholder).toBe(zh.configurationValue)
  fireEvent.change(screen.getByLabelText(zh.connectorEndpoint), { target: { value: draft.url } })
  expect(saved.placeholder).toBe(zh.privateValueRetained)
  expect(added.placeholder).toBe(zh.configurationValue)
})

it.each(['invalid-name', 'case-collision'] as const)('keeps private input and blocks discovery for HTTP header %s', async (kind) => {
  const api = transport(async () => [])
  const onSaved = vi.fn()
  const props = { onClose: vi.fn(), onSaved, t: locale.bind(NS) }
  const view = render(<ConnectorEditor {...props} />)
  await act(async () => {})
  fireEvent.change(screen.getByLabelText(zh.mcpServerType), { target: { value: 'streamable-http' } })
  fireEvent.change(screen.getByLabelText(zh.mcpServerName), { target: { value: 'Read orders' } })
  fireEvent.change(screen.getByLabelText(zh.connectorEndpoint), { target: { value: 'https://mcp.example.test' } })
  const keys = kind === 'invalid-name' ? ['Invalid Header'] : ['Authorization', 'authorization']
  for (const [index, key] of keys.entries()) {
    fireEvent.click(screen.getByRole('button', { name: zh.addConfigurationEntry }))
    fireEvent.change(screen.getByLabelText(`${zh.configurationKey} ${index + 1}`), { target: { value: key } })
    fireEvent.change(screen.getByLabelText(`${zh.configurationValue} ${index + 1}`), { target: { value: 'retained-private-value' } })
  }
  fireEvent.click(screen.getByRole('button', { name: zh.addMcp }))
  expect(screen.getByRole('alert').textContent).toBe(zh.connectorHeadersInvalid)
  expect(screen.getByRole('button', { name: zh.addMcp }).parentElement?.contains(screen.getByRole('alert'))).toBe(true)
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
  locale.setLocale('en')
  view.rerender(<ConnectorEditor {...props} />)
  expect(screen.getByRole('alert').textContent).toBe(en.connectorHeadersInvalid)
  locale.setLocale('zh')
  view.rerender(<ConnectorEditor {...props} />)
  expect(screen.getByLabelText<HTMLInputElement>(`${zh.configurationValue} 1`).value).toBe('retained-private-value')
  expect(api.invoke.mock.calls.map(call => call[1])).toEqual(['connectors.list'])
  expect(onSaved).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText(`${zh.configurationKey} 1`), { target: { value: 'X-Token' } })
  fireEvent.click(screen.getByRole('button', { name: zh.addMcp }))
  await act(async () => {})
  expect(api.invoke.mock.calls.map(call => call[1])).toContain('extensions.save')
})

it('updates connector validation feedback after a language change while keeping the draft', async () => {
  const api = transport(async () => [])
  const props = { onClose: vi.fn(), onSaved: vi.fn(), t: locale.bind(NS) }
  const view = render(<ConnectorEditor {...props} />)
  fireEvent.change(screen.getByLabelText(zh.mcpServerName), { target: { value: 'Retained draft' } })
  fireEvent.click(screen.getByRole('button', { name: zh.addMcp }))
  expect(screen.getByRole('alert').textContent).toBe(zh.connectorCommandInvalid)
  locale.setLocale('en')
  view.rerender(<ConnectorEditor {...props} />)
  expect(screen.getByRole('alert').textContent).toBe(en.connectorCommandInvalid)
  expect(screen.getByLabelText<HTMLInputElement>(en.mcpServerName).value).toBe('Retained draft')
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
  await act(async () => {})
  expect(api.invoke).toHaveBeenCalledTimes(1)
})

it('updates an unconfirmed connector save notice without reloading the editing version', async () => {
  const api = transport(async method => method === 'extensions.connector.read' ? { ...loaded, savePending: true } : [])
  const props = { editing, onClose: vi.fn(), onSaved: vi.fn(), t: locale.bind(NS) }
  const view = render(<ConnectorEditor {...props} />)
  expect((await screen.findByRole('alert')).textContent).toBe(zh.connectorSavePending)
  locale.setLocale('en')
  view.rerender(<ConnectorEditor {...props} />)
  expect(screen.getByRole('alert').textContent).toBe(en.connectorSavePending)
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
  expect(api.invoke).toHaveBeenCalledTimes(2)
  expect(screen.getByLabelText<HTMLInputElement>(en.mcpServerName).value).toBe(draft.name)
})

it.each(['read', 'save'] as const)('updates connector editing %s failures without repeating the operation', async (phase) => {
  const pending = Promise.withResolvers<unknown>()
  const retryResponse = Promise.withResolvers<undefined>()
  let fail = true
  const method = phase === 'read' ? 'extensions.connector.read' : 'extensions.connector.update'
  const api = transport(async (name) => {
    if (name === method) { if (fail) return pending.promise; await retryResponse.promise }
    return name === 'extensions.connector.read' ? loaded
      : name === 'extensions.connector.update' ? { kind: 'connector', id: draft.id, version: draft.version, visibility: 'PERSONAL' } : []
  })
  const props = { editing, onClose: vi.fn(), onSaved: vi.fn(), t: locale.bind(NS) }
  const view = render(<ConnectorEditor {...props} />)
  onTestFinished(() => { view.unmount(); retryResponse.resolve(undefined); pending.resolve(undefined) })
  if (phase === 'save') {
    fireEvent.change(await screen.findByLabelText(zh.mcpServerName), { target: { value: 'Retained edit' } })
    fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
  }
  locale.setLocale('en')
  view.rerender(<ConnectorEditor {...props} />)
  await act(async () => { pending.reject(new ProductError('CONNECTOR_STARTUP_FAILED', 'Private diagnostics', false)) })
  expect((await screen.findByRole('alert')).textContent).toBe(`${en.connectorRuntimeUnavailable} (CONNECTOR_STARTUP_FAILED)`)
  locale.setLocale('zh')
  view.rerender(<ConnectorEditor {...props} />)
  expect(screen.getByRole('alert').textContent).toBe(`${zh.connectorRuntimeUnavailable} (CONNECTOR_STARTUP_FAILED)`)
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
  expect(api.invoke.mock.calls.filter(call => call[1] === method)).toHaveLength(1)
  expect(api.cancel).not.toHaveBeenCalled()
  fail = false
  const notice = screen.getByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: phase === 'read' ? zh.retry : zh.saveConnector })
  retry.focus()
  act(() => { retry.click(); retry.click(); if (phase === 'save') fireEvent.keyDown(retry, { key: 'Escape' }) })
  expect(screen.getByRole('alert')).toBe(notice)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(api.invoke.mock.calls.filter(call => call[1] === method)).toHaveLength(2)
  await act(async () => { retryResponse.resolve(undefined) })
  expect(screen.queryByRole('alert')).toBeNull()
  if (phase === 'save') {
    const attempts = api.invoke.mock.calls.filter(call => call[1] === method)
    expect(attempts[1]?.[2]).toEqual(attempts[0]?.[2])
    expect(props.onSaved).toHaveBeenCalledOnce()
  } else expect(screen.getByLabelText<HTMLInputElement>(zh.mcpServerName).value).toBe(draft.name)
})

it.each(['read', 'save'] as const)('updates device configuration %s failures without clearing private input', async (phase) => {
  const pending = Promise.withResolvers<unknown>()
  const retryResponse = Promise.withResolvers<undefined>()
  let fail = true
  const method = `extensions.connector.configuration.${phase}`
  const api = transport(async (name) => {
    if (name === method) { if (fail) return pending.promise; await retryResponse.promise }
    return name.endsWith('.read') ? configuration : { ...editing, configured: true }
  })
  const props = { product, onCatalogChanged: vi.fn(async () => {}), t: locale.bind(NS) }
  const view = render(<ConnectorDetail {...props} />)
  onTestFinished(() => { view.unmount(); retryResponse.resolve(undefined); pending.resolve(undefined) })
  fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
  if (phase === 'save') {
    fireEvent.change(await screen.findByLabelText('Authorization'), { target: { value: 'device-only-value' } })
    fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
  }
  locale.setLocale('en')
  view.rerender(<ConnectorDetail {...props} />)
  await act(async () => { pending.reject(new ProductError('CONNECTOR_STARTUP_FAILED', 'Private diagnostics', false)) })
  expect((await screen.findByRole('alert')).textContent).toBe(`${en.connectorRuntimeUnavailable} (CONNECTOR_STARTUP_FAILED)`)
  locale.setLocale('zh')
  view.rerender(<ConnectorDetail {...props} />)
  expect(screen.getByRole('alert').textContent).toBe(`${zh.connectorRuntimeUnavailable} (CONNECTOR_STARTUP_FAILED)`)
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
  expect(api.invoke).toHaveBeenCalledTimes(phase === 'read' ? 1 : 2)
  expect(api.cancel).not.toHaveBeenCalled()
  if (phase === 'save') expect(screen.getByLabelText<HTMLInputElement>('Authorization').value).toBe('device-only-value')
  expect(screen.getByRole('button', { name: zh.saveConnector }).parentElement?.contains(screen.getByRole('alert'))).toBe(true)
  fail = false
  const notice = screen.getByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: phase === 'read' ? zh.retry : zh.saveConnector })
  retry.focus()
  act(() => { retry.click(); retry.click(); if (phase === 'save') fireEvent.keyDown(retry, { key: 'Escape' }) })
  expect(screen.getByRole('alert')).toBe(notice)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(api.invoke.mock.calls.filter(call => call[1] === method)).toHaveLength(2)
  await act(async () => { retryResponse.resolve(undefined) })
  expect(screen.queryByRole('alert')).toBeNull()
  if (phase === 'save') {
    const attempts = api.invoke.mock.calls.filter(call => call[1] === method)
    expect(attempts[1]?.[2]).toEqual(attempts[0]?.[2])
    expect(props.onCatalogChanged).toHaveBeenCalledOnce()
  } else expect(screen.getByLabelText<HTMLInputElement>('Authorization').value).toBe('')
})

it.each(['headers', 'environment'] as const)('blocks invalid device %s locally and retains values for correction', async (kind) => {
  const key = kind === 'headers' ? 'Authorization' : 'TOKEN'
  const template = kind === 'headers' ? configuration : { ...configuration, transport: 'stdio', url: undefined,
    command: 'npx', headers: [], environment: [key] }
  const api = transport(async method => method.endsWith('.read') ? template : { ...editing, configured: true })
  const props = { product, onCatalogChanged: vi.fn(async () => {}), t: locale.bind(NS) }
  const view = render(<ConnectorDetail {...props} />)
  fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
  const value = kind === 'headers' ? '中文令牌' : 'invalid\0value'
  fireEvent.change(await screen.findByLabelText(key), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
  const message = kind === 'headers' ? 'connectorHeadersInvalid' : 'connectorEnvironmentInvalid'
  expect(screen.getByRole('alert').textContent).toBe(zh[message])
  expect(screen.getByRole('button', { name: zh.saveConnector }).parentElement?.contains(screen.getByRole('alert'))).toBe(true)
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
  expect(screen.getByLabelText<HTMLInputElement>(key).value).toBe(value)
  expect(api.invoke.mock.calls.map(call => call[1])).toEqual(['extensions.connector.configuration.read'])
  locale.setLocale('en')
  view.rerender(<ConnectorDetail {...props} />)
  expect(screen.getByRole('alert').textContent).toBe(en[message])
  fireEvent.change(screen.getByLabelText(key), { target: { value: 'corrected-value' } })
  fireEvent.click(screen.getByRole('button', { name: en.saveConnector }))
  await act(async () => {})
  expect(api.invoke.mock.calls.map(call => call[1])).toEqual(['extensions.connector.configuration.read', 'extensions.connector.configuration.save'])
  expect(props.onCatalogChanged).toHaveBeenCalledOnce()
})

it.each(['command', 'arguments'] as const)('keeps MCP JSON with an unusable %s out of connection discovery', async (field) => {
  const api = transport(async () => [])
  render(<ConnectorEditor onClose={vi.fn()} onSaved={vi.fn()} t={locale.bind(NS)} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('tab', { name: zh.jsonConfiguration }))
  const json = JSON.stringify({ command: field === 'command' ? 'npx\0invalid' : 'npx',
    args: field === 'arguments' ? ['invalid\0argument'] : [] })
  fireEvent.change(screen.getByLabelText(zh.mcpJsonConfiguration), { target: { value: json } })
  fireEvent.click(screen.getByRole('button', { name: zh.applyConfiguration }))
  expect(screen.getByRole('alert').textContent).toBe(zh.connectorJsonInvalid)
  expect(screen.getByRole('alert').textContent).toMatchSnapshot()
  expect(screen.getByLabelText<HTMLTextAreaElement>(zh.mcpJsonConfiguration).value).toBe(json)
  expect(api.invoke.mock.calls.map(call => call[1])).toEqual(['connectors.list'])
})
