// @vitest-environment jsdom
/** Builtin pages register without catalog readiness and release all UI effects. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { RemoteMock, ok } from '@deepseek-ai/dsh-remote-mock'
import * as Experts from '@deepseek-harness/product-experts/client'
import * as Skills from '@deepseek-harness/product-skills/client'
import { expect, it, onTestFinished, vi } from 'vitest'

it('owns main pages, mention sources and remote mounts across unload and reload', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sessions', {} as never)
  ctx.provide('conversation', {} as never)
  ctx.provide('layout', {} as never)
  const sources = new Set<object>()
  ctx.provide('inputTriggers', { registerSource(source: object) {
    sources.add(source)
    return () => { sources.delete(source) }
  } } as never)
  // Catalog stays blocked through unload: pages must register and release without awaiting it.
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  onTestFinished(release)
  const mock = RemoteMock.create()
  mock.unary('agencyAgents/getCatalog', async () => {
    await gate
    return ok({ revision: 0, divisions: [], experts: [], warnings: [] })
  })
  mock.unary('agencyAgents/getTeams', () => ok({ revision: 0, teams: [] }))
  installConnection(ctx, { interactions: 'none', transport: { rpc: mock.rpc } })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(Gateway)
  slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' },
    'conversation.input.left': { kind: 'list', scope: 'session' },
  } }, (props: PropsRenderSlots<'main' | 'conversation.input.left'>) => { void props.renderSlot; return null })
  for (let index = 0; index < 2; index++) {
    const owner = ctx.plugin((child: Context) => { child.plugin(Experts); child.plugin(Skills) })
    await owner.await()
    await vi.waitFor(() => { expect(slots.entries('main').map(entry => entry.options.key).sort()).toEqual([
      'deepseek-harness-experts', 'deepseek-harness-skills',
    ]) })
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(sources.size).toBeGreaterThan(0)
    expect(document.head.querySelectorAll('style[data-plugin="@deepseek-harness/product-experts"]')).toHaveLength(1)
    expect(ctx.get('remote.agencyAgents')).toBeDefined()
    expect(ctx.get('remote.skillsManager')).toBeDefined()
    await owner.dispose()
    expect(slots.entries('main')).toHaveLength(0)
    expect(slots.entries('conversation.input.left')).toHaveLength(0)
    expect(sources.size).toBe(0)
    expect(document.head.querySelectorAll('style[data-plugin="@deepseek-harness/product-experts"]')).toHaveLength(0)
    expect(ctx.get('remote.agencyAgents')).toBeUndefined()
    expect(ctx.get('remote.skillsManager')).toBeUndefined()
  }
})
