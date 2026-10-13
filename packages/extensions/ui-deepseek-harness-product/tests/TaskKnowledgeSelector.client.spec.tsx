// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { SessionId } from '@deepseek-ai/dsh-session'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProductError } from '@deepseek-harness/product/errors'
import { TaskKnowledgeSelector } from '../src/client/TaskKnowledgeSelector.tsx'
import { items } from '../src/client/catalog-shared.tsx'
import { zh } from '../src/locales.ts'

afterEach(cleanup)

function fixture() {
  let open: (() => void) | undefined
  const props = {
    capabilities: { skills: [], connectorIds: [], requiredConnectorIds: [], knowledgeBaseIds: ['policy'],
      requiredKnowledgeBaseIds: ['policy'] as string[], knowledgeBaseRefs: ['company:policy'] },
    readKnowledgeCatalog: vi.fn(async () => items([{ id: 'policy', name: '业务规范', referenceKey: 'company:policy' },
      { id: 'manuals', name: '业务手册' }, { id: 'research', name: '调研资料' }])),
    recoverCapabilities: vi.fn(async () => {}), retryCapabilities: vi.fn(async () => {}),
    setKnowledgeSelection: vi.fn(async (_ids: readonly string[]) => {}),
    openCatalog: vi.fn(), onApplied: vi.fn(), onPendingChange: vi.fn(),
    subscribeOpen: (listener: () => void) => {
      open = listener
      return () => { open = undefined }
    },
    t: (key: keyof typeof zh, params?: Record<string, unknown>) => zh[key].replace('{count}',
      typeof params?.count === 'number' ? String(params.count) : '').replace('{name}', () => typeof params?.name === 'string' ? params.name : ''),
  } satisfies ComponentProps<typeof TaskKnowledgeSelector>
  return { ...props, open: () => { act(() => { open?.() }) } }
}

it('retries a temporary task failure without removing its knowledge or kit', async () => {
  const f = fixture()
  render(<TaskKnowledgeSelector {...f} capabilities={{ ...f.capabilities,
    unavailable: { code: 'CONNECTOR_DISCOVERY_FAILED', message: 'offline', retryable: true, resources: [] } }} />)
  f.open()
  fireEvent.click(await screen.findByRole('button', { name: zh.retry }))
  await waitFor(() => { expect(f.retryCapabilities).toHaveBeenCalledExactlyOnceWith(undefined) })
  expect(f.recoverCapabilities).not.toHaveBeenCalled()
  expect(f.setKnowledgeSelection).not.toHaveBeenCalled()
})

it('retains an Add-menu request while task capabilities load', async () => {
  const f = fixture()
  const view = render(<TaskKnowledgeSelector {...f} sessionId={SessionId('loading-task')} capabilities={undefined} />)
  f.open()
  expect(screen.queryByRole('dialog')).toBeNull()
  view.rerender(<TaskKnowledgeSelector {...f} sessionId={SessionId('loading-task')} />)
  expect(await screen.findByRole('dialog', {}, { timeout: 500 })).not.toBeNull()
  expect((await screen.findByRole<HTMLInputElement>('checkbox', { name: '业务规范' })).checked).toBe(true)
  expect(f.setKnowledgeSelection).not.toHaveBeenCalled()
})

it('discards a pending Add-menu request when the user switches tasks', async () => {
  const f = fixture()
  const view = render(<TaskKnowledgeSelector {...f} sessionId={SessionId('source-task')} capabilities={undefined} />)
  f.open()
  view.rerender(<TaskKnowledgeSelector {...f} sessionId={SessionId('target-task')} />)
  await screen.findByText('业务规范')
  expect(screen.queryByRole('dialog')).toBeNull()
  f.open()
  expect(await screen.findByRole('dialog')).not.toBeNull()
})

it('locks kit requirements and applies multiple optional bases once', async () => {
  const f = fixture()
  render(<TaskKnowledgeSelector {...f} />)
  await screen.findByText('业务规范')
  f.open()
  const policy = await screen.findByRole('checkbox', { name: '业务规范' })
  expect(policy.hasAttribute('disabled')).toBe(true)
  expect(screen.getByText(zh.kitRequiredKnowledge)).not.toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: '业务手册' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '调研资料' }))
  expect(f.setKnowledgeSelection).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.applyKnowledge }))
  await waitFor(() => { expect(f.setKnowledgeSelection).toHaveBeenCalledExactlyOnceWith(['policy', 'manuals', 'research'], undefined) })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
})

it('discards staged changes on cancel and retains them across search filtering', async () => {
  const f = fixture()
  render(<TaskKnowledgeSelector {...f} />)
  f.open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '业务手册' }))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '调研' } })
  expect(screen.queryByRole('checkbox', { name: '业务手册' })).toBeNull()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '业务手册' }).checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  expect(f.setKnowledgeSelection).not.toHaveBeenCalled()
  f.open()
  expect((await screen.findByRole<HTMLInputElement>('checkbox', { name: '业务手册' })).checked).toBe(false)
})

it('keeps staged selection and the dialog when preparation fails', async () => {
  const f = fixture()
  f.setKnowledgeSelection.mockRejectedValueOnce(new Error('permission revoked'))
  render(<TaskKnowledgeSelector {...f} />)
  f.open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '业务手册' }))
  fireEvent.click(screen.getByRole('button', { name: zh.applyKnowledge }))
  await screen.findByRole('alert')
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '业务手册' }).checked).toBe(true)
  expect(screen.getByRole('button', { name: '业务规范' }).textContent).toBe('业务规范')
  expect(f.onApplied).not.toHaveBeenCalled()
})

it('allows clearing optional knowledge to an explicit empty scope', async () => {
  const f = fixture()
  f.capabilities.knowledgeBaseRefs = []
  f.capabilities.requiredKnowledgeBaseIds = []
  render(<TaskKnowledgeSelector {...f} />)
  f.open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '业务规范' }))
  fireEvent.click(screen.getByRole('button', { name: zh.applyKnowledge }))
  await waitFor(() => { expect(f.setKnowledgeSelection).toHaveBeenCalledExactlyOnceWith([], undefined) })
})

it('retries catalog failure without applying an incomplete scope', async () => {
  const f = fixture()
  f.capabilities.knowledgeBaseIds = []
  f.readKnowledgeCatalog.mockRejectedValueOnce(new Error('catalog unavailable'))
  render(<TaskKnowledgeSelector {...f} />)
  expect(f.readKnowledgeCatalog).not.toHaveBeenCalled()
  f.open()
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: zh.applyKnowledge }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await screen.findByRole('checkbox', { name: '业务手册' })
  expect(f.setKnowledgeSelection).not.toHaveBeenCalled()
})

it.each([
  ['ORGANIZATION_EMPLOYEE_UNMAPPED', 'organizationEmployeeUnmapped', false],
  ['ORGANIZATION_EMPLOYEE_INACTIVE', 'organizationEmployeeInactive', false],
  ['ORGANIZATION_SOURCE_INVALID', 'organizationSourceInvalid', false],
  ['ORGANIZATION_SYNC_EXPIRED', 'organizationSyncExpired', true],
  ['ORGANIZATION_SERVICE_UNAVAILABLE', 'organizationServiceUnavailable', true],
] as const)('explains %s without discarding the current scope or offering recovery', async (code, key, retryable) => {
  const f = fixture()
  f.readKnowledgeCatalog.mockRejectedValue(new ProductError(code, 'private upstream diagnostic', retryable))
  render(<TaskKnowledgeSelector {...f} />)
  f.open()
  const dialog = within(await screen.findByRole('dialog'))
  expect((await dialog.findByRole('alert')).textContent).toBe(`${zh[key]} (${code})`)
  expect(dialog.getByRole('button', { name: zh.applyKnowledge }).hasAttribute('disabled')).toBe(true)
  expect(dialog.queryByRole('button', { name: zh.knowledgeRecovery })).toBeNull()
  expect(dialog.queryByText('private upstream diagnostic')).toBeNull()
  expect(f.setKnowledgeSelection).not.toHaveBeenCalled()
  expect(f.recoverCapabilities).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: zh.retry }))
  await dialog.findByRole('alert')
  fireEvent.click(dialog.getByRole('button', { name: zh.cancel }))
  expect(f.capabilities.knowledgeBaseIds).toEqual(['policy'])
  expect(f.onApplied).not.toHaveBeenCalled()
})

it('retains unavailable selected identities and opens the directory without applying changes', async () => {
  const f = fixture()
  f.capabilities.knowledgeBaseIds = ['removed']
  render(<TaskKnowledgeSelector {...f} />)
  f.open()
  const dialog = within(await screen.findByRole('dialog'))
  await dialog.findByRole('checkbox', { name: 'removed' })
  expect(dialog.getByText(zh.statusUnavailable)).not.toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeDirectory }))
  expect(f.openCatalog).toHaveBeenCalledExactlyOnceWith('knowledge')
  expect(f.setKnowledgeSelection).not.toHaveBeenCalled()
})

it('retains staged choices when catalog refresh returns the same task selection', async () => {
  const f = fixture()
  const view = render(<TaskKnowledgeSelector {...f} />)
  f.open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '业务手册' }))
  view.rerender(<TaskKnowledgeSelector {...f} capabilities={structuredClone(f.capabilities)} />)
  expect(screen.getByRole('dialog')).not.toBeNull()
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '业务手册' }).checked).toBe(true)
})

it('groups personal, every direct department ID, and company knowledge without merging same-named departments', async () => {
  const f = fixture()
  f.readKnowledgeCatalog.mockResolvedValue(items([
    { id: 'private', name: '个人笔记', scope: 'PERSONAL' },
    { id: 'dept-one', name: '部门一', scope: 'DEPARTMENT', ownerDepartmentId: '21', ownerName: '销售部' },
    { id: 'dept-two', name: '部门二', scope: 'DEPARTMENT', ownerDepartmentId: '22', ownerName: '销售部' },
    { id: 'policy', name: '公司规范', scope: 'COMPANY' },
  ]))
  render(<TaskKnowledgeSelector {...f} />)
  f.open()
  const dialog = within(await screen.findByRole('dialog'))
  await dialog.findByRole('heading', { name: '部门 · 销售部 (21)' })
  expect(dialog.getByRole('heading', { name: '部门 · 销售部 (22)' })).not.toBeNull()
  expect(dialog.getByRole('heading', { name: zh.scopePersonal })).not.toBeNull()
  expect(dialog.getByRole('heading', { name: zh.scopeCompany })).not.toBeNull()
})

it('renders referenced bases inside the input, removing only optional references', async () => {
  const f = fixture()
  f.capabilities.knowledgeBaseIds = ['policy', 'manuals']
  render(<TaskKnowledgeSelector {...f} />)
  const references = within(screen.getByRole('group', { name: zh.taskKnowledge }))
  await references.findByRole('button', { name: '业务手册' })
  expect(screen.queryByRole('button', { name: zh.taskKnowledge })).toBeNull()
  expect(references.queryByRole('button', { name: '移除知识库「业务规范」' })).toBeNull()
  expect(references.getByLabelText(zh.kitRequiredKnowledge)).not.toBeNull()
  fireEvent.click(references.getByRole('button', { name: '移除知识库「业务手册」' }))
  await waitFor(() => { expect(f.setKnowledgeSelection).toHaveBeenCalledExactlyOnceWith(['policy'], undefined) })
})

it('keeps referenced tags when removal fails and reports a retryable action failure', async () => {
  const f = fixture()
  f.capabilities.requiredKnowledgeBaseIds = []
  f.setKnowledgeSelection.mockRejectedValueOnce(new Error('network'))
  render(<TaskKnowledgeSelector {...f} />)
  fireEvent.click(await screen.findByRole('button', { name: '移除知识库「业务规范」' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: '业务规范' })).not.toBeNull()
  expect(f.onApplied).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '移除知识库「业务规范」' }))
  await waitFor(() => { expect(f.onApplied).toHaveBeenCalledOnce() })
})

it('renders no knowledge control for an empty scope, while the Add action can still open selection', async () => {
  const f = fixture()
  f.capabilities.knowledgeBaseIds = []
  f.capabilities.requiredKnowledgeBaseIds = []
  const view = render(<TaskKnowledgeSelector {...f} />)
  expect(view.container.textContent).toBe('')
  f.open()
  await screen.findByRole('checkbox', { name: '业务手册' })
  view.unmount()
  f.open()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('registers the Add action only after task capabilities load and removes it during a task reload', async () => {
  const f = fixture()
  const view = render(<TaskKnowledgeSelector {...f} capabilities={undefined} />)
  f.open()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.readKnowledgeCatalog).not.toHaveBeenCalled()
  view.rerender(<TaskKnowledgeSelector {...f} />)
  f.open()
  const dialog = within(await screen.findByRole('dialog'))
  await dialog.findByRole('checkbox', { name: '业务手册' })
  view.rerender(<TaskKnowledgeSelector {...f} capabilities={undefined} />)
  f.open()
  expect(screen.queryByRole('dialog')).toBeNull()
})
