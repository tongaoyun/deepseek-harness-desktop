// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { TaskKnowledgeInput } from '../src/client/TaskKnowledgeInput.tsx'
import { items } from '../src/client/catalog-shared.tsx'
import type { TaskModeActions } from '../src/client/harness-actions.ts'
import { zh } from '../src/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function unusedHook(): never { throw new Error('Knowledge selection does not use this slot source') }

function fixture(initialSession = Promise.resolve({ authenticated: true, employeeId: 'employee-a' })) {
  const translations = new Map<string, string>(Object.entries(zh))
  const sessionId = SessionId('knowledge-task')
  const mode = { id: 'standard', isDefault: true, selectable: true, defaultable: true, name: '标准模式' }
  let ids = ['policy']
  let open: (() => void) | undefined
  let notify: ((event: { type: string; payload?: unknown }) => void) | undefined
  vi.stubGlobal('dshDesktop', { extensions: {
    invoke: vi.fn(async () => ({ ok: true, result: await initialSession })),
    subscribe: (_namespace: string, listener: typeof notify) => { notify = listener; return () => { notify = undefined } },
  } })
  const readMode = vi.fn<TaskModeActions['readMode']>(async () => ({ mode, options: [mode], capabilities: {
    basePresetId: 'standard', connectorIds: [], requiredConnectorIds: [], knowledgeBaseIds: ids,
    requiredKnowledgeBaseIds: [], knowledgeBaseRefs: [],
  } }))
  const props: ComponentProps<typeof TaskKnowledgeInput> = {
    useContextMenu: contextMenuHook(),
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
  }, session: (employeeId: string | undefined) => { act(() => {
    notify?.({ type: 'session.changed', payload: { authenticated: employeeId !== undefined, employeeId } })
  }) } }
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

it('refreshes knowledge labels after catalog changes while preserving the same task selection draft', async () => {
  const f = fixture()
  const readKnowledgeCatalog = vi.fn<TaskModeActions['readKnowledgeCatalog']>(f.props.readKnowledgeCatalog)
  render(<TaskKnowledgeInput {...f.props} readKnowledgeCatalog={readKnowledgeCatalog} />)
  await screen.findByRole('button', { name: '业务规范' })
  f.open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '业务手册' }))
  readKnowledgeCatalog.mockResolvedValue(items([
    { id: 'policy', name: '最新规范' }, { id: 'manuals', name: '最新手册' },
  ]))
  f.publish(['policy'])
  expect(await screen.findByRole('checkbox', { name: '最新手册' })).toHaveProperty('checked', true)
  expect(screen.getByRole('button', { name: '最新规范' })).not.toBeNull()
  expect(screen.queryByRole('checkbox', { name: '业务规范' })).toBeNull()
  expect(f.props.setKnowledgeSelection).not.toHaveBeenCalled()
})

it('keeps removed staged knowledge visible so the user can deselect it after a catalog refresh', async () => {
  const f = fixture()
  const readKnowledgeCatalog = vi.fn<TaskModeActions['readKnowledgeCatalog']>(f.props.readKnowledgeCatalog)
  render(<TaskKnowledgeInput {...f.props} readKnowledgeCatalog={readKnowledgeCatalog} />)
  await screen.findByRole('button', { name: '业务规范' })
  f.open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '业务手册' }))
  readKnowledgeCatalog.mockResolvedValue(items([
    { id: 'policy', name: '最新规范' }, { id: 'research', name: '调研资料' },
  ]))
  f.publish(['policy'])
  const removed = await screen.findByRole('checkbox', { name: 'manuals' })
  expect(removed).toHaveProperty('checked', true)
  expect(screen.getByText(zh.statusUnavailable)).not.toBeNull()
  fireEvent.click(removed)
  expect(screen.getByRole('button', { name: zh.applyKnowledge }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: '调研资料' }))
  fireEvent.click(screen.getByRole('button', { name: zh.applyKnowledge }))
  await waitFor(() => { expect(f.props.setKnowledgeSelection).toHaveBeenCalledExactlyOnceWith(['policy', 'research'], 'knowledge-task') })
})

it('clears the previous employee catalog and dialog even when the task and selected knowledge IDs stay the same', async () => {
  const f = fixture()
  const next = Promise.withResolvers<Awaited<ReturnType<TaskModeActions['readKnowledgeCatalog']>>>()
  const readKnowledgeCatalog = vi.fn<TaskModeActions['readKnowledgeCatalog']>(f.props.readKnowledgeCatalog)
  render(<TaskKnowledgeInput {...f.props} readKnowledgeCatalog={readKnowledgeCatalog} />)
  await screen.findByRole('button', { name: '业务规范' })
  f.open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '业务手册' }))
  const previousSignal = readKnowledgeCatalog.mock.calls.at(-1)?.[0]
  readKnowledgeCatalog.mockReturnValue(next.promise)
  try {
    f.session('employee-b')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: '业务规范' })).toBeNull()
    expect(previousSignal?.aborted).toBe(true)
    await act(async () => { next.resolve(items([{ id: 'policy', name: '当前员工知识' }])) })
    await screen.findByRole('button', { name: '当前员工知识' })
    f.open()
    expect(await screen.findByRole('checkbox', { name: '当前员工知识' })).toHaveProperty('checked', true)
    expect(screen.queryByRole('checkbox', { name: '业务手册' })).toBeNull()
    expect(f.props.setKnowledgeSelection).not.toHaveBeenCalled()
  } finally { await act(async () => { next.resolve([]) }) }
})

it('keeps staged knowledge choices during renewal of the same employee session', async () => {
  const f = fixture()
  render(<TaskKnowledgeInput {...f.props} />)
  await screen.findByRole('button', { name: '业务规范' })
  f.open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '业务手册' }))
  f.session('employee-a')
  await waitFor(() => { expect(f.props.readMode).toHaveBeenCalledTimes(2) })
  expect(screen.getByRole('dialog')).not.toBeNull()
  expect(screen.getByRole('checkbox', { name: '业务手册' })).toHaveProperty('checked', true)
})

it('ignores an old identity read after a newer employee event without clearing the new employee draft on renewal', async () => {
  const initial = Promise.withResolvers<{ authenticated: boolean; employeeId: string }>()
  const f = fixture(initial.promise)
  const readKnowledgeCatalog = vi.fn<TaskModeActions['readKnowledgeCatalog']>(f.props.readKnowledgeCatalog)
  render(<TaskKnowledgeInput {...f.props} readKnowledgeCatalog={readKnowledgeCatalog} />)
  try {
    await screen.findByRole('button', { name: '业务规范' })
    readKnowledgeCatalog.mockResolvedValue(items([
      { id: 'policy', name: '新员工规范' }, { id: 'manuals', name: '新员工手册' },
    ]))
    f.session('employee-b')
    await screen.findByRole('button', { name: '新员工规范' })
    f.open()
    fireEvent.click(await screen.findByRole('checkbox', { name: '新员工手册' }))
    await act(async () => { initial.resolve({ authenticated: true, employeeId: 'employee-a' }) })
    f.session('employee-b')
    await waitFor(() => { expect(f.props.readMode).toHaveBeenCalledTimes(3) })
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(screen.getByRole('checkbox', { name: '新员工手册' })).toHaveProperty('checked', true)
  } finally { await act(async () => { initial.resolve({ authenticated: true, employeeId: 'employee-a' }) }) }
})

it('aborts and ignores the previous employee catalog read after switching employees', async () => {
  const f = fixture()
  const old = Promise.withResolvers<Awaited<ReturnType<TaskModeActions['readKnowledgeCatalog']>>>()
  const readKnowledgeCatalog = vi.fn<TaskModeActions['readKnowledgeCatalog']>(f.props.readKnowledgeCatalog)
    .mockReturnValueOnce(old.promise)
  render(<TaskKnowledgeInput {...f.props} readKnowledgeCatalog={readKnowledgeCatalog} />)
  try {
    await waitFor(() => { expect(readKnowledgeCatalog).toHaveBeenCalledOnce() })
    const oldSignal = readKnowledgeCatalog.mock.calls[0]?.[0]
    readKnowledgeCatalog.mockResolvedValue(items([{ id: 'policy', name: '新员工资料' }]))
    f.session('employee-b')
    await screen.findByRole('button', { name: '新员工资料' })
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => { old.resolve(items([{ id: 'policy', name: '旧员工资料' }])) })
    expect(screen.queryByRole('button', { name: '旧员工资料' })).toBeNull()
    expect(screen.getByRole('button', { name: '新员工资料' })).not.toBeNull()
  } finally { await act(async () => { old.resolve([]) }) }
})
