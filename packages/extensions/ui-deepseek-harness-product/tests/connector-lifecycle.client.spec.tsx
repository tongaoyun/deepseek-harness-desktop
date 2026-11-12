// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConnectorDraftSchema } from '@deepseek-harness/product/connector-draft'
import { ConnectorEditor } from '../src/client/ConnectorEditor.tsx'
import { ConnectorDetail, ConnectorDetailModal } from '../src/client/ConnectorView.tsx'
import { items, localDetail } from '../src/client/catalog-shared.tsx'
import { zh } from '../src/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const t = (key: keyof typeof zh) => zh[key]
const draft = ConnectorDraftSchema.parse({ kind: 'connector', id: 'personal-mcp', version: '1.0.1', name: 'MCP',
  summary: 'Tools', category: 'other', transport: 'streamable-http', url: 'https://mcp.example.test' })
const editing = { id: draft.id, version: '1.0.0' }
const product = localDetail(items([{ ...editing, name: 'Shared MCP', authMode: 'none', canConfigure: true,
  status: 'needs-configuration', visibility: 'COMPANY', tools: [] }])[0]!)
const template = { ...editing, transport: 'streamable-http', url: 'https://mcp.example.test', arguments: [],
  headers: ['Authorization'], environment: [], configured: false, timeoutSeconds: 60 }
const receipt = { kind: 'connector', id: draft.id, version: draft.version, visibility: 'PERSONAL' }
const loaded = { draft, configured: true, savePending: false }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

it.each(['transport', 'catalog'] as const)('retries failed OAuth provider %s reads without losing connector input', async (failure) => {
  let reads = 0
  const provider = { id: 'company-oauth', version: '1.0.0', name: 'Company OAuth', authMode: 'oauth',
    visibility: 'COMPANY', reviewStatus: 'PUBLISHED', tools: [] }
  const invoke = vi.fn(async (_namespace: string, method: string) => {
    expect(method).toBe('connectors.list')
    if (++reads === 1) {
      if (failure === 'transport') throw new Error('Provider request unavailable')
      return { ok: true, result: {} }
    }
    return { ok: true, result: [provider] }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  render(<ConnectorEditor onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
  fireEvent.change(screen.getByLabelText(zh.mcpServerType), { target: { value: 'streamable-http' } })
  fireEvent.change(screen.getByLabelText(zh.mcpServerName), { target: { value: 'My HTTP connector' } })
  fireEvent.change(screen.getByLabelText(zh.connectorEndpoint), { target: { value: 'https://my-mcp.example.test' } })
  fireEvent.click(screen.getByRole('button', { name: zh.addConfigurationEntry }))
  fireEvent.change(screen.getByLabelText(`${zh.configurationKey} 1`), { target: { value: 'Authorization' } })
  fireEvent.change(screen.getByLabelText(`${zh.configurationValue} 1`), { target: { value: 'retained-private-value' } })
  fireEvent.change(screen.getByLabelText(zh.connectorTimeout), { target: { value: '120' } })
  await screen.findByRole('alert')
  expect(screen.queryByLabelText(zh.authentication)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  const authentication = await screen.findByLabelText<HTMLSelectElement>(zh.authentication)
  expect(authentication.options[1]?.text).toBe('Company OAuth · OAuth')
  expect(screen.getByLabelText<HTMLInputElement>(zh.mcpServerName).value).toBe('My HTTP connector')
  expect(screen.getByLabelText<HTMLInputElement>(zh.connectorEndpoint).value).toBe('https://my-mcp.example.test')
  expect(screen.getByLabelText<HTMLInputElement>(`${zh.configurationValue} 1`).value).toBe('retained-private-value')
  expect(screen.getByLabelText<HTMLInputElement>(zh.connectorTimeout).value).toBe('120')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(reads).toBe(2)
})

it('cancels an OAuth provider retry when the editor closes', async () => {
  const pending = deferred<unknown>()
  let reads = 0
  const invoke = vi.fn(async (_namespace: string, _method: string, _payload: unknown, _request: string) => {
    if (++reads === 1) throw new Error('Provider request unavailable')
    return { ok: true, result: await pending.promise }
  })
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  const view = render(<ConnectorEditor onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
  fireEvent.change(screen.getByLabelText(zh.mcpServerType), { target: { value: 'streamable-http' } })
  await screen.findByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.retry })
  retry.focus()
  fireEvent.click(retry)
  expect(reads).toBe(2)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  view.unmount()
  expect(cancel).toHaveBeenCalledWith('product', invoke.mock.calls[1]?.[3])
  await act(async () => { pending.resolve([]) })
})

it.each(['header', 'escape', 'mask'] as const)('asks before discarding connector edits through %s', async (action) => {
  vi.stubGlobal('dshDesktop', { extensions: { invoke: vi.fn(async () => ({ ok: true, result: [] })), cancel: vi.fn() } })
  const onClose = vi.fn()
  render(<ConnectorEditor onClose={onClose} onSaved={vi.fn()} t={t} />)
  const name = screen.getByLabelText<HTMLInputElement>(zh.mcpServerName)
  fireEvent.change(name, { target: { value: 'Unsaved connector' } })
  name.focus()
  name.setSelectionRange(2, 8)
  closeDialog(action)
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByText(zh.knowledgeDiscardDraftConfirmation)).toBeTruthy()
  const keep = screen.getByRole('button', { name: zh.knowledgeKeepEditing })
  expect(document.activeElement).toBe(keep)
  expect(screen.queryByRole('textbox', { name: zh.mcpServerName })).toBeNull()
  expect(name.isConnected).toBe(true)
  fireEvent.click(keep)
  expect(screen.getByLabelText(zh.mcpServerName)).toBe(name)
  expect(name.value).toBe('Unsaved connector')
  expect(document.activeElement).toBe(name)
  expect([name.selectionStart, name.selectionEnd]).toEqual([2, 8])
  expect({ focused: document.activeElement === name, selection: [name.selectionStart, name.selectionEnd] }).toMatchSnapshot('Retained connector edit')
  closeDialog(action)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeDiscardDraft }))
  expect(onClose).toHaveBeenCalledOnce()
})

it('returns to the same private device field and selection after cancelling discard', async () => {
  const invoke = vi.fn(async () => ({ ok: true, result: template }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  render(<ConnectorDetail product={product} onCatalogChanged={vi.fn(async () => {})} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
  const field = await screen.findByLabelText<HTMLInputElement>('Authorization')
  fireEvent.change(field, { target: { value: 'private-test-value' } })
  field.focus()
  field.setSelectionRange(2, 7)
  closeDialog('escape')
  const keep = screen.getByRole('button', { name: zh.knowledgeKeepEditing })
  expect(document.activeElement).toBe(keep)
  expect(field.isConnected).toBe(true)
  expect(field.closest('[hidden]')).not.toBeNull()
  fireEvent.click(keep)
  expect(screen.getByLabelText('Authorization')).toBe(field)
  expect(document.activeElement).toBe(field)
  expect([field.selectionStart, field.selectionEnd]).toEqual([2, 7])
  expect(invoke).toHaveBeenCalledOnce()
})

it('protects unapplied MCP JSON and browser reload without treating a loaded connector as dirty', async () => {
  vi.stubGlobal('dshDesktop', { extensions: { invoke: vi.fn(async (_namespace: string, method: string) => ({ ok: true,
    result: method === 'extensions.connector.read' ? loaded : [] })), cancel: vi.fn() } })
  const onClose = vi.fn()
  render(<ConnectorEditor editing={editing} onClose={onClose} onSaved={vi.fn()} t={t} />)
  await screen.findByLabelText(zh.mcpServerName)
  const unchanged = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unchanged)
  expect(unchanged.defaultPrevented).toBe(false)
  closeDialog('header')
  expect(onClose).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('tab', { name: zh.jsonConfiguration }))
  fireEvent.change(screen.getByLabelText(zh.mcpJsonConfiguration), { target: { value: '{"mcpServers":' } })
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
  closeDialog('header')
  expect(onClose).toHaveBeenCalledOnce()
  expect(screen.getByText(zh.knowledgeDiscardDraftConfirmation)).toBeTruthy()
})

it('does not let a delayed clipboard read overwrite newer private configuration', async () => {
  const clipboard = deferred<string>()
  vi.stubGlobal('navigator', { clipboard: { readText: () => clipboard.promise } })
  vi.stubGlobal('dshDesktop', { extensions: { invoke: vi.fn(async () => ({ ok: true, result: [] })), cancel: vi.fn() } })
  render(<ConnectorEditor onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.pasteConfiguration }))
  fireEvent.change(screen.getByLabelText(`${zh.configurationKey} 1`), { target: { value: 'NEW_KEY' } })
  fireEvent.change(screen.getByLabelText(`${zh.configurationValue} 1`), { target: { value: 'new-value' } })
  await act(async () => { clipboard.resolve('OLD_KEY=old-value') })
  expect(screen.getByLabelText<HTMLInputElement>(`${zh.configurationKey} 1`).value).toBe('NEW_KEY')
  expect(screen.getByLabelText<HTMLInputElement>(`${zh.configurationValue} 1`).value).toBe('new-value')
})

it('uses the latest clipboard request when reads complete out of order', async () => {
  const first = deferred<string>(), second = deferred<string>()
  const readText = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  vi.stubGlobal('navigator', { clipboard: { readText } })
  vi.stubGlobal('dshDesktop', { extensions: { invoke: vi.fn(async () => ({ ok: true, result: [] })), cancel: vi.fn() } })
  render(<ConnectorEditor onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.pasteConfiguration }))
  fireEvent.click(screen.getByRole('button', { name: zh.pasteConfiguration }))
  await act(async () => { second.resolve('LATEST=value') })
  await act(async () => { first.resolve('OLD=value') })
  expect(screen.getByLabelText<HTMLInputElement>(`${zh.configurationKey} 1`).value).toBe('LATEST')
})

it.each(['stdio', 'streamable-http'] as const)('preserves remaining %s inputs when an earlier configuration row is removed', async (transport) => {
  const invoke = vi.fn(async () => ({ ok: true, result: [] }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  render(<ConnectorEditor onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
  if (transport === 'streamable-http') {
    fireEvent.change(screen.getByLabelText(zh.mcpServerType), { target: { value: transport } })
    fireEvent.click(screen.getByRole('button', { name: zh.addConfigurationEntry }))
  }
  fireEvent.click(screen.getByRole('button', { name: transport === 'stdio' ? zh.addVariable : zh.addConfigurationEntry }))
  fireEvent.change(screen.getByLabelText(`${zh.configurationKey} 1`), { target: { value: 'FIRST_KEY' } })
  fireEvent.change(screen.getByLabelText(`${zh.configurationKey} 2`), { target: { value: 'SECOND_KEY' } })
  const remaining = screen.getByLabelText<HTMLInputElement>(`${zh.configurationValue} 2`)
  fireEvent.change(remaining, { target: { value: 'retained-private-value' } })
  remaining.focus()
  remaining.setSelectionRange(2, 6)
  fireEvent.click(screen.getByRole('button', { name: `${zh.remove} 1` }))
  expect(screen.getByLabelText(`${zh.configurationValue} 1`)).toBe(remaining)
  expect(document.activeElement).toBe(remaining)
  expect([remaining.selectionStart, remaining.selectionEnd]).toEqual([2, 6])
  expect(screen.getByLabelText<HTMLInputElement>(`${zh.configurationKey} 1`).value).toBe('SECOND_KEY')
  expect(remaining.value).toBe('retained-private-value')
  await act(async () => {})
  expect(invoke).toHaveBeenCalledTimes(1)
})

it('closes without a discard prompt after replacing an empty configuration row', async () => {
  vi.stubGlobal('dshDesktop', { extensions: { invoke: vi.fn(async () => ({ ok: true, result: [] })), cancel: vi.fn() } })
  const onClose = vi.fn()
  render(<ConnectorEditor onClose={onClose} onSaved={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.addVariable }))
  fireEvent.click(screen.getByRole('button', { name: `${zh.remove} 1` }))
  closeDialog('header')
  expect(onClose).toHaveBeenCalledOnce()
  expect(screen.queryByText(zh.knowledgeDiscardDraftConfirmation)).toBeNull()
  await act(async () => {})
})

it.each(['header', 'escape', 'mask'] as const)('protects device secrets before %s dismissal and retains them when editing continues', async (action) => {
  vi.stubGlobal('dshDesktop', { extensions: { invoke: vi.fn(async () => ({ ok: true, result: template })), cancel: vi.fn() } })
  render(<ConnectorDetail product={product} onCatalogChanged={async () => {}} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
  fireEvent.change(await screen.findByLabelText('Authorization'), { target: { value: 'unsaved-secret' } })
  closeDialog(action)
  expect(screen.getByRole('dialog', { name: zh.configureDevice })).toBeTruthy()
  expect(screen.getByText(zh.knowledgeDiscardDraftConfirmation)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeKeepEditing }))
  expect(screen.getByLabelText<HTMLInputElement>('Authorization').value).toBe('unsaved-secret')
  closeDialog(action)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeDiscardDraft }))
  expect(screen.queryByRole('dialog', { name: zh.configureDevice })).toBeNull()
})

it.each([undefined, {}, { ...receipt, id: 'another-mcp' }, { ...receipt, version: '1.0.0' },
  { ...receipt, kind: 'skill' }, { ...receipt, visibility: 'COMPANY' }])(
  'retains personal connector edits after an unconfirmed receipt and accepts a valid retry: %j', async (invalid) => {
    let valid = false
    const invoke = vi.fn(async (_namespace: string, method: string) => ({ ok: true,
      result: method === 'extensions.connector.read' ? loaded : method === 'extensions.connector.update' ? valid ? receipt : invalid : [] }))
    vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
    const onSaved = vi.fn()
    render(<ConnectorEditor editing={editing} onClose={vi.fn()} onSaved={onSaved} t={t} />)
    fireEvent.change(await screen.findByLabelText(zh.mcpServerName), { target: { value: 'Retained edit' } })
    fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
    await screen.findByRole('alert')
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByLabelText<HTMLInputElement>(zh.mcpServerName).value).toBe('Retained edit')
    valid = true
    fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
    await act(async () => {})
    expect(onSaved).toHaveBeenCalledOnce()
  },
)

it.each(['header', 'escape', 'mask'] as const)('keeps personal connector editing open on %s close while saving', async (action) => {
  const pending = deferred<unknown>()
  const invoke = vi.fn(async (_namespace: string, method: string) => ({ ok: true,
    result: method === 'extensions.connector.read' ? loaded : method === 'extensions.connector.update' ? await pending.promise : [] }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const onClose = vi.fn()
  render(<ConnectorEditor editing={editing} onClose={onClose} onSaved={vi.fn()} t={t} />)
  await screen.findByLabelText(zh.mcpServerName)
  fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
  try {
    closeDialog(action)
    expect(onClose).not.toHaveBeenCalled()
  } finally { await act(async () => { pending.resolve(receipt) }) }
})

it.each([undefined, {}, { ...loaded, draft: { ...draft, id: 'another-mcp' } },
  { ...loaded, draft: { ...draft, kind: 'skill' } }, { ...loaded, configured: 'true' }, { ...loaded, savePending: 'false' }])(
  'rejects malformed or unrelated connector editing data: %j', async (invalid) => {
    const invoke = vi.fn(async (_namespace: string, method: string) => ({ ok: true,
      result: method === 'extensions.connector.read' ? invalid : [] }))
    vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
    render(<ConnectorEditor editing={editing} onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
    await screen.findByRole('alert')
    expect(screen.queryByLabelText(zh.mcpServerName)).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.saveConnector }).disabled).toBe(true)
  },
)

it('keeps a new connector identity and private input after an invalid receipt until retry is confirmed', async () => {
  let valid = false
  const invoke = vi.fn(async (_namespace: string, method: string, payload?: unknown) => {
    const value = method === 'extensions.save' ? ConnectorDraftSchema.parse(payload) : undefined
    return { ok: true, result: value ? valid
      ? { ...receipt, id: value.id, version: value.version } : { ...receipt, id: 'another-mcp' } : [] }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const onSaved = vi.fn()
  render(<ConnectorEditor onClose={vi.fn()} onSaved={onSaved} t={t} />)
  fireEvent.change(screen.getByLabelText(zh.mcpServerName), { target: { value: 'My connector' } })
  fireEvent.change(screen.getByLabelText(zh.connectorSummary), { target: { value: '  查询订单和库存  ' } })
  fireEvent.change(screen.getByLabelText(zh.mcpCommand), { target: { value: 'node server.js' } })
  fireEvent.change(screen.getByLabelText(zh.connectorCategory), { target: { value: 'ecommerce-platforms' } })
  fireEvent.change(screen.getByLabelText(`${zh.configurationKey} 1`), { target: { value: 'API_KEY' } })
  fireEvent.change(screen.getByLabelText('值 1'), { target: { value: 'device-only-value' } })
  fireEvent.click(screen.getByRole('button', { name: zh.addMcp }))
  await screen.findByRole('alert')
  expect(onSaved).not.toHaveBeenCalled()
  expect(screen.getByLabelText<HTMLInputElement>('值 1').value).toBe('device-only-value')
  const firstSave = invoke.mock.calls.find(call => call[1] === 'extensions.save')?.[2]
  expect(ConnectorDraftSchema.parse(firstSave).category).toBe('ecommerce-platforms')
  expect(ConnectorDraftSchema.parse(firstSave).summary).toBe('查询订单和库存')
  expect(screen.getByLabelText<HTMLTextAreaElement>(zh.connectorSummary).value).toBe('  查询订单和库存  ')
  valid = true
  fireEvent.click(screen.getByRole('button', { name: zh.addMcp }))
  await act(async () => {})
  expect(onSaved).toHaveBeenCalledOnce()
  expect(invoke.mock.calls.filter(call => call[1] === 'extensions.save').at(-1)?.[2]).toEqual(firstSave)
})

it.each([
  { name: 'multiline script', command: 'python', arguments: ['-c', 'print("中文")\nprint("literal $VALUE")', ''] },
  { name: 'CRLF script', command: 'python', arguments: ['-c', 'print("first")\r\nprint("second")'] },
  { name: 'executable path containing equals', command: 'C:\\Tools\\release=dev\\mcp.exe', arguments: ['--literal', '$VALUE'] },
  { name: 'long argument list', command: 'node', arguments: Array.from({ length: 30 }, () => 'x'.repeat(1000)) },
].flatMap(value => (['create', 'edit'] as const).map(mode => ({ ...value, mode }))))(
  'preserves an unedited $name when saving a $mode connector', async ({ command, arguments: args, mode }) => {
    const source = ConnectorDraftSchema.parse({ ...draft, name: 'Literal MCP', transport: 'stdio', command, arguments: args,
      url: undefined, environment: { TOKEN: '' } })
    let saved: unknown
    const invoke = vi.fn(async (_namespace: string, method: string, payload?: unknown) => {
      if (method === 'extensions.connector.read') return { ok: true, result: { ...loaded, draft: source } }
      if (method === 'extensions.save' || method === 'extensions.connector.update') {
        const value = ConnectorDraftSchema.parse(mode === 'create' ? payload : (payload as { draft: unknown }).draft)
        saved = value
        return { ok: true, result: { kind: 'connector', id: value.id, version: value.version, visibility: 'PERSONAL' } }
      }
      return { ok: true, result: [] }
    })
    vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
    const onSaved = vi.fn()
    render(<ConnectorEditor {...mode === 'edit' ? { editing } : {}} onClose={vi.fn()} onSaved={onSaved} t={t} />)
    if (mode === 'create') {
      await act(async () => {})
      fireEvent.click(screen.getByRole('tab', { name: zh.jsonConfiguration }))
      fireEvent.change(screen.getByLabelText(zh.mcpJsonConfiguration), { target: { value: JSON.stringify({
        mcpServers: { 'Literal MCP': { command, args, env: { TOKEN: '' } } },
      }) } })
      fireEvent.click(screen.getByRole('button', { name: zh.applyConfiguration }))
    }
    const name = await screen.findByLabelText(zh.mcpServerName)
    fireEvent.change(name, { target: { value: 'Renamed MCP' } })
    fireEvent.click(screen.getByRole('button', { name: mode === 'edit' ? zh.saveConnector : zh.addMcp }))
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
    expect(saved).toMatchObject({ name: 'Renamed MCP', command, arguments: args, environment: { TOKEN: '' } })
    expect(onSaved).toHaveBeenCalledOnce()
  },
)

it('validates changed commands and saves the corrected literal argv instead of the imported arguments', async () => {
  const source = ConnectorDraftSchema.parse({ ...draft, transport: 'stdio', url: undefined, command: 'python',
    arguments: ['-c', 'print("first")\nprint("second")'] })
  let saved: unknown
  const invoke = vi.fn(async (_namespace: string, method: string, payload?: unknown) => {
    if (method === 'extensions.connector.read') return { ok: true, result: { ...loaded, draft: source } }
    if (method === 'extensions.connector.update') {
      saved = payload
      return { ok: true, result: receipt }
    }
    return { ok: true, result: [] }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const onSaved = vi.fn()
  render(<ConnectorEditor editing={editing} onClose={vi.fn()} onSaved={onSaved} t={t} />)
  const command = await screen.findByLabelText<HTMLTextAreaElement>(zh.mcpCommand)
  for (const value of ['node | other-command', 'node $TOKEN', 'node "unclosed']) {
    fireEvent.change(command, { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
    expect(screen.getByRole('alert').textContent).toBe(zh.connectorCommandInvalid)
    expect(command.value).toBe(value)
    expect(saved).toBeUndefined()
    expect(onSaved).not.toHaveBeenCalled()
  }
  expect({ command: command.value, error: screen.getByRole('alert').textContent }).toMatchInlineSnapshot(`
    {
      "command": "node \"unclosed",
      "error": "请填写完整命令并检查引号。环境变量请在下方填写，命令不支持管道、重定向或变量展开。",
    }
  `)
  fireEvent.change(command, { target: { value: "node --flag 'literal $TOKEN' ''" } })
  fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  expect(saved).toMatchObject({ ...editing, draft: { command: 'node', arguments: ['--flag', 'literal $TOKEN', ''] } })
  expect(onSaved).toHaveBeenCalledOnce()
  expect(invoke.mock.calls.filter(call => call[1] === 'extensions.connector.update')).toHaveLength(1)
})

it('ignores an abandoned device configuration read after StrictMode reactivation', async () => {
  const first = deferred<unknown>()
  const current = deferred<unknown>()
  let reads = 0
  const invoke = vi.fn(async (_namespace: string, method: string, _payload?: unknown, _request?: string) => ({ ok: true,
    result: method === 'extensions.connector.configuration.read' ? await (++reads === 1 ? first.promise : current.promise) : [] }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  render(<StrictMode><ConnectorDetail product={product} onCatalogChanged={async () => {}} t={t} /></StrictMode>)
  fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
  expect(reads).toBe(2)
  await act(async () => { current.resolve(template) })
  fireEvent.change(screen.getByLabelText('Authorization'), { target: { value: 'retained-private-value' } })
  fireEvent.change(screen.getByLabelText(zh.connectorTimeout), { target: { value: '120' } })
  await act(async () => { first.resolve({ ...template, url: 'https://abandoned.example.test', timeoutSeconds: 10 }) })
  expect(screen.getByLabelText<HTMLInputElement>(zh.connectorTimeout).value).toBe('120')
  expect(screen.getByLabelText<HTMLInputElement>('Authorization').value).toBe('retained-private-value')
  expect(screen.getByDisplayValue<HTMLInputElement>('https://mcp.example.test').readOnly).toBe(true)
  expect(cancel).toHaveBeenCalledWith('product', invoke.mock.calls[0]![3])
})

it.each(['read', 'save'] as const)('cancels the old connector configuration %s when its published version changes', async (phase) => {
  const pending = deferred<unknown>()
  const nextProduct = { ...product, version: '2.0.0' }
  const invoke = vi.fn(async (_namespace: string, method: string, payload: unknown, _request?: string) => {
    const next = typeof payload === 'object' && payload !== null && 'version' in payload && payload.version === nextProduct.version
    return { ok: true, result: next ? { ...template, version: nextProduct.version }
      : method.endsWith('.read') && phase === 'save' ? template : await pending.promise }
  })
  const cancel = vi.fn(), onCatalogChanged = vi.fn(async () => {})
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  const props = { onClose: vi.fn(), onCatalogChanged, t }
  const view = render(<ConnectorDetailModal {...props} detail={product} />)
  fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
  if (phase === 'save') {
    fireEvent.change(await screen.findByLabelText('Authorization'), { target: { value: 'old-version-private-value' } })
    fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
  }
  const request = invoke.mock.calls.at(-1)![3]
  view.rerender(<ConnectorDetailModal {...props} detail={nextProduct} />)
  expect(screen.queryByRole('dialog', { name: zh.configureDevice })).toBeNull()
  expect(cancel).toHaveBeenCalledWith('product', request)
  fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
  expect((await screen.findByLabelText<HTMLInputElement>('Authorization')).value).toBe('')
  await act(async () => { pending.resolve(phase === 'read' ? template : { ...editing, configured: true }) })
  expect(screen.getByLabelText<HTMLInputElement>('Authorization').value).toBe('')
  expect(onCatalogChanged).not.toHaveBeenCalled()
  expect(invoke.mock.calls.at(-1)?.[2]).toEqual({ id: nextProduct.id, version: nextProduct.version })
})

it.each([undefined, {}, { id: draft.id, version: '2.0.0', configured: true },
  { id: 'another-mcp', version: editing.version, configured: true }, { ...editing, configured: false },
  { ...editing, configured: 'true' }])('retains device secrets after an unconfirmed save and accepts retry: %j', async (invalid) => {
  let valid = false
  const invoke = vi.fn(async (_namespace: string, method: string) => ({ ok: true,
    result: method === 'extensions.connector.configuration.read' ? template : valid ? { ...editing, configured: true } : invalid }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const onCatalogChanged = vi.fn(async () => {})
  render(<ConnectorDetail product={product} onCatalogChanged={onCatalogChanged} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
  fireEvent.change(await screen.findByLabelText('Authorization'), { target: { value: 'retained-private-value' } })
  fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
  await screen.findByRole('alert')
  expect(onCatalogChanged).not.toHaveBeenCalled()
  expect(screen.getByLabelText<HTMLInputElement>('Authorization').value).toBe('retained-private-value')
  valid = true
  fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
  await act(async () => {})
  expect(onCatalogChanged).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog', { name: zh.configureDevice })).toBeNull()
})

it.each([undefined, {}, { ...template, id: 'another-mcp' }, { ...template, version: '2.0.0' },
  { ...template, headers: [null] }, { ...template, arguments: null }, { ...template, transport: 'sse' },
  { ...template, timeoutSeconds: 0 }])('rejects malformed or unrelated device configuration and allows reload: %j', async (invalid) => {
  let valid = false
  const invoke = vi.fn(async () => ({ ok: true, result: valid ? template : invalid }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  render(<ConnectorDetail product={product} onCatalogChanged={async () => {}} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
  await screen.findByRole('alert')
  expect(screen.queryByLabelText('Authorization')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.saveConnector }).disabled).toBe(true)
  valid = true
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await screen.findByLabelText('Authorization')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.saveConnector }).disabled).toBe(false)
})

it.each([
  { mode: 'device', action: 'header' }, { mode: 'device', action: 'escape' }, { mode: 'device', action: 'mask' },
  { mode: 'create', action: 'header' }, { mode: 'create', action: 'escape' }, { mode: 'create', action: 'mask' },
] as const)('keeps $mode configuration open on $action close while saving and explains why', async ({ mode, action }) => {
  const pending = deferred<unknown>()
  let savingDraft = draft
  const invoke = vi.fn(async (_namespace: string, method: string, payload: unknown) => {
    if (method === 'extensions.save') savingDraft = ConnectorDraftSchema.parse(payload)
    return { ok: true, result: method === 'extensions.connector.configuration.read' ? template
      : method === 'connectors.list' ? [] : await pending.promise }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const onCatalogChanged = vi.fn(async () => {})
  render(mode === 'device' ? <ConnectorDetail product={product} onCatalogChanged={onCatalogChanged} t={t} />
    : <ConnectorEditor onClose={vi.fn()} onSaved={() => { void onCatalogChanged() }} t={t} />)
  if (mode === 'device') {
    fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
    fireEvent.change(await screen.findByLabelText('Authorization'), { target: { value: 'retained-private-value' } })
  } else {
    fireEvent.change(screen.getByLabelText(zh.mcpServerName), { target: { value: 'My connector' } })
    fireEvent.change(screen.getByLabelText(zh.mcpCommand), { target: { value: 'node server.js' } })
  }
  fireEvent.click(screen.getByRole('button', { name: mode === 'device' ? zh.saveConnector : zh.addMcp }))
  try {
    closeDialog(action)
    expect(screen.getByRole('dialog', { name: mode === 'device' ? zh.configureDevice : zh.addMcpServer })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(zh.knowledgeWaitForSave)
  } finally { await act(async () => { pending.resolve(mode === 'device' ? { ...editing, configured: true }
    : { ...receipt, id: savingDraft.id, version: savingDraft.version }) }) }
  expect(onCatalogChanged).toHaveBeenCalledOnce()
})

it.each(['create', 'device'] as const)('cancels %s save on unmount and ignores the late receipt', async (mode) => {
  const pending = deferred<unknown>()
  let savingDraft = draft
  const invoke = vi.fn(async (_namespace: string, method: string, payload: unknown, _request?: string) => {
    if (method === 'extensions.save') savingDraft = ConnectorDraftSchema.parse(payload)
    return { ok: true, result: method === 'extensions.connector.configuration.read' ? template
      : method === 'connectors.list' ? [] : await pending.promise }
  })
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  const onSaved = vi.fn()
  const view = render(mode === 'device' ? <ConnectorDetail product={product} onCatalogChanged={async () => { onSaved() }} t={t} />
    : <ConnectorEditor onClose={vi.fn()} onSaved={onSaved} t={t} />)
  if (mode === 'device') {
    fireEvent.click(screen.getByRole('button', { name: zh.configureDevice }))
    await screen.findByLabelText('Authorization')
  } else {
    fireEvent.change(screen.getByLabelText(zh.mcpServerName), { target: { value: 'My connector' } })
    fireEvent.change(screen.getByLabelText(zh.mcpCommand), { target: { value: 'node server.js' } })
  }
  fireEvent.click(screen.getByRole('button', { name: mode === 'device' ? zh.saveConnector : zh.addMcp }))
  view.unmount()
  expect(cancel).toHaveBeenCalledWith('product', invoke.mock.calls.at(-1)?.[3])
  await act(async () => { pending.resolve(mode === 'device' ? { ...editing, configured: true }
    : { ...receipt, id: savingDraft.id, version: savingDraft.version }) })
  expect(onSaved).not.toHaveBeenCalled()
})

function closeDialog(action: 'header' | 'escape' | 'mask'): void {
  if (action === 'header') fireEvent.click(screen.getByRole('button', { name: zh.close }))
  else if (action === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
  else fireEvent.click(document.querySelector('[role="presentation"] > [aria-hidden="true"]')!)
}
