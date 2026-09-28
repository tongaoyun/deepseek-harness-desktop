import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  desktopOfficeEngineInstallArguments,
  desktopOfficeEnginePresent,
  resolveDesktopOfficeEngine,
} from '../scripts/office-engine-runtime.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function modulesWithOfficeManifest(optionalDependencies: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-engine-'))
  roots.push(root)
  const modules = join(root, 'node_modules')
  const adapter = join(modules, '@deepseek-ai', 'libreoffice-kit')
  await mkdir(adapter, { recursive: true })
  await writeFile(join(adapter, 'package.json'), JSON.stringify({ optionalDependencies }))
  return modules
}

describe('Desktop Office engine recovery', () => {
  it('uses the adapter-declared native package and version for a required retry', async () => {
    const modules = await modulesWithOfficeManifest({
      '@deepseek-ai/libreoffice-kit-wasm': '0.1.2',
      '@deepseek-ai/libreoffice-kit-win32-x64': '0.1.2',
    })
    const engine = resolveDesktopOfficeEngine(modules, { platform: 'win32', arch: 'x64' })

    expect(engine).toMatchObject({
      engine: 'win32-x64',
      packageName: '@deepseek-ai/libreoffice-kit-win32-x64',
      versionRange: '0.1.2',
    })
    expect(desktopOfficeEnginePresent(engine)).toBe(false)
    expect(desktopOfficeEngineInstallArguments(engine)).toEqual([
      'add', '--save-prod', '--save-exact', '@deepseek-ai/libreoffice-kit-win32-x64@0.1.2',
    ])

    await mkdir(join(modules, '@deepseek-ai', 'libreoffice-kit-win32-x64'), { recursive: true })
    await writeFile(engine.manifestPath, '{}')
    expect(desktopOfficeEnginePresent(engine)).toBe(true)
  })

  it('rejects a selected engine without a declared package version', async () => {
    const modules = await modulesWithOfficeManifest({
      '@deepseek-ai/libreoffice-kit-wasm': 12,
    })
    expect(() => resolveDesktopOfficeEngine(modules, { platform: 'linux', arch: 'x64' }))
      .toThrow(/has no declared version/u)
  })
})
