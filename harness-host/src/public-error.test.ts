import { describe, expect, it } from 'vitest'
import { publicErrorMessage } from './public-error.js'

describe('public Host errors', () => {
  it('redacts configured and conventionally formatted credentials', () => {
    const message = publicErrorMessage(
      new Error('provider sk-1234567890abcdef; Authorization: Bearer other-secret; employee-secret; access_token=query-secret\u0007'),
      { DEEPSEEK_API_KEY: 'sk-1234567890abcdef', XIAOYIN_EMPLOYEE_BEARER_TOKEN: 'employee-secret' },
    )
    expect(message).not.toMatch(/1234567890abcdef|other-secret|employee-secret|query-secret/)
    expect(message.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4)
    expect(message).not.toContain('\u0007')
  })

  it('bounds arbitrary failures and keeps ordinary diagnostics useful', () => {
    expect(publicErrorMessage(new Error(`connection refused ${'x'.repeat(2_000)}`), {})).toHaveLength(1_000)
    expect(publicErrorMessage(new Error('Session inspection is unavailable'), {})).toBe('Session inspection is unavailable')
  })
})
