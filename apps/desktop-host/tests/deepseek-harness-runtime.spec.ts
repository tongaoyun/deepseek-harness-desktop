import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply, enabledExpertKitPresetId, referencedExpertKitPresetIds, writeBoundedResponseBody,
} from '../src/deepseek-harness-runtime.ts'
import { expertKitGenerationPath, type ExpertKitSnapshotEntry } from '../src/deepseek-harness-expert-kit-store.ts'

const roots: string[] = []

function cast<T>(value: object): T {
  return value as T
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryPath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-harness-runtime-'))
  roots.push(root)
  return join(root, name)
}

const connector = (version: string) => ({
  id: 'erp', name: 'ERP', status: 'ready', authMode: 'none', transport: 'streamable-http' as const,
  url: `https://erp-${version}.example/mcp`, arguments: [], environment: {}, headers: { Authorization: 'current' },
  toolNames: [`orders_${version}`], readOnlyTools: [`orders_${version}`],
})

const expertKit = (version: string, sha256: string): ExpertKitSnapshotEntry => ({
  id: 'order-expert', name: '订单专家', version, summary: `${version} 订单能力`,
  skillIds: [`orders-${version}`], connectorRefs: ['erp'], requiredTools: [`orders_${version}`],
  knowledgeBaseRefs: [`organization/orders-${version}`], sha256,
})

async function prepareExpertKit(home: string, kit: ExpertKitSnapshotEntry): Promise<void> {
  const root = expertKitGenerationPath(join(home, 'deepseek-harness-product/expert-kits'), kit)
  await mkdir(join(root, 'skills', `orders-${kit.version}`), { recursive: true })
  await writeFile(join(root, 'README.md'), `# ${kit.version}\n`, 'utf8')
  await writeFile(join(root, 'skills', `orders-${kit.version}`, 'SKILL.md'), `# ${kit.version} skill\n`, 'utf8')
  await writeFile(join(root, '.deepseek-harness-sha256'), `${kit.sha256}\n`, 'utf8')
}

function runtimeContext(sessionPresets: readonly string[], registrations: unknown[], failListing = false): Context {
  return cast<Context>({
    plugin: vi.fn(async () => {}),
    agentPresets: {
      readDocument: vi.fn(async () => ({ content: '[]' })),
      register: vi.fn(async (definition: unknown) => { registrations.push(definition); return () => {} }),
      composedPreset: vi.fn(() => undefined),
    },
    sessionQuery: {
      listSessions: vi.fn(async () => {
        if (failListing) throw new Error('Session store unavailable')
        return sessionPresets.map((agentPreset, index) => ({
          header: { id: `session-${String(index)}`, agentPreset },
        }))
      }),
      observeSession: vi.fn(async (id: string) => {
        const index = Number(id.slice('session-'.length))
        return { projections: { values: { agentPreset: sessionPresets[index] } }, [Symbol.dispose]() {} }
      }),
    },
    settings: { update: vi.fn(async () => {}) },
    effect: vi.fn(), on: vi.fn(), systemPrompt: { section: vi.fn() }, tools: { register: vi.fn() },
  })
}

async function mountRuntime(
  kit: ExpertKitSnapshotEntry,
  currentConnector: ReturnType<typeof connector>,
  sessionPresets: readonly string[],
  registrations: unknown[],
  failListing = false,
): Promise<void> {
  const invoke = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'skills.list') return []
    if (method === 'expertKits.list') return [kit]
    if (method === 'connectors.list') return [currentConnector]
    if (method === 'expertKits.enablement.list') return [kit.id]
    throw new Error(`unexpected product method ${method}`)
  })
  await apply(runtimeContext(sessionPresets, registrations, failListing), cast<Parameters<typeof apply>[1]>({
    product: { invoke }, publishControl: vi.fn(),
  }))
}

describe('DeepSeekHarness expert kit runtime snapshots', () => {
  it('uses kit identities and artifact generations in a deterministic order', () => {
    const connectors = [{ id: 'erp', name: 'ERP', transport: 'streamable-http' as const,
      url: 'https://erp.example/mcp', arguments: [], toolNames: ['orders_read'], readOnlyTools: ['orders_read'] }]
    const first = enabledExpertKitPresetId([
      { id: 'orders', sha256: 'A'.repeat(64) },
      { id: 'fullstack', sha256: 'b'.repeat(64) },
    ], connectors)
    expect(enabledExpertKitPresetId([
      { id: 'fullstack', sha256: 'B'.repeat(64) },
      { id: 'orders', sha256: 'a'.repeat(64) },
    ], connectors)).toBe(first)
    expect(enabledExpertKitPresetId([
      { id: 'orders', sha256: 'c'.repeat(64) },
      { id: 'fullstack', sha256: 'b'.repeat(64) },
    ], connectors)).not.toBe(first)
    expect(enabledExpertKitPresetId([
      { id: 'orders', sha256: 'A'.repeat(64) },
      { id: 'fullstack', sha256: 'b'.repeat(64) },
    ], [{ ...connectors[0]!, toolNames: ['orders_write'], readOnlyTools: [] }])).not.toBe(first)
    expect(first).toMatch(/^deepseek-harness-enabled-[0-9a-f]{12}$/u)
  })

  it('streams an artifact to disk and returns its digest', async () => {
    const target = await temporaryPath('artifact.tar.gz')
    const bytes = new Uint8Array([1, 2, 3, 4])

    await expect(writeBoundedResponseBody(new Response(bytes), target, bytes.byteLength))
      .resolves.toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(new Uint8Array(await readFile(target))).toEqual(bytes)
  })

  it('cancels an oversized artifact stream and removes its partial file', async () => {
    const target = await temporaryPath('oversized.tar.gz')
    let offset = 0
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= 6) return
        controller.enqueue(new Uint8Array([offset, offset + 1, offset + 2]))
        offset += 3
      },
      cancel() { cancelled = true },
    }))

    await expect(writeBoundedResponseBody(response, target, 5)).rejects.toThrow('compressed size limit')
    expect(cancelled).toBe(true)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not remove an existing target when exclusive creation fails', async () => {
    const target = await temporaryPath('existing.tar.gz')
    await writeFile(target, 'existing', 'utf8')

    await expect(writeBoundedResponseBody(new Response('replacement'), target, 32))
      .rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(target, 'utf8')).toBe('existing')
  })

  it('reports incomplete Session inspection so cleanup cannot run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const headerPreset = `deepseek-harness-enabled-${'a'.repeat(12)}`
    const projectedPreset = `deepseek-harness-enabled-${'b'.repeat(12)}`
    const ctx = cast<Context>({ sessionQuery: {
      listSessions: vi.fn(async () => [
        { header: { id: 'readable', agentPreset: headerPreset } },
        { header: { id: 'broken' } },
      ]),
      observeSession: vi.fn(async (id: string) => {
        if (id === 'broken') throw new Error('unreadable')
        return { projections: { values: { agentPreset: projectedPreset } }, [Symbol.dispose]() {} }
      }),
    } })

    const result = await referencedExpertKitPresetIds(ctx)

    expect(result.complete).toBe(false)
    expect([...result.ids].sort()).toEqual([headerPreset, projectedPreset].sort())
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not inspect Session broken'), expect.any(Error))
  })

  it('restores distinct historical Presets after an Expert Kit upgrade and Host restart', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-runtime-home-'))
    roots.push(home)
    vi.stubEnv('DSH_HOME', home)
    const firstKit = expertKit('v1', 'a'.repeat(64))
    const secondKit = expertKit('v2', 'b'.repeat(64))
    const firstConnector = connector('v1')
    const secondConnector = connector('v2')
    const firstId = enabledExpertKitPresetId([firstKit], [{
      id: firstConnector.id, name: firstConnector.name, transport: firstConnector.transport,
      url: firstConnector.url, arguments: [], toolNames: firstConnector.toolNames,
      readOnlyTools: firstConnector.readOnlyTools,
    }])
    const secondId = enabledExpertKitPresetId([secondKit], [{
      id: secondConnector.id, name: secondConnector.name, transport: secondConnector.transport,
      url: secondConnector.url, arguments: [], toolNames: secondConnector.toolNames,
      readOnlyTools: secondConnector.readOnlyTools,
    }])
    await prepareExpertKit(home, firstKit)
    await mountRuntime(firstKit, firstConnector, [], [])
    await prepareExpertKit(home, secondKit)
    await mountRuntime(secondKit, secondConnector, [firstId], [])

    const restartedRegistrations: unknown[] = []
    await mountRuntime(secondKit, secondConnector, [firstId, secondId], restartedRegistrations)

    const serialized = new Map(restartedRegistrations.flatMap((value) => {
      if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string') return []
      return [[value.id, JSON.stringify(value)] as const]
    }))
    const firstGeneration = expertKitGenerationPath(join(home, 'deepseek-harness-product/expert-kits'), firstKit)
    const secondGeneration = expertKitGenerationPath(join(home, 'deepseek-harness-product/expert-kits'), secondKit)
    expect(serialized.get(firstId)).toContain(join(firstGeneration, 'README.md'))
    expect(serialized.get(firstId)).toContain(join(firstGeneration, 'skills'))
    expect(serialized.get(firstId)).toContain(firstConnector.url)
    expect(serialized.get(secondId)).toContain(join(secondGeneration, 'README.md'))
    expect(serialized.get(secondId)).toContain(join(secondGeneration, 'skills'))
    expect(serialized.get(secondId)).toContain(secondConnector.url)
    expect(await readFile(join(firstGeneration, 'README.md'), 'utf8')).toBe('# v1\n')
    expect(await readFile(join(secondGeneration, 'README.md'), 'utf8')).toBe('# v2\n')
    expect((await readdir(join(home, 'deepseek-harness-product/expert-kit-presets'))).sort())
      .toEqual([`${firstId}.json`, `${secondId}.json`].sort())
  })

  it('retains unreferenced generations when Session listing is incomplete', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-runtime-home-'))
    roots.push(home)
    vi.stubEnv('DSH_HOME', home)
    const oldKit = expertKit('v1', 'c'.repeat(64))
    const currentKit = expertKit('v2', 'd'.repeat(64))
    await prepareExpertKit(home, oldKit)
    await prepareExpertKit(home, currentKit)

    await mountRuntime(currentKit, connector('v2'), [], [], true)

    const oldGeneration = expertKitGenerationPath(join(home, 'deepseek-harness-product/expert-kits'), oldKit)
    expect(await readFile(join(oldGeneration, 'README.md'), 'utf8')).toBe('# v1\n')
    expect(warn).toHaveBeenCalledWith('deepseek-harness product: Expert Kit cleanup skipped because Session references were not fully inspected')
  })
})
