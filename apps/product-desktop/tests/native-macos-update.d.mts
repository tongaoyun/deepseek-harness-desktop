import type { ElectronApplication, Page } from 'playwright'

/** Two private versions of the complete product, using its native update UI and installer. */
export interface NativeMacUpdateQualification {
  readonly initialVersion: string
  upgrade(application: ElectronApplication, page: Page, releaseOwnership: () => void): Promise<Page>
  dispose(): Promise<void>
}

/**
 * Prepare fixed-signed versions with isolated services and a test-only startup bootstrap.
 * @param options - Private application and data locations, mock identity and imported signing environment.
 * @returns Native update operation and cleanup owner.
 */
export function prepareNativeMacUpdate(options: {
  installed: string; root: string; home: string; userData: string; modelUrl: string; token: string; environment: NodeJS.ProcessEnv
}): Promise<NativeMacUpdateQualification>
