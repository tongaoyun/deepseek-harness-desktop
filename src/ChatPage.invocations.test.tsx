// @vitest-environment jsdom
import { act, useRef, useState, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ChatPage } from './ChatPage'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('resizes the composer, selects a command with the keyboard, and then submits normally', async () => {
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault())
  const noop = () => undefined
  function Composer() {
    const [prompt, setPrompt] = useState('/')
    const composerRef = useRef<HTMLTextAreaElement>(null)
    const props: ComponentProps<typeof ChatPage> = {
      activeModel: 'test', composerRef, harnessHealth: 'ready', harnessHealthDetail: '', harnessRunning: false,
      knowledgeBases: [], localDirectories: [], localFileError: '', messageListRef: { current: null }, messages: [],
      modelMenuOpen: false, modelPickerRef: { current: null }, models: [], pendingAttachments: [],
      onAddKnowledge: noop, onAddLocalDirectory: noop, onAddLocalFiles: noop, onCancel: noop, onPrepareRetry: noop,
      onPrompt: setPrompt, onReconnect: noop, onRecoverHarness: noop, onRemoveAttachment: noop, onRemoveKnowledge: noop,
      onRemoveLocalDirectory: noop, onSelectModel: noop, onSubmit: submit, onToggleModelMenu: noop,
      prompt, runtimeStatus: 'ready', selectedKnowledgeBaseRefs: [], taskMonitor: { status: 'idle', activity: '', updatedAt: '', steps: [], artifacts: [] },
      invocations: [{ token: '/kit:reports', kind: 'expert-kit', id: 'reports', name: '分析专家', description: '分析' }, { token: '/kit:reports:weekly', kind: 'expert-kit', id: 'reports', name: '周报', description: '每周报告' }],
    }
    return <ChatPage {...props} />
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Composer />))
    const input = container.querySelector('textarea')!
    expect(input.style.height).toBe('64px')
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 500 })
    const press = async (key: string, isComposing = false) => act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key, isComposing, bubbles: true, cancelable: true })) })
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(2)
    await press('Enter', true)
    expect(input.value).toBe('/')
    await press('ArrowDown')
    await press('Enter')
    expect(input.value).toBe('')
    expect(container.querySelector('.composer-capability')?.textContent).toContain('周报')
    expect(input.style.height).toBe('220px')
    expect(container.querySelector('[role="listbox"]')).toBeNull()
    expect(submit).not.toHaveBeenCalled()
    await press('Enter')
    expect(submit).toHaveBeenCalledOnce()
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 40 })
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '继续')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input.style.height).toBe('64px')
  } finally { await act(async () => root.unmount()); container.remove() }
})
