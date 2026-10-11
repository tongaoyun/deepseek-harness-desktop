/** Native dialogs can outlive IPC cancellation; late choices must not trigger work. */

/** Await a native selection only while its owning request remains active.
 * @param open - Starts the main-owned native dialog.
 * @param signal - Request cancellation or desktop disposal.
 * @returns Selected result, rejecting promptly when its owner cancels.
 */
export function waitForNativeDialog<T>(open: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (signal === undefined) return open()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      complete()
    }
    const onAbort = (): void => { finish(() => { reject(dialogError(signal.reason)) }) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      void open().then((value) => { finish(() => { resolve(value) }) },
        (error: unknown) => { finish(() => { reject(dialogError(error)) }) })
    } catch (error) { finish(() => { reject(dialogError(error)) }) }
    if (signal.aborted) onAbort()
  })
}

function dialogError(reason: unknown): Error { return reason instanceof Error ? reason : new Error('Native dialog operation failed') }
