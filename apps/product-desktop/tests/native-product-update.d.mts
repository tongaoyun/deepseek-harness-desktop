import type { ElectronApplication, Page } from 'playwright'

/** Explicit restart authorization, with or without active tasks. */
export const restartConfirmation: RegExp

interface UpdateDialogWindow {
  isClosed(): boolean
  url(): string
  getByRole(role: 'button'): { allTextContents(): Promise<string[]> }
  getByRole(role: 'button', options: { name: string | RegExp; exact: true }): { isVisible(): Promise<boolean> }
}

/** Select the shell-owned confirmation instead of a same-label product status action. */
export function dialogWithButton<P extends UpdateDialogWindow>(application: { windows(): P[] },
  name: string | RegExp, timeout?: number): Promise<P>

/** Two private versions of the complete product, using its native update UI and installer. */
export interface NativeProductUpdateQualification {
  readonly initialVersion: string
  upgrade(application: ElectronApplication, page: Page, releaseOwnership: () => void): Promise<Page>
  dispose(): Promise<void>
}

/**
 * Prepare private versions with isolated services and a test-only startup bootstrap.
 * @param options - Private application and data locations, mock identity and platform signing environment.
 * @returns Native update operation and cleanup owner.
 */
export function prepareNativeProductUpdate(options: {
  installed: string; root: string; home: string; userData: string; modelUrl: string; token: string; environment: NodeJS.ProcessEnv
}): Promise<NativeProductUpdateQualification>
