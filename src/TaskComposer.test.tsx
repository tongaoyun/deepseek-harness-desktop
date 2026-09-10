// @vitest-environment jsdom
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TaskComposer } from './TaskComposer'
import type { ChatPageProps } from './ChatPage'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
async function fixture(initial: string, overrides: Partial<ChatPageProps>, check: (container: HTMLDivElement) => Promise<void>) {
  const noop = () => {}
  function Host() {
    const [prompt, onPrompt] = useState(initial)
    const [refs, setRefs] = useState<string[]>([])
    const composerRef = useRef<HTMLTextAreaElement>(null)
    return <TaskComposer activeModel="model" composerRef={composerRef} harnessHealth="ready" harnessHealthDetail="" harnessRunning={false}
      knowledgeBases={[]} localDirectories={[]} localFileError="" messageListRef={{ current: null }} messages={[]} modelMenuOpen={false} modelPickerRef={{ current: null }} models={[]} pendingAttachments={[]}
      onAddKnowledge={(id) => setRefs((current) => [...current, id])} onRemoveKnowledge={(id) => setRefs((current) => current.filter((value) => value !== id))}
      onAddLocalDirectory={noop} onAddLocalFiles={noop} onCancel={noop} onPrepareRetry={noop} onPrompt={onPrompt} onReconnect={noop} onRecoverHarness={noop} onRemoveAttachment={noop} onRemoveLocalDirectory={noop} onSelectModel={noop} onSubmit={(event) => event.preventDefault()} onToggleModelMenu={noop}
      prompt={prompt} runtimeStatus="ready" selectedKnowledgeBaseRefs={refs} taskMonitor={{ status: 'idle', activity: '', updatedAt: '', steps: [], artifacts: [] }} onPreview={noop} {...overrides} />
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try { await act(async () => root.render(<Host />)); await check(container) }
  finally { await act(async () => root.unmount()); container.remove() }
}
async function click(container: HTMLElement, selector: string) { await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click()) }

it.each([false, true])('labels direct continuation accurately when the existing queue is paused: %s', async (paused) => {
  await fixture('补充资料', { queue: { paused, items: [{ id: 'queued', text: '发送报告' }] } }, async (container) => {
    expect(container.querySelector('.send-button')?.getAttribute('aria-label')).toBe(paused ? '发送' : '加入消息队列')
    expect(container.querySelector('.composer-hint')?.textContent).toContain(paused ? 'Enter 发送' : 'Enter 加入队列')
  })
})

it('shows model choices without a company heading and preserves model selection', async () => {
  const select = vi.fn()
  await fixture('', { modelMenuOpen: true, activeModel: 'deepseek-v4-flash', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], onSelectModel: select }, async (container) => {
    const menu = container.querySelector('.model-menu')!
    expect(menu.querySelector('small')).toBeNull()
    expect(menu.textContent).not.toContain('公司可用模型')
    expect(menu.querySelectorAll('button')).toHaveLength(2)
    expect(menu.querySelector('button.active')!.getAttribute('title')).toBe('deepseek-v4-flash')
    expect(menu.querySelector('button.active svg')).not.toBeNull()
    await click(container, '.model-menu button:last-child')
    expect(select).toHaveBeenCalledWith('deepseek-v4-pro')
  })
})

it('shows an explicit empty model state instead of inventing a selectable fallback', async () => {
  await fixture('保留任务', { models: [], activeModel: '', modelMenuOpen: true }, async (container) => {
    const label = container.querySelector<HTMLButtonElement>('.model-label')!
    expect(label.disabled).toBe(true)
    expect(label.textContent).toContain('暂无可用模型')
    expect(container.querySelector('.model-menu')).toBeNull()
    expect(container.querySelector('textarea')!.value).toBe('保留任务')
  })
})

it('selects a skill in the middle of a sentence, preserves surrounding text and supports removal', async () => {
  await fixture('帮我 /周报', { invocations: [{ token: '/skill:weekly', id: 'weekly', kind: 'skill', name: '周报', description: '整理本周数据' }] }, async (container) => {
    await click(container, '[role="option"]')
    expect(container.querySelector('textarea')!.value).toBe('帮我 ')
    expect(container.querySelector('.composer-capability')!.textContent).toContain('周报')
    await click(container, '[aria-label="移除能力 周报"]')
    expect(container.querySelector('.composer-capability')).toBeNull()
    expect(container.querySelector('textarea')!.value).toBe('帮我 ')
  })
})
it('lets a single chosen capability describe itself until the employee types', async () => {
  const invocations = [{ token: '/kit:fullstack:api-design', id: 'fullstack', kind: 'expert-kit' as const, name: 'API接口设计', description: 'RESTful API 规范设计、OpenAPI 3.0 文档生成' }]
  await fixture('/kit:fullstack:api-design ', { invocations }, async (container) => {
    expect(container.querySelector('.composer-capability')!.textContent).toContain('API接口设计')
    expect(container.querySelector('textarea')!.placeholder).toBe('RESTful API 规范设计、OpenAPI 3.0 文档生成')
  })
  await fixture('/kit:fullstack:api-design 帮我设计订单接口', { invocations }, async (container) => {
    expect(container.querySelector('textarea')!.value).toBe('帮我设计订单接口')
  })
  await fixture('/kit:design /kit:product', { invocations: ['design', 'product'].map((id) => ({ token: `/kit:${id}`, id, name: id, description: '说明', kind: 'expert-kit' as const })) }, async (container) => {
    expect(container.querySelector('textarea')!.placeholder).toBe('描述任务，/ 调用技能或套件，@ 添加上下文')
  })
})
it('keeps a kit-bundled skill out of the menus while still naming it once chosen', async () => {
  const invocations = [
    { token: '/kit:fullstack', id: 'fullstack', kind: 'expert-kit' as const, name: '全栈开发专家', description: '开发套件' },
    { token: '/kit:fullstack:skill:api-design', id: 'fullstack', kind: 'expert-kit' as const, name: 'API接口设计', description: '设计接口', bundledSkill: true },
  ]
  await fixture('/', { invocations }, async (container) => {
    expect([...container.querySelectorAll('[role="option"]')].map((item) => item.textContent)).toEqual(['全栈开发专家开发套件'])
  })
  await fixture('/kit:fullstack:skill:api-design ', { invocations }, async (container) => {
    expect(container.querySelector('.composer-capability')!.textContent).toContain('API接口设计')
    expect(container.querySelector('textarea')!.placeholder).toBe('设计接口')
  })
})
it('turns an at query into actual knowledge context rather than leaving an inert mention', async () => {
  await fixture('参考 @资料', { knowledgeBases: [{ id: 'kb', reference: 'kb:manual', name: '公司资料', description: '流程说明', scope: 'ORGANIZATION' }] as ChatPageProps['knowledgeBases'] }, async (container) => {
    await click(container, '[role="option"]')
    expect(container.querySelector('textarea')!.value).toBe('参考 ')
    expect(container.querySelector('.composer-capability')!.textContent).toContain('公司资料')
  })
})
it('removes only the selected kit from a combined task', async () => {
  await fixture('/kit:design /kit:product 做一个方案', { invocations: ['design', 'product'].map((id) => ({ token: `/kit:${id}`, id, name: id, description: '', kind: 'expert-kit' })) }, async (container) => {
    expect(container.querySelectorAll('.composer-capability')).toHaveLength(2)
    await click(container, '[aria-label="移除能力 design"]')
    expect(container.querySelectorAll('.composer-capability')).toHaveLength(1)
    expect(container.querySelector('.composer-capability')!.textContent).toContain('product')
    expect(container.querySelector('textarea')!.value).toBe('做一个方案')
  })
})
it('offers management for empty categories and closes the panel with Escape', async () => {
  const browse = vi.fn()
  await fixture('草稿', { onBrowseCapability: browse }, async (container) => {
    await click(container, '[aria-label="添加上下文"]')
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(4)
    await click(container, '[role="tab"]:nth-child(2)')
    await click(container, '.composer-context-menu footer button')
    expect(browse).toHaveBeenCalledWith('skill')
    expect(container.querySelector('textarea')!.value).toBe('草稿')
    await click(container, '[aria-label="添加上下文"]')
    await act(async () => container.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    await click(container, '[aria-label="添加上下文"]')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
})

it('uses cascading categories with hover, keyboard navigation, and a direct attachment entry', async () => {
  const add = vi.fn()
  await fixture('保持正文', { onAddLocalFiles: add }, async (container) => {
    await click(container, '[aria-label="添加上下文"]')
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    await act(async () => tabs[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[role="tabpanel"]')!.getAttribute('aria-label')).toBe('技能')
    await act(async () => { tabs[1].focus(); tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(tabs[2].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs[2])
    await click(container, '.composer-add-file')
    expect(add).toHaveBeenCalledOnce()
    expect(container.querySelector('.composer-cascade')).toBeNull()
    expect(container.querySelector('textarea')!.value).toBe('保持正文')
  })
})
it('routes pasted images through attachment import and exposes recent work directories', async () => {
  const paste = vi.fn().mockResolvedValue(true); const recent = vi.fn()
  await fixture('', { onPasteFiles: paste, onSelectRecentDirectory: recent, recentDirectories: [{ id: 'work', name: '工作资料', path: '/work' }] }, async (container) => {
    const image = new File(['png'], '截图.png', { type: 'image/png' })
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files: [image], getData: () => '' } })
    await act(async () => container.querySelector('textarea')!.dispatchEvent(event))
    expect(paste).toHaveBeenCalledWith([image])
    expect(event.defaultPrevented).toBe(true)
    await click(container, '.context-directory-button')
    await click(container, '[title="/work"]')
    expect(recent).toHaveBeenCalledWith('/work')
  })
})

it('pastes ordinary text over the selection when the clipboard contains no files', async () => {
  await fixture('前旧后', { onPasteFiles: vi.fn().mockResolvedValue(false) }, async (container) => {
    const input = container.querySelector('textarea')!
    input.setSelectionRange(1, 2)
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: () => '新\n内容' } })
    await act(async () => input.dispatchEvent(event))
    expect(input.value).toBe('前新\n内容后')
    expect(input.readOnly).toBe(false)
  })
})

it('passes non-image clipboard files through without inserting their filename into the prompt', async () => {
  const paste = vi.fn().mockResolvedValue(true)
  await fixture('检查资料', { onPasteFiles: paste }, async (container) => {
    const file = new File(['pdf'], '中文报告.pdf', { type: 'application/pdf' })
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files: [file], getData: () => '中文报告.pdf' } })
    await act(async () => container.querySelector('textarea')!.dispatchEvent(event))
    expect(paste).toHaveBeenCalledWith([file])
    expect(container.querySelector('textarea')!.value).toBe('检查资料')
  })
})

it('leaves normal text paste available while running and clearly rejects file paste', async () => {
  const paste = vi.fn()
  await fixture('追加要求', { currentTaskRunning: true, onPasteFiles: paste }, async (container) => {
    for (const files of [[], [new File(['a'], 'a.txt')]]) {
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: { files, getData: () => '文字' } })
      await act(async () => container.querySelector('textarea')!.dispatchEvent(event))
      expect(event.defaultPrevented).toBe(files.length > 0)
    }
    expect(paste).not.toHaveBeenCalled()
    expect(container.textContent).toContain('请等待当前处理完成')
  })
})
