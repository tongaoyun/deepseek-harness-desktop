import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { flushCapabilityNotices } from './capability-notice.js'
import { apply, KnowledgeClient, parseKnowledgeBaseRefs, readKnowledgeScope } from './knowledge-plugin.js'

const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))) })

describe('readKnowledgeScope', () => {
  it('turns a malformed scope into a gap instead of a crash', () => {
    expect(readKnowledgeScope('["team:kb"]').kind).toBe('invalid')
    expect(readKnowledgeScope('not-json').kind).toBe('invalid')
    expect(readKnowledgeScope('[]')).toEqual({ kind: 'refs', refs: [] })
    expect(readKnowledgeScope(undefined).kind).toBe('none')
    expect(readKnowledgeScope('["team:weekly"]')).toEqual({ kind: 'refs', refs: ['team:weekly'] })
  })

  it('does not register unrestricted tools when the configured scope is malformed', () => {
    vi.stubEnv('XIAOYIN_KNOWLEDGE_BASE_REFS', 'not-json')
    vi.stubEnv('XIAOYIN_SESSION_PROJECTION_URL', 'http://127.0.0.1:1/projection')
    vi.stubEnv('XIAOYIN_SESSION_PROJECTION_TOKEN', 'test-token')
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const register = vi.fn()
    apply({ tools: { register } } as unknown as Context, { endpoint: 'http://127.0.0.1:1/api/v1/knowledge-bases' })
    expect(register).not.toHaveBeenCalled()
    flushCapabilityNotices('session-scope')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({
      sessionId: 'session-scope', value: { kind: 'knowledge', id: 'scope' },
    })
  })
})

describe('KnowledgeClient', () => {
  it('waits for the tools service before registering knowledge tools', () => {
    vi.stubEnv('XIAOYIN_KNOWLEDGE_BASE_REFS', '[]')
    const register = vi.fn(() => () => undefined)
    const effect = vi.fn()
    const inject = vi.fn()
    apply({ inject } as unknown as Context, { endpoint: 'http://127.0.0.1:1/api/v1/knowledge-bases' })
    expect(inject).toHaveBeenCalledWith(['tools'], expect.any(Function))
    expect(register).not.toHaveBeenCalled()

    const callback = inject.mock.calls[0]![1] as (ctx: Context) => void
    callback({ tools: { register }, effect } as unknown as Context)
    expect(register).toHaveBeenCalledTimes(2)
    expect(effect).toHaveBeenCalledOnce()
  })

  it('sends employee scope and search input without exposing the token in output', async () => {
    const server = createServer((request, response) => {
      expect(request.headers['x-xiaoyin-employee-id']).toBe('employee-1')
      expect(request.headers['x-xiaoyin-team-id']).toBe('crossborder')
      expect(request.headers['x-erp-session']).toBe('secret-token')
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        expect(JSON.parse(body)).toEqual({
          query: '库存风险', knowledgeBaseIds: ['kb-1'], knowledgeBaseRefs: [],
          restrictToKnowledgeBaseRefs: false, limit: 3,
        })
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ success: true, data: [{ filename: 'sop.pdf', locator: '第 2 页', content: '先核查库存' }] }))
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server unavailable')
    const client = new KnowledgeClient(
      `http://127.0.0.1:${address.port}/api/v1/knowledge-bases`,
      'employee-1', 'crossborder', 'secret-token', null,
    )
    const result = await client.search('库存风险', ['kb-1'], 3)
    expect(result).toEqual([{ filename: 'sop.pdf', locator: '第 2 页', content: '先核查库存' }])
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })

  it('enforces the selected expert kit knowledge scope', async () => {
    let received: unknown
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        received = JSON.parse(body)
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ success: true, data: [] }))
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server unavailable')
    const client = new KnowledgeClient(
      `http://127.0.0.1:${address.port}/api/v1/knowledge-bases`,
      'employee-1', 'crossborder', '', ['organization:refund-sop'],
    )
    await client.search('退款', ['kb-untrusted'], 6)
    expect(received).toEqual({ query: '退款', knowledgeBaseIds: ['kb-untrusted'], knowledgeBaseRefs: ['organization:refund-sop'], restrictToKnowledgeBaseRefs: true, limit: 6 })
  })

  it('keeps an explicitly empty scope restricted', async () => {
    let received: unknown
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      received = JSON.parse(body)
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ success: true, data: [] }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const client = new KnowledgeClient(`http://127.0.0.1:${address.port}/api/v1/knowledge-bases`, 'employee-1', '', '', readKnowledgeScope('[]').kind === 'refs' ? [] : null)
    await client.search('退款', [], 6)
    expect(received).toMatchObject({ knowledgeBaseRefs: [], restrictToKnowledgeBaseRefs: true })
  })

  it('parses unrestricted, empty, and explicit knowledge scopes', () => {
    expect(parseKnowledgeBaseRefs(undefined)).toBeNull()
    expect(parseKnowledgeBaseRefs('null')).toBeNull()
    expect(parseKnowledgeBaseRefs('[]')).toEqual([])
    expect(parseKnowledgeBaseRefs('["team:operations-sop"]')).toEqual(['team:operations-sop'])
    expect(() => parseKnowledgeBaseRefs('["unknown:operations-sop"]')).toThrow()
  })
})
