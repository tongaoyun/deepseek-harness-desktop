/**
 * Observes whether an owned fixture process can still execute.
 * @param pid - Fixture process identifier.
 * @returns False for absent processes and dead Linux process-table entries.
 */
export function processIsRunning(pid: number): boolean
