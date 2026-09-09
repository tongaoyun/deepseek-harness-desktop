import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import {
  auth, type OAuthClientProvider, type OAuthDiscoveryState,
  type StoredOAuthClientInformation, type StoredOAuthTokens,
} from '@modelcontextprotocol/client'

export interface OAuthState {
  client?: StoredOAuthClientInformation
  tokens?: StoredOAuthTokens
  discovery?: OAuthDiscoveryState
  expiresAt?: number
  redirectUrl?: string
}

export interface OAuthRequest {
  action: 'authorize' | 'token' | 'disconnect'
  url: string
  state: OAuthState
}

export class AuthorizationRequired extends Error {
  constructor() { super('连接器需要重新授权'); this.name = 'AuthorizationRequired' }
}

export function secureOAuthUrl(value: string | URL): URL {
  const url = new URL(value)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    || url.username || url.password || url.hash) throw new Error('OAuth 地址必须使用 HTTPS')
  return url
}

const oauthFetch: typeof fetch = async (input, init) => {
  secureOAuthUrl(input instanceof Request ? input.url : String(input))
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  return fetch(input, { ...init, redirect: 'error', signal: signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
}

/** SDK owns discovery, registration, issuer validation, PKCE and refresh. */
export async function connectorOAuth(request: OAuthRequest, callbacks: {
  open: (url: string) => Promise<void>
  save: (state: OAuthState) => Promise<void>
  signal?: AbortSignal
}): Promise<{ revoked?: boolean }> {
  callbacks.signal?.throwIfAborted()
  secureOAuthUrl(request.url)
  const state = request.state
  if (request.action === 'disconnect') {
    // Erase locally before attempting revocation, including when the provider is offline.
    const previous = structuredClone(state)
    delete state.tokens; delete state.client; delete state.discovery; delete state.expiresAt; delete state.redirectUrl
    await callbacks.save(state)
    const metadata = previous.discovery?.authorizationServerMetadata as { revocation_endpoint?: string } | undefined
    let revoked = false
    if (metadata?.revocation_endpoint && previous.tokens && previous.client) {
      try {
        const body = new URLSearchParams({
          token: previous.tokens.refresh_token ?? previous.tokens.access_token,
          token_type_hint: previous.tokens.refresh_token ? 'refresh_token' : 'access_token',
          client_id: previous.client.client_id,
        })
        if (previous.client.client_secret) body.set('client_secret', previous.client.client_secret)
        const response = await oauthFetch(metadata.revocation_endpoint, { method: 'POST', body })
        revoked = response.ok
        await response.body?.cancel()
      } catch { /* Local disconnect is complete even when remote revocation fails. */ }
    }
    return { revoked }
  }
  if (request.action === 'token' && state.tokens && (state.expiresAt ?? 0) > Date.now() + 30000) return {}
  if (request.action === 'token' && !state.tokens?.refresh_token) throw new AuthorizationRequired()

  let verifier = ''
  const nonce = randomBytes(32).toString('hex')
  let complete: (value: { code: string; iss?: string }) => void = () => {}
  let rejectCallback: (error: Error) => void = () => {}
  const callback = new Promise<{ code: string; iss?: string }>((resolve, reject) => { complete = resolve; rejectCallback = reject })
  void callback.catch(() => {})
  const server = createServer((req, res) => {
    const reply = (status: number, text: string) => res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'", 'referrer-policy': 'no-referrer',
    }).end(text)
    const url = new URL(req.url ?? '/', state.redirectUrl)
    if (req.method !== 'GET' || url.pathname !== '/callback' || req.headers.host !== new URL(state.redirectUrl!).host) { reply(404, 'Not found'); return }
    if (url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== nonce) { reply(400, 'Invalid authorization state'); return }
    if (url.searchParams.has('error')) { reply(400, '授权未完成，请返回小胤。'); rejectCallback(new AuthorizationRequired()); return }
    const code = url.searchParams.get('code')
    if (!code || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('iss').length > 1) { reply(400, 'Invalid authorization response'); return }
    reply(200, '授权响应已收到，请返回小胤查看连接结果。')
    const iss = url.searchParams.get('iss')
    complete({ code, ...(iss ? { iss } : {}) })
  })
  const abort = () => rejectCallback(new Error('授权已取消或超时'))
  const timeout = setTimeout(abort, 180000)
  callbacks.signal?.addEventListener('abort', abort, { once: true })
  try {
    if (request.action === 'authorize') {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('无法启动本地授权回调')
      state.redirectUrl = `http://127.0.0.1:${address.port}/callback`
      // Dynamic registration binds the new loopback redirect to a fresh public client.
      delete state.client; delete state.tokens; delete state.discovery; delete state.expiresAt
    }
    const provider: OAuthClientProvider = {
      get redirectUrl() { return state.redirectUrl },
      get clientMetadata() { return { client_name: 'Xiaoyin', redirect_uris: state.redirectUrl ? [state.redirectUrl] : [], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] } },
      state: () => nonce,
      clientInformation: (ctx) => !ctx || state.client?.issuer === ctx.issuer ? state.client : undefined,
      saveClientInformation: async (client) => { state.client = client },
      tokens: (ctx) => !ctx || state.tokens?.issuer === ctx.issuer ? state.tokens : undefined,
      saveTokens: async (tokens) => {
        state.tokens = tokens
        state.expiresAt = Date.now() + Math.max(0, tokens.expires_in ?? 300) * 1000
        await callbacks.save(state)
      },
      redirectToAuthorization: async (url) => {
        if (request.action !== 'authorize') throw new AuthorizationRequired()
        secureOAuthUrl(url)
        await callbacks.open(url.href)
      },
      saveCodeVerifier: (value) => { verifier = value },
      codeVerifier: () => verifier,
      saveDiscoveryState: (value) => { state.discovery = value },
      discoveryState: () => state.discovery,
      invalidateCredentials: async (scope) => {
        if (scope === 'all' || scope === 'tokens') { delete state.tokens; delete state.expiresAt }
        if (scope === 'all' || scope === 'client') delete state.client
        if (scope === 'all' || scope === 'discovery') delete state.discovery
        if (scope === 'all' || scope === 'verifier') verifier = ''
      },
    }
    const result = await auth(provider, { serverUrl: request.url, fetchFn: oauthFetch })
    if (result === 'REDIRECT') {
      const { code, iss } = await callback
      if (await auth(provider, { serverUrl: request.url, authorizationCode: code, ...(iss ? { iss } : {}), fetchFn: oauthFetch }) !== 'AUTHORIZED') throw new AuthorizationRequired()
    }
    if (!state.tokens?.access_token) throw new AuthorizationRequired()
    return {}
  } catch (error) {
    if (error instanceof AuthorizationRequired || (error instanceof Error && /invalid_grant|invalid_token/.test(String((error as { code?: string }).code)))) {
      delete state.tokens; delete state.expiresAt
      await callbacks.save(state)
      throw new AuthorizationRequired()
    }
    throw error
  } finally {
    clearTimeout(timeout)
    callbacks.signal?.removeEventListener('abort', abort)
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
