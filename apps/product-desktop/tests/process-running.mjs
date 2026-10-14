/** Observe executable processes without waiting for a container's PID 1 to reap zombies. */
import { readFileSync } from 'node:fs'

/** @param {number} pid Owned fixture process. @returns {boolean} Whether it can still run; dead Linux process-table entries have already released their handles. */
export function processIsRunning(pid) {
  try {
    process.kill(pid, 0)
    if (process.platform !== 'linux') return true
    const entry = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = entry.slice(entry.lastIndexOf(')') + 2).split(' ')[0]
    if (!/^[A-Zx]$/u.test(state)) throw new Error('Unrecognized Linux process state')
    return !/^[ZXx]$/u.test(state)
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return false
    throw error
  }
}
