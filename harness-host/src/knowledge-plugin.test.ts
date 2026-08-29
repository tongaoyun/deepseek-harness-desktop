import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeClient, parseKnowledgeBaseRefs } from './knowledge-plugin.js'

const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))) })

describe('KnowledgeClient', () => {
  it('sends employee scope and search input without exposing the token in output', async () => {
    const server = createServer((request, response) => {
      expect(request.headers['x-xiaoyin-employee-id']).toBe('employee-1')
      expect(request.headers['x-xiaoyin-team-id']).toBe('crossborder')
      expect(request.headers.authorization).toBe('Bearer secret-token')
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        expect(JSON.parse(body)).toEqual({
          query: '库存风险', knowledgeBaseIds: ['kb-1'], knowledgeBaseRefs: [],
          restrictToKnowledgeBaseRefs: false, limit: 3,
        })
        response.setHeader('Content-Type', 'application/json')
        response.end('[{"filename":"sop.pdf","locator":"第 2 页","content":"先核查库存"}]')
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
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        expect(JSON.parse(body)).toEqual({
          query: '退款', knowledgeBaseIds: [], knowledgeBaseRefs: ['organization:refund-sop'],
          restrictToKnowledgeBaseRefs: true, limit: 6,
        })
        response.setHeader('Content-Type', 'application/json')
        response.end('[]')
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
  })

  it('parses unrestricted, empty, and explicit knowledge scopes', () => {
    expect(parseKnowledgeBaseRefs(undefined)).toBeNull()
    expect(parseKnowledgeBaseRefs('null')).toBeNull()
    expect(parseKnowledgeBaseRefs('[]')).toEqual([])
    expect(parseKnowledgeBaseRefs('["team:operations-sop"]')).toEqual(['team:operations-sop'])
    expect(() => parseKnowledgeBaseRefs('["unknown:operations-sop"]')).toThrow()
  })
})
