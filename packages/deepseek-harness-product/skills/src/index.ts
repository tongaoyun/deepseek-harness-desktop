/** Skills product Host entry: register the generated Typert contract and mount the native service. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { TYPERT } from './generated/typert.host.js'
import { SkillsManager } from './manager.ts'

export { SkillsManager }
export { TYPERT }
export const name = 'skills-manager'
export const inject = ['typert']

export async function apply(ctx: Context): Promise<void> {
  ctx.typert.register(TYPERT as TypertContribution)
  await ctx.plugin(SkillsManager)
}
