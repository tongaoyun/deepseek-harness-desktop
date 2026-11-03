// @vitest-environment jsdom
/** Personal expert confirmations and receipts use the directory reviewed by their operation. */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { AgencySettingsPanel } from '../../src/client/index.ts'
import { createExpertClientState } from '../../src/client/client-state.ts'
import { en } from '../../src/client/locales.ts'
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
    getCustomExpert: async () => ({ ok: true, value: { slug: expert.slug, name: expert.name, description: expert.description,
      emoji: expert.emoji, avatar: expert.avatar, division: expert.division, prompt: 'Review with evidence.' } }),
    getTeams: async () => ({ ok: true, value: { teams: [], enabledTeams: [], enabledExperts: [], revision: 1 } }),
    setEnabled: unused, getPrompt: unused }
  const cache = createExpertClientState(remote)
  onTestFinished(() => { cache.catalog.dispose(); cache.teams.dispose() })
  cache.catalog.accept(original)
  const dictionary: Readonly<Record<string, string>> = en
  render(<AgencySettingsPanel remote={remote} cache={cache} useExpertCatalog={bindSnapshotSelector(cache.catalog)}
    useExpertTeams={bindSnapshotSelector(cache.teams)}
    getActive={() => 'en'} prepareTeamSelection={() => () => false} t={(key, values) => (dictionary[key] ?? key).replace(/\{(\w+)\}/gu,
      (_, name: string) => {
        const value = values?.[name]
        return typeof value === 'string' || typeof value === 'number' ? String(value) : name
      })} />)
  await act(async () => { await cache.catalog.refresh(true) })
  fireEvent.click(screen.getByRole('tab', { name: en['custom.source'] }))
  return { cache, getCatalog, remove, save }
}

function confirmDelete() {
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['custom.delete'] }))
}

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

it.each(['save', 'delete'] as const)('reports only a directory error when a committed %s needs a read that fails', async (operation) => {
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
  value.getCatalog.mockResolvedValue({ ok: true, value: { ...latest, revision: 2 } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['company.retry'] })) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(write).toHaveBeenCalledOnce()
})
