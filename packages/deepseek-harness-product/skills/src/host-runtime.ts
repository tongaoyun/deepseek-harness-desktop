/** Native skill registration, lifecycle and catalog invalidation for the product manager. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SkillCandidate, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-harness/product-runtime/company-content'
import type { ScopeOptions } from './types.ts'
import { listProviderCandidates, getProviderSkill, type ProviderCandidate } from './core.ts'
/** Invalidate registered providers after a committed write; native notifications refresh clients.
 * @param ctx Host context for refresh diagnostics.
 * @param invalidators Live provider controls owned by the manager.
 */
export function notifyChatCatalog(ctx: Context, invalidators: ReadonlySet<() => void>): void {
  for (const invalidate of invalidators) {
    try { invalidate() }
    catch (error) { ctx.logger.warn(`Skill catalog invalidation failed: ${String(error)}`) }
  }
}

/**
 * Read canonical paths from the native workspace registry. An absent optional
 * service returns undefined; a failed registry read remains a visible failure.
 * @param ctx Host context owning the optional workspace registry.
 * @returns Registered paths, or undefined when the service is absent.
 * @throws RemoteError with the registry failure retained as its cause.
 */
export function registeredWorkspacePaths(ctx: Context): string[] | undefined {
  const registry = ctx.get('workspaceRegistry')
  if (!registry) return undefined
  try {
    return registry.list().map(workspace => workspace.path)
  } catch (error) {
    throw new RemoteError('skills/operation', 'Could not read registered workspaces', {
      code: 'error.workspace.registryUnavailable', error: 'Could not read registered workspaces',
    }, { cause: error })
  }
}

/** 仅从客户端当前选中的已知 Session 解析工作目录；缺失或失效时不回退其他会话。 */
export function activeSessionCwds(ctx: Context, sessionId: unknown) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return []
  const session = ctx.sessions.get(SessionId(sessionId))
  const cwd = session?.header.cwd
  return typeof cwd === 'string' && cwd.trim() ? [cwd.trim()] : []
}

export function externalSkillProvider(
  control: SkillProviderControl, invalidators: Set<() => void>,
  companyRoot?: (signal?: AbortSignal) => Promise<string>,
) {
  invalidators.add(control.invalidate)
  control.signal.addEventListener('abort', () => {
    invalidators.delete(control.invalidate)
  }, { once: true })
  const lookupOptions = async (options: ScopeOptions = {}): Promise<ScopeOptions> => {
    const signal = options.signal === undefined ? control.signal : AbortSignal.any([control.signal, options.signal])
    return { ...options, signal, ...companyRoot ? { companySkillsRoot: await companyRoot(signal) } : {} }
  }
  return {
    name: 'dsh-skills-manager-external',
    list: async (options?: ScopeOptions) => listProviderCandidates(await lookupOptions(options)),
    get: async (candidate: SkillCandidate, options?: ScopeOptions) =>
      getProviderSkill(candidate as ProviderCandidate, await lookupOptions(options)),
  }
}

/**
 * Agent presets register their filesystem provider in a nearer, preset-scoped
 * skill layer. Register the manager policy once more in each live agent's own
 * layer so disabled shared skills cannot fall through to that native provider.
 */
export function registerAgentSkillProviders(ctx: Context, invalidators: Set<() => void>) {
  const registrations = new Map<Agent['id'], () => void>()

  const install = (agent: Agent) => {
    if (registrations.has(agent.id)) return
    const agentCtx = agent.ctx
    const skills = agentCtx.get('skills')
    if (!skills) return
    const companySource = ctx.get('companyContent')
    const dispose = skills.registerProvider(control => externalSkillProvider(control, invalidators,
      companySource ? async signal => (await companySource.forSession(agent.id, signal)).skillsRoot : undefined))
    registrations.set(agent.id, dispose)
  }

  const uninstall = (agent: Agent) => {
    const dispose = registrations.get(agent.id)
    registrations.delete(agent.id)
    dispose?.()
  }

  const stopCreated = ctx.on('agent/created', ({ agent }) => { install(agent) })
  const stopDisposed = ctx.on('agent/disposed', ({ agent }) => { uninstall(agent) })
  const agents = ctx.get('agents')
  if (agents) {
    for (const agent of agents.list()) install(agent)
  }

  return () => {
    stopCreated()
    stopDisposed()
    for (const dispose of registrations.values()) {
      dispose()
    }
    registrations.clear()
  }
}

