import { describe, expect, it } from 'vitest'
import { extensionMatches } from './ExtensionToolbar'

const extension = {
  id: 'api-design', name: 'API 接口设计', summary: '设计接口',
  category: 'code-development', installState: 'available', readiness: 'ready',
}

describe('extension category filtering', () => {
  it('uses the shared category for expert kits and 技能', () => {
    expect(extensionMatches(extension, '', 'market', 'code-development')).toBe(true)
    expect(extensionMatches(extension, '', 'market', 'code-review')).toBe(false)
  })

  it('keeps legacy entries in the other category', () => {
    expect(extensionMatches({ ...extension, category: undefined }, '', 'market', 'other')).toBe(true)
  })

  it('separates local built-ins from the market and lists installed content', () => {
    expect(extensionMatches({ ...extension, localOnly: true }, '', 'market')).toBe(false)
    expect(extensionMatches({ ...extension, localOnly: true }, '', 'builtin')).toBe(true)
    expect(extensionMatches({ ...extension, installState: 'installed' }, '', 'installed')).toBe(true)
    expect(extensionMatches(extension, '', 'installed')).toBe(false)
  })
})
