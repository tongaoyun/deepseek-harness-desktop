/** Native dialogs can outlive IPC cancellation; late choices must not trigger work. */
import { addAbortListener } from 'node:events'

/** Await a native selection only while its owning request remains active.
 * @param open - Starts the main-owned native dialog.
 * @param signal - Request cancellation or desktop disposal.
 * @returns Selected result, rejecting promptly when its owner cancels.
 */
export function waitForNativeDialog<T>(open: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (signal === undefined) return open()
  return waitForChoice(open, signal)
}

async function waitForChoice<T>(open: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const cancelled = Promise.withResolvers<never>()
  using _listener = addAbortListener(signal, () => { cancelled.reject(dialogError(signal.reason)) })
  try { return await Promise.race([cancelled.promise, new Promise<T>((resolve) => { resolve(open()) })]) }
  catch (error) { throw dialogError(error) }
}

function dialogError(reason: unknown): Error { return reason instanceof Error ? reason : new Error('Native dialog operation failed') }
