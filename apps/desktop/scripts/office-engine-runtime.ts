/** Resolve and verify the Office engine required by one Desktop target. */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { selectOfficeEngine } from '../../../scripts/libreoffice-packages.mjs'

export interface DesktopOfficeTarget {
  readonly platform: string
  readonly arch: string
}

export interface DesktopOfficeEngine {
  readonly engine: string
  readonly packageName: string
  readonly versionRange: string
  readonly manifestPath: string
}

interface OfficeKitManifest {
  readonly optionalDependencies?: Record<string, string>
}

/** Read the adapter declaration that selects the target-specific Office engine. */
export function resolveDesktopOfficeEngine(
  modules: string,
  target: DesktopOfficeTarget,
): DesktopOfficeEngine {
  const adapterPath = join(modules, '@deepseek-ai', 'libreoffice-kit', 'package.json')
  const manifest = JSON.parse(readFileSync(adapterPath, 'utf8')) as OfficeKitManifest
  const engine = selectOfficeEngine(manifest, target)
  const packageName = `@deepseek-ai/libreoffice-kit-${engine}`
  const versionRange = manifest.optionalDependencies?.[packageName]
  if (typeof versionRange !== 'string' || versionRange.length === 0) {
    throw new Error(`desktop runtime: ${packageName} has no declared version`)
  }
  return {
    engine,
    packageName,
    versionRange,
    manifestPath: join(modules, '@deepseek-ai', `libreoffice-kit-${engine}`, 'prebuilds.json'),
  }
}

/** Optional native packages may be skipped after a registry transport failure. */
export function desktopOfficeEnginePresent(engine: DesktopOfficeEngine): boolean {
  return existsSync(engine.manifestPath)
}

/** Make a skipped optional engine a required install without changing its declared version. */
export function desktopOfficeEngineInstallArguments(engine: DesktopOfficeEngine): readonly string[] {
  return ['add', '--save-prod', '--save-exact', `${engine.packageName}@${engine.versionRange}`]
}
