/** Product-owned supervised stdio sidecar. */

import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'

interface NativeResponse {
  readonly protocol?: string
  readonly request_id?: string
  readonly result?: unknown
  readonly error?: { readonly code?: string; readonly message?: string } | null
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
  readonly removeAbort: () => void
}

export class DeepSeekHarnessNativeProcess {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly pending = new Map<string, Pending>()
  private stopping: Promise<void> | undefined

  constructor(
    private readonly executable: string | undefined,
    private readonly dataDirectory: string | undefined,
  ) {}

  async start(): Promise<void> {
    if (this.child !== undefined) return
    if (this.executable === undefined) throw new Error('deepseek-harness-native executable is not configured')
    if (!existsSync(this.executable)) throw new Error(`deepseek-harness-native executable is missing: ${this.executable}`)
    const child = spawn(this.executable, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, DEEPSEEK_HARNESS_SESSION_TOKEN: undefined,
        ...this.dataDirectory === undefined ? {} : { DEEPSEEK_HARNESS_NATIVE_DATA_DIR: this.dataDirectory } },
    })
    this.child = child
    child.stderr.on('data', (data) => { console.error(`deepseek-harness-native: ${String(data).trimEnd()}`) })
    child.once('error', (error) => { this.child = undefined; this.failAll(error) })
    child.once('exit', (code, signal) => {
      this.child = undefined
      this.failAll(new Error(`deepseek-harness-native exited (${String(code ?? signal)})`))
    })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      try { this.receive(JSON.parse(line) as NativeResponse) }
      catch (error) { this.failAll(error instanceof Error ? error : new Error(String(error))) }
    })
    await this.invoke('health')
  }

  invoke(method: string, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Native request aborted'))
    const child = this.child
    if (child === undefined) return Promise.reject(new Error('deepseek-harness-native is unavailable'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.get(requestId)?.removeAbort()
        this.pending.delete(requestId)
        reject(new Error('deepseek-harness-native request timed out'))
      }, 10_000)
      const abort = () => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Native request aborted'))
      }
      const removeAbort = () => signal?.removeEventListener('abort', abort)
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(requestId, { resolve, reject, timer, removeAbort })
      child.stdin.write(`${JSON.stringify({ protocol: 'deepseek-harness.native.v1', request_id: requestId, method, payload })}\n`, (error) => {
        if (error !== undefined && error !== null) {
          clearTimeout(timer)
          removeAbort()
          this.pending.delete(requestId)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
  }

  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    const child = this.child
    if (child === undefined) return Promise.resolve()
    const stopping = new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const onExit = () => { clearTimeout(timer); resolve() }
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        timer = setTimeout(() => {
          child.off('exit', onExit)
          reject(new Error('deepseek-harness-native did not exit after SIGKILL'))
        }, 2_000)
      }, 2_000)
      child.once('exit', onExit)
      this.failAll(new Error('deepseek-harness-native stopping'))
      child.kill('SIGTERM')
    }).finally(() => { this.stopping = undefined })
    this.stopping = stopping
    return stopping
  }

  private receive(response: NativeResponse): void {
    if (response.protocol !== 'deepseek-harness.native.v1' || typeof response.request_id !== 'string') return
    const pending = this.pending.get(response.request_id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    pending.removeAbort()
    this.pending.delete(response.request_id)
    if (response.error != null) pending.reject(new Error(response.error.message ?? response.error.code ?? 'native sidecar error'))
    else pending.resolve(response.result)
  }

  private failAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.removeAbort()
      this.pending.delete(requestId)
      pending.reject(error)
    }
  }
}
