export function readDesktopAssembly(environment?: NodeJS.ProcessEnv, platform?: string): {
  runtimePackages: string[]
  resources: { from: string; to: string }[]
  buildSteps: string[][]
  packageDirectories: string[]
  icons: Partial<Record<'macos' | 'windows' | 'tray' | 'development', string>>
  builderConfig?: string
}
