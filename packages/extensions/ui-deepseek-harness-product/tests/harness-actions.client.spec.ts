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
      knowledgeBaseIds?: string[]
      sessionId?: string
      kind?: string
    }): Promise<unknown> => {
    if (method.endsWith('.read')) return structuredClone(capabilities)
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

it('provides connector management without a task selection action', () => {
  const f = fixture()
  expect('setConnectorEnabled' in f.actions).toBe(false)
  f.actions.openCatalog('connectors')
  expect(f.invoke).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
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
