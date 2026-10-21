import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CatalogSnapshot } from '../expert-contract.js'
import type { AgencyCatalogRemote } from './remote.js'
import { acceptCatalog, catalogState, refreshCatalog } from './catalog.js'

function fixture() {
  const getCatalog = vi.fn<AgencyCatalogRemote['getCatalog']>()
  const unused = async (): Promise<never> => { throw new Error('Unexpected catalog mutation') }
  const remote: AgencyCatalogRemote = { getCatalog, getCustomExpert: unused,
    saveCustomExpert: unused, deleteCustomExpert: unused }
  return { remote, getCatalog }
}

it('displays the local catalog first and requests company refresh explicitly', async () => {
  const { remote, getCatalog } = fixture()
  const current: CatalogSnapshot = { experts: [], enabled: [], revision: 1 }
  getCatalog.mockResolvedValue({ ok: true, value: current })
  await refreshCatalog(remote)
  expect(getCatalog).toHaveBeenNthCalledWith(1, false)
  expect(catalogState(remote).revision).toBe(1)
  getCatalog.mockRejectedValueOnce(new Error('Network unavailable'))
  await expect(refreshCatalog(remote, true)).rejects.toThrow('Network unavailable')
  expect(getCatalog).toHaveBeenNthCalledWith(2, true)
  expect(catalogState(remote).revision).toBe(1)
  await refreshCatalog(remote, true)
  expect(getCatalog).toHaveBeenCalledTimes(3)
})

it('keeps a newer saved selection when an earlier company refresh finishes late', async () => {
  const { remote, getCatalog } = fixture()
  const response = Promise.withResolvers<RemoteResult<CatalogSnapshot>>()
  getCatalog.mockReturnValue(response.promise)
  const pending = refreshCatalog(remote, true)
  acceptCatalog(remote, { experts: [], enabled: ['orders'], revision: 2 })
  response.resolve({ ok: true, value: { experts: [], enabled: [], revision: 1 } })
  const state = await pending
  expect(state.revision).toBe(2)
  expect(state.enabled.has('orders')).toBe(true)
})
