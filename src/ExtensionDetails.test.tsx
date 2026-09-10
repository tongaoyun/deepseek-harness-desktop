// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ExpertKitDetailsModal } from './ExpertKitDetailsModal'
import { SkillDetailsModal } from './SkillDetailsModal'
import { readExtensionContents, type ExpertKitView, type ExtensionDocument } from './expertKits'
import type { SkillView } from './skills'
import type { ConnectorRuntimeDefinition, KnowledgeBaseEntry } from './types'

vi.mock('./expertKits', () => ({ readExtensionContents: vi.fn(), setExtensionEnabled: vi.fn(), revealExtensionDirectory: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => vi.resetAllMocks())
const api: ExtensionDocument = { id: 'api-design', name: 'API接口设计', summary: '请求与响应结构标准化', argumentHint: '输入要设计的接口', path: 'skills/api-design/SKILL.md', content: '---\nname: api-design\n---\n# API接口设计\n\n检查接口。', userInvocable: true }
const background: ExtensionDocument = { ...api, id: 'internal', name: '后台知识', path: 'skills/internal/SKILL.md', userInvocable: false }
const kit: ExpertKitView = {
  id: 'fullstack-dev-expert', name: '全栈开发专家', version: '1.0.1', summary: '覆盖前后端开发与测试', category: 'code-development', minimumDesktopVersion: '0.1.30',
  commandIds: [], skillIds: [api.id, background.id], skillDetails: [
    { id: api.id, name: api.name, summary: api.summary, argumentHint: api.argumentHint ?? '' },
    { id: background.id, name: background.name, summary: background.summary, argumentHint: '' },
  ], connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [], sha256: '',
  installState: 'installed', readiness: 'ready', connectorIssues: [], knowledgeIssues: [], localOnly: false,
  installed: { source: 'catalog', enabled: true, installPath: '/extensions/fullstack', manifest: {
    schemaVersion: '2', kind: 'expert-kit', id: 'fullstack-dev-expert', name: '全栈开发专家', version: '1.0.1', summary: '覆盖前后端开发与测试', category: 'code-development', minimumDesktopVersion: '0.1.30',
    skills: [api, background], commands: [], connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [],
  } },
}

it('shows bundled skill names from the expert kit catalog before installation', async () => {
  const available = { ...kit, installed: undefined, installState: 'available' as const }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ExpertKitDetailsModal kit={available} skills={[]} connectors={[]}
      knowledgeBases={[]} installing={false} removing={false} onClose={vi.fn()} onInstall={vi.fn()}
      onSchedule={vi.fn()} />))
    expect(container.querySelector('.detail-skill-list')?.textContent).toContain('API接口设计')
    expect(container.querySelector('.detail-skill-list')?.textContent).toContain('输入要设计的接口')
    expect(container.querySelector('.detail-skill-list')?.textContent).toContain('后台知识')
    expect(container.querySelector('.detail-skill-list')?.textContent).not.toContain('api-design')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

it('uses the selected skill, keeps non-invocable knowledge readable, and closes only the nested reader', async () => {
  vi.mocked(readExtensionContents).mockResolvedValue({ readme: '# 开发流程', skills: [api, background], commands: [] })
  const onClose = vi.fn(), onUseSkill = vi.fn(), onCustomize = vi.fn()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const render = (value = kit) => <ExpertKitDetailsModal kit={value} skills={[]} connectors={[]} knowledgeBases={[]} installing={false} removing={false} onClose={onClose} onInstall={vi.fn()} onSchedule={vi.fn()} onUseSkill={onUseSkill} onCustomizeDocument={onCustomize} />
  try {
    await act(async () => root.render(render()))
    expect(container.querySelector('.expert-dependency-state')).toBeNull()
    expect(container.textContent).not.toContain('不绑定知识库')
    expect(container.querySelectorAll('.detail-command-list button')).toHaveLength(1)
    expect(container.querySelector('.detail-command-list button')?.textContent).toContain('输入要设计的接口')
    expect(container.querySelectorAll('.extension-source-list button')).toHaveLength(2)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="使用技能：API接口设计"]')!.click())
    expect(onUseSkill).toHaveBeenLastCalledWith(api)
    const opener = container.querySelector<HTMLButtonElement>('[aria-label="知识技能：API接口设计"]')!
    opener.focus()
    await act(async () => opener.click())
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('来自 全栈开发专家')
    await act(async () => container.querySelector<HTMLButtonElement>('footer button')!.click())
    expect(container.querySelector('footer')?.textContent).toBe('自定义修改')
    expect(onCustomize).toHaveBeenCalledWith(api)
    expect(onUseSkill).toHaveBeenCalledOnce()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(onClose).not.toHaveBeenCalled()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
    await act(async () => root.render(render({ ...kit, installed: { ...kit.installed!, enabled: false } })))
    expect(container.querySelector<HTMLButtonElement>('.detail-command-list button')!.disabled).toBe(true)
    await act(async () => opener.click())
    expect(container.querySelector('footer')?.textContent).toBe('自定义修改')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('opens the full README from its bounded preview and restores its opener', async () => {
  vi.mocked(readExtensionContents).mockResolvedValue({ readme: '# 开发指南\n\n## 目标角色\n\n工程师\n\n|命令|说明|\n|---|---|\n|/接口|设计接口|', skills: [], commands: [] })
  const close = vi.fn(), customize = vi.fn()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ExpertKitDetailsModal kit={{ ...kit, installed: { ...kit.installed!, author: 'QoderWork' } }} skills={[]} connectors={[]} knowledgeBases={[]} installing={false} removing={false} onClose={close} onInstall={vi.fn()} onSchedule={vi.fn()} onCustomize={customize} onExport={vi.fn()} />))
    expect(container.textContent).toContain('@QoderWork')
    expect(container.querySelector('[aria-label="编辑"]')?.textContent).toBe('编辑')
    expect(container.querySelector('[aria-label="分享此套件"]')?.textContent).toBe('分享此套件')
    const opener = container.querySelector<HTMLElement>('[aria-label="查看完整套件说明"]')!
    expect(opener.querySelector('[inert][aria-hidden="true"]')).not.toBeNull()
    opener.focus()
    await act(async () => opener.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('套件说明')
    expect(dialog.querySelector('table')?.textContent).toContain('设计接口')
    expect(dialog.querySelector('footer')).toBeNull()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(close).not.toHaveBeenCalled()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
    await act(async () => opener.click())
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('shows working connector controls and the Xiaoyin knowledge base entry', async () => {
  vi.mocked(readExtensionContents).mockResolvedValue({ readme: '', skills: [], commands: [] })
  const connector = { id: 'notion', name: 'Notion', version: '1', status: 'ready', transport: 'streamable-http', url: 'https://notion.test/mcp', authMode: 'oauth', enabled: true, toolNames: ['search', 'write'] } satisfies ConnectorRuntimeDefinition
  const knowledgeBase = { id: 'kb-1', referenceKey: 'product', reference: 'kb:product', scope: 'TEAM', name: '产品资料', description: '', createdAt: '', updatedAt: '' } satisfies KnowledgeBaseEntry
  const onToggleConnector = vi.fn(), onConfigureKnowledge = vi.fn()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ExpertKitDetailsModal
      kit={{ ...kit, connectorRefs: ['notion'], knowledgeBaseRefs: ['kb:product'] }}
      skills={[]}
      connectors={[connector]}
      knowledgeBases={[knowledgeBase]}
      installing={false}
      removing={false}
      onClose={vi.fn()}
      onInstall={vi.fn()}
      onSchedule={vi.fn()}
      onToggleConnector={onToggleConnector}
      onConfigureKnowledge={onConfigureKnowledge}
    />))
    expect(container.textContent).toContain('已启用 · 使用时检查 · 2 个工具')
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="关闭 Notion"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await act(async () => toggle.click())
    expect(onToggleConnector).toHaveBeenCalledWith(connector, false)
    const knowledge = [...container.querySelectorAll<HTMLButtonElement>('.extension-capability-link')].find((button) => button.textContent?.includes('产品资料'))!
    expect(knowledge.textContent).toContain('团队知识库 · 可用于检索')
    await act(async () => knowledge.click())
    expect(onConfigureKnowledge).toHaveBeenCalledOnce()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('opens standalone skills in a focused reader and returns focus to the catalog', async () => {
  vi.mocked(readExtensionContents).mockResolvedValue({ readme: '', skills: [api], commands: [] })
  const skill: SkillView = { ...kit, sourceKitId: '', triggers: [], installed: { ...kit.installed!, manifest: { ...kit.installed!.manifest, kind: 'skill' } } }
  const onClose = vi.fn(), onUse = vi.fn()
  const opener = document.body.appendChild(document.createElement('button'))
  opener.focus()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<SkillDetailsModal skill={skill} connectors={[]} knowledgeBases={[]} installing={false} removing={false} onClose={onClose} onInstall={vi.fn()} onUse={onUse} onRemove={vi.fn()} />))
    expect(container.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull()
    expect(document.activeElement).toBe(container.querySelector('[aria-label="关闭原文"]'))
    expect(container.querySelector('.extension-reader-body')?.textContent).toContain('检查接口。')
    expect(container.textContent).not.toContain('已就绪')
    expect(container.textContent).not.toContain('触发场景')
    const menu = container.querySelector('details')!
    menu.open = true
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(menu.open).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(onClose).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
    expect(document.activeElement).toBe(opener)
  } finally { container.remove(); opener.remove() }
})
