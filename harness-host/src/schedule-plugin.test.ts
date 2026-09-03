import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { ScheduleClient } from './schedule-plugin.js'

describe('schedule client', () => {
  const servers: Server[] = []
  afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))))

  it('creates the built-in natural-language agent workflow', async () => {
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        expect(request.method).toBe('POST')
        expect(request.headers['x-xiaoyin-employee-id']).toBe('employee-1')
        expect(request.headers.authorization).toBe('Bearer employee-token')
        expect(JSON.parse(body)).toEqual({
          name: '每周竞品动态', expertKitId: 'xiaoyin-agent', workflowId: 'agent-prompt',
          cronExpression: '0 10 * * 1', timeZone: 'Asia/Shanghai',
          inputs: { prompt: '整理本周竞品动态并给出摘要' },
        })
        response.setHeader('Content-Type', 'application/json')
        response.end('{"id":"schedule-1","status":"ACTIVE"}')
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server unavailable')
    const client = new ScheduleClient(`http://127.0.0.1:${address.port}/api/v1/schedules`, 'employee-1', 'employee-token')

    await expect(client.create({
      name: '每周竞品动态', prompt: '整理本周竞品动态并给出摘要',
      cronExpression: '0 10 * * 1', timeZone: 'Asia/Shanghai',
    })).resolves.toEqual({ id: 'schedule-1', status: 'ACTIVE' })
  })
})
