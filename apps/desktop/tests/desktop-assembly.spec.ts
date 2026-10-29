import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readDesktopAssembly } from '../scripts/desktop-assembly.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

it('keeps the official assembly empty without an application manifest', () => {
  expect(readDesktopAssembly({})).toEqual({ runtimePackages: [], resources: [], buildSteps: [], packageDirectories: [], icons: {} })
})

it('adds application resources and icons through a platform-specific assembly', (test) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-assembly-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const manifest = join(root, 'assembly.json')
  writeFileSync(manifest, JSON.stringify({
    runtimePackages: ['example-extension'], packageDirectories: ['extension'],
    buildSteps: [['run', 'build:extension']], icons: { windows: 'windows.png' }, builderConfig: 'builder.mjs',
    resources: [
      { from: 'extension.json', to: 'desktop-extension.json' },
      { from: 'native.exe', to: 'native/example.exe', platform: 'win32' },
      { from: 'native', to: 'native/example', platform: 'darwin' },
    ],
  }))
  const env = { DSH_DESKTOP_ASSEMBLY_MANIFEST: manifest, DSH_DESKTOP_APP_ID: 'com.example.desktop',
    DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_MANDATORY_UPDATE_ENABLED: '0' }
  const assembly = readDesktopAssembly(env, 'win32')
  expect(assembly).toMatchObject({
    runtimePackages: ['example-extension'], packageDirectories: [join(root, 'extension')],
    buildSteps: [['run', 'build:extension']], icons: { windows: join(root, 'windows.png') }, builderConfig: join(root, 'builder.mjs'),
    resources: [{ from: join(root, 'extension.json'), to: 'desktop-extension.json' },
      { from: join(root, 'native.exe'), to: 'native/example.exe' }],
  })
  const config = createElectronBuilderConfig(env, 'win32', 'x64')
  expect(config.extraResources).toEqual(expect.arrayContaining(assembly.resources))
  expect(config.win.icon).toBe(join(root, 'windows.png'))
  writeFileSync(manifest, JSON.stringify({ runtimePackages: [], resources: [{ from: 'file', to: '../escape' }] }))
  expect(() => readDesktopAssembly(env)).toThrow('Invalid Desktop assembly resource')
  writeFileSync(manifest, JSON.stringify({ runtimePackages: [], resources: [], builderConfig: 42 }))
  expect(() => readDesktopAssembly(env)).toThrow('Invalid Desktop assembly builder configuration')
})
