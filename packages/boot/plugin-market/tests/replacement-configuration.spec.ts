/** Preinstalled plugin settings survive module substitution, restart, and application updates. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { boot, initProfile, readBundlePatches, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { expect, it, onTestFinished } from 'vitest'

it.each([true, false])('persists stable plugin names across module upgrades (existing=%s)', async (existing) => {
  const home = mkdtempSync(join(tmpdir(), 'replacement-configuration-'))
  let ctx: Awaited<ReturnType<typeof boot>> | undefined
  onTestFinished(async () => {
    try { await ctx?.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) }
  })
  const directory = join(home, 'profile')
  initProfile(directory, [])
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(directory, 'cordis.yml'), '[]\n')
  const plugin = { id: 'employee-plugin', name: 'bundled-package', config: { value: 'initial' } }
  writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'editor', name: 'cordis:editor' }, ...existing ? [plugin] : [],
  ] }]))
  const start = async (version: number) => {
    const module = join(home, `bundled-${version}.mjs`)
    writeFileSync(module, 'export function apply(ctx, config) { ctx.provide("replacementValue", config.value) }\n')
    const profile: ProfileContext = {
      name: 'test', dir: directory, patchPath: join(directory, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'), cwd: home, home, startedBundles: [], telemetryDisabledEnv: undefined,
      overlays: [...existing ? [] : [{ insert: [plugin], defaults: true }],
        { id: plugin.id, name: plugin.name, replace: pathToFileURL(module).href }],
    }
    return boot('test', join(directory, 'cordis.yml'), readProfilePatches('test', profile), (root) => {
      root.provide('profileContext', profile)
      Object.assign(root.loader.builtins, { editor: ConfigEditor })
    })
  }
  ctx = await start(1)
  expect(ctx.get('replacementValue')).toBe('initial')
  const edit = async (value: string) => {
    const entry = ctx!.configEditor.entries().find(entry => entry.options.id === plugin.id)!
    await ctx!.configEditor.edit(entry, () => ({ value }))
    expect(ctx!.get('replacementValue')).toBe(value)
  }
  await edit('edited')
  const persisted = readFileSync(join(directory, 'cordis.patch.yml'), 'utf8')
  expect(persisted).toContain('bundled-package')
  expect(persisted).not.toContain('file:')
  expect(persisted).not.toContain('bundled-1')
  await ctx.fiber.dispose()
  ctx = await start(2)
  expect(ctx.get('replacementValue')).toBe('edited')
  await edit('edited-again')
})

it('rejects non-insert default patches before loading a profile', () => {
  const profile: ProfileContext = { name: 'invalid', dir: '/unused', patchPath: '/unused/patch.yml',
    installAnchor: '/unused/package.json', cwd: '/unused', home: '/unused', startedBundles: [],
    telemetryDisabledEnv: undefined, overlays: [{ id: 'plugin', defaults: true, config: {} }] }
  expect(() => readBundlePatches('test', profile, { name: 'invalid', dir: '/unused', patchPath: '/unused/patch.yml', layers: [], patches: [], skippedBundles: [] }))
    .toThrow('default profile patches must insert')
})
