import type { BrowserWindow } from 'electron'
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
  connectorsClose: vi.fn(async () => {}), dispose: vi.fn(),
  libraryPrepare: vi.fn(async () => {}), libraryClose: vi.fn(async () => {}), writeFile: vi.fn(), removeFile: vi.fn(),
  readFile: vi.fn(), renameFile: vi.fn(),
  encryptionAvailable: vi.fn(() => false),
  libraryReset: vi.fn(async () => {}),
  companyPrepare: vi.fn(async () => {}), companyClose: vi.fn(async () => {}),
  expertVersion: vi.fn(async (_slug: string, _sha256: string, _signal?: AbortSignal) => '/company/resources/orders'),
  bridgeOptions: vi.fn<(options: ProductBridgeOptions) => void>(),
  invoke: vi.fn(async (..._args: unknown[]) => ({})), refreshCatalog: vi.fn(async () => {}) }))
vi.mock('../src/company-content-sync.ts', async original => ({
  waitForCompanyContent: (await original<typeof import('../src/company-content-sync.ts')>()).waitForCompanyContent,
  CompanyContentSync: class {
    prepare = async () => { await fixture.companyPrepare(); void fixture.companyContent().catch(() => undefined); return this.read() }
    read = () => ({ skillsRoot: '/company/skills', expertsRoot: '/company/experts', version: '0', sha256: '0'.repeat(64) })
    refresh = async () => { await fixture.companyContent() }
    pin = async () => this.read()
    expertVersion = fixture.expertVersion
    close = fixture.companyClose
  } }))
vi.mock('../src/builtin-capabilities.ts', () => ({ builtinCapabilityPatches: () => [] }))
vi.mock('../src/native-capabilities.ts', () => ({ prepareNativeCapabilities: async () => {} }))

vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), writeFileSync: fixture.writeFile,
  rmSync: fixture.removeFile, readFileSync: fixture.readFile, renameSync: fixture.renameFile }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/unused-fixture', getAppPath: () => '/unused-fixture', getVersion: () => '0.1.0', quit: fixture.quit },
  dialog: { showMessageBox: fixture.dialog }, shell: { openExternal: vi.fn(async () => {}) },
  safeStorage: { isEncryptionAvailable: fixture.encryptionAvailable,
    encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
  screen: { getAllDisplays: () => [{ scaleFactor: 2 }] },
}))
vi.mock('../src/deepseek-harness-product-config.ts', () => ({ resolveDeepSeekHarnessProductConfig: () => ({ serverUrl: 'https://example.test',
  companyContentRefreshIntervalMs: 60000,
  connectorProxy: { responseTimeoutMs: 30000, streamIdleTimeoutMs: 120000 },
  support: { heartbeatIntervalMs: 300000, reportIntervalMs: 86400000 },
  libraryFiles: { previewMaxBytes: 1024, spreadsheetMaxBytes: 1024, officeInputMaxBytes: 1024,
    officeOutputMaxBytes: 1024, downloadMaxBytes: 1024, uploadMaxBytes: 1024, transferLifetimeMs: 60_000,
    fileRequestTimeoutMs: 60_000, maxTransfers: 8 } }) }))
vi.mock('@deepseek-ai/dsh-anonymous-user-id', () => ({ getOrCreateAnonymousUserId: () => '00000000-0000-4000-8000-000000000001' }))
vi.mock('../src/library-files.ts', () => ({ LibraryFiles: class {
  prepare = fixture.libraryPrepare; close = fixture.libraryClose; resetIdentity = fixture.libraryReset; invoke = async () => ({})
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
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.spyOn(PersonalConnectors.prototype, 'close').mockImplementation(fixture.connectorsClose)
  fixture.session = { authenticated: true, employeeId: 'fixture' }
  fixture.invokeRuntime.mockReset().mockResolvedValue([])
  fixture.companyContent.mockReset().mockResolvedValue(null)
  fixture.authenticate.mockResolvedValue({ authenticated: true })
  fixture.invoke.mockReset().mockResolvedValue({}); fixture.refreshCatalog.mockReset().mockResolvedValue()
  fixture.dispose.mockReset(); fixture.libraryClose.mockReset().mockResolvedValue()
  fixture.connectorsClose.mockReset().mockResolvedValue()
  fixture.libraryPrepare.mockReset().mockResolvedValue()
  fixture.companyPrepare.mockReset().mockResolvedValue(); fixture.companyClose.mockReset().mockResolvedValue()
  fixture.expertVersion.mockReset().mockResolvedValue('/company/resources/orders')
  fixture.libraryReset.mockReset().mockResolvedValue()
  fixture.readFile.mockReset().mockImplementation(() => { throw new Error('Missing stored login') }); fixture.renameFile.mockReset()
  fixture.writeFile.mockReset(); fixture.removeFile.mockReset(); fixture.encryptionAvailable.mockReset().mockReturnValue(false)
})

it.each(['files', 'company'] as const)('joins startup during %s preparation and rejects late startup effects on close', async (phase) => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const delayed = phase === 'files' ? fixture.libraryPrepare : fixture.companyPrepare
  delayed.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
  const cleaned = Promise.withResolvers<undefined>()
  fixture.connectorsClose.mockImplementationOnce(async () => { cleaned.resolve(undefined) })
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
    await expect(first).resolves.toMatchObject({ DSH_PRODUCT_MODEL_API_KEY: 'model-key' })
    expect(fixture.libraryPrepare).toHaveBeenCalledOnce()
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
  expect(fixture.connectorsClose).toHaveBeenCalledOnce()
})

it('releases remaining resources and joins in-flight requests before reporting cleanup failures', async () => {
  const bridgeFailure = new Error('Bridge cleanup failed')
  const filesFailure = new Error('Files cleanup failed')
  fixture.dispose.mockRejectedValueOnce(bridgeFailure)
  fixture.libraryClose.mockRejectedValueOnce(filesFailure)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const stopped = Promise.withResolvers<undefined>()
  fixture.invoke.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise; return {} })
  fixture.connectorsClose.mockImplementationOnce(async () => { stopped.resolve(undefined) })
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const operation = extension.invoke('catalog.list')
  await entered.promise
  let settled = false
  const closing = extension.close().then(() => { settled = true; return undefined }, (error: unknown) => { settled = true; return error })
  try {
    expect(await Promise.race([stopped.promise.then(() => 'stopped'), closing.then(() => 'closed')])).toBe('stopped')
    expect(fixture.libraryClose).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
  } finally {
    release.resolve(undefined)
    await operation
    await closing
  }
  expect(await closing).toBeInstanceOf(AggregateError)
  expect(await closing).toMatchObject({ errors: [bridgeFailure, filesFailure] })
  expect(fixture.connectorsClose).toHaveBeenCalledOnce()
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
    expect(environment).toMatchObject({ DSH_PRODUCT_MODEL_API_KEY: 'model-key' })
    expect(environment?.DEEPSEEK_HARNESS_SESSION_TOKEN).toBeUndefined()
    expect(environment).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(environment).not.toHaveProperty('DEEPSEEK_BASE_URL')
    const saved = String(fixture.writeFile.mock.calls[0]?.[1])
    expect(saved).toContain('deepseek-v4-flash')
    expect(saved).toContain('gpt-example')
    expect(saved).not.toContain('model-key')
    expect(JSON.parse(environment!.DSH_DESKTOP_PROFILE_PATCHES!)).toContain('/unused-fixture/product-inference.patch.json')
    expect(Object.keys(environment!)).toEqual(['DSH_COMPANY_SKILLS_ROOT', 'DSH_COMPANY_EXPERTS_ROOT', 'DEEPSEEK_HARNESS_SESSION_TOKEN', 'DSH_PRODUCT_MODEL_API_KEY', 'DSH_DESKTOP_PROFILE_PATCHES'])
  } finally { await extension.close() }
  expect(fixture.connectorsClose).toHaveBeenCalledOnce()
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
    await expect(pending).resolves.toMatchObject({ DSH_PRODUCT_MODEL_API_KEY: 'model-key' })
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

it('resolves pinned experts only over authenticated Host IPC with validated version coordinates', async () => {
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const sha256 = 'a'.repeat(64)
  const caller = new AbortController()
  try {
    await extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    await expect(extension.invokeRuntime('runtime.companyContent.expertVersion', { slug: 'orders', sha256 }, caller.signal))
      .resolves.toBe('/company/resources/orders')
    expect(fixture.expertVersion).toHaveBeenCalledWith('orders', sha256, expect.any(AbortSignal))
    const forwarded = fixture.expertVersion.mock.calls[0]![2]!
    caller.abort()
    expect(forwarded.aborted).toBe(true)
    expect(isProductMethod('runtime.companyContent.expertVersion')).toBe(false)
    for (const payload of [{ slug: '../orders', sha256 }, { slug: 'orders', sha256: '../version' },
      { slug: 'orders', sha256, employeeId: 'another' }]) {
      await expect(extension.invokeRuntime('runtime.companyContent.expertVersion', payload)).rejects.toThrow()
    }
    fixture.session = { authenticated: true, employeeId: 'another' }
    await expect(extension.invokeRuntime('runtime.companyContent.expertVersion', { slug: 'orders', sha256 }))
      .rejects.toMatchObject({ code: 'PRODUCT_HOST_IDENTITY_CHANGED' })
    expect(fixture.expertVersion).toHaveBeenCalledOnce()
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
    await expect(extension.invokeRuntime('connectors.list')).rejects.toMatchObject({ code: 'EMPLOYEE_UNAUTHORIZED' })
    fixture.session = { authenticated: true, employeeId: 'fixture' }
    await persist(fixture.session, 'new-token')
    await expect(extension.invokeRuntime('connectors.list')).resolves.toEqual([])
    fixture.session = { authenticated: true, employeeId: 'second' }
    await persist(fixture.session, 'other-token')
    await expect(extension.invokeRuntime('connectors.list')).rejects.toMatchObject({ code: 'PRODUCT_HOST_IDENTITY_CHANGED' })
    await expect(extension.invokeRuntime('runtime.library.preview.policy')).rejects.toMatchObject({ code: 'PRODUCT_HOST_IDENTITY_CHANGED' })
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

it('restores company catalogs, exact experts and Session bindings after the startup employee signs in again', async () => {
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const persist = fixture.bridgeOptions.mock.calls[0]![0].persistSession!
  try {
    await extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    fixture.session = { authenticated: false }
    await persist(fixture.session, undefined)
    fixture.session = { authenticated: true, employeeId: 'fixture' }
    await persist(fixture.session, 'new-token')
    const roots = await extension.invokeRuntime('runtime.companyContent.read')
    expect(roots).toMatchObject({ skillsRoot: '/company/skills', expertsRoot: '/company/experts' })
    await expect(extension.invokeRuntime('runtime.companyContent.refresh')).resolves.toEqual(roots)
    await expect(extension.invokeRuntime('runtime.companyContent.pin', { sessionId: 'existing-task', started: true }))
      .resolves.toEqual(roots)
    await expect(extension.invokeRuntime('runtime.companyContent.expertVersion', { slug: 'orders', sha256: 'a'.repeat(64) }))
      .resolves.toBe('/company/resources/orders')
    expect(fixture.companyPrepare).toHaveBeenCalledTimes(2)
    expect(fixture.companyClose).toHaveBeenCalledOnce()
    fixture.session = { authenticated: true, employeeId: 'second' }
    await persist(fixture.session, 'other-token')
    await expect(extension.invokeRuntime('runtime.companyContent.read')).rejects.toMatchObject({ code: 'PRODUCT_HOST_IDENTITY_CHANGED' })
    expect(fixture.companyPrepare).toHaveBeenCalledTimes(2)
  } finally { await extension.close() }
})

it('shares restored company initialization while allowing one reader to cancel independently', async () => {
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const persist = fixture.bridgeOptions.mock.calls[0]![0].persistSession!
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const pending: Promise<unknown>[] = []
  try {
    await persist(fixture.session, 'initial-token')
    await extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    fixture.session = { authenticated: false }
    await persist(fixture.session, undefined)
    fixture.session = { authenticated: true, employeeId: 'fixture' }
    await persist(fixture.session, 'new-token')
    fixture.companyPrepare.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
    const controller = new AbortController()
    const cancelled = extension.invokeRuntime('runtime.companyContent.read', undefined, controller.signal).catch((error: unknown) => error)
    pending.push(cancelled)
    await entered.promise
    const active = extension.invokeRuntime('runtime.companyContent.pin', { sessionId: 'new-task', started: false })
    pending.push(active)
    const reason = new Error('Page closed')
    controller.abort(reason)
    expect(await cancelled).toBe(reason)
    expect(fixture.companyPrepare).toHaveBeenCalledTimes(2)
    expect(fixture.companyClose).toHaveBeenCalledOnce()
    release.resolve(undefined)
    await expect(active).resolves.toMatchObject({ skillsRoot: '/company/skills' })
    await expect(extension.invokeRuntime('runtime.companyContent.read')).resolves.toMatchObject({ expertsRoot: '/company/experts' })
    expect(fixture.companyPrepare).toHaveBeenCalledTimes(2)
  } finally { release.resolve(undefined); await Promise.allSettled(pending); await extension.close() }
})

it('waits for an earlier company cleanup before restoring the same employee catalog', async () => {
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const persist = fixture.bridgeOptions.mock.calls[0]![0].persistSession!
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const pending: Promise<unknown>[] = []
  try {
    await persist(fixture.session, 'initial-token')
    await extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    fixture.companyClose.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
    fixture.session = { authenticated: false }
    pending.push(Promise.resolve(persist(fixture.session, undefined)))
    await entered.promise
    fixture.session = { authenticated: true, employeeId: 'fixture' }
    await persist(fixture.session, 'new-token')
    const restored = extension.invokeRuntime('runtime.companyContent.read')
    pending.push(restored)
    await setImmediate()
    expect(fixture.companyPrepare).toHaveBeenCalledOnce()
    release.resolve(undefined)
    await expect(restored).resolves.toMatchObject({ skillsRoot: '/company/skills' })
    expect(fixture.companyPrepare).toHaveBeenCalledTimes(2)
  } finally { release.resolve(undefined); await Promise.allSettled(pending); await extension.close() }
})

it('discards failed restored content preparation and retries without restarting the Host', async () => {
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const persist = fixture.bridgeOptions.mock.calls[0]![0].persistSession!
  try {
    await persist(fixture.session, 'initial-token')
    await extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    fixture.session = { authenticated: false }
    await persist(fixture.session, undefined)
    fixture.session = { authenticated: true, employeeId: 'fixture' }
    await persist(fixture.session, 'new-token')
    const failure = new Error('Content cache is temporarily unavailable')
    fixture.companyPrepare.mockRejectedValueOnce(failure)
    await expect(extension.invokeRuntime('runtime.companyContent.read')).rejects.toBe(failure)
    await expect(extension.invokeRuntime('runtime.companyContent.read')).resolves.toMatchObject({ expertsRoot: '/company/experts' })
    expect(fixture.companyPrepare).toHaveBeenCalledTimes(3)
    expect(fixture.companyClose).toHaveBeenCalledTimes(2)
  } finally { await extension.close() }
})

it.each(['identity', 'close'] as const)('rejects restored content when %s changes before initialization completes', async (interruption) => {
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const persist = fixture.bridgeOptions.mock.calls[0]![0].persistSession!
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let pending: Promise<unknown> | undefined
  let closing: Promise<void> | undefined
  try {
    await persist(fixture.session, 'initial-token')
    await extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    fixture.session = { authenticated: false }
    await persist(fixture.session, undefined)
    await expect(extension.invokeRuntime('runtime.companyContent.read')).rejects.toMatchObject({ code: 'EMPLOYEE_UNAUTHORIZED' })
    expect(fixture.companyPrepare).toHaveBeenCalledOnce()
    fixture.session = { authenticated: true, employeeId: 'fixture' }
    await persist(fixture.session, 'new-token')
    fixture.companyPrepare.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
    pending = extension.invokeRuntime('runtime.companyContent.read').catch((error: unknown) => error)
    await entered.promise
    if (interruption === 'identity') {
      fixture.session = { authenticated: true, employeeId: 'second' }
      await persist(fixture.session, 'other-token')
    } else closing = extension.close()
    expect(await pending).toBeInstanceOf(Error)
    release.resolve(undefined)
    await closing
    if (interruption === 'identity') {
      await expect(extension.invokeRuntime('runtime.companyContent.read')).rejects.toMatchObject({ code: 'PRODUCT_HOST_IDENTITY_CHANGED' })
    }
    expect(fixture.companyPrepare).toHaveBeenCalledTimes(2)
    expect(fixture.companyClose).toHaveBeenCalledTimes(2)
  } finally { release.resolve(undefined); await pending; await closing; await extension.close() }
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
    expect(fixture.libraryReset).toHaveBeenCalledTimes(2)
    await persist({ authenticated: true, employeeId: 'third' }, 'refreshed-token')
    expect(fixture.libraryReset).toHaveBeenCalledTimes(2)
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
    fixture.connectorsClose.mockImplementationOnce(async () => { stopped.resolve(undefined) })
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
    resets.mockClear(); fixture.libraryReset.mockClear()
    fixture.companyClose.mockImplementationOnce(async () => { entered.resolve(undefined); await release.promise })
    fixture.encryptionAvailable.mockReturnValue(true)
    const storage = operation === 'save' ? fixture.writeFile : fixture.removeFile
    storage.mockImplementationOnce(() => { throw failure })
    const session = operation === 'save' ? { authenticated: true, employeeId: 'second', expiresAt: '2000000000', loginExpiresAt: '2002592000' } : { authenticated: false }
    const token = operation === 'save' ? 'fixture-token' : undefined
    let settled = false
    expect(() => {
      pending = Promise.resolve(persist(session, token, operation === 'save' ? 'remembered-token' : undefined)).then((value) => { settled = true; return value },
        (error: unknown) => { settled = true; return error })
    }).not.toThrow()
    await entered.promise
    expect(resets).toHaveBeenCalledWith(session.employeeId)
    expect(fixture.libraryReset).toHaveBeenCalledOnce()
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

it('shows the shared startup page and never navigates away from an existing workspace for reauthorization', async () => {
  const window = { loadURL: vi.fn(async (_url: string) => {}), isDestroyed: () => false,
    isMinimized: () => false, show: vi.fn(), focus: vi.fn() }
  const browserWindow: Partial<BrowserWindow> = window
  fixture.authenticate.mockImplementation(async (_bridge, open) => {
    await open('https://example.test/authorize')
    return fixture.session
  })
  const extension = createExtension({ getWindow: () => browserWindow as BrowserWindow,
    isQuitting: () => false, requestHost: async () => ({}) })
  try {
    await extension.prepareHost({ directory: '/unused-profile', installAnchor: '/unused-runtime/package.json' })
    const url = window.loadURL.mock.calls[0]![0]
    const html = decodeURIComponent(url.slice(url.indexOf(',') + 1))
    expect(html).toContain('product-employee-authorization')
    expect(html).toContain('正在连接钉钉')
    expect(html).toContain('请在系统浏览器中完成授权')
    expect(window.loadURL).toHaveBeenCalledOnce()
    await extension.invoke('auth.ensureDingTalk')
    expect(fixture.authenticate).toHaveBeenCalledTimes(2)
    expect(window.loadURL).toHaveBeenCalledOnce()
  } finally { await extension.close() }
})

it('atomically saves OS-encrypted login credentials and restores them after weeks for the issuing server only', async () => {
  fixture.encryptionAvailable.mockReturnValue(true)
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  const session = { authenticated: true, employeeId: 'fixture', displayName: '员工',
    expiresAt: String(Math.floor(Date.now() / 1000) - 21 * 86400),
    loginExpiresAt: String(Math.floor(Date.now() / 1000) + 9 * 86400) }
  try {
    await fixture.bridgeOptions.mock.calls[0]![0].persistSession!(session, 'private-access', 'private-remembered')
    const stored = fixture.writeFile.mock.calls.find(([path]) => String(path).endsWith('deepseek-harness-session.json.tmp'))
    expect(stored).toBeDefined()
    expect(stored?.[2]).toEqual({ mode: 0o600 })
    const saved = String(stored?.[1])
    expect(saved).not.toContain('private-access')
    expect(saved).not.toContain('private-remembered')
    expect(fixture.renameFile).toHaveBeenCalledWith('/unused-fixture/deepseek-harness-session.json.tmp', '/unused-fixture/deepseek-harness-session.json')
    fixture.readFile.mockReturnValue(saved)
    const restored = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
    try {
      expect(fixture.bridgeOptions.mock.calls.at(-1)?.[0]).toMatchObject({ initialSession: session,
        sessionToken: 'private-access', refreshToken: 'private-remembered' })
    } finally { await restored.close() }
    fixture.readFile.mockReturnValue(JSON.stringify({ ...JSON.parse(saved), serverUrl: 'https://other-server.test' }))
    const otherServer = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
    try {
      expect(fixture.bridgeOptions.mock.calls.at(-1)?.[0].refreshToken).toBeUndefined()
      expect(fixture.bridgeOptions.mock.calls.at(-1)?.[0].sessionToken).toBeUndefined()
    } finally { await otherServer.close() }
  } finally { await extension.close() }
})
