// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionDraftSchema } from '@deepseek-harness/product/extension-draft'
import { ExtensionImporter } from '../src/client/ExtensionImporter.tsx'
import { ConnectorEditor } from '../src/client/ConnectorEditor.tsx'
import { ExtensionPreview } from '../src/client/ExtensionPreview.tsx'
import { ResourceActionsMenu } from '../src/client/ResourceActionsMenu.tsx'
import { items, localDetail } from '../src/client/catalog-shared.tsx'
import { connectorCommand, connectorCommandText, connectorConfigurations, connectorVariables } from '../src/client/connector-configuration.ts'
import { zh } from '../src/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const t = (key: keyof typeof zh): string => zh[key]
const close = () => undefined
const draft = ExtensionDraftSchema.parse({ kind: 'connector', id: 'personal-mcp', version: '1.0.0', name: 'MCP', summary: 'Tools',
  category: 'other', transport: 'streamable-http', url: 'https://mcp.example.test' })

it('uses the same ordered management menu for personal connectors and hides it for shared connectors', () => {
  const onEdit = vi.fn()
  const onDelete = vi.fn()
  const onSubmit = vi.fn()
  const product = localDetail(items([{ id: draft.id, name: draft.name, version: draft.version,
    visibility: 'PERSONAL', canEdit: true, canSubmit: true, canDelete: true }])[0]!)
  const view = render(<ResourceActionsMenu resource={product} onEdit={onEdit} onSubmit={onSubmit} onDelete={onDelete} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.resourceActions }))
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([zh.modifyResource, zh.submitShared, zh.deleteResource])
  fireEvent.click(screen.getByRole('menuitem', { name: zh.modifyResource }))
  expect(onEdit).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: zh.resourceActions }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.deleteResource }))
  expect(onDelete).toHaveBeenCalledOnce()
  view.rerender(<ResourceActionsMenu resource={{ ...product, canEdit: false, canSubmit: false, canDelete: false }}
    onEdit={onEdit} onSubmit={onSubmit} onDelete={onDelete} t={t} />)
  expect(screen.queryByRole('button', { name: zh.resourceActions })).toBeNull()
})

it('loads a personal connector for modification, preserves masked values, and keeps edits after a failed save', async () => {
  const invoke = vi.fn(async (_namespace: string, method: string) => {
    if (method === 'extensions.connector.read') return { ok: true, result: { draft: { ...draft, version: '1.0.1', headers: { TOKEN: '' } }, configured: true, savePending: false } }
    if (method === 'extensions.connector.update') throw new Error('offline')
    return { ok: true, result: [] }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  render(<ConnectorEditor editing={{ id: draft.id, version: '1.0.0' }} onClose={close} onSaved={close} t={t} />)
  await waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>(zh.mcpServerName).value).toBe('MCP') })
  expect(screen.getByPlaceholderText<HTMLInputElement>(zh.privateValueRetained).value).toBe('')
  fireEvent.change(screen.getByLabelText(zh.mcpServerName), { target: { value: 'Updated MCP' } })
  fireEvent.click(screen.getByRole('button', { name: zh.saveConnector }))
  await screen.findByRole('alert')
  expect(screen.getByLabelText<HTMLInputElement>(zh.mcpServerName).value).toBe('Updated MCP')
  expect(invoke).toHaveBeenCalledWith('product', 'extensions.connector.update', expect.objectContaining({
    id: draft.id, version: '1.0.0', draft: { ...draft, version: '1.0.1', name: 'Updated MCP', headers: { TOKEN: '' } },
  }), expect.any(String), 180_000)
})

it('keeps connector editing unavailable after a failed load and allows retry', async () => {
  let fail = true
  const invoke = vi.fn(async (_namespace: string, method: string) => {
    if (method !== 'extensions.connector.read') return { ok: true, result: [] }
    if (fail) throw new Error('offline')
    return { ok: true, result: { draft: { ...draft, version: '1.0.1' }, configured: true, savePending: false } }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  render(<ConnectorEditor editing={{ id: draft.id, version: '1.0.0' }} onClose={close} onSaved={close} t={t} />)
  expect(screen.queryByLabelText(zh.mcpServerName)).toBeNull()
  await screen.findByRole('alert')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.saveConnector }).disabled).toBe(true)
  fail = false
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await screen.findByLabelText(zh.mcpServerName)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.saveConnector }).disabled).toBe(false)
})

it('ignores an abandoned connector load after effect reactivation instead of overwriting edits', async () => {
  let finishFirst!: (value: unknown) => void
  let finishCurrent!: (value: unknown) => void
  let reads = 0
  const invoke = vi.fn(async (_namespace: string, method: string, _payload?: unknown, _requestId?: string) => {
    if (method !== 'extensions.connector.read') return { ok: true, result: [] }
    return new Promise((resolve) => { if (++reads === 1) finishFirst = resolve; else finishCurrent = resolve })
  })
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  render(<StrictMode><ConnectorEditor editing={{ id: draft.id, version: '1.0.0' }} onClose={close} onSaved={close} t={t} /></StrictMode>)
  expect(reads).toBe(2)
  await act(async () => { finishCurrent({ ok: true, result: { draft: { ...draft, version: '1.0.1' }, configured: true, savePending: false } }) })
  fireEvent.change(screen.getByLabelText(zh.mcpServerName), { target: { value: 'My retained edit' } })
  await act(async () => { finishFirst({ ok: true, result: { draft: { ...draft, name: 'Abandoned result', version: '1.0.1' }, configured: true, savePending: false } }) })
  expect(screen.getByLabelText<HTMLInputElement>(zh.mcpServerName).value).toBe('My retained edit')
  const firstRead = invoke.mock.calls.find(call => call[1] === 'extensions.connector.read')
  expect(cancel).toHaveBeenCalledWith('product', firstRead?.[3])
})

it.each([undefined, {}, { files: [{ path: 'SKILL.md', bytes: -1 }] }, { files: [null] }, { missingFields: [42] },
  { draft: { kind: 'connector' } }, { draft: { stageId: '00000000-0000-4000-8000-000000000002' } }])(
  'reports an invalid import response and releases its staging without opening a broken preview: %j', async (invalid) => {
    const stageId = '00000000-0000-4000-8000-000000000001'
    const result = invalid === undefined ? undefined : { stageId, draft: { kind: 'skill' }, missingFields: [], ...invalid }
    const inspected = vi.fn()
    const invoke = vi.fn(async (_namespace: string, method: string) => ({ ok: true, result: method === 'extensions.import.inspect' ? result : {} }))
    vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
    render(<ExtensionImporter kind="skill" onClose={close} onInspected={inspected} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh.choosePackageFile }))
    await screen.findByRole('alert')
    expect(inspected).not.toHaveBeenCalled()
    if (invalid !== undefined) expect(invoke).toHaveBeenCalledWith('product', 'extensions.import.release', { stageId }, expect.any(String))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.choosePackageFile }).disabled).toBe(false)
  },
)

it('allows cancelling file selection without reporting an import failure', async () => {
  const invoke = vi.fn(async () => ({ ok: true, result: { cancelled: true } }))
  const inspected = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  render(<ExtensionImporter kind="skill" onClose={close} onInspected={inspected} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.choosePackageFile }))
  await waitFor(() => { expect(screen.queryByRole('status')).toBeNull() })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(inspected).not.toHaveBeenCalled()
  expect(invoke).toHaveBeenCalledOnce()
})

it('parses standard JSON without accepting ambiguous transports, invalid types or tool permission overrides', () => {
  expect(connectorConfigurations(JSON.stringify({ mcpServers: {
    local: { command: 'node', args: ['path with spaces', ''], env: { API_KEY: 'local-secret' } },
    remote: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer local-secret' } },
  } }), draft)).toMatchObject([{ name: 'local', transport: 'stdio', arguments: ['path with spaces', ''], environment: { API_KEY: 'local-secret' } },
    { name: 'remote', transport: 'streamable-http' }])
  for (const config of [{ type: 'sse', url: 'https://mcp.example.test' }, { command: 'node', args: '--bad' },
    { command: 'node', url: 'https://mcp.example.test' }, { url: 'https://mcp.example.test', tools: [{ access: 'READ' }] },
    { url: 'https://user:secret@mcp.example.test' }, { command: 'node', env: { TOKEN: 123 } }]) {
    expect(() => connectorConfigurations(JSON.stringify(config), draft)).toThrow()
  }
})

it('keeps invalid JSON, selects one server, and saves private fields only after explicit save', async () => {
  const invoke = vi.fn(async (_namespace: string, method: string, payload: unknown) => {
    const value = method === 'extensions.save' ? ExtensionDraftSchema.parse(payload) : undefined
    return { ok: true, result: value ? { kind: value.kind, id: value.id, version: value.version, visibility: 'PERSONAL', installed: false } : [] }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  render(<ConnectorEditor onClose={close} onSaved={close} t={t} />)
  expect(screen.queryByText(zh.advancedInformation)).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: zh.jsonConfiguration }))
  const json = screen.getByLabelText(zh.mcpJsonConfiguration)
  fireEvent.change(json, { target: { value: '{invalid' } })
  fireEvent.click(screen.getByRole('button', { name: zh.applyConfiguration }))
  expect((await screen.findByRole('alert')).textContent).toBe(zh.connectorJsonInvalid)
  expect((json as HTMLTextAreaElement).value).toBe('{invalid')
  fireEvent.change(json, { target: { value: JSON.stringify({ mcpServers: {
    first: { command: 'node' }, second: { url: 'https://mcp.example.test', headers: { API_KEY: 'private-value' } },
  } }) } })
  fireEvent.click(screen.getByRole('button', { name: zh.applyConfiguration }))
  fireEvent.change(screen.getByLabelText(zh.selectMcpServer), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: zh.applyConfiguration }))
  expect(screen.getByLabelText<HTMLInputElement>(zh.mcpServerName).value).toBe('second')
  expect(screen.getByLabelText('值 1').getAttribute('type')).toBe('password')
  expect(invoke.mock.calls.filter(call => call[1] === 'extensions.save')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: zh.addMcp }))
  await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('product', 'extensions.save', expect.objectContaining({
    name: 'second', headers: { API_KEY: 'private-value' },
  }), expect.any(String), 180_000) })
})

it('parses literal complete commands and private variables without dropping quotes or expanding shell syntax', () => {
  const input = 'node "path with spaces/server.js" --name \'two words\' ""'
  expect(connectorCommand(input)).toEqual({ command: 'node', arguments: ['path with spaces/server.js', '--name', 'two words', ''] })
  const config = ExtensionDraftSchema.parse({ ...draft, transport: 'stdio', command: '/path with spaces/node', arguments: ['one two', '', "it's quoted", '$literal'] })
  expect(connectorCommand(connectorCommandText(config))).toEqual({ command: config.command, arguments: config.arguments })
  for (const value of ['node "unfinished', 'node \'unfinished', 'node \\', 'node file | other', 'node file > out', 'TOKEN=secret node',
    'node $SECRET', 'node $(whoami)', 'node *.js', 'node\nother', '']) expect(() => connectorCommand(value)).toThrow()
  expect(connectorVariables('API_KEY=one=two\nREGION=cn')).toEqual({ API_KEY: 'one=two', REGION: 'cn' })
  expect(connectorVariables('{"API_KEY":"private"}')).toEqual({ API_KEY: 'private' })
  for (const value of ['API_KEY=one\nAPI_KEY=two', 'missing-equals', '{"KEY":2}', '{}', '']) expect(() => connectorVariables(value)).toThrow()
})

it('keeps a complete command after errors, pastes environment values and saves a bounded operation timeout', async () => {
  const invoke = vi.fn(async (_namespace: string, method: string, payload: unknown) => {
    const value = method === 'extensions.save' ? ExtensionDraftSchema.parse(payload) : undefined
    return { ok: true, result: value ? { kind: value.kind, id: value.id, version: value.version, visibility: 'PERSONAL', installed: false } : [] }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  vi.stubGlobal('navigator', { clipboard: { readText: vi.fn(async () => 'API_KEY=device-only\nREGION=cn') } })
  const saved = vi.fn()
  render(<ConnectorEditor onClose={close} onSaved={saved} t={t} />)
  fireEvent.change(screen.getByLabelText(zh.mcpServerName), { target: { value: 'Local MCP' } })
  fireEvent.change(screen.getByLabelText(zh.mcpCommand), { target: { value: 'node "path with spaces/server.js"' } })
  fireEvent.change(screen.getByLabelText(zh.connectorTimeout), { target: { value: '601' } })
  fireEvent.click(screen.getByRole('button', { name: zh.addMcp }))
  expect(screen.getByRole('alert').textContent).toBe(zh.connectorTimeoutInvalid)
  expect(screen.getByLabelText<HTMLTextAreaElement>(zh.mcpCommand).value).toBe('node "path with spaces/server.js"')
  fireEvent.click(screen.getByRole('button', { name: zh.pasteConfiguration }))
  await waitFor(() =>{  expect(screen.getByLabelText<HTMLInputElement>('值 1').value).toBe('device-only') })
  fireEvent.change(screen.getByLabelText(zh.connectorTimeout), { target: { value: '120' } })
  fireEvent.click(screen.getByRole('button', { name: zh.addMcp }))
  await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('product', 'extensions.save', expect.objectContaining({
    command: 'node', arguments: ['path with spaces/server.js'], environment: { API_KEY: 'device-only', REGION: 'cn' }, timeoutSeconds: 120,
  }), expect.any(String), 300_000) })
  expect(saved).toHaveBeenCalledOnce()
})

it('cancels a pending file inspection and releases a late preview after the import dialog closes', async () => {
  let finish!: (value: unknown) => void
  const invoke = vi.fn(async (_namespace: string, method: string) => method === 'extensions.import.inspect'
    ? await new Promise((resolve) => { finish = resolve }) : { ok: true, result: {} })
  const cancel = vi.fn(); const inspected = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  const view = render(<ExtensionImporter kind="skill" onClose={close} onInspected={inspected} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.choosePackageFile }))
  expect(invoke).toHaveBeenCalledWith('product', 'extensions.import.inspect', { kind: 'skill', source: 'file' }, expect.any(String))
  view.unmount()
  expect(cancel).toHaveBeenCalled()
  finish({ ok: true, result: { stageId: '00000000-0000-4000-8000-000000000001', draft: {}, files: [] } })
  await waitFor(() =>{  expect(invoke).toHaveBeenCalledWith('product', 'extensions.import.release',
    { stageId: '00000000-0000-4000-8000-000000000001' }, expect.any(String)) })
  expect(inspected).not.toHaveBeenCalled()
})

it('distinguishes a timed-out file selection from an invalid package and allows retry', async () => {
  const inspected = vi.fn()
  const invoke = vi.fn().mockResolvedValueOnce({ ok: false, failure: {
    code: 'EXTENSION_REQUEST_TIMEOUT', message: 'Desktop extension request timed out', retryable: true, resources: [],
  } }).mockResolvedValueOnce({ ok: true, result: {
    stageId: '00000000-0000-4000-8000-000000000001', draft: { kind: 'skill', body: '# Imported guide' },
    files: [{ path: 'SKILL.md', bytes: 16 }], missingFields: ['name'],
  } })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  render(<ExtensionImporter kind="skill" onClose={close} onInspected={inspected} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.choosePackageFile }))
  expect((await screen.findByRole('alert')).textContent).toContain(zh.extensionRequestTimeout)
  expect(screen.queryByText(zh.importInvalid)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.choosePackageFile }))
  await waitFor(() => { expect(inspected).toHaveBeenCalledOnce() })
  expect(inspected.mock.calls[0]?.[0]).toMatchObject({
    draft: { body: '# Imported guide' }, missingFields: ['name'],
  })
})

it('offers conversation completion for incomplete imports without a manual content editor', async () => {
  const invoke = vi.fn(async () => ({ ok: true, result: {} }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const continueConversation = vi.fn(async () => undefined)
  render(<ExtensionPreview preview={{ stageId: '00000000-0000-4000-8000-000000000001', draft: {
    kind: 'skill', body: '# Retained guide', name: 'Review',
  }, files: [], missingFields: ['summary'] }} onClose={close} onSaved={close} onContinue={continueConversation} t={t} />)
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.saveAndInstall }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: zh.continueInConversation }))
  await waitFor(() =>{  expect(continueConversation).toHaveBeenCalledOnce() })
  expect(invoke).not.toHaveBeenCalled()
  expect(screen.getByRole('heading', { name: 'Retained guide' })).toBeTruthy()
})
