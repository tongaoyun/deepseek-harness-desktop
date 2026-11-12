// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { SessionId } from '@deepseek-ai/dsh-session'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { ProductError } from '@deepseek-harness/product/errors'
import { TaskKnowledgeSelector } from '../src/client/TaskKnowledgeSelector.tsx'
import { items } from '../src/client/catalog-shared.tsx'
import { en, zh } from '../src/locales.ts'

afterEach(cleanup)

function fixture() {
  let open: (() => void) | undefined
  const props = {
    capabilities: { knowledgeBaseIds: ['policy'] },
    readKnowledgeCatalog: vi.fn(async () => items([{ id: 'policy', name: '业务规范', referenceKey: 'company:policy' },
      { id: 'manuals', name: '业务手册' }, { id: 'research', name: '调研资料' }])),
    recoverCapabilities: vi.fn(async () => {}), retryCapabilities: vi.fn(async () => {}),
    setKnowledgeSelection: vi.fn(async (_ids: readonly string[]) => {}),
    openCatalog: vi.fn(), onApplied: vi.fn(),
    subscribeOpen: (listener: () => void) => {
      open = listener
      return () => { open = undefined }
    },
    t: (key: keyof typeof zh, params?: Record<string, unknown>) => zh[key].replace('{count}',
      typeof params?.count === 'number' ? String(params.count) : '').replace('{name}', () => typeof params?.name === 'string' ? params.name : ''),
  } satisfies ComponentProps<typeof TaskKnowledgeSelector>
  return { ...props, open: () => { act(() => { open?.() }) } }
}

it('waits for the catalog before retrying a temporary task failure without removing its knowledge', async () => {
  const f = fixture()
  const catalog = Promise.withResolvers<Awaited<ReturnType<typeof f.readKnowledgeCatalog>>>()
  const value = items([{ id: 'policy', name: '业务规范', referenceKey: 'company:policy' }])
  f.readKnowledgeCatalog.mockReturnValue(catalog.promise)
  render(<TaskKnowledgeSelector {...f} capabilities={{ ...f.capabilities,
    unavailable: { code: 'CONNECTOR_DISCOVERY_FAILED', message: 'offline', retryable: true, resources: [] } }} />)
  try {
    f.open()
    const retry = await screen.findByRole('button', { name: zh.retry })
    expect(retry.hasAttribute('disabled')).toBe(false)
    expect(retry.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(retry)
    expect(f.retryCapabilities).not.toHaveBeenCalled()
    await act(async () => { catalog.resolve(value) })
    await waitFor(() => { expect(retry.hasAttribute('disabled')).toBe(false) })
    fireEvent.click(retry)
    await waitFor(() => { expect(f.retryCapabilities).toHaveBeenCalledExactlyOnceWith(undefined) })
    expect(f.recoverCapabilities).not.toHaveBeenCalled()
    expect(f.setKnowledgeSelection).not.toHaveBeenCalled()
  } finally { await act(async () => { catalog.resolve(value) }) }
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

it('applies multiple selected knowledge bases once', async () => {
  const f = fixture()
  render(<TaskKnowledgeSelector {...f} />)
  await screen.findByText('业务规范')
  f.open()
  const policy = await screen.findByRole('checkbox', { name: '业务规范' })
  expect(policy.hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('checkbox', { name: '业务手册' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '调研资料' }))
  expect(f.setKnowledgeSelection).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.applyKnowledge }))
  await waitFor(() => { expect(f.setKnowledgeSelection).toHaveBeenCalledExactlyOnceWith(['policy', 'manuals', 'research'], undefined) })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
})

it.each(['cancel', 'Escape'] as const)('discards staged changes on %s and retains them across search filtering', async (action) => {
  const f = fixture()
  render(<TaskKnowledgeSelector {...f} />)
  f.open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '业务手册' }))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '调研' } })
  expect(screen.queryByRole('checkbox', { name: '业务手册' })).toBeNull()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '业务手册' }).checked).toBe(true)
  if (action === 'Escape') fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
  else fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.setKnowledgeSelection).not.toHaveBeenCalled()
  expect(f.onApplied).not.toHaveBeenCalled()
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

it('locks knowledge preparation before rapid clicks and keeps its error and draft while retrying', async () => {
  const f = fixture()
  const response = Promise.withResolvers<undefined>()
  f.setKnowledgeSelection.mockRejectedValueOnce(new Error('network')).mockReturnValue(response.promise)
  const view = render(<TaskKnowledgeSelector {...f} />)
  onTestFinished(() => { view.unmount(); response.resolve(undefined) })
  f.open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '业务手册' }))
  fireEvent.click(screen.getByRole('button', { name: zh.applyKnowledge }))
  const notice = await screen.findByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.applyKnowledge })
  const cancel = screen.getByRole('button', { name: zh.cancel })
  const directory = screen.getByRole('button', { name: zh.knowledgeDirectory })
  retry.focus()
  act(() => { retry.click(); retry.click(); cancel.click(); directory.click(); fireEvent.keyDown(retry, { key: 'Escape' }) })
  await waitFor(() => { expect(f.setKnowledgeSelection).toHaveBeenCalledTimes(2) })
  expect(screen.getByRole('dialog')).not.toBeNull()
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.getByRole('button', { name: zh.applyingKnowledge })).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(f.openCatalog).not.toHaveBeenCalled()
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '业务手册' }).checked).toBe(true)
  expect({ message: notice.textContent, action: retry.textContent, focused: document.activeElement?.textContent }).toMatchSnapshot('Pending selection retry')
  await act(async () => { response.resolve(undefined) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(f.onApplied).toHaveBeenCalledOnce()
})

it.each(['success', 'failure'] as const)('ignores an older %s after leaving and returning to the same task', async (outcome) => {
  const f = fixture()
  const first = Promise.withResolvers<undefined>()
  const second = Promise.withResolvers<undefined>()
  f.setKnowledgeSelection.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const source = SessionId('source')
  const view = render(<TaskKnowledgeSelector {...f} sessionId={source} />)
  onTestFinished(() => { view.unmount(); first.resolve(undefined); second.resolve(undefined) })
  f.open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '业务手册' }))
  fireEvent.click(screen.getByRole('button', { name: zh.applyKnowledge }))
  await waitFor(() => { expect(f.setKnowledgeSelection).toHaveBeenCalledTimes(1) })
  view.rerender(<TaskKnowledgeSelector {...f} sessionId={SessionId('other')} />)
  view.rerender(<TaskKnowledgeSelector {...f} sessionId={source} />)
  f.open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '调研资料' }))
  fireEvent.click(screen.getByRole('button', { name: zh.applyKnowledge }))
  await waitFor(() => { expect(f.setKnowledgeSelection).toHaveBeenCalledTimes(2) })
  await act(async () => { if (outcome === 'success') first.resolve(undefined); else first.reject(new Error('old failure')) })
  expect(screen.getByRole('dialog')).not.toBeNull()
  expect(screen.getByRole('button', { name: zh.applyingKnowledge })).toHaveProperty('disabled', false)
  expect(screen.getByRole('button', { name: zh.applyingKnowledge }).getAttribute('aria-disabled')).toBe('true')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(f.onApplied).not.toHaveBeenCalled()
  await act(async () => { second.resolve(undefined) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.onApplied).toHaveBeenCalledOnce()
})

it('allows clearing optional knowledge to an explicit empty scope', async () => {
  const f = fixture()
  render(<TaskKnowledgeSelector {...f} />)
  f.open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '业务规范' }))
  fireEvent.click(screen.getByRole('button', { name: zh.applyKnowledge }))
  await waitFor(() => { expect(f.setKnowledgeSelection).toHaveBeenCalledExactlyOnceWith([], undefined) })
})

it.each(['success', 'failure', 'cancel'] as const)('keeps the catalog retry and error stable until its %s without applying an incomplete scope', async (outcome) => {
  const f = fixture()
  f.capabilities.knowledgeBaseIds = []
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.readKnowledgeCatalog>>>()
  const value = items([{ id: 'manuals', name: '业务手册' }])
  const readKnowledgeCatalog = vi.fn<ComponentProps<typeof TaskKnowledgeSelector>['readKnowledgeCatalog']>()
    .mockRejectedValueOnce(new Error('catalog unavailable')).mockReturnValue(pending.promise)
  const view = render(<TaskKnowledgeSelector {...f} readKnowledgeCatalog={readKnowledgeCatalog} />)
  onTestFinished(() => { view.unmount(); pending.resolve(value) })
  expect(readKnowledgeCatalog).not.toHaveBeenCalled()
  f.open()
  const notice = await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: zh.applyKnowledge }).hasAttribute('disabled')).toBe(true)
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.retry })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '业务' } })
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  fireEvent.click(retry)
  expect(readKnowledgeCatalog).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('button', { name: zh.applyKnowledge })).toHaveProperty('disabled', true)
  if (outcome === 'cancel') {
    const signal = readKnowledgeCatalog.mock.calls.at(-1)?.[0]
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => { pending.reject(new Error('Abandoned read')) })
    expect(screen.queryByRole('dialog')).toBeNull()
  } else {
    expect({ message: notice.textContent, retry: retry.textContent, canRetry: retry.getAttribute('aria-disabled') !== 'true',
      loadingIndicator: screen.queryByRole('status', { name: zh.loading }) !== null }).toMatchSnapshot('Pending catalog retry')
    await act(async () => { if (outcome === 'success') pending.resolve(value); else pending.reject(new Error('Still unavailable')) })
    if (outcome === 'success') {
      await screen.findByRole('checkbox', { name: '业务手册' })
      expect(screen.queryByRole('alert')).toBeNull()
    } else {
      expect(screen.getByRole('alert')).toBe(notice)
      expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
      expect(retry.disabled).toBe(false)
      expect(screen.queryByRole('checkbox')).toBeNull()
    }
    expect(screen.getByRole('searchbox')).toHaveProperty('value', '业务')
  }
  expect(f.setKnowledgeSelection).not.toHaveBeenCalled()
})

it.each([false, true])('recovers a removed catalog retry without taking focus elsewhere (%s)', async (elsewhere) => {
  const f = fixture()
  f.capabilities.knowledgeBaseIds = []
  const response = Promise.withResolvers<Awaited<ReturnType<typeof f.readKnowledgeCatalog>>>()
  f.readKnowledgeCatalog.mockRejectedValueOnce(new Error('Unavailable')).mockReturnValue(response.promise)
  const view = render(<TaskKnowledgeSelector {...f} />)
  onTestFinished(() => { view.unmount(); response.resolve([]) })
  f.open()
  const retry = await screen.findByRole('button', { name: zh.retry })
  retry.focus(); fireEvent.click(retry)
  const other = screen.getByRole('button', { name: zh.cancel })
  if (elsewhere) other.focus()
  await act(async () => { response.resolve(items([{ id: 'manuals', name: '业务手册' }])) })
  await screen.findByRole('checkbox', { name: '业务手册' })
  expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
  const target = elsewhere ? other : screen.getByRole('searchbox')
  expect(document.activeElement).toBe(target)
  expect({ focused: target.getAttribute('placeholder') ?? target.textContent,
    retryVisible: screen.queryByRole('button', { name: zh.retry }) !== null }).toMatchSnapshot('Recovered catalog retry focus')
})

it.each([false, true])('recovers a removed catalog option without taking focus elsewhere (%s)', async (elsewhere) => {
  const f = fixture()
  const response = Promise.withResolvers<Awaited<ReturnType<typeof f.readKnowledgeCatalog>>>()
  const view = render(<TaskKnowledgeSelector {...f} />)
  onTestFinished(() => { view.unmount(); response.resolve([]) })
  await screen.findByRole('button', { name: '业务规范' })
  f.open()
  const removed = await screen.findByRole('checkbox', { name: '调研资料' })
  f.readKnowledgeCatalog.mockReturnValueOnce(response.promise)
  view.rerender(<TaskKnowledgeSelector {...f} refreshRevision={1} />)
  removed.focus()
  const other = screen.getByRole('button', { name: zh.cancel })
  if (elsewhere) other.focus()
  await act(async () => { response.resolve(items([{ id: 'policy', name: '业务规范' }])) })
  expect(screen.queryByRole('checkbox', { name: '调研资料' })).toBeNull()
  const target = elsewhere ? other : screen.getByRole('searchbox')
  expect(document.activeElement).toBe(target)
  expect({ focused: target.getAttribute('placeholder') ?? target.textContent,
    remaining: screen.getAllByRole('checkbox').map(node => node.closest('label')?.textContent) }).toMatchSnapshot('Refreshed catalog option focus')
})

it.each(['before', 'after'] as const)('uses the current language when it changes %s a catalog failure without restarting the read', async (timing) => {
  const f = fixture()
  f.capabilities.knowledgeBaseIds = []
  const request = Promise.withResolvers<Awaited<ReturnType<typeof f.readKnowledgeCatalog>>>()
  f.readKnowledgeCatalog.mockReturnValue(request.promise)
  const view = render(<TaskKnowledgeSelector {...f} />)
  f.open()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '业务' } })
  const fail = async () => { await act(async () => { request.reject(new Error('private diagnostic')) }) }
  if (timing === 'after') {
    await fail()
    expect(screen.getByRole('alert').textContent).toBe(zh.loadFailed)
  }
  view.rerender(<TaskKnowledgeSelector {...f} t={key => en[key]} />)
  if (timing === 'before') await fail()
  expect(screen.getByRole('alert').textContent).toBe(en.loadFailed)
  expect(screen.getByRole('searchbox')).toHaveProperty('value', '业务')
  expect(f.readKnowledgeCatalog).toHaveBeenCalledOnce()
  expect(f.setKnowledgeSelection).not.toHaveBeenCalled()
})

it.each(['before', 'after'] as const)('uses the current language when it changes %s selection preparation fails and retains the draft', async (timing) => {
  const f = fixture()
  const request = Promise.withResolvers<Awaited<ReturnType<typeof f.setKnowledgeSelection>>>()
  f.setKnowledgeSelection.mockReturnValueOnce(request.promise)
  const view = render(<TaskKnowledgeSelector {...f} />)
  f.open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '业务手册' }))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '业务' } })
  const reads = f.readKnowledgeCatalog.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: zh.applyKnowledge }))
  const fail = async () => { await act(async () => {
    request.reject(new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'private diagnostic', false,
      [{ kind: 'KNOWLEDGE_BASE', id: 'manuals' }]))
  }) }
  if (timing === 'after') {
    await fail()
    expect(screen.getByRole('alert').textContent).toBe(`${zh.knowledgeAccessRevoked} (KNOWLEDGE_ACCESS_REVOKED) manuals`)
  }
  view.rerender(<TaskKnowledgeSelector {...f} t={key => en[key]} />)
  if (timing === 'before') await fail()
  expect(screen.getByRole('alert').textContent).toBe(`${en.knowledgeAccessRevoked} (KNOWLEDGE_ACCESS_REVOKED) manuals`)
  expect(screen.getByRole('searchbox')).toHaveProperty('value', '业务')
  expect(screen.getByRole('checkbox', { name: '业务手册' })).toHaveProperty('checked', true)
  expect(f.readKnowledgeCatalog).toHaveBeenCalledTimes(reads)
  expect(f.setKnowledgeSelection).toHaveBeenCalledExactlyOnceWith(['policy', 'manuals'], undefined)
  expect(f.onApplied).not.toHaveBeenCalled()
})

it.each(['before', 'after'] as const)('uses the current language when it changes %s a reference removal fails without losing the reference', async (timing) => {
  const f = fixture()
  const request = Promise.withResolvers<Awaited<ReturnType<typeof f.setKnowledgeSelection>>>()
  f.setKnowledgeSelection.mockReturnValueOnce(request.promise)
  const view = render(<TaskKnowledgeSelector {...f} />)
  fireEvent.click(await screen.findByRole('button', { name: '移除知识库「业务规范」' }))
  const fail = async () => { await act(async () => { request.reject(new Error('private diagnostic')) }) }
  if (timing === 'after') {
    await fail()
    expect(screen.getByRole('alert').textContent).toBe(zh.knowledgeSelectionFailed)
  }
  view.rerender(<TaskKnowledgeSelector {...f} t={key => en[key]} />)
  if (timing === 'before') await fail()
  expect(screen.getByRole('alert').textContent).toBe(en.knowledgeSelectionFailed)
  expect(screen.getByRole('button', { name: '业务规范' })).not.toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.readKnowledgeCatalog).toHaveBeenCalledOnce()
  expect(f.setKnowledgeSelection).toHaveBeenCalledExactlyOnceWith([], undefined)
  expect(f.onApplied).not.toHaveBeenCalled()
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

it.each(['confirmed', 'removed', 'failed'] as const)('retains selection rows and focus during a catalog refresh until %s', async (outcome) => {
  const f = fixture()
  const response = Promise.withResolvers<Awaited<ReturnType<typeof f.readKnowledgeCatalog>>>()
  const view = render(<TaskKnowledgeSelector {...f} refreshRevision={0} />)
  f.open()
  const manual = await screen.findByRole<HTMLInputElement>('checkbox', { name: '业务手册' })
  fireEvent.click(manual)
  const apply = screen.getByRole<HTMLButtonElement>('button', { name: zh.applyKnowledge })
  await waitFor(() => { expect(apply.disabled).toBe(false) })
  manual.focus()
  f.readKnowledgeCatalog.mockReturnValueOnce(response.promise)
  view.rerender(<TaskKnowledgeSelector {...f} refreshRevision={1} />)
  expect(screen.getByRole('checkbox', { name: '业务手册' })).toBe(manual)
  expect(manual.checked).toBe(true)
  expect(document.activeElement).toBe(manual)
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  expect(apply.disabled).toBe(false)
  expect(apply.getAttribute('aria-disabled')).toBe('true')
  expect(apply.classList.contains('product-control-pending')).toBe(true)
  fireEvent.click(apply)
  expect(f.setKnowledgeSelection).not.toHaveBeenCalled()
  await act(async () => {
    if (outcome === 'failed') response.reject(new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Revoked', false))
    else response.resolve(items(outcome === 'removed' ? [{ id: 'policy', name: '业务规范' }]
      : [{ id: 'policy', name: '业务规范' }, { id: 'manuals', name: '业务手册' }]))
  })
  if (outcome === 'failed') {
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByRole('alert')).not.toBeNull()
    expect(apply.disabled).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
    expect({ focused: document.activeElement?.getAttribute('placeholder'), failure: screen.getByRole('alert').textContent })
      .toMatchSnapshot('Rejected catalog focus')
  } else {
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: outcome === 'removed' ? 'manuals' : '业务手册' })).toBe(manual)
    expect(manual.checked).toBe(true)
    expect(document.activeElement).toBe(manual)
    expect(apply.disabled).toBe(false)
    if (outcome === 'removed') expect(screen.getByText(zh.statusUnavailable)).not.toBeNull()
  }
})

it.each((['unavailable', 'department'] as const).flatMap(change => (['zh', 'en'] as const)
  .flatMap(locale => [false, true].map(elsewhere => ({ change, locale, elsewhere })))))(
  'keeps a staged knowledge checkbox through $change regrouping ($locale, elsewhere=$elsewhere)', async ({ change, locale, elsewhere }) => {
    const f = fixture()
    const dictionary = locale === 'zh' ? zh : en
    const props = { ...f, t: (key: keyof typeof zh) => dictionary[key] }
    const initial = [{ id: 'policy', name: '业务规范', scope: 'COMPANY' },
      { id: 'manuals', name: '业务手册 manuals', scope: 'COMPANY' },
      { id: 'research', name: '调研资料', scope: 'DEPARTMENT', ownerDepartmentId: '21', ownerName: '产品部' }]
    f.readKnowledgeCatalog.mockResolvedValue(items(initial))
    const response = Promise.withResolvers<Awaited<ReturnType<typeof f.readKnowledgeCatalog>>>()
    const view = render(<><TaskKnowledgeSelector {...props} refreshRevision={0} /><input aria-label="Other draft" defaultValue="Unsubmitted" /></>)
    onTestFinished(() => { view.unmount(); response.resolve(items(initial)) })
    f.open()
    const manual = await screen.findByRole<HTMLInputElement>('checkbox', { name: '业务手册 manuals' })
    fireEvent.click(manual)
    const search = screen.getByRole<HTMLInputElement>('searchbox')
    fireEvent.change(search, { target: { value: 'manuals' } })
    search.setSelectionRange(1, 3)
    const other = screen.getByRole<HTMLInputElement>('textbox', { name: 'Other draft' })
    other.setSelectionRange(2, 5)
    manual.focus()
    if (elsewhere) other.focus()
    f.readKnowledgeCatalog.mockReturnValueOnce(response.promise)
    view.rerender(<><TaskKnowledgeSelector {...props} refreshRevision={1} /><input aria-label="Other draft" defaultValue="Unsubmitted" /></>)
    expect(screen.getByRole('checkbox', { name: '业务手册 manuals' })).toBe(manual)
    await act(async () => { response.resolve(items(change === 'unavailable' ? initial.filter(row => row.id !== 'manuals')
      : initial.map(row => row.id === 'manuals' ? { ...row, scope: 'DEPARTMENT', ownerDepartmentId: '22', ownerName: '产品部' } : row))) })
    expect(screen.getByRole('checkbox', { name: change === 'unavailable' ? 'manuals' : '业务手册 manuals' })).toBe(manual)
    expect(manual.checked).toBe(true)
    expect(document.activeElement).toBe(elsewhere ? other : manual)
    expect(screen.getByRole('searchbox')).toBe(search)
    expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['manuals', 1, 3])
    expect([other.value, other.selectionStart, other.selectionEnd]).toEqual(['Unsubmitted', 2, 5])
    expect(screen.getByRole('heading', { name: change === 'unavailable' ? dictionary.otherKnowledge : `${dictionary.scopeDepartment} · 产品部 (22)` })).not.toBeNull()
    if (change === 'unavailable') expect(screen.getByText(dictionary.statusUnavailable)).not.toBeNull()
    expect(f.setKnowledgeSelection).not.toHaveBeenCalled()
    if (!elsewhere) {
      fireEvent.click(manual)
      expect(document.activeElement).toBe(change === 'unavailable' ? search : manual)
      expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['manuals', 1, 3])
    }
  },
)

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

it('renders referenced bases inside the input, allowing each reference to be removed', async () => {
  const f = fixture()
  f.capabilities.knowledgeBaseIds = ['policy', 'manuals']
  render(<TaskKnowledgeSelector {...f} />)
  const references = within(screen.getByRole('group', { name: zh.taskKnowledge }))
  await references.findByRole('button', { name: '业务手册' })
  expect(screen.queryByRole('button', { name: zh.taskKnowledge })).toBeNull()
  expect(references.getByRole('button', { name: '移除知识库「业务规范」' })).not.toBeNull()
  fireEvent.click(references.getByRole('button', { name: '移除知识库「业务手册」' }))
  await waitFor(() => { expect(f.setKnowledgeSelection).toHaveBeenCalledExactlyOnceWith(['policy'], undefined) })
})

it('keeps referenced tags when removal fails and reports a retryable action failure', async () => {
  const f = fixture()
  f.setKnowledgeSelection.mockRejectedValueOnce(new Error('network'))
  render(<TaskKnowledgeSelector {...f} />)
  fireEvent.click(await screen.findByRole('button', { name: '移除知识库「业务规范」' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: '业务规范' })).not.toBeNull()
  expect(f.onApplied).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '移除知识库「业务规范」' }))
  await waitFor(() => { expect(f.onApplied).toHaveBeenCalledOnce() })
})

it.each(['zh', 'en'] as const)('keeps the removal button focused and the error stable during a locked retry in %s', async (language) => {
  const f = fixture()
  const first = Promise.withResolvers<undefined>(), retry = Promise.withResolvers<undefined>()
  f.setKnowledgeSelection.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)
  const text = language === 'zh' ? zh : en
  const t: typeof f.t = (key, params) => text[key].replace('{name}', () => typeof params?.name === 'string' ? params.name : '')
  const view = render(<TaskKnowledgeSelector {...f} t={t} />)
  onTestFinished(() => { view.unmount(); first.resolve(undefined); retry.resolve(undefined) })
  const name = await screen.findByRole('button', { name: '业务规范' })
  const remove = screen.getByRole<HTMLButtonElement>('button', { name: t('removeKnowledgeReference', { name: '业务规范' }) })
  const group = screen.getByRole('group', { name: text.taskKnowledge })
  remove.focus()
  act(() => { remove.click(); remove.click(); name.click() })
  await waitFor(() => { expect(f.setKnowledgeSelection).toHaveBeenCalledOnce() })
  expect(remove.disabled).toBe(false)
  expect(remove.getAttribute('aria-disabled')).toBe('true')
  expect(group.getAttribute('aria-busy')).toBe('true')
  expect(document.activeElement).toBe(remove)
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => { first.reject(new Error('Preparation failed')) })
  const notice = screen.getByRole('alert')
  expect(document.activeElement).toBe(remove)
  act(() => { remove.click(); remove.click(); name.click() })
  await waitFor(() => { expect(f.setKnowledgeSelection).toHaveBeenCalledTimes(2) })
  expect(screen.getByRole('alert')).toBe(notice)
  expect(document.activeElement).toBe(remove)
  expect({ message: notice.textContent, action: remove.getAttribute('aria-label'), busy: group.getAttribute('aria-busy') }).toMatchSnapshot()
  await act(async () => { retry.resolve(undefined) })
  expect(f.onApplied).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(remove.getAttribute('aria-disabled')).toBe('false')
  view.rerender(<TaskKnowledgeSelector {...f} capabilities={{ knowledgeBaseIds: [] }} t={t} />)
  expect(screen.queryByRole('group', { name: text.taskKnowledge })).toBeNull()
})

it('renders no knowledge control for an empty scope, while the Add action can still open selection', async () => {
  const f = fixture()
  f.capabilities.knowledgeBaseIds = []
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
