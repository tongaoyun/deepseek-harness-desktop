// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { useEnterpriseCatalog } from './useEnterpriseCatalog'
import { createExpertKitDownload, createSkillDownload, loadConnectors, loadExpertKits, loadSkills } from './api'
import { inspectInstalledExtensions, installExtension } from './expertKits'
import { loadEnterpriseCatalogCache } from './enterpriseCache'
import type { BootstrapResponse, ConnectorCatalogEntry, InstalledExpertKit } from './types'
import type { DingTalkUser } from './auth'

vi.mock('./api', () => ({ createExpertKitDownload: vi.fn(), createSkillDownload: vi.fn(), loadExpertKits: vi.fn(async () => []), loadSkills: vi.fn(async () => []), loadKnowledgeBases: vi.fn(async () => []), loadConnectors: vi.fn(async () => []) }))
vi.mock('./enterpriseCache', () => ({ loadEnterpriseCatalogCache: vi.fn(async () => undefined), saveEnterpriseCatalogCache: vi.fn(async () => {}) }))
vi.mock('./expertKits', () => ({ inspectInstalledExtensions: vi.fn(), installExtension: vi.fn(), mergeExpertKits: (_catalog: unknown, installed: InstalledExpertKit[]) => installed.map((item) => ({ id: item.manifest.id })) }))
vi.mock('./skills', () => ({ mergeSkills: () => [] }))
vi.mock('./extensionSubmissions', () => ({ loadPersonalConnectors: () => [], isPersonalConnector: () => false }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const bootstrap = { endpoints: {} } as BootstrapResponse
const enabledConnectorIds: string[] = []
const installed = (id: string) => ({ installed: [{ manifest: { id } } as InstalledExpertKit], issues: [] })
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(loadConnectors).mockResolvedValue([])
  vi.mocked(loadExpertKits).mockResolvedValue([])
  vi.mocked(loadSkills).mockResolvedValue([])
  vi.mocked(inspectInstalledExtensions).mockResolvedValue(installed('old'))
})

async function fixture(
  check: (render: (owner: string) => Promise<void>, state: () => ReturnType<typeof useEnterpriseCatalog>) => Promise<void>,
  withBootstrap = true,
) {
  let state!: ReturnType<typeof useEnterpriseCatalog>
  function Probe({ owner }: { owner: string }) {
    // Match the session hook's stable user object.
    const user = users[owner]
    state = useEnterpriseCatalog({ accessToken: '', bootstrap: withBootstrap ? bootstrap : undefined, enabledConnectorIds, user }); return null
  }
  const root = createRoot(document.createElement('div'))
  try { await check(async (owner) => { await act(async () => root.render(<Probe owner={owner} />)) }, () => state) }
  finally { await act(async () => root.unmount()) }
}
const users: Record<string, DingTalkUser> = { one: { userId: 'one' } as DingTalkUser, two: { userId: 'two' } as DingTalkUser }

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

it('continues published kit synchronization after a concurrent inventory refresh', async () => {
  let resolve!: (value: ConnectorCatalogEntry[]) => void
  const oldKit = {
    source: 'catalog', packageSha256: 'a'.repeat(64),
    manifest: { kind: 'expert-kit', id: 'fullstack-dev-expert', version: '1.0.0' },
  } as InstalledExpertKit
  const latestKit = {
    ...oldKit, packageSha256: 'b'.repeat(64),
    manifest: { ...oldKit.manifest, version: '1.0.1' },
  } as InstalledExpertKit
  vi.mocked(loadExpertKits).mockResolvedValue([{
    id: 'fullstack-dev-expert', name: '全栈开发专家', version: '1.0.1', sha256: 'b'.repeat(64),
  } as never])
  vi.mocked(createExpertKitDownload).mockResolvedValue({
    id: 'fullstack-dev-expert', version: '1.0.1', sha256: 'b'.repeat(64), url: 'http://example.test/kit.tar.gz',
    expiresAt: '2026-09-10T06:00:00Z',
  })
  vi.mocked(installExtension).mockResolvedValue(latestKit)
  vi.mocked(inspectInstalledExtensions).mockResolvedValue({ installed: [oldKit], issues: [] })
  vi.mocked(loadConnectors).mockReturnValueOnce(new Promise((yes) => { resolve = yes }))

  await fixture(async (render, state) => {
    await render('one')
    await act(async () => { await state().refreshInstalled() })
    await act(async () => resolve([]))
    expect(inspectInstalledExtensions).toHaveBeenCalledTimes(3)
    expect(installExtension).toHaveBeenCalledOnce()
    expect(state().expertKits.map((item) => item.id)).toEqual(['fullstack-dev-expert'])
  })
})

it('replaces an installed standalone skill with the published content', async () => {
  const local = {
    source: 'catalog', packageSha256: 'a'.repeat(64),
    manifest: { kind: 'skill', id: 'document-insight', version: '1.0.0' },
  } as InstalledExpertKit
  const latest = { ...local, packageSha256: 'b'.repeat(64), manifest: { ...local.manifest, version: '1.1.0' } } as InstalledExpertKit
  vi.mocked(loadSkills).mockResolvedValue([{ id: 'document-insight', name: '文档洞察', version: '1.1.0', sha256: 'b'.repeat(64) } as never])
  vi.mocked(createSkillDownload).mockResolvedValue({
    id: 'document-insight', version: '1.1.0', sha256: 'b'.repeat(64), url: 'http://example.test/skill.tar.gz', expiresAt: '',
  })
  vi.mocked(installExtension).mockResolvedValue(latest)
  vi.mocked(inspectInstalledExtensions).mockResolvedValue({ installed: [local], issues: [] })

  await fixture(async (render) => {
    await render('one')
    expect(createSkillDownload).toHaveBeenCalledOnce()
    expect(vi.mocked(installExtension).mock.calls).toEqual([[expect.objectContaining({ id: 'document-insight' }), 'skill']])
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

it('loads cached catalog data and installed extensions without enterprise bootstrap', async () => {
  vi.mocked(loadEnterpriseCatalogCache).mockResolvedValue({
    savedAt: '2026-09-10T00:00:00Z',
    catalog: [{ id: 'cached-kit', name: '缓存套件' } as never],
    skills: [], knowledge: [], connectors: [{ id: 'cached-connector' } as ConnectorCatalogEntry],
  })
  await fixture(async (render, state) => {
    await render('one')
    expect(state().expertKitCatalog.map((item) => item.id)).toEqual(['cached-kit'])
    expect(state().expertKits.map((item) => item.id)).toEqual(['old'])
    expect(state().connectors.some((item) => item.id === 'cached-connector')).toBe(true)
    expect(state().error).toContain('正在显示本机缓存和已安装扩展')
    expect(state().loading).toBe(false)
    expect(loadExpertKits).not.toHaveBeenCalled()
    expect(loadConnectors).not.toHaveBeenCalled()
  }, false)
})

it('reports partial remote failures and retains the last cached content', async () => {
  vi.mocked(loadEnterpriseCatalogCache).mockResolvedValue({
    savedAt: '2026-09-10T00:00:00Z',
    catalog: [{ id: 'cached-kit', name: '缓存套件' } as never],
    skills: [], knowledge: [], connectors: [],
  })
  vi.mocked(loadExpertKits).mockRejectedValue(new Error('network unavailable'))
  await fixture(async (render, state) => {
    await render('one')
    expect(state().expertKitCatalog.map((item) => item.id)).toEqual(['cached-kit'])
    expect(state().error).toContain('专家套件同步失败')
    expect(state().loading).toBe(false)
  })
})

it('hides the previous employee catalog on the first render after an account change', async () => {
  const renders: Array<{ owner: string; kits: string[] }> = []
  function Probe({ owner }: { owner: string }) {
    const state = useEnterpriseCatalog({
      accessToken: '', bootstrap, enabledConnectorIds, user: users[owner] ?? null,
    })
    renders.push({ owner, kits: state.expertKits.map((kit) => kit.id) })
    return null
  }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(<Probe owner="one" />))
    expect(renders.at(-1)?.kits).toEqual(['old'])
    await act(async () => root.render(<Probe owner="two" />))
    expect(renders.find((render) => render.owner === 'two')?.kits).toEqual([])
    await act(async () => root.render(<Probe owner="signed-out" />))
    expect(renders.find((render) => render.owner === 'signed-out')?.kits).toEqual([])
  } finally { await act(async () => root.unmount()) }
})
