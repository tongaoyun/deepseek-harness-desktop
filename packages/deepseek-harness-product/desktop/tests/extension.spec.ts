import { beforeEach, expect, it, vi } from 'vitest'
import { DingTalkAuthorizationTimeoutError } from '@deepseek-harness/product/dingtalk-auth'
import type { ProductBridgeOptions } from '@deepseek-harness/product/bridge'
import type { ProductSession } from '@deepseek-harness/product'
import { ProductError } from '@deepseek-harness/product/errors'
import { DeepSeekHarnessApiError } from '@deepseek-harness/product'
import { createExtension } from '../src/index.ts'
import { isProductMethod } from '@deepseek-harness/product/protocol'
import { PersonalConnectors } from '../src/personal-connectors.ts'
import { setImmediate } from 'node:timers/promises'

const fixture = vi.hoisted(() => ({ authenticate: vi.fn<typeof import('@deepseek-harness/product/dingtalk-auth').ensureDingTalkSession>(),
  session: { authenticated: true, employeeId: 'fixture' } as ProductSession,
  invokeRuntime: vi.fn(async (..._args: unknown[]): Promise<unknown> => []),
  dialog: vi.fn(async (..._args: unknown[]) => ({ response: 0 })), quit: vi.fn(),
  companyContent: vi.fn(async () => null),
  bootstrap: vi.fn(async () => ({ modelApiKey: 'model-key', endpoints: { litellm: 'https://example.test/v1' }, models: ['deepseek-v4-flash', 'gpt-example'] })),
  start: vi.fn(async () => {}), stop: vi.fn(async () => {}), dispose: vi.fn(),
  knowledgePrepare: vi.fn(async () => {}), knowledgeClose: vi.fn(async () => {}), writeFile: vi.fn(), removeFile: vi.fn(),
  encryptionAvailable: vi.fn(() => false),
  knowledgeReset: vi.fn(async () => {}),
  companyPrepare: vi.fn(async () => {}), companyClose: vi.fn(async () => {}),
  bridgeOptions: vi.fn<(options: ProductBridgeOptions) => void>(),
  invoke: vi.fn(async (..._args: unknown[]) => ({})), refreshCatalog: vi.fn(async () => {}) }))
vi.mock('../src/company-content-sync.ts', () => ({ CompanyContentSync: class {
  prepare = async () => { await fixture.companyPrepare(); void fixture.companyContent().catch(() => undefined); return this.read() }
  read = () => ({ skillsRoot: '/company/skills', expertsRoot: '/company/experts', version: '0', sha256: '0'.repeat(64) })
  refresh = async () => { await fixture.companyContent() }
  pin = async () => this.read()
  close = fixture.companyClose
} }))
vi.mock('../src/builtin-capabilities.ts', () => ({ builtinCapabilityPatches: () => [] }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), writeFileSync: fixture.writeFile,
  rmSync: fixture.removeFile }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/unused-fixture', getAppPath: () => '/unused-fixture', getVersion: () => '0.1.0', quit: fixture.quit },
  dialog: { showMessageBox: fixture.dialog }, shell: { openExternal: vi.fn(async () => {}) },
  safeStorage: { isEncryptionAvailable: fixture.encryptionAvailable, encryptString: (value: string) => Buffer.from(value) },
  screen: { getAllDisplays: () => [{ scaleFactor: 2 }] },
}))
vi.mock('../src/deepseek-harness-product-config.ts', () => ({ resolveDeepSeekHarnessProductConfig: () => ({ serverUrl: 'https://example.test',
  companyContentRefreshIntervalMs: 60000,
  connectorProxy: { responseTimeoutMs: 30000, streamIdleTimeoutMs: 120000 },
  support: { heartbeatIntervalMs: 300000, reportIntervalMs: 86400000 },
  knowledgeFiles: { previewMaxBytes: 1024, spreadsheetMaxBytes: 1024, officeInputMaxBytes: 1024,
    officeOutputMaxBytes: 1024, downloadMaxBytes: 1024, uploadMaxBytes: 1024, transferLifetimeMs: 60_000,
    fileRequestTimeoutMs: 60_000, maxTransfers: 8 } }) }))
vi.mock('../src/deepseek-harness-native-process.ts', () => ({ DeepSeekHarnessNativeProcess: class {
  start = fixture.start; stop = fixture.stop; invoke = async () => ({})
} }))
vi.mock('../src/knowledge-files.ts', () => ({ KnowledgeFiles: class {
  prepare = fixture.knowledgePrepare; close = fixture.knowledgeClose; resetIdentity = fixture.knowledgeReset; invoke = async () => ({})
} }))
vi.mock('@deepseek-harness/product/dingtalk-auth', async original => ({
  ...await original<typeof import('@deepseek-harness/product/dingtalk-auth')>(), ensureDingTalkSession: fixture.authenticate,
}))
vi.mock('@deepseek-harness/product/bridge', () => ({ DeepSeekHarnessProductBridge: class {
  constructor(options: ProductBridgeOptions) { fixture.bridgeOptions(options) }
  dispose = fixture.dispose; invoke = fixture.invoke; invokeRuntime = fixture.invokeRuntime
  getSession = () => fixture.session
  subscribe = () => () => {}; refreshCatalog = fixture.refreshCatalog
  loadRuntimeBootstrap = fixture.bootstrap
  loadCompanyContent = fixture.companyContent
} }))
beforeEach(() => {
  vi.clearAllMocks()
  fixture.session = { authenticated: true, employeeId: 'fixture' }
  fixture.invokeRuntime.mockReset().mockResolvedValue([])
  fixture.companyContent.mockReset().mockResolvedValue(null)
  fixture.authenticate.mockResolvedValue({ authenticated: true })
  fixture.invoke.mockReset().mockResolvedValue({}); fixture.refreshCatalog.mockReset().mockResolvedValue()
  fixture.dispose.mockReset(); fixture.knowledgeClose.mockReset().mockResolvedValue(); fixture.stop.mockReset().mockResolvedValue()
  fixture.start.mockReset().mockResolvedValue(); fixture.knowledgePrepare.mockReset().mockResolvedValue()
  fixture.companyPrepare.mockReset().mockResolvedValue(); fixture.companyClose.mockReset().mockResolvedValue()
  fixture.knowledgeReset.mockReset().mockResolvedValue()
  fixture.writeFile.mockReset(); fixture.removeFile.mockReset(); fixture.encryptionAvailable.mockReset().mockReturnValue(false)
})

it.each(['files', 'native', 'company'] as const)('joins startup during %s preparation and rejects late startup effects on close', async (phase) => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const delayed = phase === 'files' ? fixture.knowledgePrepare : phase === 'native' ? fixture.start : fixture.companyPrepare
  delayed.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
  const cleaned = Promise.withResolvers<undefined>()
  fixture.stop.mockImplementationOnce(async () => { cleaned.resolve(undefined) })
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const pending = extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
  const outcome = pending.then(value => value, (error: unknown) => error)
  await entered.promise
  let closed = false
  const closing = extension.close().then(() => { closed = true })
  try {
    await cleaned.promise
    expect(closed).toBe(false)
  } finally {
    release.resolve(undefined)
    await closing
  }
  expect(await outcome).toBeUndefined()
  expect(fixture.writeFile).not.toHaveBeenCalled()
  expect(fixture.invoke).not.toHaveBeenCalled()
  if (phase === 'files') expect(fixture.start).not.toHaveBeenCalled()
  if (phase !== 'company') expect(fixture.companyPrepare).not.toHaveBeenCalled()
  else expect(fixture.companyClose).toHaveBeenCalledOnce()
})

it('coalesces concurrent Host preparation instead of replacing the company sync twice', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  fixture.companyPrepare.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  try {
    const first = extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    await entered.promise
    const second = extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    expect(second).toBe(first)
    release.resolve(undefined)
    await expect(first).resolves.toMatchObject({ DEEPSEEK_API_KEY: 'model-key' })
    expect(fixture.knowledgePrepare).toHaveBeenCalledOnce()
    expect(fixture.start).toHaveBeenCalledOnce()
    expect(fixture.companyPrepare).toHaveBeenCalledOnce()
  } finally {
    release.resolve(undefined)
    await extension.close()
  }
})

it('shares cleanup completion and failure across repeated close calls', async () => {
  const failure = new Error('Bridge cleanup failed')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  fixture.dispose.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise; throw failure })
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const first = extension.close().catch((error: unknown) => error)
  await entered.promise
  const second = extension.close().catch((error: unknown) => error)
  release.resolve(undefined)
  expect(await first).toMatchObject({ errors: [failure] })
  expect(await second).toBe(await first)
  expect(fixture.dispose).toHaveBeenCalledOnce()
  expect(fixture.stop).toHaveBeenCalledOnce()
})

it('releases remaining resources and joins in-flight requests before reporting cleanup failures', async () => {
  const bridgeFailure = new Error('Bridge cleanup failed')
  const filesFailure = new Error('Files cleanup failed')
  fixture.dispose.mockRejectedValueOnce(bridgeFailure)
  fixture.knowledgeClose.mockRejectedValueOnce(filesFailure)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const stopped = Promise.withResolvers<undefined>()
  fixture.invoke.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise; return {} })
  fixture.stop.mockImplementationOnce(async () => { stopped.resolve(undefined) })
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const operation = extension.invoke('catalog.list')
  await entered.promise
  let settled = false
  const closing = extension.close().then(() => { settled = true; return undefined }, (error: unknown) => { settled = true; return error })
  try {
    expect(await Promise.race([stopped.promise.then(() => 'stopped'), closing.then(() => 'closed')])).toBe('stopped')
    expect(fixture.knowledgeClose).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
  } finally {
    release.resolve(undefined)
    await operation
    await closing
  }
  expect(await closing).toBeInstanceOf(AggregateError)
  expect(await closing).toMatchObject({ errors: [bridgeFailure, filesFailure] })
  expect(fixture.stop).toHaveBeenCalledOnce()
})

it('cancels a shared sign-in only after its last caller cancels and allows a new attempt', async () => {
  const entered = Promise.withResolvers<AbortSignal>()
  fixture.authenticate.mockImplementationOnce(async (_bridge, _open, options) => {
    const signal = options?.signal
    if (!signal) throw new Error('No authentication signal')
    entered.resolve(signal)
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('Authorization cancelled', { cause: signal.reason })) }, { once: true })
    })
  })
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const first = new AbortController()
  const second = new AbortController()
  try {
    const pendingFirst = extension.invoke('auth.ensureDingTalk', undefined, first.signal)
    const rejectedFirst = expect(pendingFirst).rejects.toThrow('First cancelled')
    const underlying = await entered.promise
    const pendingSecond = extension.invoke('auth.ensureDingTalk', undefined, second.signal)
    const rejectedSecond = expect(pendingSecond).rejects.toThrow('Second cancelled')
    await Promise.resolve()
    first.abort(new Error('First cancelled'))
    await rejectedFirst
    expect(underlying.aborted).toBe(false)
    expect(fixture.authenticate).toHaveBeenCalledOnce()
    second.abort(new Error('Second cancelled'))
    await rejectedSecond
    expect(underlying.aborted).toBe(true)
    await expect(extension.invoke('auth.ensureDingTalk')).resolves.toEqual({ authenticated: true, employeeId: 'fixture' })
    expect(fixture.authenticate).toHaveBeenCalledTimes(2)
  } finally { first.abort(); second.abort(); await extension.close() }
})

it('retries expired DingTalk sign-in and supplies only model configuration and profile overlays to Host', async () => {
  fixture.authenticate.mockRejectedValueOnce(new DingTalkAuthorizationTimeoutError())
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  try {
    const environment = await extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    expect(fixture.authenticate).toHaveBeenCalledTimes(2)
    expect(fixture.dialog).toHaveBeenCalledWith(expect.objectContaining({ message: '钉钉登录已超时' }))
    expect(environment).toMatchObject({ DEEPSEEK_API_KEY: 'model-key' })
    expect(environment?.DEEPSEEK_HARNESS_SESSION_TOKEN).toBeUndefined()
    const saved = String(fixture.writeFile.mock.calls[0]?.[1])
    expect(saved).toContain('deepseek-v4-flash')
    expect(saved).toContain('gpt-example')
    expect(saved).not.toContain('model-key')
    expect(JSON.parse(environment!.DSH_DESKTOP_PROFILE_PATCHES!)).toContain('/unused-fixture/product-inference.patch.json')
    expect(Object.keys(environment!)).toEqual(['DSH_COMPANY_SKILLS_ROOT', 'DSH_COMPANY_EXPERTS_ROOT', 'DEEPSEEK_HARNESS_SESSION_TOKEN', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_DESKTOP_PROFILE_PATCHES'])
  } finally { await extension.close() }
  expect(fixture.stop).toHaveBeenCalledOnce()
  expect(fixture.dispose).toHaveBeenCalledOnce()
  const signal = fixture.authenticate.mock.calls[0]?.[2]?.signal as AbortSignal
  expect(signal.aborted).toBe(true)
})

it.each(['authentication', 'bootstrap'] as const)('waits for explicit retry after a network failure during %s', async (phase) => {
  const failure = new ProductError('PRODUCT_NETWORK_UNAVAILABLE', 'private diagnostic', true)
  if (phase === 'authentication') fixture.authenticate.mockRejectedValueOnce(failure)
  else fixture.bootstrap.mockRejectedValueOnce(failure)
  const choice = Promise.withResolvers<{ response: number }>()
  const shown = Promise.withResolvers<undefined>()
  fixture.dialog.mockImplementationOnce(async () => { shown.resolve(undefined); return choice.promise })
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  try {
    const pending = extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    await shown.promise
    expect(fixture.writeFile).not.toHaveBeenCalled()
    expect(fixture.bootstrap).toHaveBeenCalledTimes(phase === 'authentication' ? 0 : 1)
    expect(JSON.stringify(fixture.dialog.mock.calls)).not.toContain('private diagnostic')
    choice.resolve({ response: 0 })
    await expect(pending).resolves.toMatchObject({ DEEPSEEK_API_KEY: 'model-key' })
    expect(fixture.authenticate).toHaveBeenCalledTimes(2)
    expect(fixture.quit).not.toHaveBeenCalled()
  } finally { choice.resolve({ response: 1 }); await extension.close() }
})

it('enters the workspace while the background company check fails and exposes retry through trusted Host IPC', async () => {
  fixture.companyContent.mockRejectedValueOnce(new Error('Company server unavailable'))
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  try {
    await expect(extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })).resolves.toMatchObject({ DSH_COMPANY_SKILLS_ROOT: '/company/skills' })
    expect(fixture.dialog).not.toHaveBeenCalled()
    await expect(extension.invokeRuntime('runtime.companyContent.refresh')).resolves.toMatchObject({ version: '0' })
    expect(isProductMethod('runtime.companyContent.pin')).toBe(false)
  } finally { await extension.close() }
})

it('exits without writing inference configuration when startup retry is declined', async () => {
  fixture.authenticate.mockRejectedValueOnce(new DeepSeekHarnessApiError(503, 'UNAVAILABLE', 'private'))
  fixture.dialog.mockResolvedValueOnce({ response: 1 })
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  try {
    await expect(extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })).resolves.toBeUndefined()
    expect(fixture.quit).toHaveBeenCalledOnce()
    expect(fixture.bootstrap).not.toHaveBeenCalled()
    expect(fixture.writeFile).not.toHaveBeenCalled()
  } finally { await extension.close() }
})

it('keeps invalid startup configuration as a failure', async () => {
  const failure = new Error('Invalid runtime bootstrap')
  fixture.bootstrap.mockRejectedValueOnce(failure)
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  try {
    await expect(extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })).rejects.toBe(failure)
    expect(fixture.dialog).not.toHaveBeenCalled()
    expect(fixture.writeFile).not.toHaveBeenCalled()
  } finally { await extension.close() }
})

it('settles startup on close and ignores a late retry choice', async () => {
  fixture.authenticate.mockRejectedValueOnce(new ProductError('PRODUCT_NETWORK_UNAVAILABLE', 'Unavailable', true))
  const shown = Promise.withResolvers<undefined>()
  const choice = Promise.withResolvers<{ response: number }>()
  fixture.dialog.mockImplementationOnce(async () => { shown.resolve(undefined); return choice.promise })
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const pending = extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
  try {
    await shown.promise
    await extension.close()
    await expect(pending).resolves.toBeUndefined()
    choice.resolve({ response: 0 })
    await Promise.resolve()
    expect(fixture.authenticate).toHaveBeenCalledOnce()
    expect(fixture.bootstrap).not.toHaveBeenCalled()
    expect(fixture.writeFile).not.toHaveBeenCalled()
    expect(fixture.quit).not.toHaveBeenCalled()
  } finally { choice.resolve({ response: 1 }); await pending }
})


it('routes explicit connector refresh to Host with strict payload and lifecycle cancellation', async () => {
  const requestHost = vi.fn(async (..._args: unknown[]) => ({ connectedIds: ['crm'], unavailableIds: [] }))
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost })
  try {
    const controller = new AbortController()
    await expect(extension.invoke('connectors.refresh', {}, controller.signal))
      .resolves.toEqual({ connectedIds: ['crm'], unavailableIds: [] })
    expect(requestHost).toHaveBeenCalledWith('product', 'connectors.refresh', {}, expect.any(AbortSignal))
    const forwarded = requestHost.mock.calls[0]![3] as AbortSignal
    controller.abort()
    expect(forwarded.aborted).toBe(true)
    await expect(extension.invoke('connectors.refresh', { headers: { Authorization: 'forged' } })).rejects.toThrow()
    expect(requestHost).toHaveBeenCalledTimes(1)
  } finally { await extension.close() }
})

it('keeps a Host bound to its startup employee while allowing the same employee to sign in again', async () => {
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const persist = fixture.bridgeOptions.mock.calls[0]![0].persistSession!
  try {
    await extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    fixture.session = { authenticated: false }
    await persist(fixture.session, undefined)
    await expect(extension.invokeRuntime('connectors.list')).rejects.toMatchObject({ code: 'PRODUCT_HOST_IDENTITY_CHANGED' })
    fixture.session = { authenticated: true, employeeId: 'fixture' }
    await persist(fixture.session, 'new-token')
    await expect(extension.invokeRuntime('connectors.list')).resolves.toEqual([])
    fixture.session = { authenticated: true, employeeId: 'second' }
    await persist(fixture.session, 'other-token')
    await expect(extension.invokeRuntime('connectors.list')).rejects.toMatchObject({ code: 'PRODUCT_HOST_IDENTITY_CHANGED' })
    await expect(extension.invokeRuntime('knowledge.search', { query: 'orders' })).rejects.toMatchObject({ code: 'PRODUCT_HOST_IDENTITY_CHANGED' })
    await expect(extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' }))
      .rejects.toMatchObject({ code: 'PRODUCT_HOST_IDENTITY_CHANGED' })
    expect(fixture.invokeRuntime).toHaveBeenCalledOnce()
  } finally { await extension.close() }
})

it('rejects a late Host result after its employee changes', async () => {
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const entered = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<undefined>()
  let pending: Promise<unknown> | undefined
  try {
    await extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    fixture.invokeRuntime.mockImplementationOnce(async (_method, _payload, signal) => {
      if (!(signal instanceof AbortSignal)) throw new Error('Missing identity cancellation')
      entered.resolve(signal)
      await release.promise
      return []
    })
    pending = extension.invokeRuntime('connectors.list').catch((error: unknown) => error)
    const signal = await entered.promise
    fixture.session = { authenticated: true, employeeId: 'second' }
    await fixture.bridgeOptions.mock.calls[0]![0].persistSession!(fixture.session, 'other-token')
    expect(signal.aborted).toBe(true)
    release.resolve(undefined)
    expect(await pending).toBeInstanceOf(Error)
  } finally { release.resolve(undefined); await pending; await extension.close() }
})

it.each(['bootstrap', 'company'] as const)('does not publish another employee\'s Host environment after switching during %s preparation', async (phase) => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  if (phase === 'bootstrap') fixture.bootstrap.mockImplementationOnce(async () => {
    entered.resolve(undefined); await release.promise
    return { modelApiKey: 'model-key', endpoints: { litellm: 'https://example.test/v1' }, models: ['deepseek-v4-flash', 'gpt-example'] }
  })
  else fixture.companyPrepare.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const pending = extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    .catch((error: unknown) => error)
  try {
    await entered.promise
    fixture.session = { authenticated: true, employeeId: 'second' }
    await fixture.bridgeOptions.mock.calls[0]![0].persistSession!(fixture.session, 'other-token')
    release.resolve(undefined)
    expect(await pending).toBeInstanceOf(Error)
    expect(fixture.writeFile).not.toHaveBeenCalled()
    await expect(extension.invokeRuntime('connectors.list')).rejects.toMatchObject({ code: 'PRODUCT_HOST_IDENTITY_CHANGED' })
    expect(fixture.invokeRuntime).not.toHaveBeenCalled()
  } finally { release.resolve(undefined); await pending; await extension.close() }
})

it('invalidates employee resources in session order before awaiting an old company cleanup', async () => {
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const closingCompany = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const resets = vi.spyOn(PersonalConnectors.prototype, 'resetIdentity')
  const pending: Promise<unknown>[] = []
  try {
    await extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    fixture.companyClose.mockImplementationOnce(async () => { closingCompany.resolve(undefined); await release.promise })
    const persist = fixture.bridgeOptions.mock.calls[0]![0].persistSession
    if (!persist) throw new Error('Missing employee resource cleanup')
    const first = Promise.resolve(persist({ authenticated: true, employeeId: 'second' }, 'fixture-token'))
    pending.push(first)
    await closingCompany.promise
    const second = Promise.resolve(persist({ authenticated: true, employeeId: 'third' }, 'fixture-token'))
    pending.push(second)
    await second
    release.resolve(undefined)
    await first
    expect(resets.mock.calls.map(call => call[0])).toEqual(['second', 'third'])
    expect(fixture.knowledgeReset).toHaveBeenCalledTimes(2)
    await persist({ authenticated: true, employeeId: 'third' }, 'refreshed-token')
    expect(fixture.knowledgeReset).toHaveBeenCalledTimes(2)
  } finally {
    release.resolve(undefined)
    await Promise.allSettled(pending)
    await extension.close()
    resets.mockRestore()
  }
})

it('joins an earlier employee cleanup before reporting extension shutdown complete', async () => {
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const stopped = Promise.withResolvers<undefined>()
  let pending: Promise<void> | undefined
  let closing: Promise<void> | undefined
  try {
    await extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    fixture.companyClose.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
    fixture.stop.mockImplementationOnce(async () => { stopped.resolve(undefined) })
    const persist = fixture.bridgeOptions.mock.calls[0]![0].persistSession
    if (!persist) throw new Error('Missing employee resource cleanup')
    pending = Promise.resolve(persist({ authenticated: true, employeeId: 'second' }, 'fixture-token'))
    await entered.promise
    let closed = false
    closing = extension.close().then(() => { closed = true })
    await stopped.promise
    // All other cleanup has settled; the next event-loop turn exposes an unjoined identity cleanup.
    await setImmediate()
    expect(closed).toBe(false)
    release.resolve(undefined)
    await closing
    expect(closed).toBe(true)
  } finally {
    release.resolve(undefined)
    await pending
    await closing
    await extension.close()
  }
})

it.each(['save', 'remove'] as const)('invalidates employee resources and joins cleanup when stored sign-in %s fails', async (operation) => {
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const failure = new Error('Local session storage is unavailable')
  const resets = vi.spyOn(PersonalConnectors.prototype, 'resetIdentity')
  let pending: Promise<unknown> | undefined
  try {
    const persist = fixture.bridgeOptions.mock.calls[0]![0].persistSession
    if (!persist) throw new Error('Missing employee resource cleanup')
    await persist({ authenticated: true, employeeId: 'fixture' }, 'initial-token')
    await extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    resets.mockClear(); fixture.knowledgeReset.mockClear()
    fixture.companyClose.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
    fixture.encryptionAvailable.mockReturnValue(true)
    const storage = operation === 'save' ? fixture.writeFile : fixture.removeFile
    storage.mockImplementationOnce(() => { throw failure })
    const session = operation === 'save' ? { authenticated: true, employeeId: 'second' } : { authenticated: false }
    const token = operation === 'save' ? 'fixture-token' : undefined
    let settled = false
    expect(() => {
      pending = Promise.resolve(persist(session, token)).then((value) => { settled = true; return value },
        (error: unknown) => { settled = true; return error })
    }).not.toThrow()
    await entered.promise
    expect(resets).toHaveBeenCalledWith(session.employeeId)
    expect(fixture.knowledgeReset).toHaveBeenCalledOnce()
    await setImmediate()
    expect(settled).toBe(false)
    release.resolve(undefined)
    expect(await pending).toMatchObject({ errors: [failure] })
  } finally {
    release.resolve(undefined)
    await pending
    await extension.close()
    resets.mockRestore()
  }
})
