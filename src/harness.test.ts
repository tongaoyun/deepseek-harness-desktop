import { describe, expect, it } from 'vitest'
import { harnessActivityLabel } from './harness'

describe('harnessActivityLabel', () => {
  it('shows safe progress labels without exposing reasoning content', () => {
    const label = harnessActivityLabel({
      requestId: 1,
      event: {
        event: {
          method: 'session.event',
          params: { event: { type: 'tool/call', name: 'sales_summary', reasoning: 'private' } },
        },
      },
    })
    expect(label).toBe('正在调用 sales_summary')
    expect(label).not.toContain('private')
  })
})
