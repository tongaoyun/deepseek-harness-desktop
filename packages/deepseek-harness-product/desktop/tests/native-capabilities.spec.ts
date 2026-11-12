/** Native profile composition preserves user control after enabling product defaults. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, initProfile, loadOptionalPatches, loadProfileDirectory, readProfileManifest, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import * as atomicWrite from '@deepseek-ai/dsh-atomic-write'
import { expect, it, onTestFinished, vi } from 'vitest'
import { prepareNativeCapabilities } from '../src/native-capabilities.ts'

const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))

function directory() {
  const root = mkdtempSync(join(tmpdir(), 'product-native-capabilities-'))
  onTestFinished(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
  vi.stubEnv('DSH_HOME', join(root, 'home'))
  return root
}

it('cancels preparation while waiting for another writer without changing profile files', async () => {
  const root = directory()
  initProfile(root, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  const before = ['package.json', 'cordis.patch.yml'].map(path => readFileSync(join(root, path), 'utf8'))
  const acquired = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const holding = withFileLock(join(root, '.product-native-capabilities-v1'), async () => {
    acquired.resolve(undefined)
    await release.promise
  })
  onTestFinished(async () => { release.resolve(undefined); await holding })
  await acquired.promise
  const controller = new AbortController()
  const pending = prepareNativeCapabilities({ directory: root, installAnchor }, { signal: controller.signal })
  const reason = new Error('Desktop closed')
  controller.abort(reason)
  await expect(pending).rejects.toMatchObject({ name: 'AbortError', cause: reason })
  expect(['package.json', 'cordis.patch.yml'].map(path => readFileSync(join(root, path), 'utf8'))).toEqual(before)
  expect(existsSync(join(root, '.product-native-capabilities-v1'))).toBe(false)
})

it('retries a failed completion-marker write without duplicating defaults or replacing user settings', async () => {
  const root = directory()
  const marker = join(root, '.product-native-capabilities-v1')
  const write = atomicWrite.writeFileAtomic
  const failure = new Error('Marker write failed')
  const probe = vi.spyOn(atomicWrite, 'writeFileAtomic').mockImplementation(async (path, ...args) => {
    if (path === marker) throw failure
    return write(path, ...args)
  })
  onTestFinished(() => { probe.mockRestore() })
  await expect(prepareNativeCapabilities({ directory: root, installAnchor }, { platform: 'darwin' })).rejects.toBe(failure)
  expect(existsSync(marker)).toBe(false)
  const files = ['package.json', 'cordis.patch.yml']
  const before = files.map(path => readFileSync(join(root, path), 'utf8'))
  probe.mockRestore()
  await prepareNativeCapabilities({ directory: root, installAnchor }, { platform: 'darwin' })
  expect(files.map(path => readFileSync(join(root, path), 'utf8'))).toEqual(before)
  expect(existsSync(marker)).toBe(true)
})

it('preserves an existing native default preset and saved selection on first preparation', async () => {
  const root = directory()
  initProfile(root, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  writeFileSync(join(root, 'cordis.patch.yml'), '- id: agent-preset-registry\n  config:\n    default: standard\n    selectedDefault: standard\n')
  await prepareNativeCapabilities({ directory: root, installAnchor }, { platform: 'darwin' })
  const profile = loadProfileDirectory('test', root, installAnchor)
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  expect(entries.find(entry => entry.id === 'agent-preset-registry')?.config)
    .toEqual({ default: 'standard', selectedDefault: 'standard' })
})

it('applies existing browser settings after the new default insertion', async () => {
  const root = directory()
  initProfile(root, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  writeFileSync(join(root, 'cordis.patch.yml'), '- id: browser-use-playwright\n  disabled: true\n  config:\n    mode: attach\n    cdpEndpoint: http://127.0.0.1:9222\n')
  await prepareNativeCapabilities({ directory: root, installAnchor }, { platform: 'darwin' })
  const profile = loadProfileDirectory('test', root, installAnchor)
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  expect(entries.find(entry => entry.id === 'browser-use-playwright')).toMatchObject({
    disabled: true, config: { mode: 'attach', cdpEndpoint: 'http://127.0.0.1:9222' },
  })
})

it.each(['bundle', 'home'] as const)('reuses a browser provider from the native %s layer', async (layer) => {
  const root = directory()
  const patches = '- insert:\n    - id: existing-browser-registry\n      name: "@deepseek-ai/dsh-browser-use"\n    - id: existing-browser\n      name: "@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp"\n'
  const bundle = join(root, 'node_modules', 'fixture-browser-bundle')
  const home = join(root, 'home')
  if (layer === 'bundle') {
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'fixture-browser-bundle', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(bundle, 'cordis.patch.yml'), patches)
  } else {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'cordis.patch.yml'), patches)
  }
  initProfile(root, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...layer === 'bundle' ? ['fixture-browser-bundle'] : []])
  await prepareNativeCapabilities({ directory: root, installAnchor }, { platform: 'darwin' })
  const profile = loadProfileDirectory('test', root, installAnchor)
  expect(profile.skippedBundles.filter(bundle => bundle.packageName !== '@deepseek-ai/dsh-cua-bundle')).toEqual([])
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches,
    loadOptionalPatches('test', join(home, 'cordis.patch.yml')) ?? []])
  expect(entries.filter(entry => entry.name === '@deepseek-ai/dsh-browser-use').map(entry => entry.id))
    .toEqual(['existing-browser-registry'])
  expect(entries.filter(entry => entry.name.startsWith('@deepseek-ai/dsh-experimental-browser-use-')).map(entry => entry.id))
    .toEqual(['existing-browser'])
})

it.each(['darwin', 'win32'] as const)('composes native browser and voice capabilities for %s', async (platform) => {
  const root = directory()
  await prepareNativeCapabilities({ directory: root, installAnchor }, { platform })
  const manifest = readProfileManifest('test', root)
  expect(manifest.dsh?.profile?.bundles).toContain('@deepseek-ai/dsh-experimental-voice-input-bundle')
  expect(manifest.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-cua-bundle')).toBe(platform === 'darwin')
  const profile = loadProfileDirectory('test', root, installAnchor)
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  expect(profile.skippedBundles.map(bundle => bundle.packageName)).toEqual(
    platform === 'darwin' && process.platform !== 'darwin' ? ['@deepseek-ai/dsh-cua-bundle'] : [],
  )
  expect(entries.find(entry => entry.id === 'browser-use-playwright')).toMatchObject({
    name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp', config: { mode: 'launch', headless: false },
  })
  expect(entries.find(entry => entry.id === 'ui-voice-input')?.disabled).toBeUndefined()
  expect(entries.find(entry => entry.id === 'agent-preset-registry')?.config).toMatchObject({ default: platform === 'darwin' ? 'ptc' : 'standard' })
  if (platform === 'darwin' && process.platform === 'darwin') expect(entries.find(entry => entry.id === 'cua')?.config).toMatchObject({ agentPreset: 'ptc' })
})

it('retains native plugin opt-outs and browser edits across subsequent preparations', async () => {
  const root = directory()
  await prepareNativeCapabilities({ directory: root, installAnchor }, { platform: 'darwin' })
  writeProfileBundles(root, readProfileManifest('test', root), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  const path = join(root, 'cordis.patch.yml')
  const edited = readFileSync(path, 'utf8') + '\n- id: browser-use-playwright\n  disabled: true\n'
  writeFileSync(path, edited)
  const before = readFileSync(join(root, 'package.json'), 'utf8')
  await prepareNativeCapabilities({ directory: root, installAnchor }, { platform: 'darwin' })
  expect(readFileSync(path, 'utf8')).toBe(edited)
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before)
})

it('preserves comments, expressions and an existing browser provider without inserting a second provider', async () => {
  const root = directory()
  initProfile(root, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  const path = join(root, 'cordis.patch.yml')
  writeFileSync(path, '# User configuration\n- insert:\n    - id: existing-browser\n      name: "@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp"\n      config:\n        mode: launch\n        headless: !!js process.env.HEADLESS === \'1\'\n')
  await prepareNativeCapabilities({ directory: root, installAnchor }, { platform: 'darwin' })
  const patch = readFileSync(path, 'utf8')
  expect(patch).toContain('# User configuration')
  expect(patch).toContain('!!js')
  expect(patch).not.toContain('browser-use-playwright')
})

it('rejects invalid profile configuration without selecting bundles or marking preparation complete', async () => {
  const root = directory()
  initProfile(root, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  const manifest = readFileSync(join(root, 'package.json'), 'utf8')
  writeFileSync(join(root, 'cordis.patch.yml'), 'invalid: configuration\n')
  await expect(prepareNativeCapabilities({ directory: root, installAnchor })).rejects.toThrow('YAML sequence')
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest)
  writeFileSync(join(root, 'cordis.patch.yml'), '[]\n')
  await prepareNativeCapabilities({ directory: root, installAnchor })
  expect(readProfileManifest('test', root).dsh?.profile?.bundles).toContain('@deepseek-ai/dsh-experimental-voice-input-bundle')
})
