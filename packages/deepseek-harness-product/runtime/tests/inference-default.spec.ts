import { writeFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { readProfilePatches, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Llm from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'

it('repairs an unavailable saved default through Loader and retains a permitted selection after reload', async () => {
  const { ctx, profile, start } = await configurationFixture({ hmr: false })
  const selections = [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }, { provider: 'product-gateway', model: 'gpt-example' }]
  await writeFile(profile.patchPath, JSON.stringify([{ insert: [{ id: 'product-inference-default',
    name: new URL('../src/inference-default.ts', import.meta.url).href, config: { selections } }] }]))
  await reconcileProfilePatches(ctx, readProfilePatches('test', profile), 'test')
  await ctx.loader.await()
  await expect.poll(() => ctx.agentDefaultModel.currentSelection()).toEqual(selections[0])
  await ctx.agentDefaultModel.saveSelection(selections[1]!)
  await ctx.plugin(Sessions)
  await ctx.plugin(Projections)
  await ctx.plugin(Agents)
  await ctx.plugin(Llm)
  await ctx.plugin(Tools)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentLoop, { agents: [] })
  const handle = await ctx.agents.create({ sessionId: SessionId('first-product-task'),
    agentOptions: { provider: 'test', model: 'original' } })
  expect(handle.agent.options).toMatchObject(selections[1]!)
  await handle.dispose()
  await ctx.fiber.dispose()
  const restarted = await start()
  expect(restarted.agentDefaultModel.currentSelection()).toEqual(selections[1])
})

it('retries a failed default repair through native configuration persistence before creating later tasks', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const selection = { provider: 'product-gateway', model: 'available-model' }
  const edit = vi.spyOn(ctx.configEditor, 'edit').mockRejectedValueOnce(new Error('Profile temporarily unavailable'))
  await writeFile(profile.patchPath, JSON.stringify([{ insert: [{ id: 'product-inference-default',
    name: new URL('../src/inference-default.ts', import.meta.url).href, config: { selections: [selection] } }] }]))
  await reconcileProfilePatches(ctx, readProfilePatches('test', profile), 'test')
  await ctx.loader.await()
  await expect.poll(() => edit.mock.calls.length).toBe(1)
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'original' })
  await ctx.plugin(Sessions)
  await ctx.plugin(Projections)
  await ctx.plugin(Agents)
  await ctx.plugin(Llm)
  await ctx.plugin(Tools)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentLoop, { agents: [] })
  const handles = await Promise.all(['first-retry', 'concurrent-retry'].map(sessionId => ctx.agents.create({
    sessionId: SessionId(sessionId), agentOptions: { provider: 'test', model: 'original' },
  })))
  expect(edit).toHaveBeenCalledTimes(2)
  expect(ctx.agentDefaultModel.currentSelection()).toEqual(selection)
  for (const handle of handles) {
    expect(handle.agent.options).toMatchObject(selection)
    await handle.dispose()
  }
})
