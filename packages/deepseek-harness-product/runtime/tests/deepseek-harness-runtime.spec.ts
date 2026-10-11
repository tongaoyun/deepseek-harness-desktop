import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { publicToolName } from '@deepseek-ai/dsh-mcp-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, writeBoundedResponseBody, type DeepSeekHarnessRuntimeControl } from '../src/runtime.ts'
import { expertKitGenerationPath, skillGenerationPath, type ExpertKitContent, type SkillContent } from '../src/content.ts'
import { connectorServerName } from '../src/deepseek-harness-connector-contract.ts'

const roots: string[] = []
const asContext = (value: object): Context => value as Context
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryPath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'product-runtime-'))
  roots.push(root)
  return join(root, name)
}

const kit: ExpertKitContent = {
  id: 'order-expert', name: 'Order expert', version: '1', summary: 'Review orders.',
  skillIds: ['order-query'], connectorRefs: ['erp'], requiredTools: ['base_tool', 'orders_read'],
  knowledgeBaseRefs: ['company:orders'], sha256: 'a'.repeat(64),
}
const skill: SkillContent = {
  id: 'order-query', name: 'Order query', version: '1', summary: 'Read orders.',
  connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [], sha256: 'b'.repeat(64),
}
const connector = {
  id: 'erp', name: 'ERP', status: 'ready', authMode: 'none', transport: 'streamable-http',
  url: 'https://erp.example/mcp', arguments: [], environment: {}, headers: { Authorization: 'current' },
  toolNames: ['orders_read'], readOnlyTools: ['orders_read'],
  tools: [{ name: 'orders_read', access: 'READ' }],
}

async function installFixtures(home: string): Promise<void> {
  const kitRoot = expertKitGenerationPath(join(home, 'product-capabilities-v1/expert-kits'), kit)
  const skillRoot = skillGenerationPath(join(home, 'product-capabilities-v1/skills'), skill)
  await mkdir(join(kitRoot, 'skills', 'order-query'), { recursive: true })
  await mkdir(skillRoot, { recursive: true })
  await writeFile(join(kitRoot, 'README.md'), '# Order expert\n\nReview order facts before acting.\n')
  const instructions = '---\nname: order-query\ndescription: Read orders.\n---\n# Order query\n\nCheck order details.\n'
  await writeFile(join(kitRoot, 'skills/order-query/SKILL.md'), instructions)
  await writeFile(join(skillRoot, 'SKILL.md'), instructions)
  await writeFile(join(kitRoot, '.deepseek-harness-sha256'), kit.sha256)
  await writeFile(join(skillRoot, '.deepseek-harness-sha256'), skill.sha256)
}

async function setup() {
  const home = await temporaryPath('home')
  vi.stubEnv('DSH_HOME', home)
  await installFixtures(home)
  let selected = 'minimal'
  const definitions = new Map<string, PresetDefinition>([
    ['minimal', { id: 'minimal', plugins: [{ id: 'minimal-only', name: 'base' }] }],
    ['ptc', { id: 'ptc', plugins: [{ id: 'ptc-only', name: 'ptc' }] }],
  ])
  const registered: string[] = []
  const derive = vi.fn((base: string, definition: PresetDefinition) => {
    const mode = definitions.get(base)
    if (mode === undefined) throw new Error(`Unknown mode: ${base}`)
    return { ...definition, plugins: [...mode.plugins, ...definition.plugins], resolutionBase: 'file:///profile/' }
  })
  const invoke = vi.fn(async (method: string, _payload?: unknown, _signal?: AbortSignal): Promise<unknown> => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee-1' }
    if (method === 'expertKits.get') return kit
    if (method === 'skills.get') return skill
    if (method === 'connectors.list') return [connector]
    if (method === 'knowledge.bases.list') return [{ id: 'orders', referenceKey: 'company:orders' }]
    throw new Error(`Unexpected product method: ${method}`)
  })
  const ctx = asContext({
    plugin: vi.fn(async () => undefined),
    agents: { list: () => [] },
    sessionProjections: { register: vi.fn() },
    get: vi.fn(() => undefined), logger: { warn: vi.fn() }, on: vi.fn(), effect: vi.fn(),
    agentPresets: {
      defaultId: 'minimal', derive, resolve: async (id: string) => definitions.get(id),
      register: vi.fn(async (definition: PresetDefinition) => {
        registered.push(definition.id)
        definitions.set(definition.id, definition)
        return async () => { definitions.delete(definition.id) }
      }),
      acquireScope: async (id: string) => ({ key: id, [Symbol.asyncDispose]: async () => {} }),
    },
    sessionQuery: {
      listSessions: async () => selected === 'minimal' ? [] : [{ header: { id: 'session', agentPreset: selected } }],
      observeSession: async () => ({ header: { agentPreset: selected },
        projections: { values: { agentPreset: selected } }, events: [], [Symbol.dispose]() {} }),
    },
    tools: { schemas: (id: string) => {
      const rows = definitions.get(id)?.plugins ?? []
      return [
        ...rows.some(row => row.id === 'minimal-only') ? [{ name: 'base_tool' }] : [],
        ...rows.some(row => row.name === '@deepseek-ai/dsh-mcp-client')
          ? [{ name: publicToolName(connectorServerName('erp'), 'orders_read') }] : [],
      ]
    } },
  })
  const mount = async () => {
    let control: DeepSeekHarnessRuntimeControl | undefined
    await apply(ctx, { product: { invoke },
      publishControl(value) { control = value } })
    if (control === undefined) throw new Error('Runtime control is unavailable')
    return control
  }
  const control = await mount()
  return { home, ctx, control, mount, invoke, derive, registered, definitions, select(id: string) { selected = id } }
}

describe('Product task composition', () => {
  it('keeps concurrent kit preparations independent when the first caller cancels', async () => {
    const f = await setup()
    await f.control.installExpertKit(kit.id)
    await rm(expertKitGenerationPath(join(f.home, 'product-capabilities-v1/expert-kits'), kit), { recursive: true })
    let artifactStarted!: () => void
    const started = new Promise<void>((resolve) => { artifactStarted = resolve })
    const original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async (method, payload, signal) => {
      if (method !== 'expertKits.artifact') return original(method, payload, signal)
      artifactStarted()
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const reason: unknown = signal.reason
          reject(reason instanceof Error ? reason : new Error('Kit preparation was cancelled'))
        }, { once: true })
      })
    })
    const controller = new AbortController()
    const first = f.control.prepareCapabilities({ expertKitId: kit.id }, controller.signal)
    const denied = expect(first).rejects.toThrow('cancel first caller')
    await started
    const second = f.control.prepareCapabilities({ expertKitId: kit.id })
    await installFixtures(f.home)
    controller.abort(new Error('cancel first caller'))
    await denied
    await expect(second).resolves.toMatchObject({ capabilities: { expertKit: { id: kit.id } } })
    expect(f.registered).toHaveLength(1)
  })

  it('rejects declared skills missing from the actual pinned kit artifact', async () => {
    const f = await setup()
    await f.control.installExpertKit(kit.id)
    await rm(join(expertKitGenerationPath(join(f.home, 'product-capabilities-v1/expert-kits'), kit), 'skills/order-query'), { recursive: true })
    const preparation = f.control.prepareCapabilities({ expertKitId: kit.id })
    await expect(preparation).rejects.toMatchObject({ code: 'KIT_SKILL_MISSING',
      resources: [{ kind: 'expert-kit', id: kit.id }, { kind: 'skill', id: 'order-query' }] })
    await expect(preparation).rejects.toHaveProperty('dependencyChecks', expect.arrayContaining([
      { kind: 'SKILL', reference: 'order-query', status: 'MISSING' },
      { kind: 'DATA_CONNECTION', reference: 'erp', status: 'NOT_CHECKED' },
    ]))
    expect(f.registered).toEqual([])
  })

  it('uses the main-process desktop version to reject incompatible kit preparation', async () => {
    const f = await setup()
    await f.control.installExpertKit(kit.id)
    const original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async method => method === 'expertKits.get' ? { ...kit, minimumDesktopVersion: '9.0.0' }
      : method === 'runtime.environment' ? { desktopVersion: '0.2.0' } : original(method))
    await expect(f.control.prepareCapabilities({ expertKitId: kit.id })).rejects.toMatchObject({ code: 'DESKTOP_VERSION_REQUIRED' })
    expect(f.registered).toEqual([])
  })

  it('starts without standard, eager content registrations, or catalog reads', async () => {
    const f = await setup()
    expect(f.registered).toEqual([])
    expect(f.derive).not.toHaveBeenCalled()
    expect(f.invoke).not.toHaveBeenCalled()
    expect(await f.control.readCapabilities({})).toMatchObject({ basePresetId: 'minimal' })
  })

  it('installs a skill independently of the kit task Preset', async () => {
    const f = await setup()
    await f.control.installSkill(skill.id)
    expect(f.registered).toEqual([])
    await f.control.installExpertKit(kit.id)
    const prepared = await f.control.prepareCapabilities({ expertKitId: kit.id })
    expect(f.registered).toEqual([prepared.presetId])
    expect(prepared.presetId).toMatch(/^product-task-[a-f0-9]{64}$/)
    expect(prepared.capabilities).toMatchObject({
      basePresetId: 'minimal', expertKit: { id: kit.id, sha256: kit.sha256 },
      skills: [], connectorIds: ['erp'], knowledgeBaseIds: ['orders'],
    })
    const definition = f.definitions.get(prepared.presetId)
    expect(definition?.plugins.map(row => row.name)).toEqual([
      'base', expect.stringContaining('expert-kit-readme'),
      expect.stringContaining('kit-skills'),
      'cordis:product-task-capabilities', '@deepseek-ai/dsh-mcp-client', expect.stringContaining('knowledge'),
    ])
    expect(f.derive.mock.calls.map(call => call[0])).toEqual(['minimal'])
    expect((await readdir(join(f.home, 'product-capabilities-v1'))).sort()).toEqual([
      'expert-kits', 'installed-expert-kits-v1', 'installed-skills-v1', 'skills', 'tasks-v1',
    ])
    const persisted = await readFile(join(f.home, 'product-capabilities-v1/tasks-v1', `${prepared.presetId}.json`), 'utf8')
    expect(persisted).not.toContain('Authorization')
  })

  it('coalesces content preparation and reuses an identical final task registration', async () => {
    const f = await setup()
    await f.control.installExpertKit(kit.id)
    const request = { expertKitId: kit.id }
    const [first, second] = await Promise.all([
      f.control.prepareCapabilities(request), f.control.prepareCapabilities(request),
    ])
    expect(second.presetId).toBe(first.presetId)
    expect(f.registered).toEqual([first.presetId])
  })

  it('checks required tools in the final mode and withdraws a failed composition', async () => {
    const f = await setup()
    await f.control.installExpertKit(kit.id)
    const first = await f.control.prepareCapabilities({ expertKitId: kit.id })
    f.select(first.presetId)
    await expect(f.control.prepareCapabilities({ sessionId: 'session', basePresetId: 'ptc' }))
      .rejects.toThrow('requires unavailable tools: base_tool')
    expect(await f.control.readCapabilities({ sessionId: 'session' })).toEqual(first.capabilities)
    expect([...f.definitions.keys()].filter(id => id.startsWith('product-task-'))).toEqual([first.presetId])
    expect((await readdir(join(f.home, 'product-capabilities-v1/tasks-v1'))).filter(name => name.endsWith('.json')))
      .toEqual([`${first.presetId}.json`])
  })

  it('restores pinned content without re-reading kit or skill catalogs', async () => {
    const f = await setup()
    await f.control.installExpertKit(kit.id)
    const first = await f.control.prepareCapabilities({ expertKitId: kit.id })
    await f.control.uninstallExpertKit(kit.id)
    f.select(first.presetId)
    f.invoke.mockClear()
    const restored = await f.mount()
    expect(await restored.readCapabilities({ sessionId: 'session' })).toEqual(first.capabilities)
    expect(f.invoke.mock.calls.map(call => call[0])).toEqual(['connectors.list'])
    expect([...f.definitions.keys()].filter(id => id.startsWith('product-task-'))).toEqual([first.presetId])
    expect(JSON.stringify(f.definitions.get(first.presetId))).toContain(kit.sha256)
  })

  it('rejects catalog identity changes before downloading and keeps the installed version', async () => {
    const f = await setup()
    const installed = await f.control.installExpertKit(kit.id)
    const invoke = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async (method, payload, signal) => method === 'expertKits.get'
      ? { ...kit, version: '2', sha256: 'c'.repeat(64) } : invoke(method, payload, signal))
    await expect(f.control.prepareCapabilities({ expertKitId: kit.id })).rejects.toMatchObject({
      code: 'KIT_INSTALLED_VERSION_CHANGED', resources: [{ kind: 'expert-kit', id: kit.id }],
    })
    expect(f.invoke.mock.calls.some(call => call[0] === 'expertKits.artifact')).toBe(false)
    expect(await f.control.readInstalledExpertKits()).toEqual({ installed: [installed] })
    expect(f.registered).toEqual([])
    expect(await readdir(join(f.home, 'product-capabilities-v1/tasks-v1'))).toEqual([])
  })

  it('rejects artifact identity drift before mounting any task', async () => {
    const f = await setup()
    const path = skillGenerationPath(join(f.home, 'product-capabilities-v1/skills'), skill)
    await rm(path, { recursive: true })
    f.invoke.mockImplementation(async (method) => {
      if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee-1' }
      if (method === 'skills.get') return skill
      if (method === 'skills.artifact') return { ...skill, version: '2', url: 'https://example.test/artifact' }
      throw new Error(`Unexpected product method: ${method}`)
    })
    await expect(f.control.installSkill(skill.id)).rejects.toThrow('artifact identity mismatch')
    expect(f.registered).toEqual([])
  })

  it('rejects a skill whose instruction identity differs from its catalog', async () => {
    const f = await setup()
    const path = skillGenerationPath(join(f.home, 'product-capabilities-v1/skills'), skill)
    await writeFile(join(path, 'SKILL.md'), '---\nname: different-skill\ndescription: Different\n---\n')
    await expect(f.control.installSkill(skill.id)).rejects.toThrow('no matching SKILL.md')
    expect(f.registered).toEqual([])
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

})
