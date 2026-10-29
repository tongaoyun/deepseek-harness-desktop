/** Record credential-free Host module identities after the product acceptance profile has booted. */
import { writeFileSync } from 'node:fs'

export const inject = ['appReady', 'loader']

/** @param {import('@deepseek-ai/cordis').Context} ctx Test profile. @param {{ output: string }} config Private diagnostic destination. */
export function apply(ctx, config) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    const urls = [...ctx.loader.internal.loadCache.keys()]
      .filter(url => /\/(?:dsh-)?(?:app-boot|hmr|plugin-manager)\//u.test(url)
        || /\/@deepseek-harness\/product-(?:experts|skills)\/lib\//u.test(url))
    writeFileSync(config.output, JSON.stringify({
      modules: urls,
      loaderSharesRoot: ctx.loader.ctx.root === ctx.root,
      includes: [...ctx.loader.entries()].filter(entry => entry.options.name === 'cordis:include')
        .map(entry => ({ id: entry.options.id, path: entry.options.config?.path })),
    }, null, 2))
  }))
}
