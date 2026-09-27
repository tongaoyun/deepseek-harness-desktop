import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from './desktop-plan-mode-plugin.js'

afterEach(() => vi.unstubAllEnvs())

describe('desktop plan-mode policy', () => {
  it('writes the desktop mode into the official projection when an agent is created', () => {
    vi.stubEnv('XIAOYIN_EXECUTION_MODE', 'plan')
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const set = vi.fn()
    const ctx = {
      planMode: { set, get: vi.fn() },
      on: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => listeners.set(event, listener)),
    } as unknown as Context
    apply(ctx)
    const agent = { id: 'agent-1' }
    listeners.get('agent/created')?.({ agent })
    expect(set).toHaveBeenCalledWith(agent, true)
  })
})
