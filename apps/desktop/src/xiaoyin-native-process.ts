/** Supervised stdio sidecar for product-only native capabilities. */

import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'

interface NativeResponse {
  readonly protocol?: string
  readonly request_id?: string
  readonly result?: unknown
  readonly error?: { readonly code?: string; readonly message?: string }
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

export class XiaoyinNativeProcess {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly pending = new Map<string, Pending>()
  private stopping: Promise<void> | undefined

  constructor(
    private readonly executable: string | undefined,
    private readonly dataDirectory: string | undefined,
  ) {}

  async start(): Promise<void> {
    if (this.child !== undefined || this.executable === undefined || !existsSync(this.executable)) return
    const child = spawn(this.executable, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.dataDirectory === undefined
        ? process.env
        : { ...process.env, XIAOYIN_NATIVE_DATA_DIR: this.dataDirectory },
    })
    this.child = child
    child.stderr.on('data', (data) => { console.error(`xiaoyin-native: ${String(data).trimEnd()}`) })
    child.once('error', (error) => { this.failAll(error) })
    child.once('exit', (code, signal) => {
      this.child = undefined
      if (code !== 0 && signal !== 'SIGTERM') this.failAll(new Error(`xiaoyin-native exited (${String(code ?? signal)})`))
    })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      try { this.receive(JSON.parse(line) as NativeResponse) }
      catch (error) { this.failAll(error instanceof Error ? error : new Error(String(error))) }
    })
    await this.invoke('health')
  }

  invoke(method: string, payload?: unknown): Promise<unknown> {
    const child = this.child
    if (child === undefined) return Promise.reject(new Error('xiaoyin-native is unavailable'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('xiaoyin-native request timed out'))
      }, 10_000)
      this.pending.set(requestId, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ protocol: 'xiaoyin.native.v1', request_id: requestId, method, payload })}\n`, (error) => {
        if (error !== undefined) {
          clearTimeout(timer)
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
    const stopping = new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.failAll(new Error('xiaoyin-native stopped')); child.kill('SIGTERM'); resolve(undefined) }, 2_000)
      child.once('exit', () => { clearTimeout(timer); resolve(undefined) })
      this.failAll(new Error('xiaoyin-native stopping'))
      child.kill('SIGTERM')
    }).finally(() => { this.stopping = undefined; this.child = undefined })
    this.stopping = stopping
    return stopping
  }

  private receive(response: NativeResponse): void {
    if (response.protocol !== 'xiaoyin.native.v1' || typeof response.request_id !== 'string') return
    const pending = this.pending.get(response.request_id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pending.delete(response.request_id)
    if (response.error !== undefined) pending.reject(new Error(response.error.message ?? response.error.code ?? 'native sidecar error'))
    else pending.resolve(response.result)
  }

  private failAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.reject(error)
    }
  }
}
