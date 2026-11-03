/** Native Loader, Settings and LLM behavior with additive company inference. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished, vi } from 'vitest'
import { boot, initProfile, loadOptionalPatches, readProfilePatches, reconcileProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Settings from '@deepseek-ai/dsh-settings'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
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

async function fixture(initial = { provider: 'test', model: 'original' }) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'product-inference-')))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
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
      ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { DSH_PRODUCT_MODEL_API_KEY: 'company-model-key' } }]))
      Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, model: DefaultModel,
        'test-llm': Llm, 'test-pi': PiAi, 'native-deepseek': DeepSeekApiKey, 'product-inference': ProductInference })
    })
    onTestFinished(() => ctx.fiber.dispose())
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
  await configure([company()])
  await expect.poll(() => ctx.llm.listProviders().map(row => row.id)).toContain('product-gateway')
  await ctx.agentDefaultModel.saveSelection({ provider: 'personal', model: 'personal-model', reasoningEffort: ReasoningEffortId('high') })
  await configure([company(['deepseek-v4-flash'])])
  await expect.poll(() => ctx.llm.listProviders().map(row => row.id)).not.toContain('product-gateway')
  expect(await ctx.llm.resolveModelInfo('personal', 'personal-model')).toMatchObject({ id: 'personal-model' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'personal', model: 'personal-model', reasoningEffort: 'high' })
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
  const edit = vi.spyOn(ctx.configEditor, 'edit').mockRejectedValueOnce(new Error('Profile temporarily unavailable'))
  await configure([company()])
  await expect.poll(() => edit.mock.calls.length).toBe(1)
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'original' })
  const handle = await createAgent(ctx, 'retry-default', 'test', 'original')
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'product-deepseek', model: 'deepseek-v4-flash' })
  expect(handle.agent.options).toMatchObject({ provider: 'product-deepseek', model: 'deepseek-v4-flash' })
  await handle.dispose()
})
