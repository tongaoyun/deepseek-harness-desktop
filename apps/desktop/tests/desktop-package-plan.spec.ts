/** Compare early source selection with the former pack-everything runtime selection. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { releaseFamily } from '../../../scripts/release/families.ts'
import { packedManifest } from '../../../scripts/release/tarball.ts'
import { readDesktopAssembly } from '../scripts/desktop-assembly.mjs'
import { desktopPackagePlan } from '../scripts/desktop-package-plan.ts'
import { prepareDesktopPackageSet } from '../scripts/prepare-package-set.ts'
import { DESKTOP_HOST_RUNTIME_FILES, DESKTOP_PACKAGES_DIR } from '../src/core-package-set.ts'

it.each([
  ['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'],
] as const)('preserves the assembled tarballs when selecting before packing for %s/%s', (platform, arch) => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-package-plan-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const write = (path: string, value: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), value)
  }
  write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*/*\n  - vendor/*\n  - native/system/packages/*\n')
  const definitions: [string, string, Record<string, unknown>][] = [
    ['apps/cli', '@deepseek-ai/dsh', { dependencies: { '@deepseek-ai/cordis': '1.0.0', '@deepseek-ai/node-addon-system': '1.0.0' } }],
    ['apps/desktop-host', '@deepseek-ai/dsh-desktop-host', { private: true }],
    ['vendor/cordis', '@deepseek-ai/cordis', {}],
    ['vendor/unused', '@deepseek-ai/unused-vendor', {}],
    ['packages/util/unused', '@deepseek-ai/dsh-unused', {}],
    ['native/system/packages/entry', '@deepseek-ai/node-addon-system', {}],
    ['packages/product/desktop', 'product-desktop', { private: true, dependencies: { 'product-extension': '1.0.0' } }],
    ['packages/product/extension', 'product-extension', { private: true, optionalDependencies: { '@deepseek-ai/dsh-macos': '1.0.0' } }],
    ['packages/util/macos', '@deepseek-ai/dsh-macos', { os: ['darwin'] }],
    ['packages/product/unused', 'product-unused', { private: true }],
  ]
  for (const [directory, name, additions] of definitions) {
    write(`${directory}/package/package.json`, JSON.stringify({ name, version: '1.0.0', ...additions }))
    write(`${directory}/package.json`, readFileSync(join(root, directory, 'package/package.json'), 'utf8'))
    if (name === '@deepseek-ai/dsh-desktop-host') {
      for (const file of DESKTOP_HOST_RUNTIME_FILES) write(`${directory}/package/${file}`, '')
    }
  }
  const assembly = { runtimePackages: ['product-desktop'], packageDirectories: ['desktop', 'extension', 'unused'].map(name => join(root, 'packages/product', name)) }
  const plan = desktopPackagePlan(root, { platform, arch }, assembly)
  expect(plan.privateDirectories).toEqual(['apps/desktop-host', ...assembly.packageDirectories.slice(0, 2)])
  expect(plan.dsh).not.toContain('@deepseek-ai/dsh-unused')
  expect(plan.dsh.includes('@deepseek-ai/dsh-macos')).toBe(platform === 'darwin')
  expect(plan.vendor).toEqual(['@deepseek-ai/cordis'])
  const selected = new Set([...plan.dsh, ...plan.vendor, 'product-desktop', 'product-extension', '@deepseek-ai/dsh-desktop-host', '@deepseek-ai/node-addon-system'])
  for (const input of ['all', 'selected']) mkdirSync(join(root, input))
  for (const [directory, name] of definitions) {
    const file = `${name.replace('@', '').replaceAll('/', '-')}.tgz`
    for (const input of selected.has(name) ? ['all', 'selected'] : ['all']) {
      execFileSync('tar', ['-czf', join(root, input, file), '-C', join(root, directory), 'package'])
    }
  }
  const names = (output: string): unknown[] => readdirSync(join(root, output, DESKTOP_PACKAGES_DIR)).map(file =>
    packedManifest(join(root, output, DESKTOP_PACKAGES_DIR, file)).name).sort()
  for (const input of ['all', 'selected']) {
    prepareDesktopPackageSet([join(root, input)], join(root, `${input}-output`), { platform, arch }, assembly.runtimePackages)
  }
  expect(names('selected-output')).toEqual(names('all-output'))
})

it.each([
  ['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'],
] as const)('keeps every product runtime package and its UI extension for %s/%s', (platform, arch) => {
  const root = resolve(import.meta.dirname, '../../..')
  const assembly = readDesktopAssembly({ DSH_DESKTOP_ASSEMBLY_MANIFEST: join(root, 'packages/deepseek-harness-product/desktop/assembly.json') }, platform)
  const plan = desktopPackagePlan(root, { platform, arch }, assembly)
  expect(plan.privateDirectories).toEqual(['apps/desktop-host', ...assembly.packageDirectories])
  expect(plan.privateDirectories.some(directory => basename(directory) === 'ui-deepseek-harness-product')).toBe(true)
  expect(plan.dsh.length).toBeLessThan(releaseFamily('dsh').members(root).length)
  expect(plan.vendor.length).toBeLessThan(releaseFamily('vendor').members(root).length)
})
