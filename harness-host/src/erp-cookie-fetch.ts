export class ErpCookieError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ErpCookieError' }
}

export function erpCookieFetch(connector: { id: string; url: string },
  endpoint = process.env.XIAOYIN_ERP_COOKIE_BRIDGE_URL,
  token = process.env.XIAOYIN_ERP_COOKIE_BRIDGE_TOKEN,
): typeof fetch {
  return async (input, init) => {
    try {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== new URL(connector.url).origin || url.username || url.password) {
        throw new ErpCookieError(403, 'ERP MCP 请求地址不在该连接器的授权来源内')
      }
      if (!endpoint || !token) throw new ErpCookieError(401, '请在小胤桌面扫码登录 ERP 后重试')
      const bridge = new URL(endpoint)
      if (bridge.protocol !== 'http:' || bridge.hostname !== '127.0.0.1' || bridge.username || bridge.password) {
        throw new ErpCookieError(403, 'ERP 会话桥接地址无效')
      }
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      const session = await fetch(endpoint, {
        method: 'POST', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ connectorId: connector.id, url: url.href }),
      })
      if (!session.ok) throw new ErpCookieError(session.status, session.status === 401
        ? 'ERP 登录已失效，请重新扫码登录' : session.status === 403
          ? 'ERP MCP 来源未授权或当前登录账号与任务不一致' : '暂时无法核实 ERP 登录状态，请重试')
      const result = await session.json() as { cookie?: unknown }
      if (typeof result.cookie !== 'string' || !result.cookie || /[\r\n]/.test(result.cookie)) {
        throw new ErpCookieError(401, 'ERP 登录已失效，请重新扫码登录')
      }
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      headers.delete('authorization')
      headers.set('cookie', result.cookie)
      const response = await fetch(input, { ...init, headers, redirect: 'error' })
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel()
        throw new ErpCookieError(response.status, response.status === 401
          ? 'ERP 登录已失效，请重新扫码登录' : '当前 ERP 账号没有访问此 MCP 服务的权限')
      }
      if (!response.ok) {
        await response.body?.cancel()
        return new Response('ERP MCP 服务请求失败', { status: response.status })
      }
      return response
    } catch (error) {
      if (error instanceof ErpCookieError && (error.status === 401 || error.status === 403)) {
        return new Response(error.message, { status: error.status })
      }
      if (error instanceof ErpCookieError) throw error
      // Upstream and transport errors must never serialize session credentials.
      throw new ErpCookieError(503, 'ERP MCP 请求失败，请检查服务地址、网络和登录状态')
    }
  }
}
