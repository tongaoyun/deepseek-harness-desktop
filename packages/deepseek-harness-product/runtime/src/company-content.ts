/** Native plugins read the latest catalog; each Agent resolves an immutable Session binding. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-query'
import { z } from 'zod'
import { addAbortListener } from 'node:events'
import type { CompanyContentRoots, CompanyContentSource } from '@deepseek-harness/product/protocol'
import type { DeepSeekHarnessProductIpc } from './deepseek-harness-product-ipc.ts'

const rootsSchema = z.object({ version: z.string().min(1).max(80), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  skillsRoot: z.string().min(1), expertsRoot: z.string().min(1) }).strict()

interface BindingRequest {
  readonly controller: AbortController
  readonly result: Promise<CompanyContentRoots>
  readers: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { companyContent: CompanyContent }
}

/** Credential-free company content source exposed only inside the product Host. */
export class CompanyContent extends Service implements CompanyContentSource {
  private readonly lifecycle = new AbortController()
  private readonly pendingBindings = new Map<string, BindingRequest>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly prompted = new WeakSet<Agent>()

  constructor(ctx: Context, private readonly product: Pick<DeepSeekHarnessProductIpc, 'invoke'>) {
    super(ctx, 'companyContent')
    ctx.on('agent/created', async ({ agent, signal }) => {
      try { await this.installVersion(agent, signal) }
      catch (_error) {
        // Content failure blocks execution, while the native Session keeps its history and draft.
        this.lifecycle.signal.throwIfAborted()
        signal?.throwIfAborted()
      }
    })
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      await this.installVersion(agent, signal)
      return next()
    })
    ctx.effect(() => async () => {
      this.lifecycle.abort(new Error('Company content plugin unloaded'))
      await Promise.allSettled([...this.operations])
    }, 'company-content.lifecycle')
  }

  private async installVersion(agent: Agent, signal?: AbortSignal): Promise<void> {
    const version = await this.forSession(agent.id, signal)
    if (this.prompted.has(agent)) return
    const prompt = agent.ctx.get('systemPrompt')
    if (!prompt) throw new Error('Company content requires the native system prompt service')
    agent.ctx.effect(() => prompt.context({ name: 'company-content-version', order: 120, required: true,
      text: `Company content version: ${version.version}; SHA-256: ${version.sha256}.`,
    }), 'company-content.session-version')
    this.prompted.add(agent)
  }

  /** Read installed content without a network check.
   * @param signal - Optional reader cancellation; omission uses the plugin lifetime.
   * @returns Validated local catalog roots.
   */
  read(signal?: AbortSignal): Promise<CompanyContentRoots> {
    return this.track(signal, async control => rootsSchema.parse(
      await this.product.invoke('runtime.companyContent.read', undefined, control)))
  }

  /** Refresh through main while keeping the last successful catalog available.
   * @param signal - Optional caller cancellation; shared synchronization remains owned by main.
   */
  async refresh(signal?: AbortSignal): Promise<void> {
    await this.track(signal, control => this.product.invoke('runtime.companyContent.refresh', undefined, control))
  }

  private async track<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const control = signal === undefined ? this.lifecycle.signal : AbortSignal.any([signal, this.lifecycle.signal])
    const pending = Promise.resolve().then(async () => {
      control.throwIfAborted()
      const value = await operation(control)
      control.throwIfAborted()
      return value
    })
    this.operations.add(pending)
    try { return await pending }
    finally { this.operations.delete(pending) }
  }

  /** Resolve one real Session; resumed tasks and child Agents keep their original content.
   * @param sessionId - Native Session identity supplied by its Agent.
   * @param signal - Cancel this reader; the last reader also cancels main-process verification.
   * @returns Roots revalidated by main; only concurrent requests share a check.
   */
  async forSession(sessionId: string, signal = this.lifecycle.signal): Promise<CompanyContentRoots> {
    signal = AbortSignal.any([signal, this.lifecycle.signal])
    signal.throwIfAborted()
    let pending = this.pendingBindings.get(sessionId)
    if (!pending) {
      const session = this.ctx.sessions.get(SessionId(sessionId))
      if (!session) throw new Error('Company content requires an existing Session')
      const controller = new AbortController()
      const operationSignal = AbortSignal.any([controller.signal, this.lifecycle.signal])
      const result = (async () => {
        using observation = await this.ctx.sessionQuery.observeSession(session.id, { signal: operationSignal })
        operationSignal.throwIfAborted()
        const value = await this.product.invoke('runtime.companyContent.pin', { sessionId,
          ...session.header.parentSession === undefined ? {} : { parentSessionId: session.header.parentSession },
          started: observation.events.some(event => event.type === 'request/header'),
        }, operationSignal)
        operationSignal.throwIfAborted()
        return rootsSchema.parse(value)
      })()
      pending = { controller, result, readers: 0 }
      const request = pending
      this.pendingBindings.set(sessionId, request)
      this.operations.add(result)
      void result.finally(() => {
        this.operations.delete(result)
        if (this.pendingBindings.get(sessionId) === request) this.pendingBindings.delete(sessionId)
      }).catch(() => undefined)
    }
    pending.readers++
    const cancelled = Promise.withResolvers<never>()
    using _listener = addAbortListener(signal, () => { cancelled.reject(signal.reason) })
    try {
      const value = await Promise.race([pending.result, cancelled.promise])
      signal.throwIfAborted()
      return value
    }
    finally {
      if (--pending.readers === 0) {
        if (this.pendingBindings.get(sessionId) === pending) this.pendingBindings.delete(sessionId)
        pending.controller.abort(new Error('Company content has no remaining readers'))
      }
    }
  }
}
