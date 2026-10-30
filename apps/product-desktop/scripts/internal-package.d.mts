/** Stable product application identifier used by internal packages. */
export const INTERNAL_APP_ID: string
/** Sign product code using the fixed keychain identity, preserving prepared-runtime bytes and signatures. */
export function signInternalApplication(appPath: string, environment: NodeJS.ProcessEnv): Promise<void>
/** Reseal modified root resources without signing nested code; strict deep verification remains required. */
export function resignInternalApplicationResources(appPath: string, environment: NodeJS.ProcessEnv): Promise<void>
/** Reject invalid application signatures and a different signing certificate or product identifier. */
export function verifyInternalApplication(appPath: string, environment: NodeJS.ProcessEnv): Promise<void>
/** Add product feeds and fixed self-signing to an official unsigned preparation. */
export function internalBuilderConfig(
  config: ReturnType<typeof import('../../desktop/scripts/electron-builder-config.mjs').createElectronBuilderConfig>,
  environment: NodeJS.ProcessEnv,
  platform: string,
): ReturnType<typeof import('../../desktop/scripts/electron-builder-config.mjs').createElectronBuilderConfig>
