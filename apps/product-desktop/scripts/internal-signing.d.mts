/** Public fingerprints of the fixed internal code-signing certificate. */
export function internalCertificateIdentity(pem: string, expectedSHA256: string, now?: number): { sha1: string; sha256: string }

/**
 * Run packaging with an isolated keychain; remove its credentials after the operation settles.
 * @param environment - Fixed PKCS#12 input, password and expected public fingerprint.
 * @param action - Packaging operation, with input secrets removed from its environment.
 * @param run - Optional credential-safe Apple command adapter; omitted executes security.
 * @returns Completion after packaging and keychain cleanup.
 */
export function withInternalMacIdentity(environment: NodeJS.ProcessEnv, action: (environment: NodeJS.ProcessEnv) => Promise<void>,
  run?: (command: string, args: string[]) => Promise<string>): Promise<void>
