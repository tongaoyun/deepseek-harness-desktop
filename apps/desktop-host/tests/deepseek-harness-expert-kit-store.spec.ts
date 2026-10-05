import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  expertKitPresetId,
  expertKitGenerationPath,
  pruneExpertKitGenerations,
  pruneExpertKitPresetSnapshots,
  readExpertKitPresetSnapshots,
  writeExpertKitPresetSnapshot,
  type ExpertKitSnapshotEntry,
} from '../src/deepseek-harness-expert-kit-store.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-harness-expert-kit-store-'))
  roots.push(root)
  return root
}

function kit(sha256: string): ExpertKitSnapshotEntry {
  return {
    id: 'order-expert', name: '订单专家', version: '1.0.0', summary: '排查订单问题。',
    skillIds: ['order-query'], connectorRefs: ['erp'], requiredTools: ['order_get'],
    knowledgeBaseRefs: ['organization/orders'], sha256,
  }
}

const connectors = [{ id: 'erp', name: 'ERP', transport: 'streamable-http' as const,
  url: 'https://erp.example/mcp', arguments: [], toolNames: ['order_get'], readOnlyTools: ['order_get'] }]

describe('DeepSeekHarness Expert Kit artifact generations', () => {
  it('keeps different hashes in different immutable directories', async () => {
    const root = await temporaryRoot()
    const first = expertKitGenerationPath(root, kit('a'.repeat(64)))
    const second = expertKitGenerationPath(root, kit('b'.repeat(64)))

    expect(first).toBe(join(root, 'order-expert', 'a'.repeat(64)))
    expect(second).toBe(join(root, 'order-expert', 'b'.repeat(64)))
    expect(second).not.toBe(first)
  })

  it('round-trips non-secret Preset descriptors for Host restart', async () => {
    const root = await temporaryRoot()
    const entry = kit('a'.repeat(64))
    const id = expertKitPresetId(entry, connectors)
    await writeExpertKitPresetSnapshot(root, { id, kit: entry, connectors })

    const result = await readExpertKitPresetSnapshots(root)
    expect(result).toEqual({ snapshots: [{ schema: 'deepseek-harness.expert-kit-preset.v3', id, kit: {
      ...entry, sha256: 'a'.repeat(64),
    }, connectors }], diagnostics: [] })
    const source = await readFile(join(root, `${id}.json`), 'utf8')
    expect(source).not.toContain('headers')
    expect(source).not.toContain('token')
  })

  it('does not overwrite an existing generation descriptor with changed metadata', async () => {
    const root = await temporaryRoot()
    const entry = kit('b'.repeat(64))
    const id = expertKitPresetId(entry, connectors)
    await writeExpertKitPresetSnapshot(root, { id, kit: entry, connectors })

    await expect(writeExpertKitPresetSnapshot(root, {
      id, kit: { ...entry, summary: '被篡改的说明。' }, connectors,
    })).rejects.toThrow('is immutable')
  })

  it('isolates a corrupt snapshot without hiding valid generations', async () => {
    const root = await temporaryRoot()
    const entry = kit('c'.repeat(64))
    const id = expertKitPresetId(entry, connectors)
    await writeExpertKitPresetSnapshot(root, { id, kit: entry, connectors })
    await writeFile(join(root, 'broken.json'), '{not-json', 'utf8')

    const result = await readExpertKitPresetSnapshots(root)
    expect(result.snapshots.map(snapshot => snapshot.id)).toEqual([id])
    expect(result.diagnostics).toEqual([expect.stringContaining('broken.json')])
  })

  it('removes only Presets and generations absent from retained Sessions and the current catalog', async () => {
    const root = await temporaryRoot()
    const snapshotsRoot = join(root, 'snapshots')
    const kitsRoot = join(root, 'kits')
    const historical = kit('a'.repeat(64))
    const current = { ...kit('b'.repeat(64)), version: '2.0.0' }
    const stale = { ...kit('c'.repeat(64)), version: '0.9.0' }
    const historicalId = expertKitPresetId(historical, connectors)
    const staleId = expertKitPresetId(stale, connectors)
    await writeExpertKitPresetSnapshot(snapshotsRoot, { id: historicalId, kit: historical, connectors })
    await writeExpertKitPresetSnapshot(snapshotsRoot, { id: staleId, kit: stale, connectors })
    await Promise.all([historical, current, stale].map(async (entry) => {
      const generation = expertKitGenerationPath(kitsRoot, entry)
      await mkdir(generation, { recursive: true })
      await writeFile(join(generation, 'README.md'), entry.version, 'utf8')
    }))

    await pruneExpertKitPresetSnapshots(snapshotsRoot, new Set([historicalId]))
    await pruneExpertKitGenerations(kitsRoot, [historical, current])

    expect((await readExpertKitPresetSnapshots(snapshotsRoot)).snapshots.map(snapshot => snapshot.id))
      .toEqual([historicalId])
    expect((await readdir(join(kitsRoot, historical.id))).sort()).toEqual([
      historical.sha256, current.sha256,
    ].sort())
  })
})
