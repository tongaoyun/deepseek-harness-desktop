/**
 * Record source and actual signing mode after successful internal packaging.
 * @param root - Repository root.
 * @param args - Explicit native target and optional build version.
 * @param environment - Internal signing mode, public feed and certificate fingerprint.
 * @returns Completion after exclusive record creation.
 */
export function writeInternalBuildRecord(root: string, args: string[], environment: NodeJS.ProcessEnv): Promise<void>
