import { beforeEach, expect, it, vi } from 'vitest'
import { DingTalkAuthorizationTimeoutError } from '@deepseek-harness/product/dingtalk-auth'
import type { ProductBridgeOptions } from '@deepseek-harness/product/bridge'
import { ProductError } from '@deepseek-harness/product/errors'
import { DeepSeekHarnessApiError } from '@deepseek-harness/product'
import { createExtension } from '../src/index.ts'
import type { ExtensionAuthoring } from '../src/extension-authoring.ts'

const fixture = vi.hoisted(() => ({ authenticate: vi.fn<typeof import('@deepseek-harness/product/dingtalk-auth').ensureDingTalkSession>(),
  dialog: vi.fn(async (..._args: unknown[]) => ({ response: 0 })), quit: vi.fn(),
  bootstrap: vi.fn(async () => ({ modelApiKey: 'model-key', endpoints: { litellm: 'https://example.test/v1' }, models: ['deepseek-v4-flash', 'gpt-example'] })),
  stop: vi.fn(async () => {}), dispose: vi.fn(), writeFile: vi.fn(), bridgeOptions: vi.fn<(options: ProductBridgeOptions) => void>(),
  invoke: vi.fn(async (..._args: unknown[]) => ({})), refreshCatalog: vi.fn(async () => {}),
  authoringOptions: vi.fn<(options: ConstructorParameters<typeof ExtensionAuthoring>[0]) => void>() }))
vi.mock('../src/extension-authoring.ts', async (original) => {
  const module = await original<typeof import('../src/extension-authoring.ts')>()
  return { ...module, ExtensionAuthoring: class extends module.ExtensionAuthoring {
    constructor(options: ConstructorParameters<typeof ExtensionAuthoring>[0]) { super(options); fixture.authoringOptions(options) }
  } }
})
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), writeFileSync: fixture.writeFile }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/unused-fixture', getAppPath: () => '/unused-fixture', getVersion: () => '0.1.0', quit: fixture.quit },
  dialog: { showMessageBox: fixture.dialog }, shell: { openExternal: vi.fn(async () => {}) },
  safeStorage: { isEncryptionAvailable: () => false },
  screen: { getAllDisplays: () => [{ scaleFactor: 2 }] },
}))
vi.mock('../src/deepseek-harness-product-config.ts', () => ({ resolveDeepSeekHarnessProductServerUrl: () => 'https://example.test',
  resolveDeepSeekHarnessConnectorProxyPolicy: () => ({ responseTimeoutMs: 30000, streamIdleTimeoutMs: 120000 }),
  resolveDesktopSupportPolicy: () => ({ heartbeatIntervalMs: 300000, reportIntervalMs: 86400000 }),
  resolveDeepSeekHarnessKnowledgeFilePolicy: () => ({ previewMaxBytes: 1024, spreadsheetMaxBytes: 1024, officeInputMaxBytes: 1024,
    officeOutputMaxBytes: 1024, downloadMaxBytes: 1024, uploadMaxBytes: 1024, transferLifetimeMs: 60_000,
    fileRequestTimeoutMs: 60_000, maxTransfers: 8 }) }))
vi.mock('../src/deepseek-harness-native-process.ts', () => ({ DeepSeekHarnessNativeProcess: class {
  start = async () => {}; stop = fixture.stop; invoke = async () => ({})
} }))
vi.mock('../src/knowledge-files.ts', () => ({ KnowledgeFiles: class {
  prepare = async () => {}; close = async () => {}; resetIdentity = async () => {}; invoke = async () => ({})
} }))
vi.mock('@deepseek-harness/product/dingtalk-auth', async original => ({
  ...await original<typeof import('@deepseek-harness/product/dingtalk-auth')>(), ensureDingTalkSession: fixture.authenticate,
}))
vi.mock('@deepseek-harness/product/bridge', () => ({ DeepSeekHarnessProductBridge: class {
  constructor(options: ProductBridgeOptions) { fixture.bridgeOptions(options) }
  dispose = fixture.dispose; invoke = fixture.invoke; invokeRuntime = async () => []
  getSession = () => ({ authenticated: true })
  subscribe = () => () => {}; refreshCatalog = fixture.refreshCatalog
  loadRuntimeBootstrap = fixture.bootstrap
} }))
beforeEach(() => {
  vi.clearAllMocks(); fixture.authenticate.mockResolvedValue({ authenticated: true })
  fixture.invoke.mockReset().mockResolvedValue({}); fixture.refreshCatalog.mockReset().mockResolvedValue()
})

it('installs saved skills through the authenticated skill operation without requiring other catalogs', async () => {
  fixture.refreshCatalog.mockRejectedValue(new ProductError('ORGANIZATION_SERVICE_UNAVAILABLE', 'Knowledge unavailable', true))
  const host = vi.fn(async () => ({}))
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: host })
  try {
    const options = fixture.authoringOptions.mock.calls[0]?.[0]
    if (!options) throw new Error('Missing authoring callbacks')
    const signal = new AbortController().signal
    await expect(options.installSkill('my-independent-skill', signal)).resolves.toBeUndefined()
    expect(fixture.invoke).toHaveBeenCalledWith('skills.install', { id: 'my-independent-skill' }, signal)
    expect(fixture.refreshCatalog).not.toHaveBeenCalled()
    expect(host).not.toHaveBeenCalled()
  } finally { await extension.close() }
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
    await expect(extension.invoke('auth.ensureDingTalk')).resolves.toEqual({ authenticated: true })
    expect(fixture.authenticate).toHaveBeenCalledTimes(2)
  } finally { first.abort(); second.abort(); await extension.close() }
})

it('retries expired DingTalk sign-in and supplies only model configuration and profile overlays to Host', async () => {
  fixture.authenticate.mockRejectedValueOnce(new DingTalkAuthorizationTimeoutError())
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  try {
    const environment = await extension.prepareHost()
    expect(fixture.authenticate).toHaveBeenCalledTimes(2)
    expect(fixture.dialog).toHaveBeenCalledWith(expect.objectContaining({ message: '钉钉登录已超时' }))
    expect(environment).toMatchObject({ DEEPSEEK_API_KEY: 'model-key' })
    expect(environment?.DEEPSEEK_HARNESS_SESSION_TOKEN).toBeUndefined()
    const saved = String(fixture.writeFile.mock.calls[0]?.[1])
    expect(saved).toContain('deepseek-v4-flash')
    expect(saved).toContain('gpt-example')
    expect(saved).not.toContain('model-key')
    expect(JSON.parse(environment!.DSH_DESKTOP_PROFILE_PATCHES!)).toContain('/unused-fixture/product-inference.patch.json')
    expect(Object.keys(environment!)).toEqual(['DEEPSEEK_HARNESS_SESSION_TOKEN', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_DESKTOP_PROFILE_PATCHES'])
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
    const pending = extension.prepareHost()
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

it('exits without writing inference configuration when startup retry is declined', async () => {
  fixture.authenticate.mockRejectedValueOnce(new DeepSeekHarnessApiError(503, 'UNAVAILABLE', 'private'))
  fixture.dialog.mockResolvedValueOnce({ response: 1 })
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  try {
    await expect(extension.prepareHost()).resolves.toBeUndefined()
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
    await expect(extension.prepareHost()).rejects.toBe(failure)
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
  const pending = extension.prepareHost()
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

it('routes device Skill install, inspection, and uninstall through the Host product namespace', async () => {
  const requestHost = vi.fn(async () => ({ id: 'document-insight' }))
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost })
  try {
    const installedSkills = fixture.bridgeOptions.mock.calls[0]?.[0].installedSkills
    expect(installedSkills).toBeDefined()
    const signal = new AbortController().signal
    await installedSkills!('install', { id: 'document-insight' }, signal)
    await installedSkills!('read', {}, signal)
    await installedSkills!('uninstall', { id: 'document-insight' }, signal)
    expect(requestHost.mock.calls).toEqual([
      ['product', 'skills.install', { id: 'document-insight' }, signal],
      ['product', 'skills.installed.read', {}, signal],
      ['product', 'skills.uninstall', { id: 'document-insight' }, signal],
    ])
  } finally { await extension.close() }
})
