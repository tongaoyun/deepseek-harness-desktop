/** Product-owned inputs for the generic desktop packaging pipeline. */
export interface ProductAssembly {
  readonly builderConfig?: string
  readonly runtimePackages: readonly string[]
  readonly buildSteps: readonly (readonly string[])[]
  readonly packageDirectories: readonly string[]
  readonly icons: Readonly<Record<string, string>>
  readonly resources: readonly { readonly from: string; readonly to: string; readonly platform?: string }[]
}

/**
 * Resolve native binaries and preserve resource paths when relocating a manifest.
 * @param manifestPath - Product-owned assembly source.
 * @param cargoTargetDirectory - Effective absolute target directory returned by Cargo metadata.
 * @returns Assembly with absolute source paths and platform-specific native binaries.
 */
export function productPackagingAssembly(manifestPath: string, cargoTargetDirectory: string): ProductAssembly
