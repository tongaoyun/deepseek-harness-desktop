// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { TaskKnowledgeInput } from '../src/client/TaskKnowledgeInput.tsx'
import { items } from '../src/client/catalog-shared.tsx'
import type { TaskModeActions } from '../src/client/harness-actions.ts'
import { zh } from '../src/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function unusedHook(): never { throw new Error('Knowledge selection does not use this slot source') }

function fixture() {
  const translations = new Map<string, string>(Object.entries(zh))
  const sessionId = SessionId('knowledge-task')
  const mode = { id: 'standard', isDefault: true, selectable: true, defaultable: true, name: '标准模式' }
  let ids = ['policy']
  let open: (() => void) | undefined
  let notify: ((event: { type: string }) => void) | undefined
  vi.stubGlobal('dshDesktop', { extensions: {
    subscribe: (_namespace: string, listener: typeof notify) => { notify = listener; return () => { notify = undefined } },
  } })
  const readMode = vi.fn<TaskModeActions['readMode']>(async () => ({ mode, options: [mode], capabilities: {
    basePresetId: 'standard', connectorIds: [], requiredConnectorIds: [], knowledgeBaseIds: ids,
    requiredKnowledgeBaseIds: [], knowledgeBaseRefs: [],
  } }))
  const props: ComponentProps<typeof TaskKnowledgeInput> = {
    sessionId, useSessions: selector => selector({ ids: [sessionId], phase: 'ready', projectionsBySession: {}, byId: {
      [sessionId]: { id: sessionId, displayTitle: 'Session', blank: true, running: false, updatedAt: 0,
        retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'standard' } },
    } }), readMode, readKnowledgeCatalog: vi.fn(async () => items([
      { id: 'policy', name: '业务规范' }, { id: 'manuals', name: '业务手册' },
    ])), setKnowledgeSelection: vi.fn(async () => {}), recoverCapabilities: vi.fn(async () => {}),
    retryCapabilities: vi.fn(async () => {}), openCatalog: vi.fn(),
    subscribeOpen: (listener) => { open = listener; return () => { open = undefined } },
    useSession: unusedHook, useProjection: unusedHook, useConversation: unusedHook, useInput: unusedHook,
    useChat: unusedHook, useTrajectory: unusedHook, useAccess: unusedHook,
    useRemoteAccess: unusedHook, useSessionAccess: unusedHook, useWorkspaceAccess: unusedHook,
    inputActions: { captureInsertion: unusedHook, insertText: unusedHook, insertQuote: unusedHook,
      setDraft: unusedHook, persistDraft: unusedHook,
      addAttachments: unusedHook, removeAttachment: unusedHook, pruneAttachments: unusedHook, submit: unusedHook },
    usePanelInfo: unusedHook, useSessionStatus: unusedHook,
    useSessionRetainInfo: unusedHook, useWorkspaces: unusedHook, useResource: unusedHook,
    t: key => translations.get(key) ?? key,
  }
  return { props, open: () => { act(() => { open?.() }) }, publish: (next: string[]) => {
    ids = next
    act(() => { notify?.({ type: 'catalog.changed' }) })
  } }
}

it('keeps task knowledge editable when a capability refresh arrives before preparation settles', async () => {
  const f = fixture()
  let finish!: () => void
  const preparation = new Promise<void>((resolve) => { finish = resolve })
  const setKnowledgeSelection = vi.fn(async () => preparation)
  const view = render(<TaskKnowledgeInput {...f.props} setKnowledgeSelection={setKnowledgeSelection} />)
  await screen.findByRole('button', { name: '业务规范' })
  f.open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '业务手册' }))
  fireEvent.click(screen.getByRole('button', { name: zh.applyKnowledge }))
  expect(setKnowledgeSelection).toHaveBeenCalledExactlyOnceWith(['policy', 'manuals'], 'knowledge-task')
  f.publish(['policy', 'manuals'])
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  await act(async () => { finish(); await preparation })
  const references = view.container.querySelector('[role=group]')!
  expect([...references.querySelectorAll('button')].every(button => !button.disabled)).toBe(true)
  f.open()
  expect(await screen.findByRole('checkbox', { name: '业务手册' })).toHaveProperty('checked', true)
})
