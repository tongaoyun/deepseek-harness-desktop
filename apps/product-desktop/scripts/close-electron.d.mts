import type { ChildProcess } from 'node:child_process'

/**
 * Closes an owned Electron application, terminating its tree and failing if shutdown stalls.
 * @param app - Application owned by the acceptance.
 * @param timeoutMs - Graceful close budget in milliseconds.
 * @returns After the process closes; rejects on shutdown failure.
 */
export function closeElectronAcceptance(app: { process(): ChildProcess; close(): Promise<void> }, timeoutMs?: number): Promise<void>
