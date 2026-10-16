// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskExpertKitSeat, TaskExpertKitHeader } from '../src/client/TaskExpertKitSeat.tsx'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh } from '../src/locales.ts'
import type { TaskModeActions } from '../src/client/harness-actions.ts'
import { items } from '../src/client/catalog-shared.tsx'
import { ProductError } from '@deepseek-harness/product/errors'

afterEach(cleanup)

function unusedHook(): never {
  throw new Error('Expert Kit selection does not read this slot source')
}

function fixture() {
  const sessionId = SessionId('session')
  const translations = new Map<string, string>(Object.entries(zh))
  const mode = { id: 'standard', isDefault: true, selectable: true, defaultable: true, name: '标准模式' }
  const ptc = { ...mode, id: 'ptc', name: 'PTC 模式', isDefault: false }
  const readMode = vi.fn<TaskModeActions['readMode']>(async () => ({ mode, options: [mode, ptc], capabilities: {
    basePresetId: 'standard', expertKit: { id: 'design', name: '产品设计', version: '1', sha256: 'a'.repeat(64) },
    skills: [], connectorIds: ['erp'], requiredConnectorIds: ['erp'], knowledgeBaseIds: [], requiredKnowledgeBaseIds: [], knowledgeBaseRefs: [],
  } }))
  const setExpertKit = vi.fn<TaskModeActions['setExpertKit']>(async () => {})
  const readExpertKits = vi.fn<TaskModeActions['readExpertKits']>(async () => items([
    { id: 'design', name: '产品设计', summary: '设计工作的完整说明' }, { id: 'analysis', name: '数据分析' },
  ]))
  const openCatalog = vi.fn()
  const recoverCapabilities = vi.fn<TaskModeActions['recoverCapabilities']>(async () => {})
  const retryCapabilities = vi.fn<TaskModeActions['retryCapabilities']>(async () => {})
  const props: ComponentProps<typeof TaskExpertKitSeat> & ComponentProps<typeof TaskExpertKitHeader> = {
    sessionId, useSessions: selector => selector({
      ids: [sessionId], phase: 'ready', projectionsBySession: {}, byId: {
        [sessionId]: { id: sessionId, displayTitle: 'Session', blank: true, running: false, updatedAt: 0,
          retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'product-task-private-hash' } },
      },
    }), readMode,
    useSession: unusedHook, useProjection: unusedHook, useConversation: unusedHook, useInput: unusedHook,
    useChat: unusedHook, useTrajectory: unusedHook, useAccess: unusedHook,
    useRemoteAccess: unusedHook, useSessionAccess: unusedHook, useWorkspaceAccess: unusedHook,
    inputActions: { captureInsertion: unusedHook, insertText: unusedHook, setDraft: unusedHook, persistDraft: unusedHook,
      addAttachments: unusedHook, removeAttachment: unusedHook, pruneAttachments: unusedHook, submit: unusedHook },
    usePanelInfo: unusedHook, useSessionStatus: unusedHook,
    useSessionRetainInfo: unusedHook, useWorkspaces: unusedHook, useResource: unusedHook,
    readExpertKits, setExpertKit, openCatalog,
    recoverCapabilities, retryCapabilities,
    t: key => translations.get(key) ?? key,
  }
  return { props, readMode, readExpertKits, setExpertKit, recoverCapabilities, retryCapabilities, openCatalog }
}

it.each([TaskExpertKitSeat, TaskExpertKitHeader])('retries transient restoration without resetting the kit', async (Component) => {
  const f = fixture()
  const state = await f.readMode()
  f.readMode.mockResolvedValue({ ...state, capabilities: { ...state.capabilities,
    unavailable: { code: 'CONNECTOR_DISCOVERY_FAILED', message: 'offline', retryable: true, resources: [] } } })
  render(<Component {...f.props} />)
  fireEvent.click(await screen.findByRole('button', { name: zh.retry }))
  await waitFor(() => { expect(f.retryCapabilities).toHaveBeenCalledExactlyOnceWith('session') })
  expect(f.recoverCapabilities).not.toHaveBeenCalled()
  expect(f.setExpertKit).not.toHaveBeenCalled()
})

it('renders only the independent kit selector and leaves execution mode to the native plugin', async () => {
  const f = fixture()
  render(<TaskExpertKitSeat {...f.props} />)
  await screen.findByText('产品设计')
  expect(screen.queryByText(/product-task-|已选能力/)).toBeNull()
  expect(f.readExpertKits).not.toHaveBeenCalled()
  expect(screen.queryByText('标准模式')).toBeNull()
  expect(screen.getByRole('button', { name: zh.selectExpertKit }).textContent).toBe('产品设计')
  expect(screen.queryByRole('button', { name: zh.taskKnowledge })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.selectExpertKit }))
  await screen.findByRole('menuitem', { name: '数据分析' })
  expect(screen.queryByText('设计工作的完整说明')).toBeNull()
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
    '不使用套件', '产品设计', '数据分析', '查看专家套件',
  ])
  expect(screen.getByRole('menu').querySelectorAll('svg')).toHaveLength(1)
  expect(f.setExpertKit).not.toHaveBeenCalled()
})

it('keeps the kit selector available when the task has no kit', async () => {
  const f = fixture()
  f.readMode.mockImplementation(async () => {
    const current = await fixture().readMode()
    const { expertKit: _kit, ...capabilities } = current.capabilities
    return { ...current, capabilities }
  })
  render(<TaskExpertKitSeat {...f.props} />)
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.selectExpertKit }).hasAttribute('disabled')).toBe(false) })
  expect(screen.getByRole('button', { name: zh.selectExpertKit }).textContent).toBe(zh.expertKits)
  fireEvent.click(screen.getByRole('button', { name: zh.selectExpertKit }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.noExpertKit }))
  expect(f.setExpertKit).not.toHaveBeenCalled()
})

it('replaces or clears a kit through task preparation', async () => {
  const f = fixture()
  render(<TaskExpertKitSeat {...f.props} />)
  await screen.findByText('产品设计')
  fireEvent.click(screen.getByRole('button', { name: zh.selectExpertKit }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '数据分析' }))
  await waitFor(() => { expect(f.setExpertKit).toHaveBeenCalledWith('analysis', 'session') })
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.selectExpertKit }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: zh.selectExpertKit }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.noExpertKit }))
  await waitFor(() => { expect(f.setExpertKit).toHaveBeenCalledWith(null, 'session') })
})

it('keeps the current kit on failed preparation before the conversation starts', async () => {
  const f = fixture()
  f.setExpertKit.mockRejectedValueOnce(new Error('dependency unavailable'))
  render(<TaskExpertKitSeat {...f.props} />)
  await screen.findByText('产品设计')
  expect(screen.queryByRole('button', { name: zh.taskKnowledge })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.selectExpertKit }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '数据分析' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: zh.selectExpertKit }).textContent).toBe('产品设计')
  expect(screen.queryByText('标准模式')).toBeNull()
})

it('opens the kit directory without changing the task', async () => {
  const f = fixture()
  render(<TaskExpertKitSeat {...f.props} />)
  await screen.findByText('产品设计')
  fireEvent.click(screen.getByRole('button', { name: zh.selectExpertKit }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.expertKitDirectory }))
  expect(f.openCatalog).toHaveBeenCalledExactlyOnceWith('expertKits')
  expect(f.setExpertKit).not.toHaveBeenCalled()
})

it('retries kit catalog failures without changing the task', async () => {
  const f = fixture()
  f.readExpertKits.mockRejectedValueOnce(new Error('catalog unavailable'))
  render(<TaskExpertKitSeat {...f.props} />)
  await screen.findByText('产品设计')
  fireEvent.click(screen.getByRole('button', { name: zh.selectExpertKit }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.retry }))
  await screen.findByRole('menuitem', { name: '数据分析' })
  expect(f.readExpertKits).toHaveBeenCalledTimes(2)
  expect(f.setExpertKit).not.toHaveBeenCalled()
})

it('avoids preparing a new task when selecting its existing kit', async () => {
  const f = fixture()
  render(<TaskExpertKitSeat {...f.props} />)
  await screen.findByText('产品设计')
  fireEvent.click(screen.getByRole('button', { name: zh.selectExpertKit }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '产品设计' }))
  expect(f.setExpertKit).not.toHaveBeenCalled()
})

it('shows the pinned task kit as a read-only header without reading its device installation', async () => {
  const f = fixture()
  f.readExpertKits.mockResolvedValue(items([{ id: 'analysis', name: '数据分析' }]))
  render(<TaskExpertKitHeader {...f.props} />)
  const label = await screen.findByText('产品设计')
  expect(label.closest('button')).toBeNull()
  expect(label.parentElement?.getAttribute('title')).toBe('专家套件: 产品设计')
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('menu')).toBeNull()
  expect(f.readExpertKits).not.toHaveBeenCalled()
  expect(f.setExpertKit).not.toHaveBeenCalled()
  expect(f.openCatalog).not.toHaveBeenCalled()
})

it('omits the started-task header when no expert kit was selected', async () => {
  const f = fixture()
  const current = await f.readMode()
  const { expertKit: _kit, ...capabilities } = current.capabilities
  f.readMode.mockResolvedValue({ ...current, capabilities })
  const view = render(<TaskExpertKitHeader {...f.props} />)
  await waitFor(() => { expect(f.readMode).toHaveBeenCalledWith('session') })
  expect(view.container.innerHTML).toBe('')
  expect(f.readExpertKits).not.toHaveBeenCalled()
})

it('does not show a previous task kit while reading a different Session', async () => {
  const f = fixture()
  const current = await f.readMode()
  let resolve!: (value: typeof current) => void
  f.readMode.mockResolvedValueOnce(current).mockImplementationOnce(() => new Promise((complete) => { resolve = complete }))
  const view = render(<TaskExpertKitHeader {...f.props} />)
  await screen.findByText('产品设计')
  view.rerender(<TaskExpertKitHeader {...f.props} sessionId={SessionId('other')} />)
  expect(screen.queryByText('产品设计')).toBeNull()
  await waitFor(() => { expect(f.readMode).toHaveBeenLastCalledWith('other') })
  resolve({ ...current, capabilities: { ...current.capabilities,
    expertKit: { id: 'analysis', name: '数据分析', version: '1', sha256: 'b'.repeat(64) } } })
  await screen.findByText('数据分析')
  expect(screen.queryByRole('button')).toBeNull()
})

it('keeps snapshot recovery visible in a started task even when its kit cannot be read', async () => {
  const f = fixture()
  const current = await f.readMode()
  const { expertKit: _kit, ...capabilities } = current.capabilities
  f.readMode.mockResolvedValue({ ...current, capabilities: { ...capabilities,
    unavailable: { code: 'TASK_SNAPSHOT_INVALID', message: 'Private snapshot path', retryable: false, resources: [] } } })
  f.recoverCapabilities.mockRejectedValueOnce(new Error('Private recovery diagnostic'))
  render(<TaskExpertKitHeader {...f.props} />)
  await screen.findByText(`${zh.taskSnapshotUnavailable} (TASK_SNAPSHOT_INVALID)`)
  expect(screen.queryByText('Private snapshot path')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.selectExpertKit })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.taskRecovery }))
  await waitFor(() => { expect(f.recoverCapabilities).toHaveBeenCalledWith('session') })
  await screen.findByText(zh.taskSelectionFailed)
  expect(screen.getByRole('button', { name: zh.taskRecovery }).hasAttribute('disabled')).toBe(false)
  expect(f.setExpertKit).not.toHaveBeenCalled()
})

it.each([
  ['KIT_NOT_INSTALLED', zh.expertKitNotInstalled],
  ['KIT_INSTALLED_VERSION_CHANGED', zh.expertKitInstalledVersionChanged],
])('localizes %s when installation changes during a selection', async (code, message) => {
  const f = fixture()
  f.setExpertKit.mockRejectedValueOnce(new ProductError(code, 'Private runtime diagnostic', false,
    [{ kind: 'expert-kit', id: 'analysis' }]))
  render(<TaskExpertKitSeat {...f.props} />)
  await screen.findByText('产品设计')
  fireEvent.click(screen.getByRole('button', { name: zh.selectExpertKit }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '数据分析' }))
  expect((await screen.findByRole('alert')).textContent).toBe(`${message} (${code})`)
  expect(screen.getByRole('button', { name: zh.selectExpertKit }).textContent).toBe('产品设计')
})

it('ignores a previous task preparation failure after switching Sessions', async () => {
  const f = fixture()
  let reject!: (error: Error) => void
  f.setExpertKit.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise }))
  const view = render(<TaskExpertKitSeat {...f.props} />)
  await screen.findByText('产品设计')
  fireEvent.click(screen.getByRole('button', { name: zh.selectExpertKit }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '数据分析' }))
  expect(f.setExpertKit).toHaveBeenCalledWith('analysis', 'session')
  view.rerender(<TaskExpertKitSeat {...f.props} sessionId={SessionId('other')} />)
  await waitFor(() => { expect(f.readMode).toHaveBeenLastCalledWith('other') })
  reject(new Error('previous task failed'))
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.selectExpertKit }).hasAttribute('disabled')).toBe(false) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('offers explicit recovery for an unavailable snapshot without displaying a fallback mode', async () => {
  const f = fixture()
  const current = await f.readMode()
  f.readMode.mockResolvedValue({ ...current, capabilities: { ...current.capabilities,
    unavailable: { code: 'TASK_SNAPSHOT_INVALID', message: 'Snapshot damaged', retryable: false, resources: [] } } })
  render(<TaskExpertKitSeat {...f.props} />)
  await screen.findByText(`${zh.taskSnapshotUnavailable} (TASK_SNAPSHOT_INVALID)`)
  expect(screen.queryByText('标准模式')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.taskRecovery }))
  await waitFor(() => { expect(f.recoverCapabilities).toHaveBeenCalledWith('session') })
})
