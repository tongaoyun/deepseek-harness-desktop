import type { Context } from '@deepseek-ai/cordis'
import {
  Config,
  apply as applyUpstream,
  inject,
} from '@deepseek-ai/dsh-tool-session-query'

/**
 * rc.2 applies its prompt section after the SDK context has become inactive.
 * Keep the upstream query implementation and tool schemas, but make the
 * optional prompt hint best-effort so the tools can still be registered.
 */
export { Config, inject }
export const name = 'xiaoyin-session-query-compat'

export function apply(ctx: Context, config: Parameters<typeof applyUpstream>[1]): void {
  const systemPrompt = ctx.systemPrompt
  const guardedSystemPrompt = Object.create(systemPrompt) as typeof systemPrompt
  guardedSystemPrompt.section = (...args: Parameters<typeof systemPrompt.section>) => {
    try {
      return systemPrompt.section(...args)
    } catch (error) {
      if (String(error).includes('inactive context')) return () => undefined
      throw error
    }
  }
  const scopedContext = Object.create(ctx) as Context
  Object.defineProperty(scopedContext, 'systemPrompt', { value: guardedSystemPrompt })
  applyUpstream(scopedContext, config)
}
