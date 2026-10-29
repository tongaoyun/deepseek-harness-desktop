import { expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { commitBulk } from './bulk-operations.ts'
import type { ExpertSummary } from '../expert-contract.ts'
const expert = (slug: string, conflict = false): ExpertSummary => ({ slug, name: slug, nameEn: slug, description: '', descriptionEn: '', emoji: '🧩', division: 'engineering', divisionZh: '', custom: true, conflict })
it('merges confirmed targets into current state and skips removed or conflicted experts', async () => {
  const setEnabled = vi.fn((enabled: string[], revision: number, _signal?: AbortSignal) => Promise.resolve({
    ok: true as const, value: { enabled, revision: revision + 1 },
  }))
  const remote = { getCatalog: vi.fn(() => Promise.resolve({ ok: true as const, value: { experts: [expert('target'), expert('conflict', true), expert('other')], enabled: ['other'], revision: 9 } })), setEnabled }
  expect(await commitBulk(remote, ['target', 'removed', 'conflict'], true)).toEqual({ enabled: ['other', 'target'], revision: 10 })
  expect(setEnabled).toHaveBeenCalledWith(['other', 'target'], 9)
  expect(await commitBulk(remote, ['target'], false)).toEqual({ enabled: ['other'], revision: 10 })
})
it('stops on failed refresh and surfaces a conflicting write without retrying', async () => {
  const setEnabled = vi.fn(() => Promise.resolve({ ok: false as const, error: new RemoteError('gateway/bad-request', 'Changed elsewhere', {}) }))
  const getCatalog = vi.fn(() => Promise.resolve({ ok: true as const, value: { experts: [expert('target')], enabled: [], revision: 1 } }))
  await expect(commitBulk({ getCatalog, setEnabled }, ['target'], true)).rejects.toThrow('Changed elsewhere')
  expect(setEnabled).toHaveBeenCalledTimes(1)
  getCatalog.mockRejectedValueOnce(new Error('Offline'))
  await expect(commitBulk({ getCatalog, setEnabled }, ['target'], true)).rejects.toThrow('Offline')
  expect(setEnabled).toHaveBeenCalledTimes(1)
})

it('preserves structured native failures for bulk writes and reads', async () => {
  const error = new RemoteError('gateway/internal', 'Carrier unavailable', {})
  const getCatalog = vi.fn(() => Promise.resolve({ ok: true as const, value: { experts: [expert('target')], enabled: [], revision: 1 } }))
  const setEnabled = vi.fn(() => Promise.resolve({ ok: false as const, error }))
  await expect(commitBulk({ getCatalog, setEnabled }, ['target'], true)).rejects.toBe(error)
  const readFailure = { getCatalog: () => Promise.resolve({ ok: false as const, error }), setEnabled }
  await expect(commitBulk(readFailure, ['target'], true)).rejects.toBe(error)
  expect(setEnabled).toHaveBeenCalledOnce()
})
