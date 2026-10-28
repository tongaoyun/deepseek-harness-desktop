/** Correlated Host-to-main extension requests for product data. */

import { addAbortListener } from 'node:events'
import { randomUUID } from 'node:crypto'
import { ProductError, isProductFailure, type ProductFailure } from '@deepseek-harness/product/errors'
import type { ProductRuntimeMethod } from '@deepseek-harness/product/protocol'

const PRODUCT_REQUEST_TIMEOUT_MS = 60_000

interface ProductResultMessage {
  readonly type: 'extension-result'
  readonly requestId: string
  readonly result?: unknown
  readonly error?: string
  readonly failure?: ProductFailure
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly removeAbort?: () => void
}

/** Private product RPC client over the Electron parent IPC channel. */
export class DeepSeekHarnessProductIpc {
  private readonly pending = new Map<string, PendingRequest>()
  private closed = false

  /** Request one allowlisted product operation from Electron main.
   * @param method - Product operation accepted by the main-process bridge.
   * @param payload - Operation input without credentials.
   * @param signal - Optional caller cancellation propagated to Electron main.
   * @param timeoutMs - Optional trusted operation deadline, at most 30 minutes.
   * @returns The main-process result.
   */
  invoke(method: ProductRuntimeMethod, payload?: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000)) {
      return Promise.reject(new ProductError('KNOWLEDGE_REQUEST_INVALID', 'Invalid file request timeout', false))
    }
    if (this.closed || !process.connected || process.send === undefined) {
      return Promise.reject(new Error('deepseek-harness product: Electron main is unavailable'))
    }
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('deepseek-harness product: request cancelled'))
    }
    const requestId = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failRequest(requestId, new Error(`deepseek-harness product: ${method} timed out`), true)
      }, timeoutMs ?? (method === 'connectors.list' ? 2 * 600_000 + PRODUCT_REQUEST_TIMEOUT_MS : PRODUCT_REQUEST_TIMEOUT_MS))
      timer.unref()
      let listener: Disposable | undefined
      this.pending.set(requestId, { resolve, reject, timer, removeAbort: () => { listener?.[Symbol.dispose]() } })
      if (signal !== undefined) listener = addAbortListener(signal, () => {
        this.failRequest(requestId, signal.reason instanceof Error ? signal.reason : new Error('deepseek-harness product: request cancelled'), true)
      })
      try {
        process.send?.({ type: 'extension-invoke', namespace: 'product', requestId, method, payload }, (error) => {
          if (error != null) this.failRequest(requestId, error)
        })
      } catch (error) { this.failRequest(requestId, error instanceof Error ? error : new Error(String(error))) }
    })
  }

  /** Settle a correlated response received by the Host process.
   * @param message - Candidate parent-process message.
   * @returns Whether this client consumed the message.
   */
  handle(message: unknown): boolean {
    if (!isProductResultMessage(message)) return false
    const pending = this.pending.get(message.requestId)
    if (pending === undefined) return true
    clearTimeout(pending.timer)
    pending.removeAbort?.()
    this.pending.delete(message.requestId)
    if (message.error === undefined) pending.resolve(message.result)
    else pending.reject(message.failure === undefined ? new Error(message.error)
      : new ProductError(message.failure.code, message.failure.message, message.failure.retryable, message.failure.resources,
        { dependencyChecks: message.failure.dependencyChecks }))
    return true
  }

  /** Reject every outstanding request and prevent new work.
   * @param reason - Lifecycle reason reported to pending callers.
   */
  close(reason = 'Host stopped'): void {
    if (this.closed) return
    this.closed = true
    for (const requestId of this.pending.keys()) {
      this.failRequest(requestId, new Error(`deepseek-harness product: ${reason}`), true)
    }
  }

  private failRequest(requestId: string, error: Error, cancel = false): void {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    pending.removeAbort?.()
    this.pending.delete(requestId)
    pending.reject(error)
    if (cancel) this.cancel(requestId)
  }

  private cancel(requestId: string): void {
    if (!process.connected) return
    try {
      process.send?.({ type: 'extension-cancel', requestId }, (_error) => {
        // Cancellation is advisory; a closed parent channel cannot undo local settlement.
      })
    } catch (_error) {
      // The parent channel can close between the connected check and this send.
    }
  }
}

function isProductResultMessage(value: unknown): value is ProductResultMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return candidate.type === 'extension-result'
    && typeof candidate.requestId === 'string'
    && candidate.requestId.length >= 8
    && candidate.requestId.length <= 128
    && (candidate.error === undefined || typeof candidate.error === 'string')
    && (candidate.failure === undefined || isProductFailure(candidate.failure))
}
