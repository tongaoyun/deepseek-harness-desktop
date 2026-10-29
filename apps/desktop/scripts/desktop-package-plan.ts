/** Select source packages before packing with the same closure used to assemble the runtime. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { releaseFamily } from '../../../scripts/release/families.ts'
import { selectDesktopPackageClosure } from './prepare-package-set.ts'
import type { desktopTargetPlatform } from './desktop-build-paths.mjs'

/**
 * Select exact family filters and private directories required by one Desktop assembly.
 * @param root - Repository containing source package manifests.
 * @param target - Installer platform and architecture.
 * @param assembly - Runtime roots and private package directories declared by the application.
 * @returns Exact family names and private directories to pack; native entry packing remains target-owned.
 */
export function desktopPackagePlan(
  root: string,
  target: ReturnType<typeof desktopTargetPlatform>,
  assembly: { readonly runtimePackages: readonly string[]; readonly packageDirectories: readonly string[] },
): { dsh: string[]; vendor: string[]; privateDirectories: string[] } {
  const dsh = releaseFamily('dsh').members(root)
  const vendor = releaseFamily('vendor').members(root)
  const privateDirectories = ['apps/desktop-host', ...assembly.packageDirectories]
  const privatePackages = [...privateDirectories, 'native/system/packages/entry'].map(directory => ({
    directory, manifest: JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8')) as Record<string, unknown>,
  }))
  const available = new Map<string, { directory: string; manifest: Readonly<Record<string, unknown>> }>()
  for (const member of [...dsh, ...vendor, ...privatePackages]) {
    const name = member.manifest.name
    if (typeof name !== 'string' || name === '') throw new Error(`desktop package plan: ${member.directory} has no package name`)
    if (available.has(name)) throw new Error(`desktop package plan: duplicate package ${name}`)
    available.set(name, member)
  }
  const selected = new Set(selectDesktopPackageClosure(available, target, assembly.runtimePackages, root).map(member => member.directory))
  return {
    dsh: dsh.filter(member => selected.has(member.directory)).map(member => member.name),
    vendor: vendor.filter(member => selected.has(member.directory)).map(member => member.name),
    privateDirectories: privateDirectories.filter(directory => selected.has(directory)),
  }
}
