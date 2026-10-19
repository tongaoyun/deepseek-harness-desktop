import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as Readme from '@deepseek-harness/product-expert-kit-readme'
import { ExtensionDraftSchema, extensionFiles } from '@deepseek-harness/product/authoring'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProductData } from '../src/data.ts'
import * as KitSkills from '../src/kit-skills.ts'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'The complete review instructions are available.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('discovers an authored large kit skill without preloading its body and restores the logged guide', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-kit-skills-loader-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const description = `Review source evidence. ${'Use detailed source evidence for review. '.repeat(20)}`.trim()
  const body = `${'Preserve the source evidence.\n'.repeat(3_000)}End of complete review instructions.`
  const generated = extensionFiles(ExtensionDraftSchema.parse({ kind: 'expert-kit', id: 'review-kit', version: '1.0.0',
    name: 'Review kit', summary: 'Review source evidence.', category: 'knowledge-research', body: '# Guide\n\nReport only source facts.',
    skills: [{ id: 'qa', name: 'Evidence review', summary: 'Review source evidence.', description, body }],
  }))
  for (const [path, text] of Object.entries(generated.files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), text)
  }
  expect(Buffer.byteLength(generated.files['skills/qa/SKILL.md']!)).toBeGreaterThan(65_536)
  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Skills)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(Agents)
  await ctx.plugin(AgentLoop, { agents: [] })
  const invoke = vi.fn(async () => ({ id: 'review-kit', version: '2.0.0', token: 'private-employee-token' }))
  new ProductData(ctx, { invoke })
  ctx.loader.builtins['kit-skills-fixture'] = KitSkills
  ctx.loader.builtins['kit-readme-fixture'] = Readme
  await ctx.loader.root.update([
    { id: 'kit-skills', name: 'cordis:kit-skills-fixture', config: {
      expertKitId: 'review-kit', providerName: 'pinned-kit', directory: join(root, 'skills'),
    } },
    { id: 'kit-readme', name: 'cordis:kit-readme-fixture', config: {
      expertKitId: 'review-kit',
      entries: [{ name: 'expert-kit-review', description: 'Review evidence.', path: join(root, 'README.md') }],
    } },
  ])
  await ctx.loader.await()
  for (const id of ['kit-skills', 'kit-readme']) await ctx.loader.resolve(id).fiber?.await()
  expect((await ctx.skills.list()).find(skill => skill.name === 'qa')?.description).toBe(description)
  expect((await ctx.skills.get('qa'))?.content).toBe(body)
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('large-kit'), agentOptions: { provider: 'fixture', model: 'fixture' } })
  onTestFinished(() => handle.dispose())
  const followup = () => createUserMessage({ content: [{ type: 'text' as const, text: 'Review the evidence.' }], source: { kind: 'user' as const } })
  handle.agent.followup(followup())
  await vi.waitFor(() => { expect(handle.agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true) }, { timeout: 10_000 })
  const events = handle.agent.session.snapshotEvents()
  const instructions = events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'product-expert-kit-instructions'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
  expect(instructions).toHaveLength(1)
  expect(instructions[0]).not.toContain(body)
  expect(instructions[0]).toContain('Report only source facts.')
  const firstRequest = adapter.requests[0]?.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text)
  expect(firstRequest).toContain(instructions[0])
  expect(JSON.stringify(events)).not.toContain('private-employee-token')
  const recorded = instructions[0]!.replaceAll(await realpath(root), '<HOME>').replaceAll(root, '<HOME>')
  await expect(JSON.stringify({ instructionBytes: Buffer.byteLength(recorded),
    instructionSha256: createHash('sha256').update(recorded).digest('hex'), description }, null, 2) + '\n')
    .toMatchFileSnapshot('expected/large-kit-instructions.json')
  await handle.dispose()
  const restored = await ctx.agents.create({ sessionId: SessionId('large-kit'), seed: events,
    agentOptions: { provider: 'fixture', model: 'fixture' } })
  onTestFinished(() => restored.dispose())
  restored.agent.followup(followup())
  await vi.waitFor(() => { expect(restored.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(2) }, { timeout: 10_000 })
  expect(adapter.requests[1]?.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text))
    .toContain(instructions[0])
  expect(restored.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
    && event.data.source.kind === 'product-expert-kit-instructions')).toHaveLength(1)
  expect(invoke).toHaveBeenCalled()
  await ctx.loader.root.update([])
  await ctx.loader.await()
  expect(await ctx.skills.list()).toEqual([])
})
