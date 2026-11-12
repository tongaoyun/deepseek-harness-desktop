/** Seed native opt-ins once; subsequent changes belong to the native plugin manager. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeEntries, initProfile, loadOverlayPatches, PROFILE_PATCH_FILENAME, readProfileManifest, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'
import { isSeq, parseDocument } from 'yaml'

/**
 * Enable the shipped CUA and voice bundles and configure native Playwright browser tools.
 * The completion marker preserves later user opt-outs across desktop restarts and upgrades.
 * @param directory - Native Desktop profile directory, prepared before the Host starts.
 * @param platform - Host platform; the native CUA bundle supports macOS only.
 */
export async function prepareNativeCapabilities(directory: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const marker = join(directory, '.product-native-capabilities-v1')
  const template = PROFILE_TEMPLATES.web
  if (template === undefined) throw new Error('Native Web profile template is unavailable')
  initProfile(directory, template.bundles)
  await withFileLock(marker, async () => {
    if (existsSync(marker)) return
    const path = join(directory, PROFILE_PATCH_FILENAME)
    const document = parseDocument(readFileSync(path, 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    })
    const error = document.errors[0]
    if (error !== undefined) throw error
    if (!isSeq(document.contents)) throw new Error('Desktop profile patch must be a YAML sequence')
    const manifest = readProfileManifest('product', directory)
    const bundles = [...manifest.dsh?.profile?.bundles ?? []]
    const additions = ['@deepseek-ai/dsh-experimental-voice-input-bundle',
      ...platform === 'darwin' ? ['@deepseek-ai/dsh-cua-bundle'] : []]
    for (const name of additions) if (!bundles.includes(name)) bundles.push(name)
    const entries = composeEntries([loadOverlayPatches('product', path)])
    for (const entry of entries) if (entry.group && Array.isArray(entry.config)) entries.push(...entry.config as typeof entries)
    const browserProviders = ['playwright-mcp', 'chrome-devtools-mcp', 'stagehand-native']
      .map(provider => `@deepseek-ai/dsh-experimental-browser-use-${provider}`)
    const insert = []
    if (!entries.some(entry => entry.name === '@deepseek-ai/dsh-browser-use')) {
      insert.push({ id: 'browser-use', name: '@deepseek-ai/dsh-browser-use' })
    }
    if (!entries.some(entry => browserProviders.includes(entry.name))) {
      insert.push({ id: 'browser-use-playwright', name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp',
        config: { mode: 'launch', headless: false } })
    }
    if (insert.length > 0) document.add({ insert })
    if (platform === 'darwin') document.add({ id: 'agent-preset-registry', config: { default: 'ptc' } })
    await writeFileAtomic(path, String(document), { mode: 0o600 })
    writeProfileBundles(directory, manifest, bundles)
    await writeFileAtomic(marker, '1\n', { mode: 0o600 })
  })
}
