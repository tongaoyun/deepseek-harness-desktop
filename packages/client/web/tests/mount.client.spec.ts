// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { mountClient } from '../src/mount.ts'
import type { ClientEntryState } from '@deepseek-ai/dsh-client-modules/client'

/** Provide a fake `uiRenderer` from its own plugin fiber so it can be replaced. */
function provideRenderer(ctx: Context, mount: (container: HTMLElement) => () => void) {
  return ctx.plugin({ apply: (scope: Context) => { scope.reflect.provide('uiRenderer', { mount }) } })
}

function entryState() {
  let snapshot: ClientEntryState = { syncing: false, failures: [] }
  const listeners = new Set<() => void>()
  return {
    state: { getSnapshot: () => snapshot, subscribe: (listener: () => void) => {
      listeners.add(listener); return () => { listeners.delete(listener) }
    } },
    publish(value: ClientEntryState) { snapshot = value; for (const listener of listeners) listener() },
    listeners,
  }
}

describe('mountClient', () => {
  it('mounts into the container and unmounts when the tree is disposed', async () => {
    const ctx = new Context()
    const unmount = vi.fn()
    const mount = vi.fn((_container: HTMLElement) => unmount)
    provideRenderer(ctx, mount)
    const container = document.createElement('div')

    await mountClient(ctx, container, entryState())

    expect(mount).toHaveBeenCalledExactlyOnceWith(container)
    expect(unmount).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
    expect(unmount).toHaveBeenCalledOnce()
  })

  it('remounts when uiRenderer is replaced', async () => {
    const ctx = new Context()
    const container = document.createElement('div')
    const first = { unmount: vi.fn(), mount: vi.fn(() => first.unmount) }
    const second = { unmount: vi.fn(), mount: vi.fn(() => second.unmount) }

    await mountClient(ctx, container, entryState())
    expect(first.mount).not.toHaveBeenCalled()

    const renderer = provideRenderer(ctx, first.mount)
    await vi.waitFor(() => { expect(first.mount).toHaveBeenCalledExactlyOnceWith(container) })

    await renderer.dispose()
    expect(first.unmount).toHaveBeenCalledOnce()

    provideRenderer(ctx, second.mount)
    await vi.waitFor(() => { expect(second.mount).toHaveBeenCalledExactlyOnceWith(container) })
    await ctx.fiber.dispose()
    expect(second.unmount).toHaveBeenCalledOnce()
  })

  it('unmounts before plugin teardown and recovers after successful activation', async () => {
    const ctx = new Context()
    const container = document.createElement('div')
    const events: string[] = []
    const entries = entryState()
    let adapterInstalled = true
    provideRenderer(ctx, () => {
      expect(adapterInstalled).toBe(true)
      events.push('mount')
      container.textContent = 'ready'
      return () => { events.push('unmount'); container.textContent = '' }
    })
    await mountClient(ctx, container, entries)
    entries.publish({ syncing: true, failures: [] })
    expect(events).toEqual(['mount', 'unmount'])
    adapterInstalled = false
    expect(container.querySelector('[data-dsh-boot]')).not.toBeNull()
    entries.publish({ syncing: false, failures: [{ id: 'session', message: 'activation failed' }] })
    expect(container.textContent).toContain('session: activation failed')
    expect(events).toEqual(['mount', 'unmount'])
    entries.publish({ syncing: true, failures: [] })
    adapterInstalled = true
    entries.publish({ syncing: false, failures: [] })
    expect(container.textContent).toBe('ready')
    expect(events).toEqual(['mount', 'unmount', 'mount'])
    await ctx.fiber.dispose()
    expect(entries.listeners.size).toBe(0)
  })
})
