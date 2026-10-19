/** Optional application-owned resources and runtime roots, shared by both build stages. */
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

export function readDesktopAssembly(environment = process.env, platform = process.platform) {
  const path = environment.DSH_DESKTOP_ASSEMBLY_MANIFEST
  if (path === undefined) return { runtimePackages: [], resources: [], buildSteps: [], packageDirectories: [], icons: {} }
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(value.runtimePackages) || value.runtimePackages.some(name => typeof name !== 'string')
    || !Array.isArray(value.resources)) throw new Error('Invalid Desktop assembly manifest')
  const resources = value.resources.filter(resource => resource.platform === undefined || resource.platform === platform)
    .map(resource => {
      if (typeof resource.from !== 'string' || typeof resource.to !== 'string' || isAbsolute(resource.to)
        || resource.to.split(/[\\/]/).includes('..')) throw new Error('Invalid Desktop assembly resource')
      return { from: resolve(dirname(path), resource.from), to: resource.to }
    })
  const buildSteps = value.buildSteps ?? []
  if (!Array.isArray(buildSteps) || buildSteps.some(step => !Array.isArray(step) || step.some(arg => typeof arg !== 'string'))) throw new Error('Invalid Desktop assembly build steps')
  const directories = value.packageDirectories ?? []
  if (!Array.isArray(directories) || directories.some(path => typeof path !== 'string')) throw new Error('Invalid Desktop assembly package directories')
  const icons = Object.fromEntries(Object.entries(value.icons ?? {}).map(([key, icon]) => {
    if (!['macos', 'windows', 'tray', 'development'].includes(key) || typeof icon !== 'string') throw new Error('Invalid Desktop assembly icon')
    return [key, resolve(dirname(path), icon)]
  }))
  if (value.builderConfig !== undefined && (typeof value.builderConfig !== 'string' || value.builderConfig.trim() === '')) {
    throw new Error('Invalid Desktop assembly builder configuration')
  }
  return { runtimePackages: value.runtimePackages, resources, buildSteps, icons,
    ...(value.builderConfig === undefined ? {} : { builderConfig: resolve(dirname(path), value.builderConfig) }),
    packageDirectories: directories.map(directory => resolve(dirname(path), directory)) }
}
