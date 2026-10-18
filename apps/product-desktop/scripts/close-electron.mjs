/** Bounded Playwright Electron shutdown for restart and final acceptance cleanup. */
import { terminateAcceptanceTree } from './acceptance-process.mjs'

/**
 * Close the application and join its process; a stalled close force-stops the tree and fails acceptance.
 * @param {{process(): import('node:child_process').ChildProcess, close(): Promise<void>}} app Electron application owned by this acceptance.
 * @param {number} timeoutMs Graceful close budget; defaults to ten seconds.
 * @returns {Promise<void>} After the owned process closes; rejects on timeout, close, or termination failure.
 */
export async function closeElectronAcceptance(app, timeoutMs = 10_000) {
  const child = app.process()
  let applicationClosed = false
  let processClosed = child.exitCode !== null || child.signalCode !== null
  let onClose = () => {}
  const closed = processClosed
    ? Promise.resolve()
    : new Promise(resolve => {
        onClose = () => { processClosed = true; resolve() }
        child.once('close', onClose)
      })
  let deadline
  let joinDeadline
  try {
    await Promise.race([
      Promise.all([app.close().then(() => { applicationClosed = true }), closed]),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error(
          `Electron acceptance close timed out after ${timeoutMs} ms: ${JSON.stringify({
            applicationClosed, processClosed, pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode,
          })}`,
        )), timeoutMs)
      }),
    ])
  } catch (error) {
    clearTimeout(deadline)
    try {
      await terminateAcceptanceTree(child)
      await Promise.race([closed, new Promise((_, reject) => {
        joinDeadline = setTimeout(() => reject(new Error('Electron acceptance process did not close after termination')), 10_000)
      })])
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Electron acceptance shutdown failed')
    }
    throw error
  } finally {
    clearTimeout(deadline)
    clearTimeout(joinDeadline)
    child.off('close', onClose)
  }
}
