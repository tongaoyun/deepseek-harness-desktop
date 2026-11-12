// @vitest-environment jsdom
import { createRef, type ComponentProps } from 'react'
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ProductError } from '@deepseek-harness/product/errors'
import { TaskKnowledgeInput } from '../src/client/TaskKnowledgeInput.tsx'
import { items } from '../src/client/catalog-shared.tsx'
import type { TaskModeActions } from '../src/client/harness-actions.ts'
import { en, zh } from '../src/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function unusedHook(): never { throw new Error('Knowledge selection does not use this slot source') }

it('clears private references on sign-out and ignores a late capability response until the employee signs in again', async () => {
  const f = fixture()
  render(<TaskKnowledgeInput {...f.props} />)
  await screen.findByRole('button', { name: '业务规范' })
  const pending = Promise.withResolvers<Awaited<ReturnType<TaskModeActions['readCapabilities']>>>()
  vi.mocked(f.props.readCapabilities).mockImplementationOnce(() => pending.promise)
  f.publish(['policy'])
  await waitFor(() => { expect(f.props.readCapabilities).toHaveBeenCalledTimes(2) })
  f.session(undefined)
  expect(screen.queryByRole('status')).toBeNull()
  f.open()
  expect(f.props.openEmployeeSignIn).toHaveBeenCalledOnce()
  expect(screen.queryByRole('group', { name: zh.taskKnowledge })).toBeNull()
  await act(async () => { pending.resolve({ basePresetId: 'standard', knowledgeBaseIds: ['policy'] }) })
  f.publish(['policy'])
  expect(f.props.readCapabilities).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('button', { name: '业务规范' })).toBeNull()
  f.session('employee-a')
  await screen.findByRole('button', { name: '业务规范' })
  expect(screen.queryByRole('status')).toBeNull()
})

it('removes cached private references when a configuration refresh returns unauthorized', async () => {
  const f = fixture()
  render(<TaskKnowledgeInput {...f.props} />)
  await screen.findByRole('button', { name: '业务规范' })
  vi.mocked(f.props.readCapabilities).mockRejectedValueOnce(new ProductError('EMPLOYEE_UNAUTHORIZED', 'Private diagnostic'))
  f.publish(['policy'])
  await waitFor(() => { expect(f.props.readCapabilities).toHaveBeenCalledTimes(2) })
  await waitFor(() => { expect(screen.queryByRole('group', { name: zh.taskKnowledge })).toBeNull() })
  f.open()
  expect(f.props.openEmployeeSignIn).toHaveBeenCalledOnce()
  expect(screen.queryByRole('group', { name: zh.taskKnowledge })).toBeNull()
  expect(screen.queryByText(/EMPLOYEE_UNAUTHORIZED|Private diagnostic/u)).toBeNull()
})

it('keeps a signed-out composer quiet and requests the global login only from the knowledge action', async () => {
  const f = fixture()
  vi.mocked(f.props.readCapabilities).mockRejectedValueOnce(new ProductError('EMPLOYEE_UNAUTHORIZED', 'Employee authentication is required'))
  const view = render(<TaskKnowledgeInput {...f.props} />)
  await waitFor(() => { expect(f.props.readCapabilities).toHaveBeenCalledOnce() })
  await act(async () => {})
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(f.props.openEmployeeSignIn).not.toHaveBeenCalled()
  const english = new Map<string, string>(Object.entries(en))
  view.rerender(<TaskKnowledgeInput {...f.props} t={key => english.get(key) ?? key} />)
  f.open()
  expect(f.props.openEmployeeSignIn).toHaveBeenCalledOnce()
  expect(f.props.openCatalog).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
  f.session('employee-a')
  await screen.findByRole('button', { name: '业务规范' })
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('retries a failed configuration read without applying a knowledge selection', async () => {
  const f = fixture()
  const response = Promise.withResolvers<Awaited<ReturnType<TaskModeActions['readCapabilities']>>>()
  vi.mocked(f.props.readCapabilities).mockRejectedValueOnce(new Error('Bridge disconnected')).mockReturnValueOnce(response.promise)
  const view = render(<TaskKnowledgeInput {...f.props} />)
  const capabilities = { basePresetId: 'standard', knowledgeBaseIds: ['policy'] }
  onTestFinished(() => { view.unmount(); response.resolve(capabilities) })
  expect((await screen.findByRole('alert')).textContent).toContain(zh.taskReadFailed)
  expect(screen.getByRole('alert').textContent).not.toContain('Bridge disconnected')
  const english = new Map<string, string>(Object.entries(en))
  view.rerender(<TaskKnowledgeInput {...f.props} t={key => english.get(key) ?? key} />)
  expect(screen.getByRole('alert').textContent).toContain(en.taskReadFailed)
  expect(f.props.readCapabilities).toHaveBeenCalledOnce()
  const notice = screen.getByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: en.retry })
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.getByRole('button', { name: en.retry })).toBe(retry)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  fireEvent.click(retry)
  expect(f.props.readCapabilities).toHaveBeenCalledTimes(2)
  expect({ message: notice.textContent, action: retry.textContent }).toMatchSnapshot('Pending capability retry')
  await act(async () => { response.resolve(capabilities) })
  await screen.findByRole('button', { name: '业务规范' })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(f.props.setKnowledgeSelection).not.toHaveBeenCalled()
  expect(f.props.readCapabilities).toHaveBeenCalledTimes(2)
})

it('shows a restart instruction when the running Host belongs to another employee', async () => {
  const f = fixture()
  vi.mocked(f.props.readCapabilities).mockRejectedValueOnce(new ProductError('PRODUCT_HOST_IDENTITY_CHANGED', 'Private diagnostic'))
  render(<TaskKnowledgeInput {...f.props} />)
  expect((await screen.findByRole('alert')).textContent).toMatchInlineSnapshot('"员工身份已变化，请重启桌面端后继续。"')
  expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
  expect(f.props.openEmployeeSignIn).not.toHaveBeenCalled()
})

it.each(['empty', 'selected', 'elsewhere', 'failure', 'unmount', 'session'] as const)(
  'restores capability retry focus through the native input only for its owned confirmed result: %s', async (outcome) => {
    const f = fixture()
    const response = Promise.withResolvers<Awaited<ReturnType<TaskModeActions['readCapabilities']>>>()
    const result = { basePresetId: 'standard', knowledgeBaseIds: outcome === 'empty' ? [] : ['policy'] }
    vi.mocked(f.props.readCapabilities).mockRejectedValueOnce(new Error('Offline')).mockReturnValueOnce(response.promise)
    const input = createRef<HTMLTextAreaElement>()
    const focusInput = vi.fn(() => { input.current?.focus({ preventScroll: true }) })
    const view = render(<><textarea ref={input} aria-label="原生输入框" defaultValue="保留草稿" />
      <TaskKnowledgeInput {...f.props} focusInput={focusInput} /></>)
    onTestFinished(() => { view.unmount(); response.resolve(result) })
    const notice = await screen.findByRole('alert')
    const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.retry })
    retry.focus(); act(() => { retry.click(); retry.click() })
    expect(screen.getByRole('alert')).toBe(notice)
    expect(document.activeElement).toBe(retry)
    if (outcome === 'elsewhere') input.current?.focus()
    if (outcome === 'unmount') view.unmount()
    if (outcome === 'session') view.rerender(<TaskKnowledgeInput {...f.props} sessionId={SessionId('another-task')}
      focusInput={focusInput} />)
    await act(async () => {
      if (outcome === 'failure') response.reject(new Error('Still offline'))
      else response.resolve(result)
    })
    expect(focusInput).toHaveBeenCalledTimes(outcome === 'empty' || outcome === 'selected' ? 1 : 0)
    if (outcome === 'empty' || outcome === 'selected' || outcome === 'elsewhere') {
      expect(document.activeElement).toBe(input.current)
      expect(input.current?.value).toBe('保留草稿')
      expect(screen.queryByRole('alert')).toBeNull()
      expect({ focus: document.activeElement?.getAttribute('aria-label'), draft: input.current?.value,
        references: screen.queryByRole('group', { name: zh.taskKnowledge })?.textContent ?? null }).toMatchSnapshot('Recovered composer')
    }
    if (outcome === 'failure') {
      expect(document.activeElement).toBe(retry)
      expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
    }
    expect(f.props.setKnowledgeSelection).not.toHaveBeenCalled()
  },
)

function fixture(initialSession = Promise.resolve({ authenticated: true, employeeId: 'employee-a' })) {
  const translations = new Map<string, string>(Object.entries(zh))
  const sessionId = SessionId('knowledge-task')
  let ids = ['policy']
  let open: (() => void) | undefined
  let notify: ((event: { type: string; payload?: unknown }) => void) | undefined
  vi.stubGlobal('dshDesktop', { extensions: {
    invoke: vi.fn(async () => ({ ok: true, result: await initialSession })),
    subscribe: (_namespace: string, listener: typeof notify) => { notify = listener; return () => { notify = undefined } },
  } })
  const readCapabilities = vi.fn<TaskModeActions['readCapabilities']>(async () => ({ basePresetId: 'standard', knowledgeBaseIds: ids }))
  const props: ComponentProps<typeof TaskKnowledgeInput> = {
    useContextMenu: contextMenuHook(),
    sessionId, useSessions: selector => selector({ ids: [sessionId], phase: 'ready', projectionsBySession: {}, byId: {
      [sessionId]: { id: sessionId, displayTitle: 'Session', blank: true, running: false, updatedAt: 0,
        retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'standard' } },
    } }), readCapabilities, readKnowledgeCatalog: vi.fn(async () => items([
      { id: 'policy', name: '业务规范' }, { id: 'manuals', name: '业务手册' },
    ])), setKnowledgeSelection: vi.fn(async () => {}), recoverCapabilities: vi.fn(async () => {}),
    retryCapabilities: vi.fn(async () => {}), openCatalog: vi.fn(), openEmployeeSignIn: vi.fn(), focusInput: vi.fn(),
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
  await waitFor(() => { expect(setKnowledgeSelection).toHaveBeenCalledExactlyOnceWith(['policy', 'manuals'], 'knowledge-task') })
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
  await waitFor(() => { expect(f.props.readCapabilities).toHaveBeenCalledTimes(2) })
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
    await waitFor(() => { expect(f.props.readCapabilities).toHaveBeenCalledTimes(3) })
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
