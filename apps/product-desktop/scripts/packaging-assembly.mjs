/** Resolve product-owned resources using Cargo's effective target directory. */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Make an application manifest independent of its temporary file location.
 * @param {string} manifestPath Product-owned assembly source.
 * @param {string} cargoTargetDirectory Effective absolute target directory returned by Cargo metadata.
 * @returns {object} Assembly with absolute source paths and platform-specific native binaries.
 */
export function productPackagingAssembly(manifestPath, cargoTargetDirectory) {
  const source = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const base = dirname(manifestPath)
  return {
    ...source,
    // The product entrypoint builds and verifies the Cargo binary before delegation.
    buildSteps: [],
    ...(source.builderConfig === undefined ? {} : { builderConfig: resolve(base, source.builderConfig) }),
    packageDirectories: source.packageDirectories.map(path => resolve(base, path)),
    icons: Object.fromEntries(Object.entries(source.icons).map(([key, path]) => [key, resolve(base, path)])),
    resources: source.resources.map(resource => ({ ...resource,
      from: resource.to === 'native/deepseek-harness-native.exe'
        ? join(cargoTargetDirectory, 'release', 'deepseek-harness-native.exe')
        : resource.to === 'native/deepseek-harness-native'
          ? join(cargoTargetDirectory, 'release', 'deepseek-harness-native')
          : resolve(base, resource.from),
    })),
  }
}
