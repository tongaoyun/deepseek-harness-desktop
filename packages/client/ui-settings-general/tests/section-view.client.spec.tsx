// @vitest-environment jsdom
import { useEffect, useState } from 'react'
import { act, fireEvent, within } from '@testing-library/react'
import { describe, expect, onTestFinished, vi } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createSettingsShellStore } from '../src/client/shell-store.ts'

const it = createClientTest({ roster: webApp }, { mount: true })
const PANEL = 'test-settings-page' as MainPanelId

describe('shared settings section view', () => {
  it('shares a registered page across main and settings, suspends covered instances, and follows Loader lifecycle', async ({ start }) => {
    // jsdom has no layout or scrolling implementation.
    const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    onTestFinished(() => {
      if (previous) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previous)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    })
    const c = await start()
    const view = within(c.container!)
    const shell = () => (c.ctx.slots.entries('sidebar.settings')[0]!.store as ReturnType<typeof createSettingsShellStore>).create()
    let mounted = 0
    const closeMain = () => { c.ctx.layout.selectPanel(null) }
    const Page = ({ close }: SettingsSectionOwnerProps) => {
      useEffect(() => { mounted += 1; return () => { mounted -= 1 } }, [])
      return <button onClick={close}>Leave shared page</button>
    }
    const registerPage = () => c.ctx.slots.inject('settings.section', () => c.ctx.slots.register({ name: 'settings.section', id: 'shared-test', label: 'Shared test' }, Page))
    let offPage = registerPage()
    const offPanel = c.ctx.slots.inject('main', () => c.ctx.slots.register({ name: 'main', key: PANEL }, ({ renderFactorySlot }: PropsRuntime<'main'> & PropsRenderFactories) => {
      const [sectionId, setSectionId] = useState('shared-test')
      return <>
        <button onClick={() => { setSectionId('missing-page') }}>Missing page</button>
        <div data-testid="shared-main">{renderFactorySlot('settings.section-view', { sectionId, close: closeMain, presentation: 'embedded' })}</div>
      </>
    }))
    onTestFinished(() => { offPage(); offPanel() })
    await act(async () => { c.ctx.layout.selectPanel(PANEL); await c.flush() })
    expect(view.getByTestId('shared-main').textContent).toBe('Leave shared page')
    expect(mounted).toBe(1)
    await act(async () => { shell().actions.openSection('shared-test'); await c.flush() })
    expect(view.getByTestId('shared-main').textContent).toBe('')
    expect(mounted).toBe(1)
    const dialog = within(document.body).getByRole('dialog', { name: 'Settings' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave shared page' }))
    await c.flush()
    expect(view.getByTestId('shared-main').textContent).toBe('Leave shared page')
    expect(mounted).toBe(1)
    await act(async () => { offPage(); await c.flush() })
    expect(view.getByTestId('shared-main').textContent).toBe('')
    expect(mounted).toBe(0)
    await act(async () => { offPage = registerPage(); await c.flush() })
    expect(mounted).toBe(1)
    await act(async () => { await c.reload('@deepseek-ai/dsh-client-ui-sidebar'); c.ctx.layout.selectPanel(PANEL); await c.flush() })
    expect(mounted).toBe(1)
    fireEvent.click(view.getByRole('button', { name: 'Missing page' }))
    expect(view.getByTestId('shared-main').textContent).toBe('')
    expect(mounted).toBe(0)
    await act(async () => { await c.unload('@deepseek-ai/dsh-client-ui-settings-general'); await c.flush() })
    expect(c.ctx.slots.spec('settings.section')).toBeUndefined()
  }, 60_000)
})
