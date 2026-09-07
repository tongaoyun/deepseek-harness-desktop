// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { CapabilityHero } from './CapabilityHero'
import { CatalogLoading } from './CatalogLoading'
import { XiaoyinMascot } from './XiaoyinMascot'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

async function render(element: ReactNode, check: (container: HTMLDivElement, rerender: (next: ReactNode) => Promise<void>) => Promise<void>) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const rerender = async (next: ReactNode) => { await act(async () => root.render(next)) }
  try { await rerender(element); await check(container, rerender) }
  finally { await act(async () => root.unmount()); container.remove() }
}

it('uses the reference animation and distinct page illustrations', async () => {
  await render(<XiaoyinMascot variant="hero" />, async (container, rerender) => {
    const original = container.querySelector('img')!.getAttribute('src')!
    expect(original).toContain('expert-body.gif')
    expect(container.querySelector('.mascot-still')).not.toBeNull()
    await rerender(<CapabilityHero kind="experts" />)
    expect(container.querySelector('.mascot-hand')!.getAttribute('src')).toContain('expert-hand.gif')
    await rerender(<CapabilityHero kind="skills" />)
    expect(container.querySelectorAll('.postcard-cover')).toHaveLength(3)
    await rerender(<CapabilityHero kind="connectors" />)
    expect(container.querySelector('.connector-reference-art')!.getAttribute('src')).toContain('connectors.svg')
    await rerender(<XiaoyinMascot variant="hero" />)
    expect(container.querySelector('img')!.getAttribute('src')).toBe(original)
  })
})

it('switches expert scenes without a duplicate creation entry', async () => {
  await render(<CapabilityHero kind="experts" />, async (container) => {
    const scenes = container.querySelectorAll<HTMLButtonElement>('.hero-scene-switcher button')
    expect(scenes).toHaveLength(3)
    expect(scenes[0].getAttribute('aria-pressed')).toBe('true')
    await act(async () => scenes[1].click())
    expect(container.textContent).toContain('法律行业')
    expect(scenes[1].getAttribute('aria-pressed')).toBe('true')
    expect(scenes[0].getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('.catalog-create')).toBeNull()
    expect(container.textContent).not.toContain('让小胤帮我创建')
    expect(container.querySelectorAll('button')).toHaveLength(3)
  })
})

it('gives knowledge a reading pose and non-interactive capability labels', async () => {
  await render(<CapabilityHero kind="knowledge" />, async (container) => {
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('小胤正在翻阅资料')
    expect(container.querySelector('.knowledge-turning-page')).not.toBeNull()
    expect(container.querySelector('.knowledge-reader-gaze')).not.toBeNull()
    expect(container.querySelectorAll('.knowledge-hero-features li')).toHaveLength(3)
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).not.toContain('上传文档后即可检索')
  })
})

it('opens real skill highlights and omits empty quick links', async () => {
  const open = vi.fn()
  const highlights = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: `技能 ${id}` }))
  await render(<CapabilityHero kind="skills" highlights={highlights} onOpenHighlight={open} />, async (container, rerender) => {
    const links = container.querySelectorAll<HTMLButtonElement>('.skill-hero-postcards button')
    expect(links).toHaveLength(3)
    await act(async () => links[1].click())
    expect(open).toHaveBeenCalledWith('b')
    await rerender(<CapabilityHero kind="skills" onOpenHighlight={open} />)
    expect(container.querySelector('.skill-hero-postcards button')).toBeNull()
  })
})

it('rotates expert scenes and clears the timer when leaving the page', async () => {
  vi.useFakeTimers()
  try {
    await render(<CapabilityHero kind="experts" />, async (container, rerender) => {
      await act(async () => { vi.advanceTimersByTime(5500) })
      expect(container.querySelector('.hero-scene-copy')!.textContent).toContain('法律行业')
      await act(async () => container.querySelector<HTMLButtonElement>('.hero-scene-switcher button')!.focus())
      await act(async () => { vi.advanceTimersByTime(5500) })
      expect(container.querySelector('.hero-scene-copy')!.textContent).toContain('法律行业')
      await rerender(<CapabilityHero kind="skills" />)
      expect(vi.getTimerCount()).toBe(0)
    })
  } finally { vi.useRealTimers() }
})

it('announces loading without exposing fake interactive cards', async () => {
  await render(<CatalogLoading kind="skill" label="正在加载技能" />, async (container) => {
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    expect(container.querySelectorAll('.catalog-skeleton')).toHaveLength(6)
    expect(container.querySelector('button')).toBeNull()
  })
})
