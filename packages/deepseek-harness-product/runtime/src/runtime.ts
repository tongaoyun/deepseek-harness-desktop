/** Product capabilities mounted on public Harness extension points. */

import { objectRecord, stringField, stringList } from './response-fields.ts'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { publicToolName } from '@deepseek-ai/dsh-mcp-client'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import type { ProductContentIdentity, ProductInstalledExpertKits, ProductInstalledSkills, ProductTaskCapabilityRequest, ProductTaskCapabilityResult, ProductTaskCapabilities } from '@deepseek-harness/product/protocol'
import { ProductError } from '@deepseek-harness/product/errors'
import { compareVersions } from '@deepseek-harness/product/catalog-manager'
import { ExpertKitCommonTaskSchema } from '@deepseek-harness/product/extension-draft'
import { z } from 'zod'
import { createTaskCapabilities, type TaskContent } from './tasks.ts'
import { createInstalledSkills } from './installed-skills.ts'
import { createInstalledExpertKits } from './installed-expert-kits.ts'
import { prepareProductContentStorage } from './content-retention.ts'
import * as ConversationAuthoring from './conversation-authoring.ts'
import * as KnowledgeLibrary from './knowledge-library.ts'
import * as tar from 'tar'
import type { DeepSeekHarnessProductIpc } from './deepseek-harness-product-ipc.ts'
import {
  connectorServerName,
  connectorToolPolicy,
  parseConnectorCatalog,
  type DeepSeekHarnessConnector as Connector,
} from './deepseek-harness-connector-contract.ts'
import { expertKitGenerationPath, skillGenerationPath, type ExpertKitContent, type SkillContent } from './content.ts'

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 2_048
// Preset trees resolve from the dsh profile, not from this private Host package's
// dependency scope. Resolve the product plugin while the Host dependency graph
// is authoritative, then give Loader the exact immutable module URL.
const EXPERT_KIT_README_PLUGIN = import.meta.resolve('@deepseek-harness/product-expert-kit-readme')
const KIT_SKILLS_PLUGIN = import.meta.resolve('@deepseek-harness/product-runtime/kit-skills')
const KNOWLEDGE_PLUGIN = import.meta.resolve('@deepseek-harness/product-runtime/knowledge')

export const inject = ['agentPresets', 'agents', 'sessionQuery', 'sessionProjections', 'skills', 'systemPrompt', 'tools']

/** Live product controls published to the private Desktop Host IPC boundary. */
export interface DeepSeekHarnessRuntimeControl {
  readCapabilities(request: ProductTaskCapabilityRequest, signal?: AbortSignal): Promise<ProductTaskCapabilities>
  prepareCapabilities(request: ProductTaskCapabilityRequest, signal?: AbortSignal): Promise<ProductTaskCapabilityResult>
  installSkill(id: string, signal?: AbortSignal): Promise<ProductContentIdentity>
  uninstallSkill(id: string, signal?: AbortSignal): Promise<{ id: string }>
  readInstalledSkills(sessionId?: string, signal?: AbortSignal): Promise<ProductInstalledSkills>
  installExpertKit(id: string, signal?: AbortSignal): Promise<ProductContentIdentity>
  uninstallExpertKit(id: string, signal?: AbortSignal): Promise<{ id: string }>
  readInstalledExpertKits(signal?: AbortSignal): Promise<ProductInstalledExpertKits>
}

/** Runtime dependencies supplied by the private Desktop Host. */
export interface Config {
  /** Credential-owning main-process bridge exposed through private IPC. */
  readonly product: Pick<DeepSeekHarnessProductIpc, 'invoke'>
  /** Publish controls only after the product runtime has finished mounting. */
  readonly publishControl: (control: DeepSeekHarnessRuntimeControl | undefined) => void
}

type ExpertKit = ExpertKitContent

type Skill = SkillContent

interface InstalledExpertKit {
  readonly kit: ExpertKit
  readonly readmePath: string
  readonly skillDirectory?: string
}

interface Artifact {
  readonly id: string
  readonly version: string
  readonly sha256: string
  readonly url: string
}

/** Mount product Skill, Preset, MCP and knowledge capabilities into Harness. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(ConversationAuthoring, { product: config.product })
  await ctx.plugin(KnowledgeLibrary, { product: config.product })
  const root = join(resolveDshHome(), 'product-capabilities-v1')
  const skillsRoot = join(root, 'skills')
  const kitsRoot = join(root, 'expert-kits')
  await Promise.all([mkdir(skillsRoot, { recursive: true }), mkdir(kitsRoot, { recursive: true })])
  await prepareProductContentStorage(root, (message) => { ctx.logger.warn(message) }, async () => {
    const files = new Set<string>()
    const required = new Set<string>()
    const retainPreset = (id: string | undefined) => {
      if (!id?.startsWith('product-task-')) return
      if (!/^product-task-[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid recorded product task identity')
      const path = join(root, 'tasks-v1', `${id}.json`)
      files.add(path)
      required.add(path)
    }
    for (const session of await ctx.sessionQuery.listSessions()) {
      const key = createHash('sha256').update(session.header.id).digest('hex')
      const skills = join(root, 'installed-skills-v1', `session-${key}.json`)
      files.add(skills)
      retainPreset(session.header.agentPreset)
      using observation = await ctx.sessionQuery.observeSession(session.header.id)
      retainPreset(observation.header.agentPreset)
      const selected = observation.projections?.values.agentPreset
      if (typeof selected === 'string') retainPreset(selected)
      for (const event of observation.events) {
        if (event.type === 'agent-preset/selected') retainPreset(event.data.agentPreset)
        if (event.type === 'user/message' && event.data.source.kind === 'product-installed-skills') {
          required.add(skills)
        }
      }
    }
    return { retainedFiles: files, requiredFiles: required }
  })
  const connectorsByPreset = new Map<string, readonly Connector[]>()
  const connectorsByAgent = new Map<Agent, readonly Connector[]>()
  installConnectorPolicy(ctx, connectorsByPreset, connectorsByAgent, config.product)
  const content = async (id: string, signal?: AbortSignal, installedIdentity?: ProductContentIdentity,
    taskId?: string): Promise<TaskContent> => {
    validateProductId(id)
    const catalog = expertKitCatalog([await config.product.invoke('expertKits.get', { id }, signal)])[0]
    if (catalog === undefined || catalog.id !== id) throw new Error(`Selected kit is unavailable: ${id}`)
    validateContentIdentity(catalog)
    if (installedIdentity !== undefined
      && (catalog.version !== installedIdentity.version || catalog.sha256 !== installedIdentity.sha256)) {
      throw new ProductError('KIT_INSTALLED_VERSION_CHANGED', 'Install the current expert kit version before selecting it', false,
        [{ kind: 'expert-kit', id }])
    }
    const minimum = catalog.minimumDesktopVersion
    const checks: ProductTaskCapabilityResult['dependencyChecks'][number][] = [
      ...minimum === undefined ? [] : [{ kind: 'DESKTOP_VERSION' as const, reference: minimum, status: 'NOT_CHECKED' as const }],
      ...catalog.skillIds.map(reference => ({ kind: 'SKILL' as const, reference, status: 'NOT_CHECKED' as const })),
      ...catalog.connectorRefs.map(reference => ({ kind: 'DATA_CONNECTION' as const, reference, status: 'NOT_CHECKED' as const })),
      ...catalog.requiredTools.map(reference => ({ kind: 'TOOL' as const, reference, status: 'NOT_CHECKED' as const })),
      ...catalog.knowledgeBaseRefs.map(reference => ({ kind: 'KNOWLEDGE_BASE' as const, reference, status: 'NOT_CHECKED' as const })),
    ]
    if (minimum !== undefined) {
      const environment = objectRecord(await config.product.invoke('runtime.environment', undefined, signal), 'runtime environment')
      if (typeof environment.desktopVersion !== 'string' || compareVersions(environment.desktopVersion, minimum) < 0) {
        checks[0] = { kind: 'DESKTOP_VERSION', reference: minimum, status: 'INCOMPATIBLE' }
        throw new ProductError('DESKTOP_VERSION_REQUIRED', `This kit requires desktop ${minimum}`, false,
          [{ kind: 'expert-kit', id }], { dependencyChecks: checks })
      }
      checks[0] = { kind: 'DESKTOP_VERSION', reference: minimum, status: 'READY' }
    }
    signal?.throwIfAborted()
    const identity = { id: catalog.id, name: catalog.name, version: catalog.version, sha256: catalog.sha256 }
    const dependencies = { identity, connectorRefs: catalog.connectorRefs,
      knowledgeBaseRefs: catalog.knowledgeBaseRefs, requiredTools: catalog.requiredTools }
    await installExpertKitArtifact(config.product, catalog, kitsRoot, signal)
    const installed = await installedExpertKit(catalog, kitsRoot)
    let shortcut: TaskContent['shortcut']
    if (taskId !== undefined) {
      const path = join(dirname(installed.readmePath), '.deepseek-harness-kit/kit.json')
      try {
        if ((await stat(path)).size > 256 * 1024) throw new Error('Kit manifest exceeds the size limit')
        const manifest = objectRecord(JSON.parse(await readFile(path, { encoding: 'utf8', signal })), 'kit manifest')
        if (manifest.id !== catalog.id || manifest.version !== catalog.version) throw new Error('Kit manifest identity mismatch')
        const tasks = z.array(ExpertKitCommonTaskSchema).max(12).parse(manifest.commonTasks)
        shortcut = tasks.find(task => task.id === taskId)
        if (new Set(tasks.map(task => task.id)).size !== tasks.length || shortcut === undefined
          || shortcut.skillIds.some(name => !catalog.skillIds.includes(name))) throw new Error('Invalid shortcut skill binding')
      } catch (error) {
        signal?.throwIfAborted()
        throw new ProductError('KIT_TASK_INVALID', 'Install a kit version with valid shortcut skill bindings', false,
          [{ kind: 'expert-kit', id }, { kind: 'kit-task', id: taskId }], { cause: error })
      }
    }
    const lifecycle = new AbortController()
    const provider = new FileSystemSkillProvider(ctx, { signal: lifecycle.signal, invalidate: () => undefined }, {
      providerName: 'product-kit-validation', includeDefaultRoots: false,
      customSkillDirs: installed.skillDirectory === undefined ? [] : [installed.skillDirectory], watch: false,
    })
    try {
      const listed = await provider.list({ signal })
      const candidates = Array.isArray(listed) ? listed : listed.candidates
      for (const [index, check] of checks.entries()) {
        if (check.kind !== 'SKILL') continue
        const skillId = check.reference
        const candidate = candidates.find(value => value.name === skillId)
        const valid = candidate !== undefined && await provider.get(candidate, { signal }) !== undefined
        checks[index] = { ...check, status: valid ? 'READY' : 'MISSING' }
      }
    } finally { lifecycle.abort(); await provider.dispose() }
    const missing = checks.filter(check => check.status === 'MISSING')
    if (missing.length > 0) throw new ProductError('KIT_SKILL_MISSING', `Kit ${id} has invalid packaged skills`, false,
      [{ kind: 'expert-kit', id }, ...missing.map(check => ({ kind: 'skill', id: check.reference }))], { dependencyChecks: checks })
    return { ...dependencies, dependencyChecks: checks, ...shortcut === undefined ? {} : { shortcut },
      plugins: expertKitPlugins(installed, shortcut?.skillIds) }
  }
  const installedKits = createInstalledExpertKits(ctx, {
    root: join(root, 'installed-expert-kits-v1'), product: config.product, prepare: content,
  })
  const tasks = await createTaskCapabilities(ctx, {
    root: join(root, 'tasks-v1'), content: (_kind, id, signal, taskId) => installedKits.prepare(id, signal, taskId),
    authorizeKit: async (id, signal) => { await config.product.invoke('expertKits.get', { id }, signal) },
    visibleKnowledge: async (signal) => {
      const catalog = await config.product.invoke('knowledge.bases.list', undefined, signal)
      if (!Array.isArray(catalog)) throw new Error('Invalid knowledge catalog')
      return catalog.map(row => stringField(objectRecord(row, 'knowledge base'), 'id'))
    },
    async connectors(ids, signal) { return parseConnectorCatalog(await config.product.invoke('connectors.list', { ids }, signal)) },
    connectorPlugin, knowledgePlugins,
    async validateKnowledge(ids, refs, signal) {
      if (ids.length === 0 && refs.length === 0) return []
      const value = await config.product.invoke('knowledge.bases.list', undefined, signal)
      if (!Array.isArray(value)) throw new Error('Invalid knowledge catalog')
      const visible = new Set(value.flatMap((entry) => {
        const record = objectRecord(entry, 'knowledge base')
        return [record.id, record.referenceKey, record.reference].filter((item): item is string => typeof item === 'string')
      }))
      if ([...ids, ...refs].some(id => !visible.has(id))) throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Selected knowledge is unavailable', false, [...ids, ...refs].filter(id => !visible.has(id)).map(id => ({ kind: 'knowledge-base', id })))
      return [...new Set([...ids, ...refs.map((reference) => {
        const record = value.map(entry => objectRecord(entry, 'knowledge base'))
          .find(entry => [entry.id, entry.referenceKey, entry.reference].includes(reference))
        if (value.map(entry => objectRecord(entry, 'knowledge base')).filter(entry => [entry.id, entry.referenceKey, entry.reference].includes(reference)).length !== 1) throw new ProductError('KNOWLEDGE_REFERENCE_AMBIGUOUS', `Select a fixed knowledge base ID for ${reference}`)
        if (record === undefined || typeof record.id !== 'string') throw new Error('Knowledge reference cannot be resolved')
        return record.id
      })])]
    },
    async register(definition, selectedConnectors) {
      const unregister = await ctx.agentPresets.register(definition)
      connectorsByPreset.set(definition.id, selectedConnectors)
      let disposed = false
      const dispose = async () => {
        if (disposed) return
        disposed = true
        connectorsByPreset.delete(definition.id)
        await unregister()
      }
      ctx.effect(() => dispose, `product-task.preset.${definition.id}`)
      return dispose
    },
    validateTools: (presetId, tools) => validateRequiredTools(ctx, presetId, tools, connectorsByPreset.get(presetId) ?? []),
  })
  ctx.on('agent-preset/resolve-selection', async (agent, _requested, next) => tasks.resolveSelection(agent.session.id, await next()))
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const capabilities = await tasks.read({ sessionId: agent.session.id })
    if (capabilities.unavailable !== undefined) {
      const failure = capabilities.unavailable
      throw new ProductError(failure.code, failure.message, failure.retryable, failure.resources)
    }
    await tasks.validate(ctx.agentPresets.composedPreset(agent.ctx), signal)
    return decision
  })
  const installedSkills = createInstalledSkills(ctx, {
    root: join(root, 'installed-skills-v1'), product: config.product, parse: skillCatalog,
    load: skill => loadMarketSkill(ctx, skillsRoot, skill),
    install: (skill, signal) => installSkillArtifact(config.product, skill, skillsRoot, signal).then(() => undefined),
    capabilities: sessionId => tasks.read({ sessionId }),
    connectors: async (ids, signal) => parseConnectorCatalog(await config.product.invoke('connectors.list', { ids }, signal)),
    async mountConnectors(agent, connectors, signal) {
      const preset = ctx.agentPresets.composedPreset(agent.ctx)
      const inherited = preset === undefined ? [] : connectorsByPreset.get(preset) ?? []
      const selected = connectors.filter(connector => !inherited.some(value => value.id === connector.id))
      if (selected.length === 0) return async () => {}
      const fiber = agent.ctx.plugin({
        name: 'product-skill-connectors',
        async apply(owner: Context) {
          connectorsByAgent.set(agent, selected)
          owner.effect(() => () => { connectorsByAgent.delete(agent) }, 'product-skill-connectors.policy')
          for (const connector of selected) {
            await owner.plugin({ name: McpClient.name, inject: McpClient.inject, apply: McpClient.apply }, connectorConfig(connector))
          }
        },
      })
      const abort = () => {
        void fiber.dispose().catch((error: unknown) => { ctx.logger.warn(`Skill connector disposal failed: ${String(error)}`) })
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      try { await fiber; signal?.throwIfAborted() }
      catch (error) { await fiber.dispose(); throw error }
      finally { signal?.removeEventListener('abort', abort) }
      return () => fiber.dispose()
    },
  })
  config.publishControl({
    readCapabilities: request => tasks.read(request),
    prepareCapabilities: (request, signal) => tasks.prepare(request, signal),
    installSkill: (id, signal) => installedSkills.install(id, signal),
    uninstallSkill: (id, signal) => installedSkills.uninstall(id, signal),
    readInstalledSkills: (sessionId, signal) => installedSkills.read(sessionId, signal),
    installExpertKit: (id, signal) => installedKits.install(id, signal),
    uninstallExpertKit: (id, signal) => installedKits.uninstall(id, signal),
    readInstalledExpertKits: signal => installedKits.read(signal),
  })
  ctx.effect(() => () => { config.publishControl(undefined) }, 'deepseek-harness-product.runtime-control')
}

/** Capability rows contain product providers only; the task owns its base mode and dependencies. */
function expertKitPlugins(selected: InstalledExpertKit, initialSkillIds: readonly string[] = []): PresetDefinition['plugins'] {
  const key = `${selected.kit.id}-${selected.kit.sha256.toLowerCase()}`
  return [{
    id: `product-kit-readme-${key}`, name: EXPERT_KIT_README_PLUGIN,
    config: { expertKitId: selected.kit.id, initialSkillIds, skillProviderName: `product-kit-${key}`,
      entries: [{ name: `expert-kit-${selected.kit.id}`, description: selected.kit.summary, path: selected.readmePath }] },
  }, ...selected.skillDirectory === undefined ? [] : [{
    id: `product-kit-skills-${key}`, name: KIT_SKILLS_PLUGIN,
    config: { expertKitId: selected.kit.id, providerName: `product-kit-${key}`, directory: selected.skillDirectory },
  }]]
}

function knowledgePlugins(refs: readonly string[], ids: readonly string[] = []): PresetDefinition['plugins'] {
  return refs.length === 0 && ids.length === 0 ? [] : [{
    id: 'product-knowledge', name: KNOWLEDGE_PLUGIN,
    config: { knowledgeBaseRefs: refs, knowledgeBaseIds: ids },
  }]
}

async function validateRequiredTools(
  ctx: Context, presetId: string, requiredTools: readonly string[], connectors: readonly Connector[],
): Promise<void> {
  if (requiredTools.length === 0) return
  await using preset = await ctx.agentPresets.acquireScope(presetId)
  const available = new Set(ctx.tools.schemas(preset.key).map(tool => tool.name))
  const missing = requiredTools.filter(tool => !available.has(tool)
    && !connectors.some(connector => connector.toolNames.includes(tool)
      && available.has(publicToolName(connectorServerName(connector.id), tool))))
  if (missing.length > 0) throw new ProductError('KIT_TOOL_MISSING', `Task requires unavailable tools: ${missing.join(', ')}`, false,
    missing.map(id => ({ kind: 'tool', id })))
}

async function loadMarketSkill(
  ctx: Context,
  skillsRoot: string,
  skill: Skill,
): Promise<SkillDefinition> {
  const directory = skillGenerationPath(skillsRoot, skill)
  const lifecycle = new AbortController()
  const providerName = `deepseek-harness-market-${skill.id}-${skill.sha256.slice(0, 12)}`
  const provider = new FileSystemSkillProvider(ctx, {
    signal: lifecycle.signal,
    invalidate: () => undefined,
  }, {
    providerName,
    includeDefaultRoots: false,
    customSkillDirs: [dirname(directory)],
    watch: false,
  })
  try {
    const listed = await provider.list({})
    const candidates = Array.isArray(listed) ? listed : listed.candidates
    const candidate = candidates.find(value => value.name === skill.id)
    if (candidate === undefined) {
      throw new Error(`deepseek-harness product: Skill ${skill.id} artifact has no matching SKILL.md`)
    }
    const definition = await provider.get(candidate, {})
    if (definition === undefined || definition.name !== skill.id) {
      throw new Error(`deepseek-harness product: Skill ${skill.id} artifact identity does not match its catalog id`)
    }
    return definition
  } finally {
    lifecycle.abort()
    await provider.dispose()
  }
}


function connectorPlugin(connector: Connector): PresetDefinition['plugins'][number] {
  return { id: `deepseek-harness-mcp-${connectorServerName(connector.id)}`,
    name: '@deepseek-ai/dsh-mcp-client', config: connectorConfig(connector) }
}

function connectorConfig(connector: Connector): McpClient.Config {
  const serverName = connectorServerName(connector.id)
  if (connector.transport === 'streamable-http') {
    if (connector.url === undefined) throw new Error(`deepseek-harness product: connector ${connector.id} has no URL`)
    return {
      transport: 'streamable-http', serverName, url: connector.url, headers: { ...connector.headers },
      toolCallTimeoutMs: connector.timeoutSeconds * 1000, failOnStartupError: true,
    }
  }
  if (connector.command === undefined) throw new Error(`deepseek-harness product: connector ${connector.id} has no command`)
  return {
    transport: 'stdio', serverName, command: connector.command, args: [...connector.arguments],
    env: { ...connector.environment }, cwd: '', toolCallTimeoutMs: connector.timeoutSeconds * 1000, failOnStartupError: true,
  }
}

function installConnectorPolicy(
  ctx: Context,
  connectorsByPreset: ReadonlyMap<string, readonly Connector[]>,
  connectorsByAgent: ReadonlyMap<Agent, readonly Connector[]>,
  product: Config['product'],
): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const preset = exec.agent === undefined ? undefined : ctx.agentPresets.composedPreset(exec.agent.ctx)
    const connectors = [...preset === undefined ? [] : connectorsByPreset.get(preset) ?? [],
      ...exec.agent === undefined ? [] : connectorsByAgent.get(exec.agent) ?? []]
    const policy = connectorToolPolicy(connectors, exec.name)
    if (policy === 'unrelated') return next()
    const connector = connectors.find(value => connectorToolPolicy([value], exec.name) !== 'unrelated')
    if (connector === undefined) return { kind: 'deny' as const, reason: 'Connector definition is missing.' }
    const live = parseConnectorCatalog(await product.invoke('connectors.list', { ids: [connector.id] }, exec.signal))
    const current = live.find(value => value.id === connector.id && value.transport === connector.transport)
    if (current === undefined) {
      return { kind: 'deny' as const, reason: 'This connector authorization is unavailable.' }
    }
    if (current.version !== connector.version) return { kind: 'deny' as const,
      reason: 'This connector configuration changed. Start a new task to use the updated connector.' }
    const livePolicy = connectorToolPolicy([current], exec.name)
    if (policy === 'undeclared' || livePolicy === 'undeclared' || livePolicy === 'unrelated') return { kind: 'deny' as const,
      reason: 'This connector tool is not declared in the enterprise catalog.' }
    if (policy === 'read-only' && livePolicy === 'read-only') return next()
    if (policy === 'write' || livePolicy === 'write') {
      return Promise.resolve({
        kind: 'ask' as const,
        reason: 'The enterprise connector operation may change business data.',
        displayReason: {
          en: 'Allow this enterprise connector to change business data?',
          'zh-CN': '允许这个企业连接器修改业务数据吗？',
        },
      })
    }
    return Promise.resolve({ kind: 'deny' as const,
      reason: 'This connector tool is not declared in the enterprise catalog.' })
  })
}

async function installSkillArtifact(
  product: Config['product'],
  catalog: Skill,
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  validateProductId(catalog.id)
  validateSha256(catalog.sha256)
  const generation = resolve(root, catalog.sha256.toLowerCase())
  assertChild(root, generation)
  const target = resolve(generation, catalog.id)
  assertChild(generation, target)
  await installArtifactAt(product, 'skills.artifact', catalog, root, target, signal)
  return generation
}

async function installExpertKitArtifact(
  product: Config['product'],
  catalog: ExpertKit,
  parent: string,
  signal?: AbortSignal,
): Promise<string> {
  const target = expertKitGenerationPath(parent, catalog)
  return await installArtifactAt(product, 'expertKits.artifact', catalog, parent, target, signal)
}

async function installArtifactAt(
  product: Config['product'],
  method: 'skills.artifact' | 'expertKits.artifact',
  catalog: Pick<Skill, 'id' | 'version' | 'sha256'>,
  containmentRoot: string,
  target: string,
  signal?: AbortSignal,
): Promise<string> {
  assertChild(containmentRoot, target)
  if (await installedSha(target) === catalog.sha256.toLowerCase()) return target
  const artifact = artifactResponse(await product.invoke(method, { id: catalog.id }, signal))
  if (artifact.id !== catalog.id || artifact.version !== catalog.version
    || artifact.sha256.toLowerCase() !== catalog.sha256.toLowerCase()) {
    throw new Error(`deepseek-harness product: artifact identity mismatch for ${catalog.id}`)
  }
  const stage = `${target}.installing-${process.pid}-${Date.now().toString(36)}`
  assertChild(containmentRoot, stage)
  await mkdir(dirname(target), { recursive: true })
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  try {
    const archivePath = join(stage, '.deepseek-harness-package.tar.gz')
    const actual = await downloadArtifact(artifact.url, archivePath, signal)
    if (actual !== catalog.sha256.toLowerCase()) throw new Error(`deepseek-harness product: SHA-256 mismatch for ${catalog.id}`)
    await extractArtifact(archivePath, stage)
    await writeFile(join(stage, '.deepseek-harness-sha256'), `${actual}\n`, { encoding: 'utf8', mode: 0o600 })
    signal?.throwIfAborted()
    // Immutable generations are never removed while Sessions may reference them.
    if (await isDirectory(target)) throw new ProductError('CONTENT_GENERATION_INVALID', 'Existing pinned content needs explicit recovery')
    await rename(stage, target)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
  return target
}

async function installedExpertKit(
  kit: ExpertKit,
  kitsRoot: string,
): Promise<InstalledExpertKit> {
  const kitRoot = expertKitGenerationPath(kitsRoot, kit)
  if (!await isDirectory(kitRoot) || await installedSha(kitRoot) !== kit.sha256.toLowerCase()) {
    throw new Error(`expert kit generation is not installed: ${kit.id}@${kit.sha256}`)
  }
  const kitSkills = join(kitRoot, 'skills')
  const hasKitSkills = await isDirectory(kitSkills)
  return {
    kit,
    readmePath: await expertKitReadmePath(kitRoot),
    ...(hasKitSkills ? { skillDirectory: kitSkills } : {}),
  }
}

async function expertKitReadmePath(root: string): Promise<string> {
  for (const name of ['README.md', 'readme.md']) {
    const path = join(root, name)
    if (await isFile(path)) return path
  }
  throw new Error(`deepseek-harness product: expert kit has no README.md: ${root}`)
}

async function downloadArtifact(urlText: string, target: string, signal?: AbortSignal): Promise<string> {
  const url = new URL(urlText)
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
    throw new Error('deepseek-harness product: artifact URL is invalid')
  }
  const response = await fetch(url, { signal: signal === undefined ? AbortSignal.timeout(60_000) : AbortSignal.any([signal, AbortSignal.timeout(60_000)]), redirect: 'error' })
  if (!response.ok) throw new Error(`deepseek-harness product: artifact download failed with HTTP ${String(response.status)}`)
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTIFACT_BYTES) {
    throw new Error('deepseek-harness product: artifact exceeds the compressed size limit')
  }
  return await writeBoundedResponseBody(response, target, MAX_ARTIFACT_BYTES)
}

/** Stream one response to disk while enforcing its complete byte limit and computing SHA-256. */
export async function writeBoundedResponseBody(
  response: Response,
  target: string,
  maximumBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('deepseek-harness product: invalid artifact size limit')
  if (response.body === null) throw new Error('deepseek-harness product: artifact response has no body')
  const reader = response.body.getReader()
  let file: Awaited<ReturnType<typeof open>> | undefined
  const hash = createHash('sha256')
  let received = 0
  let created = false
  let completed = false
  try {
    file = await open(target, 'wx', 0o600)
    created = true
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value.byteLength
      if (received > maximumBytes) {
        throw new Error('deepseek-harness product: artifact exceeds the compressed size limit')
      }
      hash.update(chunk.value)
      let offset = 0
      while (offset < chunk.value.byteLength) {
        const result = await file.write(chunk.value, offset, chunk.value.byteLength - offset)
        if (result.bytesWritten === 0) throw new Error('deepseek-harness product: artifact download made no write progress')
        offset += result.bytesWritten
      }
    }
    completed = true
    return hash.digest('hex')
  } finally {
    if (!completed) {
      try { await reader.cancel('artifact download did not complete') }
      catch (cancelError) { console.warn('deepseek-harness product: could not cancel artifact response', cancelError) }
    }
    reader.releaseLock()
    try { await file?.close() }
    finally { if (!completed && created) await rm(target, { force: true }) }
  }
}

async function extractArtifact(archivePath: string, target: string): Promise<void> {
  let entries = 0
  let extractedBytes = 0
  try {
    await tar.x({
      cwd: target,
      file: archivePath,
      gzip: true,
      strict: true,
      preservePaths: false,
      filter: (path, entry) => {
        const supportedType = 'type' in entry
          ? entry.type === 'File' || entry.type === 'Directory'
          : entry.isFile() || entry.isDirectory()
        if (!safeArchivePath(path) || !supportedType) {
          throw new Error(`deepseek-harness product: unsafe archive entry ${path}`)
        }
        entries += 1
        extractedBytes += entry.size
        if (entries > MAX_ARCHIVE_ENTRIES || extractedBytes > MAX_EXTRACTED_BYTES) {
          throw new Error('deepseek-harness product: artifact exceeds extraction limits')
        }
        return true
      },
    })
  } finally {
    await rm(archivePath, { force: true })
  }
}

function safeArchivePath(value: string): boolean {
  const path = value.replaceAll('\\', '/')
  if (path.includes('\0') || posix.isAbsolute(path) || isAbsolute(value)) return false
  const segments = path.split('/').filter(segment => segment !== '' && segment !== '.')
  return segments.length > 0 && segments.every(segment => segment !== '..')
}

function assertChild(parent: string, child: string): void {
  const prefix = resolve(parent) + sep
  if (!resolve(child).startsWith(prefix)) throw new Error('deepseek-harness product: install path escaped its product root')
}

async function installedSha(target: string): Promise<string | undefined> {
  try { return (await readFile(join(target, '.deepseek-harness-sha256'), 'utf8')).trim().toLowerCase() }
  catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw error
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() }
  catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  }
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() }
  catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function validateProductId(id: string): void {
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(id)) throw new Error(`deepseek-harness product: invalid product id ${id}`)
}

function validateSha256(value: string): void {
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('deepseek-harness product: invalid artifact SHA-256')
}

function validateContentIdentity(content: ProductContentIdentity): void {
  validateProductId(content.id)
  if (content.version === '' || content.version.length > 128) {
    throw new Error('deepseek-harness product: invalid content version')
  }
  validateSha256(content.sha256)
}

function expertKitCatalog(value: unknown): ExpertKit[] {
  if (!Array.isArray(value)) throw new Error('deepseek-harness product: invalid expert kit catalog')
  return value.map((entry) => {
    const record = objectRecord(entry, 'expert kit')
    return {
      id: stringField(record, 'id'), name: stringField(record, 'name'), version: stringField(record, 'version'),
      summary: stringField(record, 'summary'), skillIds: stringList(record.skillIds, 'skillIds'),
      connectorRefs: stringList(record.connectorRefs, 'connectorRefs'),
      requiredTools: stringList(record.requiredTools, 'requiredTools'),
      knowledgeBaseRefs: stringList(record.knowledgeBaseRefs, 'knowledgeBaseRefs'),
      sha256: stringField(record, 'sha256'),
      ...(typeof record.minimumDesktopVersion === 'string' ? { minimumDesktopVersion: record.minimumDesktopVersion } : {}),
    }
  })
}

function skillCatalog(value: unknown): Skill[] {
  if (!Array.isArray(value)) throw new Error('deepseek-harness product: invalid skill catalog')
  return value.map((entry) => {
    const record = objectRecord(entry, 'skill')
    return {
      id: stringField(record, 'id'), name: stringField(record, 'name'), version: stringField(record, 'version'),
      summary: stringField(record, 'summary'), connectorRefs: stringList(record.connectorRefs, 'connectorRefs'),
      requiredTools: stringList(record.requiredTools, 'requiredTools'),
      knowledgeBaseRefs: stringList(record.knowledgeBaseRefs, 'knowledgeBaseRefs'),
      sha256: stringField(record, 'sha256'),
    }
  })
}

function artifactResponse(value: unknown): Artifact {
  const record = objectRecord(value, 'artifact')
  const result = { id: stringField(record, 'id'), version: stringField(record, 'version'),
    sha256: stringField(record, 'sha256'), url: stringField(record, 'url') }
  validateSha256(result.sha256)
  return result
}
