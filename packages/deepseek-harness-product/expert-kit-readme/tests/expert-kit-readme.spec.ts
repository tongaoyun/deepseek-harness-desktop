import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import * as ExpertKitReadme from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function readme(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-harness-expert-kit-readme-'))
  roots.push(root)
  const path = join(root, 'README.md')
  await writeFile(path, content)
  return path
}

describe('DeepSeekHarness Expert Kit README skills', () => {
  it('loads the guide automatically, deduplicates visible instructions and restores them after context replacement', async () => {
    const path = await readme('# Orders\n\nFollow the diagnostic workflow.\n')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(Sessions)
    const fiber = await ctx.plugin(ExpertKitReadme, { entries: [{ name: 'expert-kit-orders', description: 'Diagnose orders.', path }] })
    const session = ctx.sessions.create(SessionId('orders'))
    const agent = { id: session.id, ctx, session } as Agent
    const signal = new AbortController().signal
    const enter = () => agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
    const decision = await enter()
    if (decision.kind !== 'enter') throw new Error('Expected admitted step')
    expect(decision.messages).toHaveLength(1)
    expect(JSON.stringify(decision.messages)).toContain('Follow the diagnostic workflow.')
    session.append('user/message', decision.messages[0]!, { surfaceOp: 'append' })
    expect(await enter()).toMatchObject({ messages: [] })
    const seq = session.surface.nodes[0]!
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Compacted context.' }], source: { kind: 'user' } }),
      { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
    expect(await enter()).toMatchObject({ messages: [{ source: { kind: 'product-expert-kit-instructions' } }] })
    await fiber.dispose()
    expect(await enter()).toMatchObject({ messages: [] })
    await ctx.fiber.dispose()
  })


  it('publishes summaries to the model and loads the original README on demand', async () => {
    const path = await readme('# 订单专家\n\n按照订单排查流程工作。\n')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(ExpertKitReadme, { entries: [{
      name: 'expert-kit-order-expert', description: '排查订单问题并解释金额。', path,
    }] })
    const resolvedPath = await realpath(path)

    expect(await ctx.skills.list()).toEqual([{
      name: 'expert-kit-order-expert',
      description: '排查订单问题并解释金额。',
      invocation: { modelInvocable: true, userInvocable: false },
      provider: 'deepseek-harness-expert-kit-readme',
      source: 'preset',
      resourceBase: { kind: 'directory', path: dirname(resolvedPath) },
      path: resolvedPath,
    }])
    expect(await ctx.skills.get('expert-kit-order-expert')).toMatchObject({
      content: '# 订单专家\n\n按照订单排查流程工作。\n',
      invocation: { modelInvocable: true, userInvocable: false },
    })

    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('rejects a README larger than the package limit', async () => {
    const path = await readme('界'.repeat(21_846))
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)

    await expect(ctx.plugin(ExpertKitReadme, { entries: [{
      name: 'expert-kit-large', description: 'Oversized README.', path,
    }] })).rejects.toThrow('exceeds 65536 bytes')
  })
})
