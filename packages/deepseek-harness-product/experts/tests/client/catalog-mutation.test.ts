/** Personal mutations preserve company content accepted while the write is in flight. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { ExpertCatalog } from '../../src/client/catalog.ts'
import type { AgencyCatalogRemote } from '../../src/client/remote.ts'
import type { CatalogSnapshot } from '../../src/expert-contract.ts'

const company = { slug: 'reviewer', name: 'Reviewer', nameEn: 'Reviewer', description: 'Review', descriptionEn: '',
  emoji: '🔎', division: 'engineering', divisionZh: '研发', custom: false, company: true }
const original: CatalogSnapshot = { experts: [company], enabled: [], revision: 1 }
const receipt: CatalogSnapshot = { ...original, revision: 2 }
const updated: CatalogSnapshot = { ...receipt, experts: [{ ...company, name: 'Updated reviewer' }] }

function fixture() {
  const getCatalog = vi.fn<AgencyCatalogRemote['getCatalog']>().mockResolvedValue({ ok: true, value: updated })
  const unused = (): Promise<never> => Promise.reject(new Error('Unexpected mutation'))
  const catalog = new ExpertCatalog({ getCatalog, getCustomExpert: unused, saveCustomExpert: unused, deleteCustomExpert: unused })
  onTestFinished(() => { catalog.dispose() })
  const started = catalog.accept(original)
  return { catalog, getCatalog, started }
}

it('accepts an unchanged-operation receipt without rereading and fences an older read', async () => {
  const { catalog, getCatalog, started } = fixture()
  const response = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['getCatalog']>>>()
  getCatalog.mockReturnValueOnce(response.promise)
  const reading = catalog.refresh()
  expect((await catalog.acceptMutation(receipt, started)).revision).toBe(2)
  response.resolve({ ok: true, value: original })
  expect((await reading).revision).toBe(2)
  expect(getCatalog).toHaveBeenCalledOnce()
})

it.each([2, 3])('preserves concurrent content at revision %s without rereading', async (revision) => {
  const { catalog, getCatalog, started } = fixture()
  const current = catalog.accept({ ...updated, revision })
  expect(await catalog.acceptMutation(receipt, started)).toBe(current)
  expect(getCatalog).not.toHaveBeenCalled()
})

it.each(['before', 'after'] as const)('rereads lower-revision content and fences an old read finishing %s it', async (order) => {
  const { catalog, getCatalog, started } = fixture()
  catalog.accept({ ...updated, revision: 1 })
  const stale = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['getCatalog']>>>()
  const fresh = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['getCatalog']>>>()
  getCatalog.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
  const reading = catalog.refresh()
  const accepting = catalog.acceptMutation(receipt, started)
  expect(getCatalog).toHaveBeenCalledTimes(2)
  if (order === 'before') {
    stale.resolve({ ok: true, value: original })
    await reading
    expect(catalog.getSnapshot().experts[0].name).toBe('Updated reviewer')
  }
  fresh.resolve({ ok: true, value: updated })
  const current = await accepting
  if (order === 'after') {
    stale.resolve({ ok: true, value: original })
    expect(await reading).toBe(current)
  }
  expect(current.experts[0].name).toBe('Updated reviewer')
})

it('does not start a superseded queued company read after the post-commit read', async () => {
  const { catalog, getCatalog, started } = fixture()
  catalog.accept({ ...updated, revision: 1 })
  const stale = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['getCatalog']>>>()
  const fresh = Promise.withResolvers<Awaited<ReturnType<AgencyCatalogRemote['getCatalog']>>>()
  getCatalog.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
  const reading = catalog.refresh()
  const queued = catalog.refresh(true)
  const accepting = catalog.acceptMutation(receipt, started)
  fresh.resolve({ ok: true, value: updated })
  const current = await accepting
  stale.resolve({ ok: true, value: original })
  expect(await reading).toBe(current)
  expect(await queued).toBe(current)
  expect(getCatalog).toHaveBeenCalledTimes(2)
})

it('preserves known content on a failed post-commit read and permits a fresh retry', async () => {
  const { catalog, getCatalog, started } = fixture()
  const current = catalog.accept({ ...updated, revision: 1 })
  getCatalog.mockRejectedValueOnce(new Error('Directory unavailable'))
  await expect(catalog.acceptMutation(receipt, started)).rejects.toThrow('Directory unavailable')
  expect(catalog.getSnapshot()).toBe(current)
  expect((await catalog.refresh()).experts[0].name).toBe('Updated reviewer')
  expect(getCatalog).toHaveBeenCalledTimes(2)
})

it.each(['acceptEnabled', 'adoptRevision'] as const)('filters a delayed %s selection through the currently available expert directory', (operation) => {
  const { catalog } = fixture()
  catalog.accept({ experts: [company, { ...company, slug: 'conflicted', conflict: true }], enabled: [], revision: 2 })
  const enabled = [company.slug, 'conflicted', 'removed']
  const current = operation === 'acceptEnabled' ? catalog.acceptEnabled({ enabled, revision: 2 }) : catalog.adoptRevision(2, enabled)
  expect([...current.enabled]).toEqual([company.slug])
  expect(current.experts.find(expert => expert.slug === 'conflicted')?.conflict).toBe(true)
})
