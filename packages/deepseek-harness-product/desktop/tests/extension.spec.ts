import { beforeEach, expect, it, vi } from 'vitest'
import { DingTalkAuthorizationTimeoutError } from '@deepseek-harness/product/dingtalk-auth'
import type { ProductBridgeOptions } from '@deepseek-harness/product/bridge'
import { createExtension } from '../src/index.ts'

const fixture = vi.hoisted(() => ({ authenticate: vi.fn<typeof import('@deepseek-harness/product/dingtalk-auth').ensureDingTalkSession>(),
  dialog: vi.fn(async () => ({ response: 0 })),
  stop: vi.fn(async () => {}), dispose: vi.fn(), writeFile: vi.fn(), bridgeOptions: vi.fn<(options: ProductBridgeOptions) => void>() }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), writeFileSync: fixture.writeFile }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/unused-fixture', getAppPath: () => '/unused-fixture', getVersion: () => '0.1.0' },
  dialog: { showMessageBox: fixture.dialog }, shell: { openExternal: vi.fn(async () => {}) },
  safeStorage: { isEncryptionAvailable: () => false },
  screen: { getAllDisplays: () => [{ scaleFactor: 2 }] },
}))
vi.mock('../src/deepseek-harness-product-config.ts', () => ({ resolveDeepSeekHarnessProductServerUrl: () => 'https://example.test',
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
  dispose = fixture.dispose; invoke = async () => ({}); invokeRuntime = async () => []
  subscribe = () => () => {}; refreshCatalog = async () => {}
  loadRuntimeBootstrap = async () => ({ modelApiKey: 'model-key', endpoints: { litellm: 'https://example.test/v1' }, models: ['deepseek-v4-flash', 'gpt-example'] })
} }))
beforeEach(() => { vi.clearAllMocks(); fixture.authenticate.mockResolvedValue({ authenticated: true }) })

it('retries expired DingTalk sign-in and supplies only model configuration and profile overlays to Host', async () => {
  fixture.authenticate.mockRejectedValueOnce(new DingTalkAuthorizationTimeoutError())
  const extension = createExtension({ getWindow: () => undefined, isQuitting: () => false, requestHost: async () => ({}) })
  try {
    const environment = await extension.prepareHost()
    expect(fixture.authenticate).toHaveBeenCalledTimes(2)
    expect(fixture.dialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'DingTalk sign-in timed out' }))
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
