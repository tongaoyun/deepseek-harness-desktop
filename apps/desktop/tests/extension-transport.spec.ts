import { afterEach, expect, it, vi } from 'vitest'
import { invokeExtension } from '../src/extension-transport.ts'
afterEach(() => vi.useRealTimers())

it('cancels timed-out namespace requests and clears timers after successful responses', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  const pending = invokeExtension(() => new Promise(() => {}), cancel, 'fixture', 'read', {}, 'request-id')
  const response = expect(pending).resolves.toMatchObject({ ok: false,
    failure: { code: 'EXTENSION_REQUEST_TIMEOUT', retryable: true, resources: [] } })
  await vi.advanceTimersByTimeAsync(60_000)
  await response
  expect(cancel).toHaveBeenCalledWith('fixture', 'request-id')
  expect(await invokeExtension(async () => ({ ok: true, result: 'ready' }), cancel, 'fixture', 'read')).toEqual({ ok: true, result: 'ready' })
  expect(vi.getTimerCount()).toBe(0)
})

it('retains explicitly published failure codes and resources across the generic desktop transport', async () => {
  const failure = { code: 'RESOURCE_REVOKED', message: 'Access revoked', retryable: false, resources: [{ kind: 'fixture', id: 'resource' }] }
  await expect(invokeExtension(async () => ({ ok: false, failure }), vi.fn(), 'fixture', 'read'))
    .resolves.toEqual({ ok: false, failure })
})

it('honors an explicit bounded caller deadline and refuses invalid values before invocation', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  const invoke = vi.fn(() => new Promise(() => {}))
  const pending = invokeExtension(invoke, cancel, 'fixture', 'discover', {}, 'long-request', 300_000)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(cancel).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(240_000)
  expect(await pending).toMatchObject({ ok: false, failure: { code: 'EXTENSION_REQUEST_TIMEOUT' } })
  expect(cancel).toHaveBeenCalledWith('fixture', 'long-request')
  for (const timeout of [0, -1, Infinity, 1_800_001, 1.5]) {
    await expect(invokeExtension(invoke, cancel, 'fixture', 'discover', {}, 'invalid', timeout)).rejects.toThrow('Invalid extension request timeout')
  }
  expect(invoke).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
