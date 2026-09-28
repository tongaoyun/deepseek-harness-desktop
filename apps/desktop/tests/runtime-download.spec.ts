import { describe, expect, it, vi } from 'vitest'
import { retryRuntimeNetworkOperation } from '../scripts/runtime-download.ts'

describe('runtime network retry', () => {
  it('returns immediately after a successful download', async () => {
    const operation = vi.fn(async () => 'archive')
    const wait = vi.fn(async () => {})

    await expect(retryRuntimeNetworkOperation(operation, { wait })).resolves.toBe('archive')
    expect(operation).toHaveBeenCalledOnce()
    expect(wait).not.toHaveBeenCalled()
  })

  it('retries transient failures with bounded backoff', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('connect timeout'))
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue('archive')
    const wait = vi.fn(async () => {})
    const warn = vi.fn()

    await expect(retryRuntimeNetworkOperation(operation, { wait, warn })).resolves.toBe('archive')
    expect(operation).toHaveBeenCalledTimes(3)
    expect(wait.mock.calls).toEqual([[2_000], [4_000]])
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('preserves the final error after the bounded attempts', async () => {
    const failure = new Error('github unavailable')
    const operation = vi.fn(async () => { throw failure })

    await expect(retryRuntimeNetworkOperation(operation, {
      attempts: 2,
      wait: async () => {},
      warn: () => {},
    })).rejects.toBe(failure)
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('rejects an invalid retry budget before downloading', async () => {
    const operation = vi.fn(async () => 'archive')
    await expect(retryRuntimeNetworkOperation(operation, { attempts: 0 })).rejects.toThrow(/positive integer/u)
    expect(operation).not.toHaveBeenCalled()
  })
})
