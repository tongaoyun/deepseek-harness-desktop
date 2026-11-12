// @vitest-environment jsdom
/** Personal expert confirmations and receipts use the directory reviewed by their operation. */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { AgencySettingsPanel } from '../../src/client/index.ts'
import { createExpertClientState } from '../../src/client/client-state.ts'
import { en, zh } from '../../src/client/locales.ts'
import type { CatalogSnapshot } from '../../src/expert-contract.ts'

const expert = { slug: 'custom-00000000-0000-4000-8000-000000000001', name: 'Personal reviewer', nameEn: 'Personal reviewer',
  description: 'Review code', descriptionEn: '', emoji: '🔎', avatar: 0, division: 'engineering', divisionZh: '研发', custom: true }
const company = { ...expert, slug: 'company-reviewer', name: 'Company reviewer', nameEn: 'Company reviewer', custom: false, company: true }
const original: CatalogSnapshot = { experts: [expert, company], enabled: [], revision: 1 }

afterEach(cleanup)

async function fixture() {
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected operation'))
  const getCatalog = vi.fn<React.ComponentProps<typeof AgencySettingsPanel>['remote']['getCatalog']>()
    .mockResolvedValue({ ok: true, value: original })
  const remove = vi.fn<React.ComponentProps<typeof AgencySettingsPanel>['remote']['deleteCustomExpert']>()
    .mockResolvedValue({ ok: true, value: { ...original, experts: [company], revision: 2 } })
  const save = vi.fn<React.ComponentProps<typeof AgencySettingsPanel>['remote']['saveCustomExpert']>()
    .mockResolvedValue({ ok: true, value: { ...original, revision: 2 } })
  const remote: React.ComponentProps<typeof AgencySettingsPanel>['remote'] = { getCatalog, deleteCustomExpert: remove, saveCustomExpert: save,
    importExpert: async () => { throw new Error('Unexpected package import') }, exportExpert: async () => { throw new Error('Unexpected package export') }, getCustomExpert: async () => ({ ok: true, value: { slug: expert.slug, name: expert.name, description: expert.description,
      emoji: expert.emoji, avatar: expert.avatar, division: expert.division, prompt: 'Review with evidence.' } }),
    getTeams: async () => ({ ok: true, value: { teams: [], enabledTeams: [], enabledExperts: [], revision: 1 } }),
    setEnabled: unused, getPrompt: unused }
  const cache = createExpertClientState(remote)
  onTestFinished(() => { cache.catalog.dispose(); cache.teams.dispose() })
  cache.catalog.accept(original)
  let language: 'zh' | 'en' = 'en'
  const dictionaries: Readonly<Record<'zh' | 'en', Readonly<Record<string, string>>>> = { zh, en }
  const props: React.ComponentProps<typeof AgencySettingsPanel> = { remote, cache, useExpertCatalog: bindSnapshotSelector(cache.catalog),
    useExpertTeams: bindSnapshotSelector(cache.teams),
    getActive: () => language, prepareTeamSelection: () => () => false,
    t: (key, values) => (dictionaries[language][key] ?? key).replace(/\{(\w+)\}/gu,
      (_, name: string) => {
        const value = values?.[name]
        return typeof value === 'string' || typeof value === 'number' ? String(value) : name
      }) }
  const view = render(<AgencySettingsPanel {...props} />)
  await act(async () => { await cache.catalog.refresh(true) })
  fireEvent.click(screen.getByRole('tab', { name: en['custom.source'] }))
  return { cache, getCatalog, remove, save, changeLanguage: () => {
    language = language === 'en' ? 'zh' : 'en'
    view.rerender(<AgencySettingsPanel {...props} />)
  } }
}

function confirmDelete() {
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['custom.delete'] }))
}

it.each([false, true].flatMap(delayed => [false, true].map(elsewhere => ({ delayed, elsewhere }))))(
  'returns deleted expert focus to the current search without changing its draft (elsewhere=$elsewhere, delayed=$delayed)', async ({ delayed, elsewhere }) => {
    const value = await fixture()
    const reply = Promise.withResolvers<{ ok: true; value: CatalogSnapshot }>()
    const refreshed = Promise.withResolvers<{ ok: true; value: CatalogSnapshot }>()
    onTestFinished(() => { reply.resolve({ ok: true, value: original }); refreshed.resolve({ ok: true, value: original }) })
    value.remove.mockReturnValueOnce(reply.promise)
    const search = screen.getByRole<HTMLInputElement>('textbox', { name: en['settings.search'] })
    fireEvent.change(search, { target: { value: 'review' } })
    search.setSelectionRange(1, 4)
    render(<input aria-label="Other draft" defaultValue="Unsubmitted" />)
    const other = screen.getByRole<HTMLInputElement>('textbox', { name: 'Other draft' })
    other.setSelectionRange(2, 5)
    const trigger = screen.getByRole<HTMLButtonElement>('button', { name: en['custom.delete'] })
    trigger.focus(); fireEvent.click(trigger)
    const confirm = within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', { name: en['custom.delete'] })
    confirm.focus(); fireEvent.click(confirm)
    if (elsewhere) other.focus()
    const updated = { ...company, description: 'Updated company content' }
    if (delayed) {
      act(() => { value.cache.catalog.accept({ ...original, experts: [expert, updated] }) })
      value.getCatalog.mockReturnValueOnce(refreshed.promise)
    }
    await act(async () => { reply.resolve({ ok: true, value: { ...original, experts: [company], revision: 2 } }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    if (delayed) await act(async () => { refreshed.resolve({ ok: true, value: { ...original, experts: [updated], revision: 2 } }) })
    expect(trigger.isConnected).toBe(false)
    expect(document.activeElement).toBe(elsewhere ? other : search)
    expect(screen.getByRole('textbox', { name: en['settings.search'] })).toBe(search)
    expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['review', 1, 4])
    expect([other.value, other.selectionStart, other.selectionEnd]).toEqual(['Unsubmitted', 2, 5])
    expect(value.remove).toHaveBeenCalledOnce()
  },
)

it.each(['renamed', 'description', 'prompt-revision'] as const)('requires a new delete confirmation after the expert is %s', async (change) => {
  const value = await fixture()
  fireEvent.click(screen.getByRole('button', { name: en['custom.delete'] }))
  const updated = { ...expert, ...(change === 'renamed' ? { name: 'Updated reviewer', nameEn: 'Updated reviewer' }
    : change === 'description' ? { description: 'Updated responsibility' } : {}) }
  act(() => { value.cache.catalog.accept({ ...original, experts: [updated, company], revision: 2 }) })
  await act(async () => { confirmDelete() })
  expect(value.remove).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain(en['error.conflict'])
  fireEvent.click(screen.getByRole('button', { name: en['custom.delete'] }))
  expect(screen.getByRole('dialog').textContent).toContain(updated.name)
  await act(async () => { confirmDelete() })
  expect(value.remove).toHaveBeenCalledWith(expert.slug, 2, expect.any(AbortSignal))
})

it('keeps an unchanged delete confirmation valid and retains it after a failed write', async () => {
  const value = await fixture()
  value.remove.mockRejectedValueOnce(new Error('Disk full'))
  fireEvent.click(screen.getByRole('button', { name: en['custom.delete'] }))
  act(() => { value.cache.catalog.accept(structuredClone(original)) })
  await act(async () => { confirmDelete() })
  expect(value.remove).toHaveBeenCalledWith(expert.slug, 1, expect.any(AbortSignal))
  expect(screen.getByRole('dialog').textContent).toContain('Disk full')
  await act(async () => { confirmDelete() })
  expect(value.remove).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['save', 'delete'] as const)('translates the confirmed expert %s result without repeating the operation', async (operation) => {
  const value = await fixture()
  if (operation === 'save') {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['custom.edit'] })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['custom.saveChanges'] })) })
  } else {
    fireEvent.click(screen.getByRole('button', { name: en['custom.delete'] }))
    await act(async () => { confirmDelete() })
  }
  const key = operation === 'save' ? 'custom.saved' : 'custom.deleted'
  expect(screen.getByRole('status').textContent).toBe(en[key])
  const reads = value.getCatalog.mock.calls.length
  value.changeLanguage()
  expect(screen.getByRole('status').textContent).toBe(zh[key])
  expect(value[operation === 'save' ? 'save' : 'remove']).toHaveBeenCalledOnce()
  expect(value.getCatalog).toHaveBeenCalledTimes(reads)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each((['save', 'delete'] as const).flatMap(operation => [1, 2, 3].map(revision => ({ operation, revision }))))(
  'preserves the company directory at revision $revision after a delayed $operation receipt', async ({ operation, revision }) => {
    const value = await fixture()
    const reply = Promise.withResolvers<{ ok: true; value: CatalogSnapshot }>()
    value[operation === 'save' ? 'save' : 'remove'].mockReturnValueOnce(reply.promise)
    if (operation === 'save') {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['custom.edit'] })) })
      fireEvent.click(screen.getByRole('button', { name: en['custom.saveChanges'] }))
    } else {
      fireEvent.click(screen.getByRole('button', { name: en['custom.delete'] }))
      confirmDelete()
    }
    expect(value[operation === 'save' ? 'save' : 'remove']).toHaveBeenCalledOnce()
    const updated = { ...company, name: 'Updated company reviewer', nameEn: 'Updated company reviewer' }
    const latest = { ...original, experts: [expert, updated], revision }
    value.getCatalog.mockResolvedValue({ ok: true, value: { ...latest, revision: Math.max(2, revision) } })
    act(() => { value.cache.catalog.accept(latest) })
    await act(async () => { reply.resolve({ ok: true, value: { ...original, revision: 2 } }); await reply.promise })
    expect(value.cache.catalog.getSnapshot().experts.find(item => item.slug === company.slug)?.name).toBe(updated.name)
    expect(screen.queryByRole('dialog')).toBeNull()
  },
)

it.each((['save', 'delete'] as const).flatMap(operation => [false, true].map(elsewhere => ({ operation, elsewhere }))))(
  'recovers the directory after a committed $operation without repeating it or taking another control (elsewhere=$elsewhere)', async ({ operation, elsewhere }) => {
    const value = await fixture()
    const reply = Promise.withResolvers<{ ok: true; value: CatalogSnapshot }>()
    const write = value[operation === 'save' ? 'save' : 'remove']
    write.mockReturnValueOnce(reply.promise)
    if (operation === 'save') {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['custom.edit'] })) })
      fireEvent.click(screen.getByRole('button', { name: en['custom.saveChanges'] }))
    } else {
      fireEvent.click(screen.getByRole('button', { name: en['custom.delete'] }))
      confirmDelete()
    }
    expect(write).toHaveBeenCalledOnce()
    const latest = { ...original, experts: [expert, { ...company, description: 'Updated company content' }] }
    act(() => { value.cache.catalog.accept(latest) })
    value.getCatalog.mockRejectedValueOnce(new Error('Directory unavailable after commit'))
    await act(async () => { reply.resolve({ ok: true, value: { ...original, revision: 2 } }); await reply.promise })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText(en[operation === 'save' ? 'custom.saved' : 'custom.deleted'])).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Directory unavailable after commit')
    const response = Promise.withResolvers<Awaited<ReturnType<typeof value.getCatalog>>>()
    onTestFinished(() => { response.resolve({ ok: true, value: { ...latest, revision: 2 } }) })
    value.getCatalog.mockReturnValueOnce(response.promise)
    const retry = screen.getByRole<HTMLButtonElement>('button', { name: en['company.retry'] })
    const search = screen.getByRole<HTMLInputElement>('textbox', { name: en['settings.search'] })
    fireEvent.change(search, { target: { value: 'reviewer' } })
    search.setSelectionRange(2, 5)
    const notice = screen.getByRole('alert')
    const reads = value.getCatalog.mock.calls.length
    retry.focus()
    await act(async () => { retry.click(); retry.click() })
    expect(value.getCatalog).toHaveBeenCalledTimes(reads + 1)
    expect(screen.getByRole('alert')).toBe(notice)
    expect(document.activeElement).toBe(retry)
    expect(retry.getAttribute('aria-busy')).toBe('true')
    if (elsewhere) search.focus()
    await act(async () => { response.resolve({ ok: true, value: { ...latest, revision: 2 } }) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(search)
    expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['reviewer', 2, 5])
    expect(write).toHaveBeenCalledOnce()
    if (!elsewhere) expect({ focus: document.activeElement?.getAttribute('aria-label'), query: search.value,
      selection: [search.selectionStart, search.selectionEnd], errors: screen.queryAllByRole('alert').length }).toMatchSnapshot()
  },
)
