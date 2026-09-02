import { describe, expect, it } from 'vitest'
import { cacheAge, ENTERPRISE_CACHE_MAX_AGE_MS } from './enterpriseCache'

describe('enterprise catalog cache', () => {
  it('marks catalogs stale only after the execution safety window', () => {
    const now = Date.parse('2026-09-02T00:00:00Z')
    expect(cacheAge(new Date(now - ENTERPRISE_CACHE_MAX_AGE_MS + 1).toISOString(), now).stale).toBe(false)
    expect(cacheAge(new Date(now - ENTERPRISE_CACHE_MAX_AGE_MS - 1).toISOString(), now).stale).toBe(true)
    expect(cacheAge('invalid', now).stale).toBe(true)
  })
})
