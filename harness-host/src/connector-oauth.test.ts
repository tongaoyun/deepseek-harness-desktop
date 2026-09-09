import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { connectorOAuth, type OAuthState } from './connector-oauth.js'
import { connectorOAuthFetch } from './connector-oauth-fetch.js'

const servers: Server[] = []
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } })
async function fixture() {
  let base = '', challenge = '', exchanges = 0, refreshes = 0, revoked = false
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const send = (value: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    if (req.url?.startsWith('/.well-known/oauth-protected-resource')) return send({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['orders:read', 'orders:write'] })
    if (req.url?.startsWith('/.well-known/')) return send({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, revocation_endpoint: `${base}/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true })
    if (req.url === '/register') return send({ ...JSON.parse(body), client_id: 'fixture-client' }, 201)
    if (req.url === '/token') {
      const params = new URLSearchParams(body)
      if (params.get('grant_type') === 'authorization_code') {
        exchanges += 1
        if (createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url') !== challenge) return send({ error: 'invalid_grant' }, 400)
      } else { refreshes += 1; if (params.get('refresh_token') !== 'refresh-1') return send({ error: 'invalid_grant' }, 400) }
      return send({ access_token: `access-${refreshes + 1}`, refresh_token: `refresh-${refreshes + 1}`, token_type: 'Bearer', expires_in: 3600, scope: 'orders:read orders:write' })
    }
    if (req.url === '/revoke') { revoked = true; return send({}) }
    return send({}, 404)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { base, setChallenge: (value: string) => { challenge = value }, stats: () => ({ exchanges, refreshes, revoked }) }
}

describe('connector OAuth lifecycle', () => {
  it('cancels a pending browser callback without saving credentials', async () => {
    const service = await fixture(), controller = new AbortController(), saved: OAuthState[] = []
    let callback = ''
    await expect(connectorOAuth({ action: 'authorize', url: `${service.base}/mcp`, state: {} }, {
      signal: controller.signal,
      save: async value => { saved.push(value) },
      open: async value => { callback = new URL(value).searchParams.get('redirect_uri')!; controller.abort() },
    })).rejects.toThrow('取消')
    expect(saved).toEqual([])
    await expect(fetch(callback)).rejects.toThrow()
  })
  it('validates state and PKCE, refreshes rotated tokens and disconnects', async () => {
    const service = await fixture(), state: OAuthState = {}, saved: OAuthState[] = []
    await connectorOAuth({ action: 'authorize', url: `${service.base}/mcp`, state }, {
      save: async value => { saved.push(structuredClone(value)) },
      open: async value => {
        const authorization = new URL(value)
        service.setChallenge(authorization.searchParams.get('code_challenge')!)
        const callback = new URL(authorization.searchParams.get('redirect_uri')!)
        callback.searchParams.set('code', 'code-1'); callback.searchParams.set('state', 'wrong')
        expect((await fetch(callback)).status).toBe(400)
        expect(service.stats().exchanges).toBe(0)
        callback.searchParams.set('state', authorization.searchParams.get('state')!)
        callback.searchParams.set('iss', service.base)
        expect((await fetch(callback)).status).toBe(200)
      },
    })
    expect(state.tokens?.access_token).toBe('access-1')
    expect(saved.at(-1)?.tokens?.refresh_token).toBe('refresh-1')
    state.expiresAt = 0
    const callbacks = { save: async () => {}, open: async () => { throw new Error('Refresh must not open a browser') } }
    await connectorOAuth({ action: 'token', url: `${service.base}/mcp`, state }, callbacks)
    expect(state.tokens?.access_token).toBe('access-2')
    expect(state.tokens?.refresh_token).toBe('refresh-2')
    expect(service.stats().refreshes).toBe(1)
    const result = await connectorOAuth({ action: 'disconnect', url: `${service.base}/mcp`, state }, callbacks)
    expect(state.tokens).toBeUndefined()
    expect(result.revoked).toBe(true)
    expect(service.stats().revoked).toBe(true)
    await expect(connectorOAuth({ action: 'token', url: `${service.base}/mcp`, state }, callbacks)).rejects.toThrow('重新授权')
  })
  it('rejects a mismatched issuer before exchanging the code', async () => {
    const service = await fixture()
    await expect(connectorOAuth({ action: 'authorize', url: `${service.base}/mcp`, state: {} }, {
      save: async () => {}, open: async value => {
        const authorization = new URL(value)
        const callback = new URL(authorization.searchParams.get('redirect_uri')!)
        callback.searchParams.set('state', authorization.searchParams.get('state')!)
        callback.searchParams.set('code', 'code-1'); callback.searchParams.set('iss', 'https://wrong.test')
        await fetch(callback)
      },
    })).rejects.toThrow()
    expect(service.stats().exchanges).toBe(0)
  })
  it('does not replay a rejected write or send a token across origins', async () => {
    let writes = 0, headers = ''
    const server = createServer(async (req, res) => {
      for await (const _ of req) { /* Drain body before replying. */ }
      if (req.url === '/credential') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: 'private-access' })); return }
      writes += 1; headers = req.headers.authorization ?? ''; res.writeHead(401).end('private-access')
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const fetcher = connectorOAuthFetch({ id: 'fixture', url: `${base}/mcp` }, `${base}/credential`, 'bridge')
    const response = await fetcher(`${base}/mcp`, { method: 'POST', body: 'write' })
    expect(response.status).toBe(401); expect(await response.text()).not.toContain('private-access')
    expect(writes).toBe(1); expect(headers).toBe('Bearer private-access')
    expect((await fetcher('https://outside.test/mcp')).status).toBe(403)
    expect(writes).toBe(1)
  })
})
