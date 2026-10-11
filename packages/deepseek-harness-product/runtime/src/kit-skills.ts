/** Live resource authorization around the official filesystem Skill Provider. */
import type { Context } from '@deepseek-ai/cordis'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { getProductData } from './data.ts'

export const name = 'product-kit-skills'
export const inject = ['skills', 'productData']
export interface Config { readonly expertKitId: string; readonly providerName: string; readonly directory: string }

export function apply(ctx: Context, config: Config): void {
  ctx.skills.registerProvider((control) => {
    const provider = new FileSystemSkillProvider(ctx, control, {
      providerName: config.providerName, includeDefaultRoots: false, customSkillDirs: [config.directory], watch: false,
    })
    const authorize = (signal?: AbortSignal) => getProductData(ctx).invoke('expertKits.get', { id: config.expertKitId }, signal)
    ctx.effect(() => () => provider.dispose(), 'product-kit-skills.filesystem')
    return {
      name: provider.name,
      async list(options) {
        await authorize(options.signal)
        const listed = await provider.list(options)
        return listed
      },
      async get(candidate, options) { await authorize(options.signal); return provider.get(candidate, options) },
    }
  })
}
