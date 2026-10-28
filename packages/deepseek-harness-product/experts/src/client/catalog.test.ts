import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CatalogSnapshot } from '../expert-contract.ts'
import type { AgencyCatalogRemote } from './remote.ts'
import { ExpertCatalog } from './catalog.ts'

function fixture() {
  const getCatalog = vi.fn<AgencyCatalogRemote['getCatalog']>()
  const unused = async (): Promise<never> => { throw new Error('Unexpected catalog mutation') }
  const remote: AgencyCatalogRemote = { getCatalog, getCustomExpert: unused,
    saveCustomExpert: unused, deleteCustomExpert: unused }
  return { remote, getCatalog, catalog: new ExpertCatalog(remote) }
}

it.each(['constructor', '__proto__', 'toString'])('displays the company category %s as text in English', (division) => {
  const { catalog } = fixture()
  const state = catalog.accept({ experts: [{ slug: 'company-reviewer', name: '审查员', nameEn: 'Reviewer',
    description: '代码审查', descriptionEn: 'Code review', emoji: '🔎', division, divisionZh: division, custom: false }],
  enabled: [], revision: 1 })
  expect(state.experts[0]?.divisionEn).toBe(division)
  expect(state.experts.map(expert => ({ division: expert.division, divisionEn: expert.divisionEn }))).toMatchSnapshot()
})

it('displays the local catalog first and requests company refresh explicitly', async () => {
  const { catalog, getCatalog } = fixture()
  const current: CatalogSnapshot = { experts: [], enabled: [], revision: 1 }
  getCatalog.mockResolvedValue({ ok: true, value: current })
  await catalog.refresh()
  expect(getCatalog).toHaveBeenNthCalledWith(1, false, expect.any(AbortSignal))
  expect(catalog.getSnapshot().revision).toBe(1)
  getCatalog.mockRejectedValueOnce(new Error('Network unavailable'))
  await expect(catalog.refresh(true)).rejects.toThrow('Network unavailable')
  expect(getCatalog).toHaveBeenNthCalledWith(2, true, expect.any(AbortSignal))
  expect(catalog.getSnapshot().revision).toBe(1)
  await catalog.refresh(true)
  expect(getCatalog).toHaveBeenCalledTimes(3)
})

it('keeps a newer saved selection when an earlier company refresh finishes late', async () => {
  const { catalog, getCatalog } = fixture()
  const response = Promise.withResolvers<RemoteResult<CatalogSnapshot>>()
  getCatalog.mockReturnValue(response.promise)
  const pending = catalog.refresh(true)
  catalog.accept({ experts: [], enabled: ['orders'], revision: 2 })
  response.resolve({ ok: true, value: { experts: [], enabled: [], revision: 1 } })
  const state = await pending
  expect(state.revision).toBe(2)
  expect(state.enabled.has('orders')).toBe(true)
})
