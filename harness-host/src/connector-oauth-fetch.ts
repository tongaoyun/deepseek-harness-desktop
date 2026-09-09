export function connectorOAuthFetch(connector: { id: string; url: string },
  endpoint = process.env.XIAOYIN_OAUTH_BRIDGE_URL,
  bridgeToken = process.env.XIAOYIN_OAUTH_BRIDGE_TOKEN,
): typeof fetch {
  return async (input, init) => {
    try {
      const target = new URL(input instanceof Request ? input.url : String(input))
      if (target.origin !== new URL(connector.url).origin || target.username || target.password) return new Response('连接器请求来源未授权', { status: 403 })
      if (!endpoint || !bridgeToken) return new Response('连接器需要授权', { status: 401 })
      const bridge = new URL(endpoint)
      if (bridge.protocol !== 'http:' || bridge.hostname !== '127.0.0.1' || bridge.username || bridge.password) throw new Error('Invalid bridge')
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      const credential = await fetch(endpoint, {
        method: 'POST', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000),
        headers: { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ connectorId: connector.id, url: target.href }),
      })
      if (!credential.ok) { await credential.body?.cancel(); return new Response('连接器授权不可用', { status: credential.status }) }
      const result = await credential.json() as { token?: string }
      if (!result.token || /[\r\n]/.test(result.token)) return new Response('连接器需要重新授权', { status: 401 })
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      headers.delete('cookie'); headers.set('authorization', `Bearer ${result.token}`)
      // A rejected tool call is never replayed by an OAuth transport middleware.
      const response = await fetch(input, { ...init, headers, redirect: 'error' })
      if (response.status === 401) {
        // Refresh on the next explicit request; never replay this potentially committed write.
        try {
          const rejected = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
            headers: { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ connectorId: connector.id, url: target.href, rejectedToken: result.token }) })
          await rejected.body?.cancel()
        } catch { /* Preserve the original authentication failure. */ }
      }
      if (!response.ok) {
        await response.body?.cancel()
        return new Response('连接器请求失败', { status: response.status })
      }
      return response
    } catch { throw new Error('连接器请求失败，请检查网络与授权状态') }
  }
}
