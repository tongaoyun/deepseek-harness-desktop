/** Product credential policy is mounted by the shipped Loader patches. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import ProductCredentials from '../src/credentials.ts'

it('disables native storage once and mounts the product provider with native configuration and initialization', async () => {
  const home = await mkdtemp(join(tmpdir(), 'product-credentials-loader-'))
  const contexts: Awaited<ReturnType<typeof boot>>[] = []
  onTestFinished(async () => {
    for (const ctx of contexts) await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DSH_PRODUCT_MODEL_API_KEY: old-key\n  PERSONAL_KEY: personal-key\n', { mode: 0o600 })
  const config = join(home, 'cordis.yml')
  await writeFile(config, JSON.stringify([{ id: 'credentials', name: 'cordis:local-credentials', config: { dshHome: home, watch: false } }]))
  const patches = loadOverlayPatches('test', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
  // Source tests remap only the artifact import; all shipped patch operations reach the native Loader.
  for (const patch of patches) for (const entry of patch.insert ?? []) {
    if (entry.id !== 'product-credentials') continue
    expect(entry.name).toBe(new URL('../lib/credentials.js', import.meta.url).href)
    entry.name = 'cordis:product-credentials'
  }
  const ctx = await boot('test', config, [...patches,
    { id: 'product-runtime', disabled: true },
    { id: 'product-credentials', config: { dshHome: home, watch: false } },
  ], (ctx) => {
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { DSH_PRODUCT_MODEL_API_KEY: 'employee-key' } }]))
    Object.assign(ctx.loader.builtins, { 'local-credentials': LocalCredentialProvider, 'product-credentials': ProductCredentials })
  })
  contexts.push(ctx)
  expect(ctx.credentials).toBeInstanceOf(ProductCredentials)
  expect(await ctx.credentials.resolve(credentialRef('DSH_PRODUCT_MODEL_API_KEY'))).toEqual({ value: 'employee-key', source: 'env' })
  expect(await ctx.credentials.resolve(credentialRef('PERSONAL_KEY'))).toEqual({ value: 'personal-key', source: 'file' })
  await ctx.fiber.dispose()
  expect(ctx.get('credentials')).toBeUndefined()
})
