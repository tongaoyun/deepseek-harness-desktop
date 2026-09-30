import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
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
