import type { Context } from '@deepseek-ai/cordis'
import type { DraftInitializationOptions, DraftInitializationResult, DraftReference } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createHarnessActions } from '../src/client/harness-actions.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { productErrorMessage } from '../src/client/product-errors.ts'
import { zh, en } from '../src/locales.ts'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'

afterEach(() => vi.unstubAllGlobals())
const asContext = (value: object) => value as Context

function fixture(opening: Promise<void> = Promise.resolve()) {
  const listeners = new Set<(event: { type: string; payload?: unknown }) => void>()
  const effects: (() => unknown)[] = []
  const release = vi.fn()
  const refreshSkills = vi.fn()
  let active = 'original'
  let count = 0
  const capabilities = { basePresetId: 'standard', knowledgeBaseIds: [] as string[] }
  const preparation = (kind = 'CURRENT_SESSION', presetId = 'prepared', ids = capabilities.knowledgeBaseIds) => ({
    kind, presetId, capabilities: { ...capabilities, knowledgeBaseIds: [...ids] },
    dependencyChecks: ids.map(reference => ({ kind: 'KNOWLEDGE_BASE', reference, status: 'READY' })),
  })
  const drafts = new Map([['original', '  unfinished draft  ']])
  const selectedPresets = new Map([['original', 'standard']])
  const references = new Map<string, readonly DraftReference[]>()
  const select = vi.fn(async (session: string, preset: string): Promise<
    { ok: true } | { ok: false; error: RemoteError }
  > => { selectedPresets.set(session, preset); return { ok: true } })
  const list = vi.fn(async (): Promise<{ ok: false; error: RemoteError }> => ({
    ok: false, error: new RemoteError('gateway/internal', 'roster unavailable', {}),
  }))
  const retain = vi.fn((id: string, options: { signal?: AbortSignal }) => {
    const ready = new Promise<void>((resolve, reject) => {
      const signal = options.signal
      const abort = () => {
        const reason: unknown = signal?.reason
        reject(reason instanceof Error ? reason : new Error('Acquisition cancelled', { cause: reason }))
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted === true) abort()
      void opening.then(resolve, reject).finally(() => { signal?.removeEventListener('abort', abort) })
    })
    // Native references also observe readiness before the serialized consumer starts waiting.
    void ready.catch(() => {})
    return { ready, release, binding: { ctx: { id } } }
  })
  const using = vi.fn(async (id: string, _options: { signal?: AbortSignal }, action: (reference: object) => Promise<void>) =>
    action({ binding: { ctx: { id } } }))
  const selectPanel = vi.fn()
  const create = vi.fn(async (options?: { sessionId?: string }) => { const id = options?.sessionId ?? `new-${++count}`; drafts.set(id, ''); return id })
  const workspaceItems = [{ workspaceId: 'workspace', sessionIds: ['original'] }]
  const initializeDefault = vi.fn(async (_signal?: AbortSignal): Promise<typeof workspaceItems[number] | undefined> => undefined)
  const createWorkspace = vi.fn(async (_input: { path: string }) => ({ workspaceId: 'chosen-workspace', sessionIds: [] as string[] }))
  const pickDirectory = vi.fn(async (): Promise<string | null> => '/chosen')
  const pickNative = vi.fn(async (_signal?: AbortSignal): Promise<
    { ok: true; value: string | null } | { ok: false; error: RemoteError }
  > => ({ ok: true, value: await pickDirectory() }))
  const setDraft = vi.fn((id: string, value: string) => { drafts.set(id, value); references.set(id, []) })
  const input = (id: string) => ({
    get draftSnapshot() { return { text: drafts.get(id) ?? '', references: references.get(id) ?? [] } },
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
    return preparation()
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
    retain, using,
    create, binding: (id: string) => ({ ctx: { id } }) },
    workspaces: { list: { getSnapshot: () => ({ items: workspaceItems }) }, initializeDefault, create: createWorkspace },
    conversation: { input: { for: (binding: { id: string }) => input(binding.id), requestDraftInitialization } },
    remote: { agentPresets: { select, list }, directoryPicker: { pick: pickNative } },
    layout: { selectPanel, beginNavigation: () => new AbortController().signal },
    uiWorkspace: { openSession: (id: string) => { active = id }, pickDirectory },
  })
  return { actions: createHarnessActions(ctx), preparation, capabilities, drafts, selectedPresets, references, setDraft,
    requestDraftInitialization,
    select, list, retain, using, selectPanel, create, invoke, workspaceItems, initializeDefault, createWorkspace, pickDirectory, pickNative,
    active: () => active, switchTo: (id: string) => { drafts.set(id, 'other draft'); active = id },
    sessionChanged: (employeeId: string) => { for (const listener of listeners) listener({ type: 'session.changed', payload: { authenticated: true, employeeId } }) },
    dispose: async () => { await Promise.all(effects.map(effect => effect())) }, listeners, release, refreshSkills }
}

it('restores a started task in place without changing its pinned composition, draft, or navigation', async () => {
  const f = fixture()
  f.selectedPresets.set('original', 'product-task-pinned')
  f.capabilities.knowledgeBaseIds = ['orders-kb']
  const reply = Promise.withResolvers<unknown>()
  f.invoke.mockImplementationOnce(() => reply.promise)
  const operation = f.actions.retryCapabilities(SessionId('original'))
  await vi.waitFor(() => { expect(f.invoke).toHaveBeenCalledOnce() })
  f.switchTo('other')
  f.drafts.set('original', 'latest draft')
  reply.resolve(f.preparation('NEW_SESSION', 'product-task-pinned'))
  await operation
  expect(f.invoke).toHaveBeenCalledExactlyOnceWith('product', 'tasks.capabilities.prepare', { sessionId: 'original' }, expect.any(String))
  expect(f.create).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
  expect(f.requestDraftInitialization).not.toHaveBeenCalled()
  expect(f.active()).toBe('other')
  expect(f.drafts.get('original')).toBe('latest draft')
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

it('preserves the current task when preparation returns a non-string session kind', async () => {
  const f = fixture()
  f.invoke.mockResolvedValueOnce({ kind: ['CURRENT_SESSION'], presetId: 'prepared', capabilities: f.capabilities })
  await expect(f.actions.setKnowledgeSelection(['policy'])).rejects.toMatchObject({ code: 'CAPABILITY_RESPONSE_INVALID' })
  expect(f.create).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
  expect(f.requestDraftInitialization).not.toHaveBeenCalled()
  expect(f.active()).toBe('original')
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
  await f.dispose()
})

it.each(['selection', 'retry'] as const)('cancels %s history acquisition on teardown without waiting for the shared opening', async (kind) => {
  const opening = Promise.withResolvers<undefined>()
  const f = fixture(opening.promise)
  f.selectedPresets.set('original', 'product-task-pinned')
  const operation = kind === 'selection' ? f.actions.setKnowledgeSelection(['policy']) : f.actions.retryCapabilities()
  let settled = false
  const result = operation.catch((error: unknown) => { settled = true; return error })
  await vi.waitFor(() => { expect(f.retain).toHaveBeenCalledOnce() })
  const disposed = f.dispose()
  try {
    await vi.waitFor(() => { expect(settled).toBe(true) }, { timeout: 200 })
    expect(await result).toMatchObject({ message: 'Product task actions were released' })
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.invoke).not.toHaveBeenCalled()
    expect(f.select).not.toHaveBeenCalled()
    expect(f.drafts.get('original')).toBe('  unfinished draft  ')
    await disposed
  } finally {
    opening.resolve(undefined)
    await result
    await disposed
  }
})

it('cancels all old employee acquisitions and lets the next employee continue', async () => {
  const opening = Promise.withResolvers<undefined>()
  const f = fixture(opening.promise)
  const first = f.actions.setKnowledgeSelection(['old-one']).catch((error: unknown) => error)
  const queued = f.actions.setKnowledgeSelection(['old-two']).catch((error: unknown) => error)
  let completed = 0
  void first.then(() => { completed++ })
  void queued.then(() => { completed++ })
  f.sessionChanged('employee-two')
  try {
    await vi.waitFor(() => { expect(completed).toBe(2) }, { timeout: 200 })
    expect(await first).toMatchObject({ message: 'Product employee identity changed' })
    expect(await queued).toMatchObject({ message: 'Product employee identity changed' })
    expect(f.release).toHaveBeenCalledTimes(2)
    expect(f.invoke).not.toHaveBeenCalled()
    opening.resolve(undefined)
    await f.actions.setKnowledgeSelection(['new-policy'])
    expect(f.capabilities.knowledgeBaseIds).toEqual(['new-policy'])
    expect(f.select).toHaveBeenCalledOnce()
  } finally {
    opening.resolve(undefined)
    await Promise.all([first, queued])
    await f.dispose()
  }
})

it('passes the same cancellation lifetime to source and destination acquisition', async () => {
  const f = fixture()
  await f.actions.setKnowledgeSelection(['policy'])
  const sourceSignal = f.retain.mock.calls[0]?.[1].signal
  expect(sourceSignal).toBeInstanceOf(AbortSignal)
  expect(f.using.mock.calls[0]?.[1].signal).toBe(sourceSignal)
  expect(sourceSignal?.aborted).toBe(false)
  await f.dispose()
  expect(sourceSignal?.aborted).toBe(true)
})

it('preserves native preset selection errors and leaves the draft and navigation intact', async () => {
  const f = fixture()
  const cause = new Error('host validation')
  const error = new RemoteError('gateway/bad-request', 'selection refused', { issues: [{ path: 'preset' }] }, { cause })
  f.select.mockResolvedValueOnce({ ok: false, error })
  await expect(f.actions.setKnowledgeSelection(['policy'])).rejects.toBe(error)
  expect({ code: error.code, message: error.message, details: error.details }).toMatchInlineSnapshot(`
    {
      "code": "gateway/bad-request",
      "details": {
        "issues": [
          {
            "path": "preset",
          },
        ],
      },
      "message": "selection refused",
    }
  `)
  expect(f.active()).toBe('original')
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
  expect(f.requestDraftInitialization).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledOnce()
  await f.dispose()
})

it('preserves native preset roster errors', async () => {
  const f = fixture()
  const error = new RemoteError('gateway/internal', 'roster disconnected', {}, { cause: new Error('carrier closed') })
  f.list.mockResolvedValueOnce({ ok: false, error })
  await expect(f.actions.readMode()).rejects.toBe(error)
  expect(f.select).not.toHaveBeenCalled()
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
  await f.dispose()
})

it('uses the native locked-session outcome to create one task and transfer the draft', async () => {
  const f = fixture()
  f.select.mockResolvedValueOnce({ ok: false, error: new RemoteError('agent-preset/locked', 'started', {
    sessionId: SessionId('original'), agentPreset: 'prepared',
  }) })
  await f.actions.setKnowledgeSelection(['policy'])
  expect(f.create).toHaveBeenCalledOnce()
  expect(f.select.mock.calls).toEqual([['original', 'prepared'], ['new-1', 'prepared']])
  expect(f.active()).toBe('new-1')
  expect(f.drafts.get('new-1')).toBe('  unfinished draft  ')
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
  expect(f.using.mock.calls[0]?.[1].signal).toBe(f.retain.mock.calls[0]?.[1].signal)
  await f.dispose()
})

it('does not open or initialize a task after identity changes during preset selection', async () => {
  const f = fixture()
  const selection = Promise.withResolvers<Awaited<ReturnType<typeof f.select>>>()
  f.select.mockImplementationOnce(() => selection.promise)
  const operation = f.actions.setKnowledgeSelection(['policy']).catch((error: unknown) => error)
  await vi.waitFor(() => { expect(f.select).toHaveBeenCalledOnce() })
  f.sessionChanged('employee-two')
  selection.resolve({ ok: true })
  expect(await operation).toMatchObject({ message: 'Product employee identity changed' })
  expect(f.using).not.toHaveBeenCalled()
  expect(f.requestDraftInitialization).not.toHaveBeenCalled()
  expect(f.active()).toBe('original')
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
  expect(f.release).toHaveBeenCalledOnce()
  await f.dispose()
})

it('reuses the native default-workspace initialization and its cancellation signal', async () => {
  const f = fixture()
  f.workspaceItems.length = 0
  f.initializeDefault.mockResolvedValueOnce({ workspaceId: 'native-default', sessionIds: [] })
  f.invoke.mockResolvedValueOnce(f.preparation('NEW_SESSION', 'prepared', ['policy']))
  await f.actions.setKnowledgeSelection(['policy'])
  expect(f.initializeDefault).toHaveBeenCalledExactlyOnceWith(f.retain.mock.calls[0]?.[1].signal)
  expect(f.pickDirectory).not.toHaveBeenCalled()
  expect(f.createWorkspace).not.toHaveBeenCalled()
  expect(f.create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'native-default' })
  expect(f.drafts.get('new-1')).toBe('  unfinished draft  ')
  await f.dispose()
})

it.each(['identity', 'teardown'] as const)('does not open a picker after %s cancels default initialization', async (kind) => {
  const f = fixture()
  const initialization = Promise.withResolvers<undefined>()
  f.workspaceItems.length = 0
  f.initializeDefault.mockImplementationOnce(() => initialization.promise)
  f.invoke.mockResolvedValueOnce(f.preparation('NEW_SESSION', 'prepared', ['policy']))
  const result = f.actions.setKnowledgeSelection(['policy']).catch((error: unknown) => error)
  await vi.waitFor(() => { expect(f.initializeDefault).toHaveBeenCalledOnce() })
  let disposed: Promise<void> | undefined
  if (kind === 'identity') f.sessionChanged('employee-two')
  else disposed = f.dispose()
  initialization.resolve(undefined)
  expect(await result).toMatchObject({ message: kind === 'identity'
    ? 'Product employee identity changed' : 'Product task actions were released' })
  expect(f.initializeDefault.mock.calls[0]?.[0]?.aborted).toBe(true)
  expect(f.pickDirectory).not.toHaveBeenCalled()
  expect(f.createWorkspace).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledOnce()
  await (disposed ?? f.dispose())
})

it.each(['identity', 'teardown'] as const)('does not register a late directory choice after %s', async (kind) => {
  const f = fixture()
  const selection = Promise.withResolvers<string | null>()
  f.workspaceItems.length = 0
  f.pickDirectory.mockImplementationOnce(() => selection.promise)
  f.invoke.mockResolvedValueOnce(f.preparation('NEW_SESSION', 'prepared', ['policy']))
  const result = f.actions.setKnowledgeSelection(['policy']).catch((error: unknown) => error)
  await vi.waitFor(() => { expect(f.pickDirectory).toHaveBeenCalledOnce() })
  let disposed: Promise<void> | undefined
  if (kind === 'identity') f.sessionChanged('employee-two')
  else disposed = f.dispose()
  selection.resolve('/old-employee-choice')
  expect(await result).toMatchObject({ message: kind === 'identity'
    ? 'Product employee identity changed' : 'Product task actions were released' })
  expect(f.createWorkspace).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
  expect(f.active()).toBe('original')
  expect(f.release).toHaveBeenCalledOnce()
  await (disposed ?? f.dispose())
})

it.each(['identity', 'teardown'] as const)('cancels the native directory chooser on %s', async (kind) => {
  const f = fixture()
  f.workspaceItems.length = 0
  f.invoke.mockResolvedValueOnce(f.preparation('NEW_SESSION', 'prepared', ['policy']))
  f.pickNative.mockImplementationOnce(signal => new Promise((resolve) => {
    signal?.addEventListener('abort', () => { resolve({ ok: false,
      error: new RemoteError('gateway/cancelled', 'directory picker was aborted', {}),
    }) }, { once: true })
  }))
  let error: unknown
  const result = f.actions.setKnowledgeSelection(['policy']).catch((failure: unknown) => { error = failure })
  await vi.waitFor(() => { expect(f.pickNative).toHaveBeenCalledOnce() })
  expect(f.pickNative).toHaveBeenCalledWith(f.retain.mock.calls[0]?.[1].signal)
  let disposed: Promise<void> | undefined
  if (kind === 'identity') f.sessionChanged('employee-two')
  else disposed = f.dispose()
  await vi.waitFor(() => { expect(error).toMatchObject({ message: kind === 'identity'
    ? 'Product employee identity changed' : 'Product task actions were released' }) })
  await result
  expect(f.createWorkspace).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledOnce()
  await (disposed ?? f.dispose())
})

it('preserves native directory-picker errors without registering a workspace or creating a task', async () => {
  const f = fixture()
  f.workspaceItems.length = 0
  f.invoke.mockResolvedValueOnce(f.preparation('NEW_SESSION', 'prepared', ['policy']))
  const error = new RemoteError('gateway/internal', 'chooser unavailable', {}, { cause: new Error('native backend') })
  f.pickNative.mockResolvedValueOnce({ ok: false, error })
  await expect(f.actions.setKnowledgeSelection(['policy'])).rejects.toBe(error)
  expect(f.createWorkspace).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
  await f.dispose()
})

it.each([
  { kind: 'CURRENT_SESSION', presetId: 'prepared' },
  { kind: 'CURRENT_SESSION', presetId: 'prepared', capabilities: { knowledgeBaseIds: [42] }, dependencyChecks: [] },
  { kind: 'CURRENT_SESSION', presetId: 'prepared', capabilities: { knowledgeBaseIds: ['policy'] }, dependencyChecks: [] },
  { kind: 'CURRENT_SESSION', presetId: 'prepared', capabilities: { basePresetId: 'standard', knowledgeBaseIds: ['policy'] },
    dependencyChecks: [{ kind: 'KNOWLEDGE_BASE', reference: 'policy', status: 'UNAUTHORIZED' }] },
  { kind: 'CURRENT_SESSION', presetId: 'prepared', capabilities: { basePresetId: 'standard', knowledgeBaseIds: ['other'] },
    dependencyChecks: [{ kind: 'KNOWLEDGE_BASE', reference: 'other', status: 'READY' }] },
])('rejects incomplete task preparation before native Session changes (%j)', async (response) => {
  const f = fixture()
  f.invoke.mockResolvedValueOnce(response)
  await expect(f.actions.setKnowledgeSelection(['policy'])).rejects.toMatchObject({ code: 'CAPABILITY_RESPONSE_INVALID' })
  expect(f.create).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
  expect(f.requestDraftInitialization).not.toHaveBeenCalled()
  expect(f.drafts.get('original')).toBe('  unfinished draft  ')
  expect(f.active()).toBe('original')
  expect(f.release).toHaveBeenCalledOnce()
  await f.dispose()
})

it.each([
  { knowledgeBaseIds: [42] },
  { knowledgeBaseIds: ['policy', 'policy'] },
  { knowledgeBaseIds: [], basePresetId: {} },
  { knowledgeBaseIds: [], unavailable: { code: 'error' } },
])('rejects malformed task selection rather than presenting it as typed data (%j)', async (response) => {
  const f = fixture()
  f.invoke.mockResolvedValueOnce(response)
  await expect(f.actions.readMode()).rejects.toMatchObject({ code: 'CAPABILITY_RESPONSE_INVALID' })
  expect(f.create).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled()
  await f.dispose()
})

it('shows a localized task response failure while retaining the native task and draft', async () => {
  const f = fixture()
  f.invoke.mockResolvedValueOnce({ kind: 'CURRENT_SESSION', presetId: 'prepared' })
  const error: unknown = await f.actions.setKnowledgeSelection(['policy']).catch((reason: unknown) => reason)
  expect({ zh: productErrorMessage(error, key => zh[key], 'taskSelectionFailed'),
    en: productErrorMessage(error, key => en[key], 'taskSelectionFailed'),
    task: f.active(), draft: f.drafts.get('original'),
    created: f.create.mock.calls.length, selected: f.select.mock.calls.length }).toMatchSnapshot()
  await f.dispose()
})
