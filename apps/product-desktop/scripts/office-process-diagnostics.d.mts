/**
 * Select native helpers descended from one packaging process without reading arguments.
 * @param table - macOS ps pid, parent pid and executable columns.
 * @param rootPid - Owned packaging process.
 * @returns Owned native helpers, excluding other packaging operations.
 */
export function officeHelperProcesses(table: string, rootPid: number): { pid: number; parentPid: number }[]

/**
 * Observe slow native helpers, then join sampling when the packaging owner cancels.
 * @param rootPid - Owned packaging process.
 * @param directory - Private evidence directory.
 * @param options - Cancellation, observation settings and test dependencies.
 * @returns Resolves after cancellation; rejects diagnostic failures.
 */
export function observeOfficeProcesses(rootPid: number, directory: string, options: {
  signal: AbortSignal
  pollMs?: number
  sampleAfterMs?: number
  now?: () => number
  readProcesses?: (signal: AbortSignal) => Promise<string>
  sample?: (pid: number, path: string, signal: AbortSignal) => Promise<void>
}): Promise<void>
