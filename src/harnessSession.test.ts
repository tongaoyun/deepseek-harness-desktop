import { describe, expect, it, vi } from 'vitest'
import { resolveHarnessSessionId } from './harnessSession'

describe('resolveHarnessSessionId', () => {
  it('starts a fresh Harness session when the caller marks the current one invalid', () => {
    const createSessionId = vi.fn(() => 'session-new')

    expect(resolveHarnessSessionId('session-live', 'session-saved', true, createSessionId)).toBe('session-new')
    expect(createSessionId).toHaveBeenCalledOnce()
  })

  it('keeps the active or persisted session while runtime capabilities remain stable', () => {
    const createSessionId = vi.fn(() => 'session-new')

    expect(resolveHarnessSessionId('session-live', 'session-saved', false, createSessionId)).toBe('session-live')
    expect(resolveHarnessSessionId('', 'session-saved', false, createSessionId)).toBe('session-saved')
    expect(createSessionId).not.toHaveBeenCalled()
  })

  it('creates a session when none exists', () => {
    const createSessionId = vi.fn(() => 'session-new')

    expect(resolveHarnessSessionId('', undefined, false, createSessionId)).toBe('session-new')
    expect(createSessionId).toHaveBeenCalledOnce()
  })
})
