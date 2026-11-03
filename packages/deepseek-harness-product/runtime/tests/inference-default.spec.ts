/** Native Loader, Settings and LLM behavior with additive company inference. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { expect, it, onTestFinished, vi } from 'vitest'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import { boot, initProfile, loadOptionalPatches, readProfilePatches, reconcileProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Settings from '@deepseek-ai/dsh-settings'
import { createLaunchEnvironmentSnapshot, type LaunchEnvironmentLayerInput } from '@deepseek-ai/dsh-launch-environment'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import ProductCredentials from '../src/credentials.ts'
import { hasProviderApiKey } from '@deepseek-ai/dsh-api-session-controller/src/catalog.ts'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Llm, { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as DeepSeekApiKey from '../../../llm/llm-deepseek-api-key/src/index.ts'
import * as ProductInference from '../src/inference-default.ts'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

const baseURL = 'https://models.test/v1'
const originalRoute = { api: 'openai-completions', baseURL: 'https://personal.test/v1',
  apiKeyEnv: 'PERSONAL_MODEL_KEY', models: [{ id: 'personal-model' }] }
const nativeRows = [
  { id: 'llm', name: 'cordis:test-llm' },
  { id: 'llm-pi-ai', name: 'cordis:test-pi',
    config: { providers: { personal: originalRoute } } },
]
const company = (models = ['deepseek-v4-flash', 'gpt-example']) => ({ id: 'product-inference-default',
  name: 'cordis:product-inference', config: { baseURL, models } })

async function fixture(initial = { provider: 'test', model: 'original' }, environment: Record<string, string> = { DSH_PRODUCT_MODEL_API_KEY: 'company-model-key' }, fallbacks: readonly LaunchEnvironmentLayerInput[] = []) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'product-inference-')))
  const started: Context[] = []
  const writes: Promise<void>[] = []
  onTestFinished(async () => {
    const stopped = await Promise.allSettled(started.map(ctx => ctx.fiber.dispose()))
    await Promise.allSettled(writes)
    await rm(home, { recursive: true, force: true })
    for (const result of stopped) if (result.status === 'rejected') throw result.reason
  })
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"test-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'agent-default-model', name: 'cordis:model', config: initial },
    ...nativeRows,
    { id: 'llm-deepseek', name: 'cordis:native-deepseek', config: { models: [{ id: 'deepseek-flash' }] } },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'test', startedBundles: ['test-bundle'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home,
    overlays: [], telemetryDisabledEnv: undefined }
  const start = async () => {
    const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
      ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: environment }, ...fallbacks]))
      Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, model: DefaultModel,
        credentials: ProductCredentials, 'test-llm': Llm, 'test-pi': PiAi, 'native-deepseek': DeepSeekApiKey, 'product-inference': ProductInference })
    })
    started.push(ctx)
    const edit = ctx.configEditor.edit.bind(ctx.configEditor)
    ctx.configEditor.edit = (entry, change) => {
      const writing = edit(entry, change)
      writes.push(writing)
      return writing
    }
    return ctx
  }
  const ctx = await start()
  const configure = async (rows: object[]) => {
    const saved = loadOptionalPatches('test', profile.patchPath)?.filter(row => row.insert === undefined) ?? []
    await writeFile(profile.patchPath, JSON.stringify([{ insert: rows }, ...saved]))
    await reconcileProfilePatches(ctx, readProfilePatches('test', profile), 'test')
    await ctx.loader.await()
  }
  return { ctx, profile, start, configure }
}

async function createAgent(ctx: Awaited<ReturnType<typeof fixture>>['ctx'], id: string, provider: string, model: string) {
  await ctx.plugin(Sessions)
  await ctx.plugin(Projections)
  await ctx.plugin(Agents)
  await ctx.plugin(Tools)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider, model } })
}

it('adds company providers through native Loader and Settings while retaining personal routes after reload', async () => {
  const { ctx, configure, start } = await fixture()
  await configure([company()])
  await expect.poll(() => ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'product-deepseek', model: 'deepseek-v4-flash' })
  expect(ctx.llm.listProviders().map(row => row.id).sort()).toEqual(['deepseek-official', 'personal', 'product-deepseek', 'product-gateway'])
  expect(await ctx.llm.resolveModelInfo('personal', 'personal-model')).toMatchObject({ provider: 'personal', id: 'personal-model' })
  expect(await ctx.llm.resolveModelInfo('product-gateway', 'gpt-example')).toMatchObject({ provider: 'product-gateway', id: 'gpt-example' })
  expect(ctx.settings.describe().find(row => row.ns === 'llm-pi-ai')?.value).toMatchObject({ providers: { personal: originalRoute,
    'product-gateway': { apiKeyEnv: 'DSH_PRODUCT_MODEL_API_KEY', baseURL } } })
  await ctx.agentDefaultModel.saveSelection({ provider: 'personal', model: 'personal-model', reasoningEffort: ReasoningEffortId('high') })
  await ctx.fiber.dispose()
  const restarted = await start()
  await expect.poll(() => restarted.llm.listProviders().map(row => row.id)).toContain('product-gateway')
  expect(restarted.agentDefaultModel.currentSelection()).toEqual({ provider: 'personal', model: 'personal-model', reasoningEffort: 'high' })
})

it.each([true, false])('uses native provider credential detection for a DeepSeek-only company catalog with company key present: %s', async (present) => {
  const { ctx, configure, profile } = await fixture({ provider: 'personal', model: 'personal-model' }, present ? { DSH_PRODUCT_MODEL_API_KEY: 'company-model-key' } : {})
  const errors = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const credentials = { id: 'credentials', name: 'cordis:credentials', config: { dshHome: profile.home, watch: false } }
  await configure([credentials, company(['deepseek-v4-flash'])])
  expect([...ctx.loader.entries()].find(entry => entry.options.id === 'product-inference-default')?.fiber?.state).toBe(FiberState.ACTIVE)
  expect(errors).not.toHaveBeenCalled()
  expect(ctx.llm.listConfigurableProviders()).toContainEqual({ provider: 'product-deepseek', displayName: 'Enterprise DeepSeek',
    settingsNs: 'product-inference-default', settingsPath: [] })
  expect(ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'product-inference-default'))
    .toMatchObject({ autoGenerate: false, value: { apiKeyEnv: 'DSH_PRODUCT_MODEL_API_KEY' } })
  expect(ctx.llm.listProviders().map(row => row.id)).not.toContain('product-gateway')
  expect(await ctx.credentials.describe(credentialRef('DEEPSEEK_API_KEY'))).toMatchObject({ configured: false })
  expect(await ctx.credentials.describe(credentialRef('DSH_PRODUCT_MODEL_API_KEY'))).toMatchObject({ configured: present,
    ...present ? { source: 'env' } : {} })
  expect(await hasProviderApiKey(ctx)).toBe(present)
  await configure([credentials])
  expect(ctx.llm.listConfigurableProviders().map(row => row.provider)).not.toContain('product-deepseek')
  expect(ctx.settings.describe().map(row => row.ns)).not.toContain('product-inference-default')
  expect(await hasProviderApiKey(ctx)).toBe(false)
})

it('advertises company credentials before a generic-only route completes its native configuration write', async () => {
  const { ctx, configure, profile } = await fixture({ provider: 'personal', model: 'personal-model' })
  const locked = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const lock = withFileLock(join(profile.dir, 'package.json'), async () => {
    locked.resolve(undefined)
    await release.promise
  })
  onTestFinished(() => { release.resolve(undefined); return lock })
  await locked.promise
  const nativeEdit = ctx.configEditor.edit.bind(ctx.configEditor)
  const entered = Promise.withResolvers<Promise<void>>()
  vi.spyOn(ctx.configEditor, 'edit').mockImplementationOnce((entry, change) => {
    const writing = nativeEdit(entry, change)
    entered.resolve(writing)
    return writing
  })
  await configure([{ id: 'credentials', name: 'cordis:credentials', config: { dshHome: profile.home, watch: false } }, company(['gpt-example'])])
  expect(ctx.llm.listProviders().map(row => row.id)).not.toContain('product-deepseek')
  expect(ctx.llm.listProviders().map(row => row.id)).not.toContain('product-gateway')
  expect(ctx.llm.listConfigurableProviders()).toContainEqual({ provider: 'product-deepseek', displayName: 'Enterprise DeepSeek',
    settingsNs: 'product-inference-default', settingsPath: [] })
  expect(await hasProviderApiKey(ctx)).toBe(true)
  release.resolve(undefined)
  await entered.promise
  expect(ctx.llm.listProviders().map(row => row.id)).toContain('product-gateway')
})

it('rejects a company credential reference that differs from its process-only authentication key', async () => {
  const { ctx, configure } = await fixture()
  await configure([company(['deepseek-v4-flash'])])
  await expect(ctx.settings.mutate('product-inference-default', [{ op: 'set', path: ['apiKeyEnv'], value: 'DEEPSEEK_API_KEY' }])).rejects.toThrow()
  expect(ctx.settings.describe().find(row => row.ns === 'product-inference-default')?.value)
    .toEqual({ apiKeyEnv: 'DSH_PRODUCT_MODEL_API_KEY' })
})

it.each(['current-employee-key', '', undefined])('uses only the signed-in employee key for generic company requests with process key: %s', async (key) => {
  const present = Boolean(key)
  const { ctx, configure, profile } = await fixture({ provider: 'personal', model: 'personal-model' },
    key === undefined ? {} : { DSH_PRODUCT_MODEL_API_KEY: key }, [
      { source: 'project-env', values: { DSH_PRODUCT_MODEL_API_KEY: 'project-company-key' } },
      { source: 'user-env', values: { DSH_PRODUCT_MODEL_API_KEY: 'home-company-key' } },
    ])
  const filename = join(profile.home, '.credentials.yaml')
  const stored = 'version: 1\nrefs:\n  DSH_PRODUCT_MODEL_API_KEY: prior-employee-key\n  PERSONAL_MODEL_KEY: personal-saved-key\n'
  await writeFile(filename, stored, { mode: 0o600 })
  const headers: IncomingHttpHeaders[] = []
  const server = createServer((request, response) => {
    headers.push(request.headers)
    request.resume()
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: {"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  onTestFinished(() => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() })
    server.closeAllConnections()
  }))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture listener did not bind TCP')
  const url = `http://127.0.0.1:${address.port}/v1`
  await configure([{ id: 'credentials', name: 'cordis:credentials', config: { dshHome: profile.home, watch: false } },
    { ...company(['gpt-example']), config: { baseURL: url, models: ['gpt-example'] } }])
  await expect.poll(() => ctx.llm.listProviders().map(row => row.id)).toContain('product-gateway')
  const companyKey = credentialRef('DSH_PRODUCT_MODEL_API_KEY')
  expect(await ctx.credentials.resolve(companyKey)).toEqual(present ? { value: 'current-employee-key', source: 'env' } : undefined)
  expect(await ctx.credentials.describe(companyKey)).toEqual({ configured: present, writable: false, ...present ? { source: 'env' } : {} })
  expect(await hasProviderApiKey(ctx)).toBe(true)
  expect(await ctx.llm.listModels('product-gateway')).toHaveLength(present ? 1 : 0)
  const chunks = []
  for await (const chunk of ctx.llm.stream({ provider: 'product-gateway', model: 'gpt-example', messages: [] })) chunks.push(chunk)
  if (present) {
    expect(headers.map(headers => headers.authorization)).toEqual(['Bearer current-employee-key'])
    expect(chunks.find(chunk => chunk.type === 'finish')).toMatchObject({ reason: { kind: 'stop' } })
  }
  else {
    expect(headers).toHaveLength(0)
    expect(chunks.find(chunk => chunk.type === 'finish')).toMatchObject({ reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } } })
  }
  await expect(ctx.credentials.set(companyKey, 'replacement-key')).rejects.toMatchObject({ code: 'PRODUCT_CREDENTIAL_MANAGED' })
  await expect(ctx.credentials.unset(companyKey)).rejects.toMatchObject({ code: 'PRODUCT_CREDENTIAL_MANAGED' })
  expect(await readFile(filename, 'utf8')).toBe(stored)
  const personal = credentialRef('PERSONAL_MODEL_KEY')
  expect(await ctx.credentials.resolve(personal)).toEqual({ value: 'personal-saved-key', source: 'file' })
  await ctx.credentials.set(personal, 'personal-updated-key')
  expect(await ctx.credentials.resolve(personal)).toEqual({ value: 'personal-updated-key', source: 'file' })
  await ctx.credentials.unset(personal)
  expect(await ctx.credentials.resolve(personal)).toBeUndefined()
  const grant = credentialKey('llm-pi-ai', 'personal')
  await ctx.credentials.modifyRecord(grant, () => Promise.resolve({ kind: 'grant', payload: { token: 'personal-grant' } }))
  expect(await ctx.credentials.readRecord(grant)).toEqual({ kind: 'grant', payload: { token: 'personal-grant' } })
  expect(await ctx.credentials.describeRecord(grant)).toEqual({ configured: true, kind: 'grant', writable: true })
  expect(await ctx.credentials.listRecords()).toEqual([{ key: grant, kind: 'grant' }])
  await ctx.credentials.deleteRecord(grant)
  expect(await ctx.credentials.readRecord(grant)).toBeUndefined()
})

it('preserves a valid native default and reasoning effort even when the model is not in the company catalog', async () => {
  const { ctx, configure } = await fixture()
  await ctx.agentDefaultModel.saveSelection({ provider: 'personal', model: 'personal-model', reasoningEffort: ReasoningEffortId('high') })
  const edit = vi.spyOn(ctx.configEditor, 'edit')
  await configure([company()])
  const handle = await createAgent(ctx, 'native-default', 'personal', 'personal-model')
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'personal', model: 'personal-model', reasoningEffort: 'high' })
  expect(handle.agent.options).toMatchObject({ provider: 'personal', model: 'personal-model' })
  expect(edit.mock.calls.filter(([entry]) => entry.options.id === 'agent-default-model')).toHaveLength(0)
  await handle.dispose()
})

it('keeps a user selection already being saved when company default repair starts', async () => {
  const { ctx, configure, profile } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const checked = Promise.withResolvers<undefined>()
  const nativeEdit = ctx.configEditor.edit.bind(ctx.configEditor)
  let choosing: Promise<void> = Promise.resolve()
  let first = true
  vi.spyOn(ctx.configEditor, 'edit').mockImplementation(async (entry, change) => {
    if (first) {
      first = false
      entered.resolve(undefined)
      await release.promise
    } else await choosing
    await nativeEdit(entry, change)
  })
  const selected = { provider: 'personal', model: 'personal-model', reasoningEffort: ReasoningEffortId('high') }
  choosing = ctx.agentDefaultModel.saveSelection(selected)
  onTestFinished(async () => { release.resolve(undefined); await choosing })
  await entered.promise
  const current = ctx.agentDefaultModel.currentSelection.bind(ctx.agentDefaultModel)
  let reads = 0
  vi.spyOn(ctx.agentDefaultModel, 'currentSelection').mockImplementation(() => {
    const selection = current()
    if (++reads === 2) checked.resolve(undefined)
    return selection
  })
  await configure([company(['deepseek-v4-flash'])])
  await checked.promise
  const creating = createAgent(ctx, 'pending-personal-default', 'test', 'original')
  release.resolve(undefined)
  await choosing
  const handle = await creating
  onTestFinished(() => handle.dispose())
  expect(current()).toEqual(selected)
  expect(loadOptionalPatches('test', profile.patchPath)?.find(row => row.id === 'agent-default-model')?.config)
    .toEqual(selected)
})

it('selects company inference on first launch when the native default has no API-key credential', async () => {
  const { ctx, configure } = await fixture({ provider: 'deepseek-official', model: 'deepseek-flash' })
  expect(await ctx.llm.listModels('deepseek-official')).toEqual([])
  await configure([company()])
  const handle = await createAgent(ctx, 'first-company-task', 'deepseek-official', 'deepseek-flash')
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'product-deepseek', model: 'deepseek-v4-flash' })
  expect(handle.agent.options).toMatchObject({ provider: 'product-deepseek', model: 'deepseek-v4-flash' })
  await handle.dispose()
})

it('keeps an explicitly saved native selection even when its credential is currently missing', async () => {
  const { ctx, configure } = await fixture({ provider: 'deepseek-official', model: 'deepseek-flash' })
  await ctx.agentDefaultModel.saveSelection({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: ReasoningEffortId('high') })
  await configure([company()])
  const handle = await createAgent(ctx, 'saved-native-task', 'deepseek-official', 'deepseek-flash')
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
  await handle.dispose()
})

it('removes an obsolete company generic route while retaining personal routes and the saved default', async () => {
  const { ctx, configure } = await fixture()
  await ctx.agentDefaultModel.saveSelection({ provider: 'personal', model: 'personal-model', reasoningEffort: ReasoningEffortId('high') })
  await configure([company()])
  await expect.poll(() => ctx.llm.listProviders().map(row => row.id)).toContain('product-gateway')
  await configure([company(['deepseek-v4-flash'])])
  await expect.poll(() => ctx.llm.listProviders().map(row => row.id)).not.toContain('product-gateway')
  expect(await ctx.llm.resolveModelInfo('personal', 'personal-model')).toMatchObject({ id: 'personal-model' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'personal', model: 'personal-model', reasoningEffort: 'high' })
})

it('finishes a native configuration reload that unloads the caller of an in-flight company route write', async () => {
  const { ctx, profile, configure } = await fixture()
  const nativeEdit = ctx.configEditor.edit.bind(ctx.configEditor)
  const writes: Promise<void>[] = []
  vi.spyOn(ctx.configEditor, 'edit').mockImplementation((entry, change) => {
    const result = nativeEdit(entry, change)
    if (entry.options.id === 'llm-pi-ai') writes.push(result)
    return result
  })
  await configure([company()])
  await expect.poll(() => writes.length).toBe(1)
  await writes[0]
  await expect.poll(() => ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'product-deepseek', model: 'deepseek-v4-flash' })
  await ctx.agentDefaultModel.saveSelection({ provider: 'personal', model: 'personal-model', reasoningEffort: ReasoningEffortId('high') })
  const locked = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const lock = withFileLock(join(profile.dir, 'package.json'), async () => {
    locked.resolve(undefined)
    await release.promise
  })
  onTestFinished(() => { release.resolve(undefined); return lock })
  await locked.promise
  await configure([company(['deepseek-v4-flash', 'gpt-new'])])
  await expect.poll(() => writes.length).toBe(2)
  const fiber = [...ctx.loader.entries()].find(entry => entry.options.id === 'product-inference-default')?.fiber
  if (fiber === undefined) throw new Error('Company inference did not activate')
  const unloading = Promise.withResolvers<undefined>()
  fiber.ctx.effect(() => () => { unloading.resolve(undefined) })
  const saved = loadOptionalPatches('test', profile.patchPath)?.filter(row => row.insert === undefined) ?? []
  await writeFile(profile.patchPath, JSON.stringify([{ insert: [company(['deepseek-v4-flash'])] }, ...saved]))
  release.resolve(undefined)
  await unloading.promise
  // The successor must reach its own native unset while the previous write holds the profile lock.
  await expect.poll(() => writes.length).toBe(3)
  await Promise.all(writes)
  expect(ctx.llm.listProviders().map(row => row.id)).not.toContain('product-gateway')
  expect(await ctx.llm.resolveModelInfo('personal', 'personal-model')).toMatchObject({ id: 'personal-model' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'personal', model: 'personal-model', reasoningEffort: 'high' })
})

it('cancels native model lookup on unload and never saves a late default', async () => {
  const { ctx, configure } = await fixture({ provider: 'personal', model: 'removed-model' })
  const lookup = Promise.withResolvers<Awaited<ReturnType<typeof ctx.llm.resolveModelInfo>>>()
  const queried = Promise.withResolvers<AbortSignal | undefined>()
  const report = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const save = vi.spyOn(ctx.agentDefaultModel, 'saveSelection')
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementationOnce((_provider, _model, signal) => {
    queried.resolve(signal)
    return lookup.promise
  })
  await configure([company(['deepseek-v4-flash'])])
  const signal = await queried.promise
  expect(signal?.aborted).toBe(false)
  await configure([])
  expect(signal?.aborted).toBe(true)
  const failure = new LlmError('Model removed during lookup', 'UNKNOWN_MODEL')
  lookup.reject(failure)
  await expect.poll(() => report.mock.calls).toEqual([['Company model operation failed after unloading', failure]])
  expect(save).not.toHaveBeenCalled()
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'personal', model: 'removed-model' })
})

it('reports a native configuration write failure after unload without continuing default repair', async () => {
  const { ctx, configure } = await fixture()
  const writing = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const report = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const save = vi.spyOn(ctx.agentDefaultModel, 'saveSelection')
  vi.spyOn(ctx.configEditor, 'edit').mockImplementationOnce(() => {
    entered.resolve(undefined)
    return writing.promise
  })
  await configure([company()])
  await entered.promise
  await configure([])
  const failure = new Error('Profile write failed after reload')
  writing.reject(failure)
  await expect.poll(() => report.mock.calls).toEqual([['Company model operation failed after unloading', failure]])
  expect(save).not.toHaveBeenCalled()
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'original' })
})

it('repairs a model explicitly rejected by its native adapter without replacing other provider configuration', async () => {
  const { ctx, configure } = await fixture()
  await ctx.agentDefaultModel.saveSelection({ provider: 'personal', model: 'removed-model' })
  await configure([company(['gpt-example'])])
  await expect.poll(() => ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'product-gateway', model: 'gpt-example' })
  expect(await ctx.llm.resolveModelInfo('personal', 'personal-model')).toMatchObject({ id: 'personal-model' })
})

it('retains an unlisted but valid native model and leaves transient lookup failures unchanged', async () => {
  const { ctx, configure } = await fixture()
  class ExternalAdapter extends LlmAdapter {
    override async *stream() { /* No inference request is issued in this metadata-only test. */ }
  }
  const adapter = new ExternalAdapter()
  ctx.llm.registerAdapter(['external'], adapter)
  await ctx.agentDefaultModel.saveSelection({ provider: 'external', model: 'unlisted-model', reasoningEffort: ReasoningEffortId('high') })
  await configure([company()])
  const handle = await createAgent(ctx, 'unlisted-native-default', 'external', 'unlisted-model')
  expect(ctx.agentDefaultModel.currentSelection()).toMatchObject({ provider: 'external', model: 'unlisted-model', reasoningEffort: 'high' })
  await handle.dispose()
  vi.spyOn(adapter, 'resolveModel').mockRejectedValue(new LlmError('Temporary network failure', 'TRANSPORT'))
  await expect(ctx.agents.create({ sessionId: SessionId('transient-lookup'),
    agentOptions: { provider: 'external', model: 'unlisted-model' } })).rejects.toMatchObject({ code: 'TRANSPORT' })
  expect(ctx.agentDefaultModel.currentSelection()).toMatchObject({ provider: 'external', model: 'unlisted-model', reasoningEffort: 'high' })
})

it('retries failed native configuration persistence before later tasks', async () => {
  const { ctx, configure } = await fixture()
  const failure = new Error('Profile temporarily unavailable')
  const report = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  const edit = vi.spyOn(ctx.configEditor, 'edit').mockRejectedValueOnce(failure)
  await configure([company()])
  await expect.poll(() => report.mock.calls).toEqual([['Company model preparation failed', failure]])
  expect(edit.mock.calls).toHaveLength(1)
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'original' })
  const handle = await createAgent(ctx, 'retry-default', 'test', 'original')
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'product-deepseek', model: 'deepseek-v4-flash' })
  expect(handle.agent.options).toMatchObject({ provider: 'product-deepseek', model: 'deepseek-v4-flash' })
  await handle.dispose()
})
