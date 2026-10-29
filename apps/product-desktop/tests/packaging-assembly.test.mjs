import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createElectronBuilderConfig } from '../../desktop/scripts/electron-builder-config.mjs'
import { productPackagingAssembly } from '../scripts/packaging-assembly.mjs'

for (const platform of ['darwin', 'win32']) {
  test(`product assembly owns its service configuration, icons and Cargo sidecar on ${platform}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'harness-product-assembly-test-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const assembly = productPackagingAssembly(fileURLToPath(new URL('../../../packages/deepseek-harness-product/desktop/assembly.json', import.meta.url)), root)
    assert.deepEqual(assembly.buildSteps, [])
    const manifest = join(root, 'assembly.json')
    await writeFile(manifest, JSON.stringify(assembly))
    const config = createElectronBuilderConfig({ DSH_DESKTOP_ASSEMBLY_MANIFEST: manifest,
      DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_APP_ID: 'com.example.qualification' }, platform, 'x64')
    const service = config.extraResources.find(resource => resource.to === 'deepseek-harness/product.json')
    assert.ok(service)
    const product = JSON.parse(await readFile(service.from, 'utf8'))
    assert.equal(product.version, 1)
    assert.ok(new URL(product.serverUrl).host)
    const suffix = platform === 'win32' ? '.exe' : ''
    assert.deepEqual(config.extraResources.find(resource => resource.to === `native/deepseek-harness-native${suffix}`), {
      from: join(root, 'release', `deepseek-harness-native${suffix}`), to: `native/deepseek-harness-native${suffix}`,
    })
    assert.equal(config.extraResources.find(resource => resource.to === 'icon.png').from, assembly.icons.windows)
    assert.equal(config.extraResources.find(resource => resource.to === 'tray.ico')?.from,
      platform === 'win32' ? assembly.icons.tray : undefined)
  })
}
