/** Bound a native acceptance command and terminate its owned process tree. */
import { execFile, spawn } from 'node:child_process'

/** @param {import('node:child_process').ChildProcess} child Owned command, started in a private process group on POSIX. @returns {Promise<void>} Terminates its live process tree; Windows termination is bounded to ten seconds. */
export function terminateAcceptanceTree(child) {
  if (child.pid === undefined) return Promise.resolve()
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL') }
    catch (error) { if (error.code !== 'ESRCH') return Promise.reject(error) }
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 10_000 }, error => {
        if (error && child.exitCode === null && child.signalCode === null) {
          reject(new Error('Unable to terminate installed acceptance process tree', { cause: error }))
        } else resolve()
      })
  })
}

/**
 * Run an acceptance command with an independent deadline. Cancellation and
 * timeout remain failures even if the child reports success while stopping.
 * @param {string} command Executable, launched without a shell.
 * @param {string[]} args Executable arguments.
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal}} options Command environment and deadline.
 * @returns {Promise<void>} Resolves after successful exit and cleanup; rejects on startup, exit, cancellation, timeout, or cleanup failure.
 */
export async function runAcceptanceProcess(command, args, { timeoutMs, signal, ...options }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Acceptance timeout must be a positive integer')
  signal?.throwIfAborted()
  const child = spawn(command, args, { ...options, stdio: 'inherit', detached: process.platform !== 'win32' })
  let failure
  let closed = false
  let requestStop
  const stopped = new Promise(resolve => { requestStop = resolve })
  const completion = new Promise(resolve => {
    child.once('error', error => { failure ??= error })
    child.once('close', (code, exitSignal) => {
      closed = true
      if (code !== 0 || exitSignal) failure ??= new Error(`Installed acceptance exited with code ${code}, signal ${exitSignal}`)
      resolve()
    })
  })
  const stop = reason => { failure ??= reason; requestStop() }
  const abort = () => stop(new Error('Installed acceptance was cancelled', { cause: signal.reason }))
  signal?.addEventListener('abort', abort, { once: true })
  const deadline = setTimeout(() => stop(new Error(`Installed acceptance timed out after ${timeoutMs} ms`)), timeoutMs)
  try {
    await Promise.race([completion, stopped])
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener('abort', abort)
    const cleanupErrors = []
    try { await terminateAcceptanceTree(child) }
    catch (error) {
      cleanupErrors.push(error)
      if (!closed) child.kill('SIGKILL')
    }
    try {
      if (!closed) {
        let timer
        try {
          await Promise.race([completion, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Installed acceptance process did not close after termination')), 10_000)
          })])
        } finally { clearTimeout(timer) }
      }
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Installed acceptance process cleanup failed')
  }
  if (failure) throw failure
}
