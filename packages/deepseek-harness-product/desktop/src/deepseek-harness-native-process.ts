/** Product-owned supervised stdio sidecar. */

import { addAbortListener } from 'node:events'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { nativeHealth, nativeResponse, NATIVE_PROTOCOL, type NativeMethod, type NativeResponse } from './native-health.ts'

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
  readonly removeAbort: () => void
}

export class DeepSeekHarnessNativeProcess {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly pending = new Map<string, Pending>()
  private starting: Promise<void> | undefined
  private stopping: Promise<void> | undefined

  constructor(
    private readonly executable: string | undefined,
    private readonly dataDirectory: string | undefined,
  ) {}

  async start(): Promise<void> {
    if (this.stopping !== undefined) throw new Error('deepseek-harness-native stopping')
    if (this.starting !== undefined) return this.starting
    if (this.child !== undefined) return
    const starting = this.launch().finally(() => { this.starting = undefined })
    this.starting = starting
    return starting
  }

  private async launch(): Promise<void> {
    if (this.executable === undefined) throw new Error('deepseek-harness-native executable is not configured')
    if (!existsSync(this.executable)) throw new Error(`deepseek-harness-native executable is missing: ${this.executable}`)
    const child = spawn(this.executable, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...scrubbedParentEnv(),
        ...this.dataDirectory === undefined ? {} : { DEEPSEEK_HARNESS_NATIVE_DATA_DIR: this.dataDirectory } },
    })
    this.child = child
    child.stdin.on('error', (error) => { if (this.child === child) this.failAll(error) })
    child.stderr.on('data', (data) => { console.error(`deepseek-harness-native: ${String(data).trimEnd()}`) })
    child.once('error', (error) => {
      if (this.child !== child) return
      if (child.pid === undefined) this.child = undefined
      this.failAll(error)
    })
    child.once('exit', (code, signal) => {
      lines.close()
      if (this.child !== child) return
      this.child = undefined
      this.failAll(new Error(`deepseek-harness-native exited (${String(code ?? signal)})`))
    })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      try { this.receive(JSON.parse(line)) }
      catch (error) { this.failAll(error instanceof Error ? error : new Error(String(error))) }
    })
    try { nativeHealth(await this.invoke('health')) }
    catch (error) {
      try { await this.stop() }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native startup and cleanup failed') }
      throw error
    }
  }

  invoke(method: NativeMethod, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Native request aborted'))
    if (this.stopping !== undefined) return Promise.reject(new Error('deepseek-harness-native stopping'))
    const child = this.child
    if (child === undefined) return Promise.reject(new Error('deepseek-harness-native is unavailable'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failRequest(requestId, new Error('deepseek-harness-native request timed out'))
      }, 10_000)
      let listener: Disposable | undefined
      const removeAbort = () => { listener?.[Symbol.dispose]() }
      this.pending.set(requestId, { resolve, reject, timer, removeAbort })
      if (signal !== undefined) listener = addAbortListener(signal, () => {
        this.failRequest(requestId, signal.reason instanceof Error ? signal.reason : new Error('Native request aborted'))
      })
      try {
        child.stdin.write(`${JSON.stringify({ protocol: NATIVE_PROTOCOL, request_id: requestId, method })}\n`, (error) => {
          if (error != null) this.failRequest(requestId, error)
        })
      } catch (error) { this.failRequest(requestId, error instanceof Error ? error : new Error(String(error))) }
    })
  }

  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    const child = this.child
    if (child === undefined) return Promise.resolve()
    const stopping = new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const onExit = () => {
        clearTimeout(timer)
        if (this.child === child) this.child = undefined
        resolve()
      }
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

  private receive(response: unknown): void {
    let envelope: NativeResponse
    try { envelope = nativeResponse(response) }
    catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)))
      return
    }
    const pending = this.pending.get(envelope.request_id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    pending.removeAbort()
    this.pending.delete(envelope.request_id)
    if (envelope.error != null) pending.reject(new Error(envelope.error.message ?? envelope.error.code ?? 'native sidecar error'))
    else pending.resolve(envelope.result)
  }

  private failRequest(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    pending.removeAbort()
    this.pending.delete(requestId)
    pending.reject(error)
  }

  private failAll(error: Error): void {
    for (const requestId of this.pending.keys()) this.failRequest(requestId, error)
  }
}
