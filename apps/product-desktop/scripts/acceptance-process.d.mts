import type { ChildProcess } from 'node:child_process'

/**
 * Terminates the live process tree owned by an acceptance command.
 * @param child - Command started in a private process group on POSIX.
 * @returns After termination is requested; Windows taskkill completion is bounded.
 */
export function terminateAcceptanceTree(child: ChildProcess): Promise<void>

/**
 * Runs and cleans up an acceptance command within its deadline.
 * @param command - Executable launched without a shell.
 * @param args - Executable arguments.
 * @param options - Environment, deadline and optional cancellation.
 * @returns After successful exit and cleanup; rejects all interrupted or failed runs.
 */
export function runAcceptanceProcess(command: string, args: string[], options: {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
}): Promise<void>
