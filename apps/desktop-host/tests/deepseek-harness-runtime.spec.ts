import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply, expertKitPresetId, referencedExpertKitPresetIds, writeBoundedResponseBody,
  type DeepSeekHarnessRuntimeControl,
} from '../src/deepseek-harness-runtime.ts'
import { expertKitGenerationPath, type ExpertKitSnapshotEntry } from '../src/deepseek-harness-expert-kit-store.ts'

const roots: string[] = []

function asContext(value: object): Context {
  return value as Context
}

function asRuntimeConfig(value: object): Parameters<typeof apply>[1] {
  return value as Parameters<typeof apply>[1]
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
  tools: [{ name: `orders_${version}`, displayName: '查询订单', description: '读取订单', access: 'READ' }],
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

async function prepareSkill(home: string, skill: { id: string; sha256: string }): Promise<void> {
  const generation = join(home, 'deepseek-harness-product/skills', skill.sha256, skill.id)
  await mkdir(generation, { recursive: true })
  await writeFile(join(generation, 'SKILL.md'), `---\nname: ${skill.id}\ndescription: Fixture\n---\n`, 'utf8')
  await writeFile(join(generation, '.deepseek-harness-sha256'), `${skill.sha256}\n`, 'utf8')
}

function runtimeContext(
  sessionPresets: readonly string[],
  registrations: unknown[],
  failListing = false,
): Context {
  return asContext({
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
    effect: vi.fn(), on: vi.fn(), systemPrompt: { section: vi.fn() }, tools: { register: vi.fn() },
  })
}

async function mountRuntime(
  kit: ExpertKitSnapshotEntry,
  currentConnector: ReturnType<typeof connector>,
  sessionPresets: readonly string[],
  registrations: unknown[],
  failListing = false,
  calls?: string[],
): Promise<DeepSeekHarnessRuntimeControl> {
  const invoke = vi.fn(async (method: string): Promise<unknown> => {
    calls?.push(method)
    if (method === 'expertKits.get') return kit
    if (method === 'expertKits.list') return [kit]
    if (method === 'skills.list') return []
    if (method === 'connectors.list') return [currentConnector]
    throw new Error(`unexpected product method ${method}`)
  })
  let control: DeepSeekHarnessRuntimeControl | undefined
  await apply(runtimeContext(sessionPresets, registrations, failListing), asRuntimeConfig({
    product: { invoke }, publishControl: (value: DeepSeekHarnessRuntimeControl | undefined) => { control = value },
  }))
  if (control === undefined) throw new Error('runtime control was not published')
  return control
}

describe('DeepSeekHarness expert kit runtime snapshots', () => {
  it('registers an Expert Kit Preset only when a Session explicitly starts it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-runtime-home-'))
    roots.push(home)
    vi.stubEnv('DSH_HOME', home)
    const kit = expertKit('v1', 'a'.repeat(64))
    await prepareExpertKit(home, kit)
    const registrations: unknown[] = []

    const control = await mountRuntime(kit, connector('v1'), [], registrations)
    expect(registrations).toEqual([])
    const presetId = await control.prepareExpertKit({ id: kit.id, version: kit.version, sha256: kit.sha256 })

    expect(presetId).toMatch(/^deepseek-harness-expert-kit-[0-9a-f]{12}$/u)
    expect(registrations).toContainEqual(expect.objectContaining({ id: presetId, name: '订单专家' }))
  })

  it('coalesces concurrent preparation for the same immutable Expert Kit generation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-runtime-home-'))
    roots.push(home)
    vi.stubEnv('DSH_HOME', home)
    const kit = expertKit('v1', 'a'.repeat(64))
    await prepareExpertKit(home, kit)
    const calls: string[] = []
    const registrations: unknown[] = []
    const control = await mountRuntime(kit, connector('v1'), [], registrations, false, calls)
    calls.length = 0
    const content = { id: kit.id, version: kit.version, sha256: kit.sha256 }

    const [first, second] = await Promise.all([
      control.prepareExpertKit(content), control.prepareExpertKit(content),
    ])

    expect(second).toBe(first)
    expect(calls.filter(method => method === 'expertKits.get')).toHaveLength(1)
    expect(calls.filter(method => method === 'connectors.list')).toHaveLength(1)
    expect(registrations.filter(value => JSON.stringify(value).includes(first))).toHaveLength(1)
  })

  it('prepares a standalone Skill lazily and registers an immutable Preset', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-runtime-home-'))
    roots.push(home)
    vi.stubEnv('DSH_HOME', home)
    const skill = {
      id: 'document-insight', name: '文档洞察', version: '1.0.0', summary: '分析企业文档',
      connectorRefs: ['erp'], requiredTools: ['orders_v1'],
      knowledgeBaseRefs: ['organization:documents'], sha256: 'e'.repeat(64),
    }
    await prepareSkill(home, skill)
    const registrations: unknown[] = []
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'skills.get') return skill
      if (method === 'skills.list') return [skill]
      if (method === 'connectors.list') return [connector('v1')]
      if (method === 'expertKits.list') return []
      throw new Error(`unexpected product method ${method}`)
    })
    let control: DeepSeekHarnessRuntimeControl | undefined

    await apply(runtimeContext([], registrations), asRuntimeConfig({
      product: { invoke }, publishControl: (value: DeepSeekHarnessRuntimeControl | undefined) => { control = value },
    }))
    if (control === undefined) throw new Error('runtime control was not published')
    const presetId = await control.prepareSkill({ id: skill.id, version: skill.version, sha256: skill.sha256 })

    expect(presetId).toMatch(/^deepseek-harness-skill-[0-9a-f]{12}$/u)
    expect(invoke).not.toHaveBeenCalledWith('skills.artifact', expect.anything())
    expect(registrations).toContainEqual(expect.objectContaining({ id: presetId, name: skill.name }))
    expect(JSON.stringify(registrations)).toContain(join(home, 'deepseek-harness-product/skills', skill.sha256))
    expect(JSON.stringify(registrations)).toContain('@deepseek-ai/dsh-mcp-client')
    const snapshot = await readFile(join(home, 'deepseek-harness-product/skill-presets', `${presetId}.json`), 'utf8')
    expect(snapshot).toContain('orders_v1')
    expect(snapshot).toContain('organization:documents')

    const restartedRegistrations: unknown[] = []
    await apply(runtimeContext([presetId], restartedRegistrations), asRuntimeConfig({
      product: { invoke }, publishControl: () => undefined,
    }))
    expect(restartedRegistrations).toContainEqual(expect.objectContaining({ id: presetId, name: skill.name }))
  })

  it('coalesces concurrent preparation for the same immutable standalone Skill generation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-runtime-home-'))
    roots.push(home)
    vi.stubEnv('DSH_HOME', home)
    const skill = {
      id: 'document-insight', name: '文档洞察', version: '1.0.0', summary: '分析企业文档',
      connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [], sha256: 'e'.repeat(64),
    }
    await prepareSkill(home, skill)
    const calls: string[] = []
    const registrations: unknown[] = []
    const invoke = vi.fn(async (method: string): Promise<unknown> => {
      calls.push(method)
      if (method === 'skills.get') return skill
      if (method === 'skills.list') return [skill]
      if (method === 'connectors.list') return []
      if (method === 'expertKits.list') return []
      throw new Error(`unexpected product method ${method}`)
    })
    let control: DeepSeekHarnessRuntimeControl | undefined
    await apply(runtimeContext([], registrations), asRuntimeConfig({
      product: { invoke }, publishControl: (value: DeepSeekHarnessRuntimeControl | undefined) => { control = value },
    }))
    if (control === undefined) throw new Error('runtime control was not published')
    calls.length = 0
    const content = { id: skill.id, version: skill.version, sha256: skill.sha256 }

    const [first, second] = await Promise.all([control.prepareSkill(content), control.prepareSkill(content)])

    expect(second).toBe(first)
    expect(calls.filter(method => method === 'skills.get')).toHaveLength(1)
    expect(calls.filter(method => method === 'connectors.list')).toHaveLength(1)
    expect(registrations.filter(value => JSON.stringify(value).includes(first))).toHaveLength(1)
  })

  it('uses one kit identity, artifact generation, and connector policy deterministically', () => {
    const connectors = [{ id: 'erp', name: 'ERP', transport: 'streamable-http' as const,
      url: 'https://erp.example/mcp', arguments: [], toolNames: ['orders_read'], readOnlyTools: ['orders_read'] }]
    const first = expertKitPresetId({ id: 'orders', sha256: 'A'.repeat(64) }, connectors)
    expect(expertKitPresetId({ id: 'orders', sha256: 'a'.repeat(64) }, connectors)).toBe(first)
    expect(expertKitPresetId({ id: 'orders', sha256: 'c'.repeat(64) }, connectors)).not.toBe(first)
    expect(expertKitPresetId({ id: 'orders', sha256: 'A'.repeat(64) }, [
      { ...connectors[0]!, toolNames: ['orders_write'], readOnlyTools: [] },
    ])).not.toBe(first)
    expect(first).toMatch(/^deepseek-harness-expert-kit-[0-9a-f]{12}$/u)
  })

  it('rejects catalog identity drift before registering a Preset', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-runtime-home-'))
    roots.push(home)
    vi.stubEnv('DSH_HOME', home)
    const current = expertKit('v2', 'b'.repeat(64))
    const registrations: unknown[] = []
    const control = await mountRuntime(current, connector('v2'), [], registrations)

    await expect(control.prepareExpertKit({
      id: current.id, version: 'v1', sha256: 'a'.repeat(64),
    })).rejects.toThrow('catalog version changed before preparation')
    expect(registrations).toEqual([])
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
    const headerPreset = `deepseek-harness-expert-kit-${'a'.repeat(12)}`
    const projectedPreset = `deepseek-harness-expert-kit-${'b'.repeat(12)}`
    const ctx = asContext({ sessionQuery: {
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

  it('restores immutable Preset content with the current employee connector authorization', async () => {
    const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-runtime-home-'))
    roots.push(home)
    vi.stubEnv('DSH_HOME', home)
    const firstKit = expertKit('v1', 'a'.repeat(64))
    const secondKit = expertKit('v2', 'b'.repeat(64))
    const firstConnector = connector('v1')
    const secondConnector = connector('v2')
    const firstId = expertKitPresetId(firstKit, [{
      id: firstConnector.id, name: firstConnector.name, transport: firstConnector.transport,
      url: firstConnector.url, arguments: [], toolNames: firstConnector.toolNames,
      readOnlyTools: firstConnector.readOnlyTools,
    }])
    const secondId = expertKitPresetId(secondKit, [{
      id: secondConnector.id, name: secondConnector.name, transport: secondConnector.transport,
      url: secondConnector.url, arguments: [], toolNames: secondConnector.toolNames,
      readOnlyTools: secondConnector.readOnlyTools,
    }])
    await prepareExpertKit(home, firstKit)
    const firstControl = await mountRuntime(firstKit, firstConnector, [], [])
    await firstControl.prepareExpertKit({
      id: firstKit.id, version: firstKit.version, sha256: firstKit.sha256,
    })
    await prepareExpertKit(home, secondKit)
    const secondControl = await mountRuntime(secondKit, secondConnector, [firstId], [])
    await secondControl.prepareExpertKit({
      id: secondKit.id, version: secondKit.version, sha256: secondKit.sha256,
    })

    const restartedRegistrations: unknown[] = []
    await mountRuntime(secondKit, secondConnector, [firstId, secondId], restartedRegistrations)

    const serialized = new Map(restartedRegistrations.flatMap((value) => {
      if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string') return []
      return [[value.id, JSON.stringify(value)] as const]
    }))
    const firstGeneration = expertKitGenerationPath(join(home, 'deepseek-harness-product/expert-kits'), firstKit)
    const secondGeneration = expertKitGenerationPath(join(home, 'deepseek-harness-product/expert-kits'), secondKit)
    expect(serialized.get(firstId)).toContain(join(firstGeneration, 'README.md'))
    expect(serialized.get(firstId)).toContain('dsh-skill-filesystem')
    expect(serialized.get(firstId)).toContain(secondConnector.url)
    expect(serialized.get(firstId)).not.toContain(firstConnector.url)
    expect(serialized.get(firstId)).toContain('current')
    expect(serialized.get(secondId)).toContain(join(secondGeneration, 'README.md'))
    expect(serialized.get(secondId)).toContain('dsh-skill-filesystem')
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
