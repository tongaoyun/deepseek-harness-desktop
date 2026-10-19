import type { Context } from '@deepseek-ai/cordis'
import type { DraftInitializationOptions, DraftInitializationResult, DraftReference } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createHarnessActions } from '../src/client/harness-actions.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'

afterEach(() => vi.unstubAllGlobals())
const asContext = (value: object) => value as Context

function fixture() {
  const listeners = new Set<(event: { type: string; payload?: unknown }) => void>()
  const effects: (() => unknown)[] = []
  const release = vi.fn()
  const refreshSkills = vi.fn()
  let active = 'original'
  let count = 0
  const capabilities = { connectorIds: [] as string[], requiredConnectorIds: [] as string[],
    knowledgeBaseIds: [] as string[], requiredKnowledgeBaseIds: [], knowledgeBaseRefs: [] }
  const drafts = new Map([['original', '  unfinished draft  ']])
  const selectedPresets = new Map([['original', 'standard']])
  const references = new Map<string, readonly DraftReference[]>()
  const select = vi.fn(async (session: string, preset: string): Promise<
    { ok: true } | { ok: false; error: { code: string; message: string } }
  > => { selectedPresets.set(session, preset); return { ok: true } })
  const selectPanel = vi.fn()
  const create = vi.fn(async (options?: { sessionId?: string }) => { const id = options?.sessionId ?? `new-${++count}`; drafts.set(id, ''); return id })
  const setDraft = vi.fn((id: string, value: string) => { drafts.set(id, value); references.set(id, []) })
  const input = (id: string) => ({
    state: { getSnapshot: () => ({ draft: drafts.get(id) ?? '',
      occurrences: (references.get(id) ?? []).map((reference, index) => ({ ...reference, occurrenceId: index + 1 })) }) },
    setDraft: (value: string) => { setDraft(id, value) }, focus: vi.fn(),
  })
  const requestDraftInitialization = vi.fn((binding: { ctx: { id: string } },
    options: DraftInitializationOptions): DraftInitializationResult => {
    const prompt = options.prompt ?? ''
    drafts.set(binding.ctx.id, typeof prompt === 'string' ? prompt : prompt.text)
    references.set(binding.ctx.id, typeof prompt === 'string' ? [] : prompt.references)
    return 'applied'
  })
  const invoke = vi.fn(async (_namespace: string, method: string,
    request: {
      connectorIds?: string[]
      knowledgeBaseIds?: string[]
      sessionId?: string
      kind?: string
    }): Promise<unknown> => {
    if (method === 'extensions.authoring.begin') return { authoringId: '00000000-0000-4000-8000-000000000001',
      sessionId: request.sessionId, revision: 0,
      draft: { kind: request.kind, id: 'created-resource', version: '1.0.0' }, files: [], missingFields: ['name'] }
    if (method === 'skills.installed.read') return { installed: [], available: [], frozen: false }
    if (method.endsWith('.read')) return structuredClone(capabilities)
    if (request.connectorIds) capabilities.connectorIds = request.connectorIds
    if (request.knowledgeBaseIds) capabilities.knowledgeBaseIds = request.knowledgeBaseIds
    return { kind: 'CURRENT_SESSION', presetId: 'prepared', capabilities }
  })
  vi.stubGlobal('dshDesktop', { extensions: {
    invoke: async (...args: Parameters<typeof invoke>) => ({ ok: true, result: args[1] === 'auth.getSession'
      ? { authenticated: true, employeeId: 'employee-one' } : await invoke(...args) }),
    cancel: vi.fn(), subscribe: (_namespace: string, listener: (event: { type: string; payload?: unknown }) => void) => {
      listeners.add(listener); return () => { listeners.delete(listener) }
    },
  } })
  const ctx = asContext({
    effect: (effect: () => () => unknown) => { effects.push(effect()) },
    uiSkills: { refresh: refreshSkills },
    sessions: { list: { getSnapshot: () => ({ byId: Object.fromEntries([...drafts.keys()]
      .map(id => [id, { id, retainedBy: { mainView: id === active ? 1 : 0 },
        projectionValues: { agentPreset: selectedPresets.get(id) } }])) }) },
    retain: (id: string) => ({ ready: Promise.resolve(), release, binding: { ctx: { id } } }),
    using: async (id: string, _options: unknown, action: (reference: object) => Promise<void>) => action({ binding: { ctx: { id } } }),
    create, binding: (id: string) => ({ ctx: { id } }) },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'workspace', sessionIds: [...drafts.keys()] }] }) } },
    conversation: { input: { for: (binding: { id: string }) => input(binding.id), requestDraftInitialization } },
    remote: { agentPresets: { select } },
    layout: { selectPanel, beginNavigation: () => new AbortController().signal },
    uiWorkspace: { openSession: (id: string) => { active = id } },
  })
  return { actions: createHarnessActions(ctx), capabilities, drafts, selectedPresets, references, setDraft, requestDraftInitialization,
    select, selectPanel, create, invoke, active: () => active, switchTo: (id: string) => { drafts.set(id, 'other draft'); active = id },
    sessionChanged: (employeeId: string) => { for (const listener of listeners) listener({ type: 'session.changed', payload: { authenticated: true, employeeId } }) },
    dispose: async () => { await Promise.all(effects.map(effect => effect())) }, listeners, release, refreshSkills }
}

it.each(['kit', 'knowledge', 'authoring'] as const)('cancels queued %s actions on account changes and releases its subscription', async (kind) => {
  const f = fixture()
  const pending = Promise.withResolvers<unknown>()
  f.invoke.mockImplementationOnce(() => pending.promise)
  const first = f.actions.installSkill('writing')
  const second = kind === 'kit' ? f.actions.installExpertKit?.('orders')
    : kind === 'knowledge' ? f.actions.setKnowledgeSelection(['orders'])
      : f.actions.startExtensionAuthoring?.('skill', { prompt: '创建技能' })
  const rejected = Promise.all([expect(first).rejects.toThrow(), expect(second).rejects.toThrow()])
  await vi.waitFor(() => { expect(f.invoke).toHaveBeenCalledOnce() })
  f.sessionChanged('employee-two')
  pending.resolve({ id: 'writing' })
  await rejected
  expect(f.invoke).toHaveBeenCalledOnce()
  expect(f.refreshSkills).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledTimes(kind === 'kit' ? 0 : 1)
  await f.actions.installExpertKit?.('new-orders')
  expect(f.invoke).toHaveBeenLastCalledWith('product', 'expertKits.install', { id: 'new-orders' }, expect.any(String))
  expect(f.create).not.toHaveBeenCalled()
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
  await f.dispose()
  expect(f.listeners.size).toBe(0)
})

it('keeps queued actions when the same employee session refreshes', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<unknown>()
  f.invoke.mockImplementationOnce(() => pending.promise)
  const first = f.actions.installSkill('writing')
  const second = f.actions.installExpertKit?.('orders')
  await vi.waitFor(() => { expect(f.invoke).toHaveBeenCalledOnce() })
  f.sessionChanged('employee-one')
  pending.resolve({ id: 'writing' })
  await Promise.all([first, second])
  expect(f.invoke).toHaveBeenLastCalledWith('product', 'expertKits.install', { id: 'orders' }, expect.any(String))
  await f.dispose()
})

it('restores a started task in place without changing its pinned composition, draft, or navigation', async () => {
  const f = fixture()
  f.selectedPresets.set('original', 'product-task-pinned')
  f.capabilities.connectorIds = ['erp']
  f.capabilities.knowledgeBaseIds = ['orders-kb']
  const reply = Promise.withResolvers<unknown>()
  f.invoke.mockImplementationOnce(() => reply.promise)
  const operation = f.actions.retryCapabilities(SessionId('original'))
  await vi.waitFor(() => { expect(f.invoke).toHaveBeenCalledOnce() })
  f.switchTo('other')
  f.drafts.set('original', 'latest draft')
  reply.resolve({ kind: 'NEW_SESSION', presetId: 'product-task-pinned', capabilities: f.capabilities })
  await operation
  expect(f.invoke).toHaveBeenCalledExactlyOnceWith('product', 'tasks.capabilities.prepare', { sessionId: 'original' }, expect.any(String))
  expect(f.create).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
  expect(f.requestDraftInitialization).not.toHaveBeenCalled()
  expect(f.active()).toBe('other')
  expect(f.drafts.get('original')).toBe('latest draft')
  expect(f.capabilities.connectorIds).toEqual(['erp'])
})

it('rejects a retry response for a different snapshot without replacing the task', async () => {
  const f = fixture()
  f.selectedPresets.set('original', 'product-task-pinned')
  await expect(f.actions.retryCapabilities()).rejects.toThrow('composition changed')
  expect(f.create).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
})

it('updates an empty task and preserves draft whitespace', async () => {
  const f = fixture()
  await f.actions.setKnowledgeSelection(['policy'])
  expect(f.create).not.toHaveBeenCalled()
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
  expect(f.select).toHaveBeenCalledWith('original', 'prepared')
  expect(f.setDraft).not.toHaveBeenCalled()
  expect(f.requestDraftInitialization).not.toHaveBeenCalled()
})

it('lists only matching installed kit identities and reflects uninstall without changing a task', async () => {
  const f = fixture()
  const catalog = [
    { id: 'orders', name: 'Orders', version: '1', sha256: 'a'.repeat(64) },
    { id: 'uninstalled', name: 'Uninstalled', version: '1', sha256: 'b'.repeat(64) },
    { id: 'updated', name: 'Updated', version: '2', sha256: 'c'.repeat(64) },
    { id: 'changed', name: 'Changed', version: '1', sha256: 'd'.repeat(64) },
  ]
  let installed = [catalog[0]!, { ...catalog[2]!, version: '1' }, { ...catalog[3]!, sha256: 'e'.repeat(64) },
    { id: 'removed', name: 'Removed', version: '1', sha256: 'f'.repeat(64) }]
  f.invoke.mockImplementation(async (_namespace, method) => {
    if (method === 'expertKits.list') return catalog
    if (method === 'expertKits.installed.read') return { installed }
    throw new Error(`Unexpected call: ${method}`)
  })
  expect((await f.actions.readExpertKits()).map(row => row.id)).toEqual(['orders'])
  installed = []
  expect(await f.actions.readExpertKits()).toEqual([])
  expect(f.select).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
})

it('refuses kit selection listing when installation records cannot be read', async () => {
  const f = fixture()
  f.invoke.mockImplementation(async (_namespace, method) => {
    if (method === 'expertKits.list') return [{ id: 'orders', name: 'Orders' }]
    throw new Error('Installation records unavailable')
  })
  await expect(f.actions.readExpertKits()).rejects.toThrow('Installation records unavailable')
  expect(f.select).not.toHaveBeenCalled()
})

it('keeps the current editor and its reference chips while updating an empty task', async () => {
  const f = fixture()
  const reference = { source: 'reference', ref: '@src/main.ts', label: 'main.ts', appearance: 'file' as const,
    clipboardText: '@src/main.ts', offset: 7, length: 12 }
  f.drafts.set('original', 'Review @src/main.ts')
  f.references.set('original', [reference])
  await f.actions.setExpertKit('orders')
  expect(f.drafts.get('original')).toBe('Review @src/main.ts')
  expect(f.references.get('original')).toEqual([reference])
  expect(f.requestDraftInitialization).not.toHaveBeenCalled()
})

it('initializes a replacement task with the latest semantic draft after a slow selection', async () => {
  const f = fixture()
  const reply = Promise.withResolvers<Awaited<ReturnType<typeof f.select>>>()
  f.select.mockImplementationOnce(() => reply.promise)
  const operation = f.actions.setExpertKit('orders')
  await vi.waitFor(() => { expect(f.select).toHaveBeenCalledOnce() })
  const reference = { source: 'reference', ref: '@src/main.ts', label: 'main.ts', appearance: 'file' as const,
    clipboardText: '@src/main.ts', offset: 7, length: 12 }
  f.drafts.set('original', 'Review @src/main.ts')
  f.references.set('original', [reference])
  f.switchTo('elsewhere')
  reply.resolve({ ok: false, error: { code: 'agent-preset/locked', message: 'started' } })
  await operation
  expect(f.drafts.get('new-1')).toBe('Review @src/main.ts')
  expect(f.references.get('new-1')).toEqual([expect.objectContaining(reference)])
  expect(f.drafts.get('original')).toBe('Review @src/main.ts')
  expect(f.active()).toBe('elsewhere')
  expect(f.requestDraftInitialization).toHaveBeenCalledExactlyOnceWith(
    { ctx: { id: 'new-1' } }, { prompt: { text: 'Review @src/main.ts',
      references: [expect.objectContaining(reference)] }, clearPreviousDraft: true })
})

it('keeps the source task and draft when the official initializer refuses a pending submission', async () => {
  const f = fixture()
  f.select.mockResolvedValueOnce({ ok: false, error: { code: 'agent-preset/locked', message: 'started' } })
  f.requestDraftInitialization.mockReturnValueOnce('blocked')
  await expect(f.actions.startExpertKit('orders')).rejects.toThrow('pending submission')
  expect(f.active()).toBe('original')
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
  expect(f.setDraft).not.toHaveBeenCalled()
})




it('starts a separate official creation conversation, initializes its tools before Agent creation and preserves the source draft', async () => {
  const f = fixture()
  await f.actions.startExtensionAuthoring?.('skill', { prompt: 'Create a review skill.' })
  const id = f.active()
  expect(id).toMatch(/^session-/)
  expect(f.drafts.get(id)).toBe('Create a review skill.')
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
  expect(f.select).not.toHaveBeenCalled()
  expect(f.create).toHaveBeenCalledWith({ workspaceId: 'workspace', sessionId: id })
  expect(f.invoke.mock.invocationCallOrder[0]).toBeLessThan(f.create.mock.invocationCallOrder[0]!)
})

it('does not open or clear the source conversation when authoring setup fails', async () => {
  const f = fixture()
  f.invoke.mockRejectedValueOnce(new Error('setup failed'))
  await expect(f.actions.startExtensionAuthoring?.('expert-kit', { prompt: 'Create a kit.' })).rejects.toThrow('setup failed')
  expect(f.create).not.toHaveBeenCalled()
  expect(f.active()).toBe('original')
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
})

it('does not steal focus if the user changes task while creation is queued', async () => {
  const f = fixture()
  const creation = f.actions.startExtensionAuthoring?.('skill', { prompt: 'Create a skill.' })
  f.switchTo('elsewhere')
  await creation
  expect(f.active()).toBe('elsewhere')
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
  expect(f.drafts.get('elsewhere')).toBe('other draft')
  expect([...f.drafts.values()]).toContain('Create a skill.')
})

it('adds knowledge to a configured kit and retains connectors and the existing draft', async () => {
  const f = fixture()
  await f.actions.startExpertKit('orders')
  f.capabilities.connectorIds = ['erp']
  await f.actions.setKnowledgeSelection(['policy'])
  expect(f.invoke).toHaveBeenLastCalledWith('product', 'tasks.capabilities.prepare', { knowledgeBaseIds: ['policy'], sessionId: 'original' }, expect.any(String))
  expect((await f.actions.readCapabilities?.())?.connectorIds).toEqual(['erp'])
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
})

it('applies an Expert Kit to the current empty task and preserves its draft', async () => {
  const f = fixture()
  await f.actions.startExpertKit('orders')
  expect(f.invoke).toHaveBeenCalledWith('product', 'tasks.capabilities.prepare', { expertKitId: 'orders', sessionId: 'original' }, expect.any(String))
  expect(f.create).not.toHaveBeenCalled()
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
})

it('installs skills without selecting a Preset or changing the task draft', async () => {
  const f = fixture()
  await f.actions.startExpertKit('development')
  f.create.mockClear()
  f.select.mockClear()
  await f.actions.installSkill('writing')
  await f.actions.installSkill('analysis')
  expect(f.create).not.toHaveBeenCalled()
  expect(f.invoke).toHaveBeenLastCalledWith('product', 'skills.install', { id: 'analysis' }, expect.any(String))
  expect(f.select).not.toHaveBeenCalled()
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
})

it('installs and reads device Kits without preparing or navigating away from a task', async () => {
  const f = fixture()
  await f.actions.installExpertKit?.('order-expert')
  expect(f.invoke).toHaveBeenLastCalledWith('product', 'expertKits.install', { id: 'order-expert' }, expect.any(String))
  const installed = [{ id: 'order-expert', version: '1.0.0', sha256: 'a'.repeat(64) }]
  f.invoke.mockResolvedValueOnce({ installed })
  await expect(f.actions.readInstalledExpertKits?.()).resolves.toEqual({ installed })
  expect(f.invoke).toHaveBeenLastCalledWith('product', 'expertKits.installed.read', undefined, expect.any(String))
  expect(f.create).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
  expect(f.selectPanel).not.toHaveBeenCalled()
  expect(f.active()).toBe('original')
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
})

it('rejects malformed device Kit installation responses', async () => {
  const f = fixture()
  f.invoke.mockResolvedValueOnce({ installed: [{ id: 'order-expert', version: '1.0.0', sha256: 'invalid' }] })
  await expect(f.actions.readInstalledExpertKits?.()).rejects.toThrow('Invalid installed Expert Kit response')
})

it('preserves an explicit skill invocation entered by the user when adding another skill', async () => {
  const f = fixture()
  f.drafts.set('original', '/analysis Review orders.\n  Keep this detail.  ')
  await f.actions.installSkill('writing')
  expect(f.drafts.get('original')).toBe('/analysis Review orders.\n  Keep this detail.  ')
})

it('carries Workspace and draft to a new task after the official concurrent-start guard rejects selection', async () => {
  const f = fixture()
  f.select.mockResolvedValueOnce({ ok: false, error: { code: 'agent-preset/locked', message: 'started' } })
  await f.actions.startExpertKit('orders')
  expect(f.create).toHaveBeenCalledWith({ workspaceId: 'workspace' })
  expect(f.active()).toBe('new-1')
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
  expect(f.drafts.get('new-1')).toBe('  unfinished draft  ')
})

it('leaves the current task and draft intact when preparation fails', async () => {
  const f = fixture()
  f.invoke.mockRejectedValueOnce(new Error('permission revoked'))
  await expect(f.actions.installSkill('writing')).rejects.toThrow('permission revoked')
  expect(f.create).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
  expect(f.active()).toBe('original')
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
})

it('applies a complete knowledge selection once and retains it when choosing a kit', async () => {
  const f = fixture()
  await f.actions.setKnowledgeSelection(['manuals', 'policy'])
  expect(f.invoke).toHaveBeenCalledExactlyOnceWith('product', 'tasks.capabilities.prepare',
    { sessionId: 'original', knowledgeBaseIds: ['manuals', 'policy'] }, expect.any(String))
  await f.actions.setExpertKit('orders')
  expect(await f.actions.readCapabilities?.()).toMatchObject({ knowledgeBaseIds: ['manuals', 'policy'] })
})

it('provides connector management without a task selection action', () => {
  const f = fixture()
  expect('setConnectorEnabled' in f.actions).toBe(false)
  f.actions.openCatalog('connectors')
  expect(f.invoke).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
})

it.each([
  ['expertKits', 'deepseek-harness-expert-kits'], ['skills', 'deepseek-harness-skills'],
  ['connectors', 'deepseek-harness-connectors'], ['knowledge', 'deepseek-harness-knowledge'],
] as const)('navigates to %s without changing the task or draft', (catalog, panel) => {
  const f = fixture()
  f.actions.openCatalog(catalog)
  expect(f.selectPanel).toHaveBeenCalledExactlyOnceWith(panel)
  expect(f.invoke).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
  expect(f.active()).toBe('original')
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
})

it('reads only the requested catalog and leaves task state intact on failure', async () => {
  const f = fixture()
  f.invoke.mockImplementation(async (_namespace, method) => {
    if (method === 'expertKits.list') return [{ id: 'orders', displayName: 'Orders' }]
    if (method === 'expertKits.installed.read') return { installed: [{ id: 'orders', version: '1', sha256: 'a'.repeat(64) }] }
    throw new Error('knowledge permission revoked')
  })
  expect((await f.actions.readExpertKits()).map(row => row.label)).toEqual(['Orders'])
  await expect(f.actions.readKnowledgeCatalog()).rejects.toThrow('knowledge permission revoked')
  expect(f.create).not.toHaveBeenCalled()
})

it('clears the kit through preparation without changing the draft', async () => {
  const f = fixture()
  await f.actions.setExpertKit(null)
  expect(f.invoke).toHaveBeenCalledWith('product', 'tasks.capabilities.prepare', { expertKitId: null, sessionId: 'original' }, expect.any(String))
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
})

it('keeps the task and draft when knowledge preparation fails', async () => {
  const f = fixture()
  f.invoke.mockRejectedValueOnce(new Error('permission revoked'))
  await expect(f.actions.setKnowledgeSelection(['policy'])).rejects.toThrow('permission revoked')
  expect(f.select).not.toHaveBeenCalled()
  expect(f.active()).toBe('original')
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
})

it('captures each queued action session and never focuses a different task after a slow preparation', async () => {
  const f = fixture()
  let finish!: () => void
  const waiting = new Promise<void>((resolve) => { finish = resolve })
  f.invoke.mockImplementationOnce(async () => {
    await waiting
    return { kind: 'CURRENT_SESSION', presetId: 'prepared', capabilities: f.capabilities }
  })
  const first = f.actions.setExpertKit('orders')
  const second = f.actions.setKnowledgeSelection(['manuals'])
  f.switchTo('other')
  f.drafts.set('original', 'latest draft')
  finish()
  await Promise.all([first, second])
  expect(f.select.mock.calls.map(call => call[0])).toEqual(['original', 'original'])
  expect(f.active()).toBe('other')
  expect(f.drafts.get('original')).toBe('latest draft')
  expect(f.drafts.get('other')).toBe('other draft')
})
