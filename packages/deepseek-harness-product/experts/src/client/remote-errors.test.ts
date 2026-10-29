/** Expert operations keep native failure identity and recovery semantics. */
import { expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { expertConflict } from '../expert-contract.ts'
import { loadEditorReview } from './editor-review.ts'
import { unwrap } from './team-ui.tsx'
import { createExpertClientState } from './client-state.ts'
import { writeEnabled, writeErrorKey } from './index.ts'
import type { AgencyCatalogRemote } from './remote.ts'

it.each(['catalog', 'expert', 'verification'] as const)('preserves the %s read failure and stops preparing an editor review', async (stage) => {
  const error = new RemoteError('gateway/cancelled', 'Reader stopped', {})
  const snapshot = { experts: [{ slug: 'custom-reviewer', name: 'Reviewer', nameEn: '', description: '', descriptionEn: '',
    emoji: '🧩', division: 'engineering', divisionZh: '', custom: true }], enabled: [], revision: 1 }
  const getCatalog = vi.fn<AgencyCatalogRemote['getCatalog']>().mockResolvedValue({ ok: true, value: snapshot })
  const getCustomExpert = vi.fn<AgencyCatalogRemote['getCustomExpert']>().mockResolvedValue({ ok: true,
    value: { slug: 'custom-reviewer', name: 'Reviewer', description: 'Review code', division: 'engineering', prompt: 'Check changes' } })
  if (stage === 'catalog') getCatalog.mockResolvedValueOnce({ ok: false, error })
  if (stage === 'expert') getCustomExpert.mockResolvedValueOnce({ ok: false, error })
  if (stage === 'verification') getCatalog.mockResolvedValueOnce({ ok: true, value: snapshot }).mockResolvedValueOnce({ ok: false, error })
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected mutation'))
  await expect(loadEditorReview({ getCatalog, getCustomExpert, saveCustomExpert: unused, deleteCustomExpert: unused }, 'custom-reviewer', 'en')).rejects.toBe(error)
  expect(getCatalog).toHaveBeenCalledTimes(stage === 'verification' ? 2 : 1)
  expect(getCustomExpert).toHaveBeenCalledTimes(stage === 'catalog' ? 0 : 1)
})

it('keeps a rejected selection write typed and leaves the confirmed catalog unchanged', async () => {
  const error = expertConflict('Revision mismatch')
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected read'))
  const setEnabled = vi.fn<Parameters<typeof writeEnabled>[0]['setEnabled']>().mockResolvedValue({ ok: false, error })
  const remote: Parameters<typeof writeEnabled>[0] = { getCatalog: unused, getCustomExpert: unused, saveCustomExpert: unused,
    deleteCustomExpert: unused, getEnabled: unused, getPrompt: unused, setEnabled }
  const cache = createExpertClientState(remote)
  const before = cache.catalog.accept({ experts: [], enabled: [], revision: 1 })
  await expect(writeEnabled(remote, cache, new Set(['reviewer']), 1)).rejects.toBe(error)
  expect(cache.catalog.getSnapshot()).toBe(before)
  expect(setEnabled).toHaveBeenCalledOnce()
  cache.catalog.dispose()
  cache.teams.dispose()
})

it('retains the native team failure and returns successful values directly', async () => {
  const error = new RemoteError('gateway/cancelled', 'Team read cancelled', {})
  await expect(unwrap(Promise.resolve({ ok: false, error }))).rejects.toBe(error)
  const value = { revision: 1 }
  await expect(unwrap(Promise.resolve({ ok: true, value }))).resolves.toBe(value)
})

it('does not mistake unrelated diagnostic wording for a settings conflict', () => {
  expect(writeErrorKey(new Error('changed since it was read in another window'))).toBeNull()
  expect(writeErrorKey({ code: 'experts/conflict', message: 'Revision mismatch' })).toBe('error.conflict')
})
