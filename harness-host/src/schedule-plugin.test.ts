import { expect, it, vi } from 'vitest'
import { ScheduleBridge } from './schedule-bridge.js'
import { ScheduleClient } from './schedule-plugin.js'
import type { JsonRpcOutput } from './protocol.js'

it('routes tools through the loopback bridge and returns desktop persistence receipts', async () => {
  const emit = vi.fn((value: JsonRpcOutput) => {
    if ('method' in value && value.method === 'schedule.request') {
      const params = value.params as { requestId: string; action: string; input: unknown }
      expect(params.action).toBe('create')
      expect(params.input).toEqual({ name: '日报', intervalMinutes: 60, prompt: '整理日报' })
      bridge.respond(params.requestId, { schedule: { id: 'desktop-plan', active: true } })
      expect(bridge.respond(params.requestId, {})).toBe(false)
    }
  })
  const bridge = new ScheduleBridge(emit)
  const endpoint = await bridge.start()
  try {
    await expect(new ScheduleClient(endpoint.url, endpoint.token).request('create', { name: '日报', intervalMinutes: 60, prompt: '整理日报' }))
      .resolves.toEqual({ schedule: { id: 'desktop-plan', active: true } })
    await expect(new ScheduleClient(endpoint.url, 'wrong-token').request('list')).rejects.toThrow('404')
    await expect(new ScheduleClient('https://example.com/schedules', endpoint.token).request('list')).rejects.toThrow('仅使用本机')
  } finally { await bridge.close() }
})
it('does not report success when desktop rejects a schedule', async () => {
  const bridge = new ScheduleBridge((value) => {
    if ('params' in value) bridge.respond((value.params as { requestId: string }).requestId, { error: '一次性时间必须在未来' })
  })
  const endpoint = await bridge.start()
  try { await expect(new ScheduleClient(endpoint.url, endpoint.token).request('create', {})).rejects.toThrow('必须在未来') }
  finally { await bridge.close() }
})
