import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, isPlanSafeTool } from './desktop-plan-mode-plugin.js'

afterEach(() => vi.unstubAllEnvs())

describe('desktop plan-mode policy', () => {
  it('allows inspection and plan review but blocks mutating or unknown tools', () => {
    for (const name of ['read', 'grep', 'knowledge_search', 'browser_snapshot', 'ask_user_question', 'exit_plan_mode', 'schedule_list']) {
      expect(isPlanSafeTool(name), name).toBe(true)
    }
    for (const name of ['write', 'edit', 'bash', 'local_files_delete', 'schedules_create', 'mcp_erp_order_create']) {
      expect(isPlanSafeTool(name), name).toBe(false)
    }
  })

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

  it('defaults unknown tools to denied while plan mode is active', async () => {
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const next = vi.fn().mockResolvedValue(undefined)
    const ctx = {
      planMode: { set: vi.fn(), get: vi.fn(() => ({ active: true })) },
      on: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => listeners.set(event, listener)),
    } as unknown as Context
    apply(ctx)
    const guard = listeners.get('tools/pre-execute')!
    await expect(guard({ agent: {}, name: 'write' }, next)).resolves.toMatchObject({ kind: 'deny' })
    expect(next).not.toHaveBeenCalled()
    await guard({ agent: {}, name: 'read' }, next)
    expect(next).toHaveBeenCalledOnce()
  })
})
