import { describe, expect, it, vi } from 'vitest'
import { apply } from './session-query-compat-plugin.js'

describe('session query compatibility layer', () => {
  it('keeps official tool registration when the prompt context is inactive', () => {
    const register = vi.fn()
    const section = vi.fn(() => { throw new Error('cannot create effect on inactive context') })
    const context = {
      systemPrompt: { section, getSectionOrder: vi.fn(() => 0) },
      tools: { register },
    } as never

    apply(context, { maxSearchResults: 10, searchTimeoutMs: 1000 })

    expect(section).toHaveBeenCalledOnce()
    expect(register).toHaveBeenCalledTimes(5)
  })

  it('does not hide unrelated prompt registration failures', () => {
    const context = {
      systemPrompt: { section: () => { throw new Error('duplicate section') }, getSectionOrder: () => 0 },
      tools: { register: vi.fn() },
    } as never

    expect(() => apply(context, { maxSearchResults: 10, searchTimeoutMs: 1000 })).toThrow('duplicate section')
  })
})
