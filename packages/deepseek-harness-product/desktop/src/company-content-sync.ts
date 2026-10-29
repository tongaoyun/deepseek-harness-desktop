/** Main owns refresh coalescing, employee isolation and durable Session bindings. */
import { addAbortListener } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ProductError } from '@deepseek-harness/product/errors'
import type { CompanyContentRoots } from '@deepseek-harness/product/protocol'
import { installCompanyContent, restoreCompanyContent } from './company-content.ts'

const coordinate = z.object({
  version: z.string().regex(/^(?:0|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()
const binding = coordinate.extend({ sessionId: z.string().min(1).max(256) }).strict()
const digest = (id: string) => createHash('sha256').update(id).digest('hex')

/** One authenticated employee's catalog. Closing aborts and joins every owned operation. */
export class CompanyContentSync {
  private readonly lifecycle = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly employeeRoot: string
  private roots!: CompanyContentRoots
  private confirmed = false
  private pending: Promise<void> | undefined
  private lastChecked = -Infinity
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly options: {
    root: string
    employeeId: string
    refreshIntervalMs: number
    load: (signal: AbortSignal) => Promise<unknown>
  }) { this.employeeRoot = join(options.root, digest(options.employeeId)) }

  /** Read verified local content immediately and start the first check in background.
   * @returns Directories usable by the native catalogs during network work.
   */
  async prepare(): Promise<CompanyContentRoots> {
    this.roots = await installCompanyContent(this.options.root, this.options.employeeId, null, this.lifecycle.signal)
    try {
      const latest = coordinate.parse(await this.readJson(join(this.employeeRoot, 'latest.json')))
      this.roots = await this.restore(latest)
      this.confirmed = true
    } catch (error) {
      // A damaged latest pointer does not hide task history or replace any task binding.
      if (!missing(error)) this.lastChecked = -Infinity
    }
    void this.refresh().catch(() => { /* Page checks report the failure and offer retry. */ })
    return this.read()
  }

  /** Return the locally installed catalog without fetching credentials or remote content. */
  read(): CompanyContentRoots {
    this.lifecycle.signal.throwIfAborted()
    return this.roots
  }

  /** Check once per configured monotonic interval; concurrent expert and skill pages share work.
   * @param signal - Cancel this caller without aborting other catalog readers.
   * @returns Completion after the validated catalog and its pointer commit together.
   */
  refresh(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    this.lifecycle.signal.throwIfAborted()
    if (this.pending) return awaitShared(this.pending, signal)
    if (performance.now() - this.lastChecked < this.options.refreshIntervalMs) return Promise.resolve()
    const operation = this.track(async () => {
      const value = await this.options.load(this.lifecycle.signal)
      const roots = await installCompanyContent(this.options.root, this.options.employeeId, value, this.lifecycle.signal)
      await this.writeJson(join(this.employeeRoot, 'latest.json'), { version: roots.version, sha256: roots.sha256 })
      this.lifecycle.signal.throwIfAborted()
      this.roots = roots
      this.confirmed = true
      this.lastChecked = performance.now()
    })
    this.pending = operation
    void operation.finally(() => { if (this.pending === operation) this.pending = undefined }).catch(() => undefined)
    return awaitShared(operation, signal)
  }

  /** Persist or restore a Session's content without replacing an existing binding.
   * @param signal - Cancel waiting without replacing an already committed binding.
   * @param request - Trusted Host Session facts, never supplied by Renderer.
   * @returns Immutable directories; children use their parent's exact content.
   */
  pin(request: { sessionId: string; parentSessionId?: string | undefined; started: boolean },
    signal?: AbortSignal): Promise<CompanyContentRoots> {
    signal?.throwIfAborted()
    const operationSignal = signal === undefined ? this.lifecycle.signal : AbortSignal.any([signal, this.lifecycle.signal])
    const action = (this.queues.get(request.sessionId) ?? Promise.resolve()).then(() => this.track(async () => {
      operationSignal.throwIfAborted()
      const directory = join(this.employeeRoot, 'sessions')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('公司内容任务缓存路径不安全')
      const path = join(directory, `${digest(request.sessionId)}.json`)
      let saved: z.infer<typeof binding> | undefined
      try { saved = binding.parse(await this.readJson(path, operationSignal)) }
      catch (error) { if (!missing(error)) throw error }
      if (saved) {
        if (saved.sessionId !== request.sessionId) throw new Error('公司内容任务版本不匹配')
        return await this.restore(saved, operationSignal)
      }
      let roots: CompanyContentRoots
      if (request.parentSessionId) {
        const parent = binding.parse(await this.readJson(join(directory, `${digest(request.parentSessionId)}.json`), operationSignal))
        if (parent.sessionId !== request.parentSessionId) throw new Error('公司内容父任务版本不匹配')
        roots = await this.restore(parent, operationSignal)
      } else {
        if (request.started) throw new ProductError('COMPANY_CONTENT_BINDING_MISSING',
          '此任务缺少公司内容版本记录，请新建对话；原任务历史已保留。', false,
          [{ kind: 'session', id: request.sessionId }])
        if (!this.confirmed) await this.refresh(operationSignal)
        roots = await this.restore(this.read(), operationSignal)
      }
      await this.writeJson(path, { sessionId: request.sessionId, version: roots.version, sha256: roots.sha256 }, operationSignal)
      return roots
    }))
    const tail = action.catch(() => undefined)
    this.queues.set(request.sessionId, tail)
    void tail.finally(() => { if (this.queues.get(request.sessionId) === tail) this.queues.delete(request.sessionId) })
    return awaitShared(action, signal)
  }

  /** Cancel remote and filesystem work, then await all owned requests and queued pins. */
  async close(): Promise<void> {
    this.lifecycle.abort(new Error('公司内容同步已结束'))
    await Promise.allSettled([...this.operations, ...this.queues.values()])
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(() => {
      this.lifecycle.signal.throwIfAborted()
      return operation()
    })
    this.operations.add(pending)
    void pending.finally(() => this.operations.delete(pending)).catch(() => undefined)
    return pending
  }

  private async restore(value: { version: string; sha256: string }, signal = this.lifecycle.signal): Promise<CompanyContentRoots> {
    try {
      return await restoreCompanyContent(this.options.root, this.options.employeeId,
        value.version, value.sha256, signal)
    } catch (error) {
      signal.throwIfAborted()
      throw new ProductError('COMPANY_CONTENT_CACHE_INVALID',
        '此任务的公司内容缓存缺失或损坏，已阻止执行；原任务历史和版本记录已保留。', false,
        [{ kind: 'company-content', id: value.sha256 }], { cause: error })
    }
  }

  private async readJson(path: string, signal = this.lifecycle.signal): Promise<unknown> {
    signal.throwIfAborted()
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2048) throw new Error('公司内容版本记录已损坏')
    return JSON.parse(await readFile(path, { encoding: 'utf8', signal }))
  }

  private async writeJson(path: string, value: unknown, signal = this.lifecycle.signal): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600, signal })
      signal.throwIfAborted()
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** A cancelled page releases its waiter; shared work remains owned by the desktop. */
function awaitShared<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  signal.throwIfAborted()
  return (async () => {
    const cancelled = Promise.withResolvers<never>()
    using _listener = addAbortListener(signal, () => {
      cancelled.reject(signal.reason instanceof Error ? signal.reason : new Error('Company content request cancelled'))
    })
    return await Promise.race([cancelled.promise, pending])
  })()
}
