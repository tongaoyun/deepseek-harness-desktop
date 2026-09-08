// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ExpertKitDetailsModal } from './ExpertKitDetailsModal'
import { SkillCatalogPage } from './ExtensionCatalogPages'
import { ExtensionPageActions } from './ExtensionPageActions'
import type { ExpertKitView } from './expertKits'
import type { SkillView } from './skills'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const noop = () => undefined
const skill: SkillView = {
  id: 'review', name: '代码审查', summary: '检查代码并给出修改建议', version: '1.0.0',
  category: 'code-review', sourceKitId: '', triggers: ['检查代码'], minimumDesktopVersion: '0.1.0',
  requiredTools: [], connectorRefs: [], knowledgeBaseRefs: [], sha256: 'a'.repeat(64),
  installState: 'available', readiness: 'ready', connectorIssues: [], knowledgeIssues: [],
}
const kit: ExpertKitView = {
  id: 'developer', name: '开发专家', summary: '开发工作方案', version: '1.0.0', category: 'code-development',
  minimumDesktopVersion: '0.1.0', commandIds: ['review'], skillIds: ['review'], connectorRefs: [],
  knowledgeBaseRefs: [], requiredTools: [], serverWorkflows: [], sha256: 'a'.repeat(64),
  installState: 'installed', installedVersion: '1.0.0', readiness: 'ready', connectorIssues: [], knowledgeIssues: [], localOnly: false,
}

async function render(element: ReactNode, check: (container: HTMLDivElement) => Promise<void>) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try { await act(async () => root.render(element)); await check(container) }
  finally { await act(async () => root.unmount()); container.remove() }
}

it('opens skill details from its title and its action without installing', async () => {
  const open = vi.fn()
  const create = vi.fn()
  await render(<SkillCatalogPage all={[skill]} visible={[skill]} loading={false} error="" filter="market" category="all" onFilter={noop} onCategory={noop} onOpen={open} onCreate={create} />, async (container) => {
    await act(async () => container.querySelector<HTMLButtonElement>('.market-card-name')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.market-card-title > button')!.click())
    expect(open.mock.calls).toEqual([['review'], ['review']])
    await act(async () => container.querySelector<HTMLButtonElement>('.skill-postcard')!.click())
    expect(open).toHaveBeenLastCalledWith('review')
    expect(create).not.toHaveBeenCalled()
  })
})

it('renders an inline detail page with command invocation and a focused back button', async () => {
  const use = vi.fn()
  const close = vi.fn()
  await render(<ExpertKitDetailsModal kit={kit} skills={[skill]} connectors={[]} knowledgeBases={[]} installing={false} removing={false} onClose={close} onInstall={noop} onSchedule={noop} onUse={use} />, async (container) => {
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('.detail-back'))
    await act(async () => container.querySelector<HTMLButtonElement>('.detail-command-list button')!.click())
    expect(use).toHaveBeenCalledWith('review')
    await act(async () => container.querySelector<HTMLButtonElement>('.detail-back')!.click())
    expect(close).toHaveBeenCalledOnce()
  })
})

it('uses compact installed skill rows and prevents using disabled skills', async () => {
  const installedSkill = { ...skill, installState: 'installed' as const, installed: { enabled: false, manifest: { kind: 'skill', id: 'review', version: '1.0.0', name: '代码审查' } } } as SkillView
  await render(<SkillCatalogPage all={[installedSkill]} visible={[installedSkill]} loading={false} error="" filter="installed" category="all" onFilter={noop} onCategory={noop} onOpen={noop} onUseSkill={noop} />, async (container) => {
    expect(container.querySelector('.installed-skill-row')).not.toBeNull()
    expect(container.querySelector('.extension-category-bar')).toBeNull()
    expect(container.querySelector('.catalog-sort')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('.installed-skill-use')!.disabled).toBe(true)
    expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
  })
})

it('keeps commands unavailable until the kit is installed', async () => {
  await render(<ExpertKitDetailsModal kit={{ ...kit, installState: 'available' }} skills={[skill]} connectors={[]} knowledgeBases={[]} installing={false} removing={false} onClose={noop} onInstall={noop} onSchedule={noop} />, async (container) => {
    expect(container.querySelector<HTMLButtonElement>('.detail-command-list button')!.disabled).toBe(true)
    expect(container.textContent).toContain('确认安装')
  })
})

it('navigates the add menu with arrows and returns focus with Escape', async () => {
  await render(<ExtensionPageActions page="skills" loading={false} query="" connectorIds={[]} onQuery={noop} onRefresh={noop} onCreate={noop} onUpload={noop} onImportConnector={async () => {}} />, async (container) => {
    const add = container.querySelector<HTMLButtonElement>('.add-extension-button')!
    await act(async () => add.click())
    const options = container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
    expect(document.activeElement).toBe(options[0])
    await act(async () => options[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement).toBe(options[1])
    await act(async () => options[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(add)
  })
})
