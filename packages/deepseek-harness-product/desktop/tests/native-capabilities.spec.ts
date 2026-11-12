/** Native profile composition preserves user control after enabling product defaults. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, initProfile, loadProfileDirectory, readProfileManifest, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'
import { expect, it, onTestFinished } from 'vitest'
import { prepareNativeCapabilities } from '../src/native-capabilities.ts'

function directory() {
  const root = mkdtempSync(join(tmpdir(), 'product-native-capabilities-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return root
}

it.each(['darwin', 'win32'] as const)('composes native browser and voice capabilities for %s', async (platform) => {
  const root = directory()
  await prepareNativeCapabilities(root, platform)
  const manifest = readProfileManifest('test', root)
  expect(manifest.dsh?.profile?.bundles).toContain('@deepseek-ai/dsh-experimental-voice-input-bundle')
  expect(manifest.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-cua-bundle')).toBe(platform === 'darwin')
  const profile = loadProfileDirectory('test', root, fileURLToPath(new URL('../package.json', import.meta.url)))
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
  await prepareNativeCapabilities(root, 'darwin')
  writeProfileBundles(root, readProfileManifest('test', root), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  const path = join(root, 'cordis.patch.yml')
  const edited = readFileSync(path, 'utf8') + '\n- id: browser-use-playwright\n  disabled: true\n'
  writeFileSync(path, edited)
  const before = readFileSync(join(root, 'package.json'), 'utf8')
  await prepareNativeCapabilities(root, 'darwin')
  expect(readFileSync(path, 'utf8')).toBe(edited)
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before)
})

it('preserves comments, expressions and an existing browser provider without inserting a second provider', async () => {
  const root = directory()
  initProfile(root, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  const path = join(root, 'cordis.patch.yml')
  writeFileSync(path, '# User configuration\n- insert:\n    - id: existing-browser\n      name: "@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp"\n      config:\n        mode: launch\n        headless: !!js process.env.HEADLESS === \'1\'\n')
  await prepareNativeCapabilities(root, 'darwin')
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
  await expect(prepareNativeCapabilities(root)).rejects.toThrow('YAML sequence')
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest)
  writeFileSync(join(root, 'cordis.patch.yml'), '[]\n')
  await prepareNativeCapabilities(root)
  expect(readProfileManifest('test', root).dsh?.profile?.bundles).toContain('@deepseek-ai/dsh-experimental-voice-input-bundle')
})
