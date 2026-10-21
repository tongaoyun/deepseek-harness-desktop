/** Native plugins read the latest catalog; each Agent resolves an immutable Session binding. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-query'
import { z } from 'zod'
import type { CompanyContentRoots, CompanyContentSource } from '@deepseek-harness/product/protocol'
import type { DeepSeekHarnessProductIpc } from './deepseek-harness-product-ipc.ts'

const rootsSchema = z.object({ version: z.string().min(1).max(80), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  skillsRoot: z.string().min(1), expertsRoot: z.string().min(1) }).strict()

declare module '@deepseek-ai/cordis' {
  interface Context { companyContent: CompanyContent }
}

/** Credential-free company content source exposed only inside the product Host. */
export class CompanyContent extends Service implements CompanyContentSource {
  private readonly lifecycle = new AbortController()
  private readonly pendingBindings = new Map<string, Promise<CompanyContentRoots>>()
  private readonly prompted = new WeakSet<Agent>()

  constructor(ctx: Context, private readonly product: Pick<DeepSeekHarnessProductIpc, 'invoke'>) {
    super(ctx, 'companyContent')
    ctx.on('agent/created', async ({ agent }) => {
      try { await this.installVersion(agent) }
      catch (_error) {
        // Content failure blocks execution, while the native Session keeps its history and draft.
        this.lifecycle.signal.throwIfAborted()
      }
    })
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      await this.installVersion(agent)
      return next()
    })
    ctx.effect(() => () => { this.lifecycle.abort(new Error('Company content plugin unloaded')); this.pendingBindings.clear() }, 'company-content.lifecycle')
  }

  private async installVersion(agent: Agent): Promise<void> {
    const version = await this.forSession(agent.id)
    if (this.prompted.has(agent)) return
    const prompt = agent.ctx.get('systemPrompt')
    if (!prompt) throw new Error('Company content requires the native system prompt service')
    agent.ctx.effect(() => prompt.context({ name: 'company-content-version', order: 120, required: true,
      text: `Company content version: ${version.version}; SHA-256: ${version.sha256}.`,
    }), 'company-content.session-version')
    this.prompted.add(agent)
  }

  /** Read the latest installed content without initiating a network check. */
  async read(): Promise<CompanyContentRoots> {
    return rootsSchema.parse(await this.product.invoke('runtime.companyContent.read', undefined, this.lifecycle.signal))
  }

  /** Refresh shared content through main; native pages retain their last successful snapshot. */
  async refresh(): Promise<void> {
    await this.product.invoke('runtime.companyContent.refresh', undefined, this.lifecycle.signal)
  }

  /** Resolve one real Session; resumed tasks and child Agents keep their original content.
   * @param sessionId - Native Session identity supplied by its Agent.
   * @returns Roots revalidated by main; only concurrent requests share a check.
   */
  forSession(sessionId: string): Promise<CompanyContentRoots> {
    let pending = this.pendingBindings.get(sessionId)
    if (!pending) {
      const session = this.ctx.sessions.get(SessionId(sessionId))
      if (!session) return Promise.reject(new Error('Company content requires an existing Session'))
      pending = (async () => {
        using observation = await this.ctx.sessionQuery.observeSession(session.id)
        const value = await this.product.invoke('runtime.companyContent.pin', { sessionId,
          ...session.header.parentSession === undefined ? {} : { parentSessionId: session.header.parentSession },
          started: observation.events.some(event => event.type === 'request/header'),
        }, this.lifecycle.signal)
        return rootsSchema.parse(value)
      })()
      this.pendingBindings.set(sessionId, pending)
      void pending.finally(() => {
        if (this.pendingBindings.get(sessionId) === pending) this.pendingBindings.delete(sessionId)
      }).catch(() => undefined)
    }
    return pending
  }
}
