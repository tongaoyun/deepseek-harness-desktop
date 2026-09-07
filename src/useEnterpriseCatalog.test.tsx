// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { useEnterpriseCatalog } from './useEnterpriseCatalog'
import { loadConnectors } from './api'
import { inspectInstalledExtensions } from './expertKits'
import { loadEnterpriseCatalogCache } from './enterpriseCache'
import type { BootstrapResponse, ConnectorCatalogEntry, InstalledExpertKit } from './types'
import type { ErpUser } from './auth'

vi.mock('./api', () => ({ loadExpertKits: vi.fn(async () => []), loadSkills: vi.fn(async () => []), loadKnowledgeBases: vi.fn(async () => []), loadConnectors: vi.fn(async () => []) }))
vi.mock('./enterpriseCache', () => ({ loadEnterpriseCatalogCache: vi.fn(async () => undefined), saveEnterpriseCatalogCache: vi.fn(async () => {}) }))
vi.mock('./expertKits', () => ({ inspectInstalledExtensions: vi.fn(), mergeExpertKits: (_catalog: unknown, installed: InstalledExpertKit[]) => installed.map((item) => ({ id: item.manifest.id })) }))
vi.mock('./skills', () => ({ mergeSkills: () => [] }))
vi.mock('./extensionSubmissions', () => ({ loadPersonalConnectors: () => [], isPersonalConnector: () => false }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const bootstrap = { endpoints: {} } as BootstrapResponse
const enabledConnectorIds: string[] = []
const installed = (id: string) => ({ installed: [{ manifest: { id } } as InstalledExpertKit], issues: [] })
beforeEach(() => { vi.resetAllMocks(); vi.mocked(loadConnectors).mockResolvedValue([]); vi.mocked(inspectInstalledExtensions).mockResolvedValue(installed('old')) })

async function fixture(check: (render: (owner: string) => Promise<void>, state: () => ReturnType<typeof useEnterpriseCatalog>) => Promise<void>) {
  let state!: ReturnType<typeof useEnterpriseCatalog>
  function Probe({ owner }: { owner: string }) {
    // Match the session hook's stable user object.
    const user = users[owner]
    state = useEnterpriseCatalog({ accessToken: '', bootstrap, enabledConnectorIds, user }); return null
  }
  const root = createRoot(document.createElement('div'))
  try { await check(async (owner) => { await act(async () => root.render(<Probe owner={owner} />)) }, () => state) }
  finally { await act(async () => root.unmount()) }
}
const users: Record<string, ErpUser> = { one: { userId: 'one' } as ErpUser, two: { userId: 'two' } as ErpUser }

it('does not let an older background inventory overwrite a completed installation refresh', async () => {
  let resolve!: (value: ConnectorCatalogEntry[]) => void
  vi.mocked(loadConnectors).mockReturnValueOnce(new Promise((yes) => { resolve = yes }))
  await fixture(async (render, state) => {
    await render('one')
    vi.mocked(inspectInstalledExtensions).mockResolvedValue(installed('new'))
    await act(async () => { await state().refreshInstalled() })
    expect(state().expertKits.map((item) => item.id)).toEqual(['new'])
    await act(async () => resolve([]))
    expect(state().expertKits.map((item) => item.id)).toEqual(['new'])
    expect(state().loading).toBe(false)
  })
})

it('ignores a late cached catalog from the previous employee', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof loadEnterpriseCatalogCache>>) => void
  vi.mocked(loadEnterpriseCatalogCache).mockReturnValueOnce(new Promise((yes) => { resolve = yes }))
  await fixture(async (render, state) => {
    await render('one')
    await render('two')
    await act(async () => resolve({ savedAt: 'old', catalog: [], skills: [], knowledge: [], connectors: [{ id: 'stale' } as ConnectorCatalogEntry] }))
    expect(state().connectors.some((item) => item.id === 'stale')).toBe(false)
    expect(loadConnectors).toHaveBeenCalledTimes(1)
  })
})

it('refreshes capability configuration when returning to the window', async () => {
  await fixture(async (render, state) => {
    await render('one')
    vi.mocked(loadConnectors).mockResolvedValue([{ id: 'new-connector' } as ConnectorCatalogEntry])
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(state().connectors.some((item) => item.id === 'new-connector')).toBe(true)
  })
})
