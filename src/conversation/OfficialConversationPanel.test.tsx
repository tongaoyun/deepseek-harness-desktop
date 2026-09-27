// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, expect, it } from 'vitest'
import { OfficialConversationPanel } from './OfficialConversationPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''
})

it('boots the official Conversation shell without the product transcript renderer', async () => {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(<OfficialConversationPanel sessionId="session-test" />); await new Promise((resolve) => setTimeout(resolve, 1_000)) })
  expect((globalThis as any).__ModuleLoader__).toBeDefined()
  expect((globalThis as any).__ModuleLoader__.mode).toBe('queue')
  expect(container.querySelector('[data-official-conversation="true"]')).not.toBeNull()
  expect(container.querySelector('.official-conversation-error')).toBeNull()
})
