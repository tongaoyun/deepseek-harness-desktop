/** Isolated external ClawHub transport for built-client pagination and detail tests. */
export const name = 'clawhub-catalog-fixture'

/** Forward official ranking and skill-file reads to the test server and cancel reads on unload. */
export function apply(ctx, config) {
  ctx.effect(() => {
    const original = globalThis.fetch
    const lifetime = new AbortController()
    const pending = new Set()
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.origin !== 'https://clawhub.ai'
        || url.pathname !== '/api/v1/skills' && !/^\/api\/v1\/skills\/[^/]+\/file$/u.test(url.pathname)) return original(input, init)
      const destination = new URL(config.endpoint)
      destination.pathname = url.pathname
      destination.search = url.search
      const request = original(destination, { ...init, signal: AbortSignal.any([init.signal, lifetime.signal]) })
      pending.add(request)
      return request.finally(() => { pending.delete(request) })
    }
    return async () => {
      globalThis.fetch = original
      lifetime.abort()
      await Promise.allSettled(pending)
    }
  })
}
