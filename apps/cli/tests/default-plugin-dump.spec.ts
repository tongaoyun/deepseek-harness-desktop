/** Config dumps use the same preinstalled defaults and employee overrides as runtime profiles. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeEntries, initProfile, loadProfileDirectory, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { expect, it, onTestFinished, vi } from 'vitest'
import { collectConfigDumpLayers } from '../src/dump-config.ts'

it('composes default inserts before user edits before later overlays', () => {
  const home = mkdtempSync(join(tmpdir(), 'default-plugin-dump-'))
  onTestFinished(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })
  vi.stubEnv('DSH_HOME', home)
  const directory = join(home, 'profile')
  initProfile(directory, [])
  const user = [{ id: 'plugin', name: 'stable-package', config: { value: 'employee' } }]
  const overlays = [{ defaults: true, insert: [{ id: 'plugin', name: 'stable-package', config: { value: 'default' } }] },
    { id: 'plugin', name: 'stable-package', disabled: true }]
  writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify(user))
  const file = join(home, 'overlay.json')
  writeFileSync(file, JSON.stringify(overlays))
  const loaded = loadProfileDirectory('test', directory, join(home, 'package.json'))
  const context: ProfileContext = { name: 'test', dir: directory, patchPath: loaded.patchPath, installAnchor: join(home, 'package.json'),
    home, cwd: home, startedBundles: [], telemetryDisabledEnv: undefined, overlays }
  const dumped = composeEntries(collectConfigDumpLayers(loaded, false, [file]).map(layer => layer.patches))
  expect(dumped).toEqual(composeEntries([readProfilePatches('test', context, loaded)]))
  expect(dumped).toEqual([{ id: 'plugin', name: 'stable-package', config: { value: 'employee' }, disabled: true }])
})
