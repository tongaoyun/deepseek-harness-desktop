import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Skills from '@deepseek-ai/dsh-skill'
import * as FileSkills from '@deepseek-ai/dsh-skill-filesystem'
import { companyContentRelease, contentDigest } from '@deepseek-harness/product/company-content'
import { expect, it, onTestFinished } from 'vitest'

it.each([
  ['description: 查询订单 # comment', true, true, true],
  ['description: "查询\\u8ba2\\u5355"', true, true, true],
  ["description: '查询订单'\ndisable-model-invocation: YES\nuser-invocable: 0", true, false, false],
  ['description: null', false, true, true],
  ['description: true', false, true, true],
  ['description: "unterminated', false, true, true],
  ['description: orders\nextra: [broken', false, true, true],
  ['description: orders\nextra: one\nextra: two', false, true, true],
  ['description: orders\ndisable-model-invocation: maybe', false, true, true],
  ['description: orders\nuserInvocable: true', false, true, true],
] as const)('checks company skill publication against the real native provider: %s', async (metadata, accepted, modelInvocable, userInvocable) => {
  const root = await mkdtemp(join(tmpdir(), 'company-skill-format-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  const text = `---\nname: orders\n${metadata}\n---\nUse the configured tools.`
  const files = { 'skills/orders/SKILL.md': Buffer.from(text).toString('base64') }
  const release = { version: '1.0.0', sha256: contentDigest(files), files }
  if (accepted) expect(companyContentRelease(release)).toEqual(release)
  else expect(() => companyContentRelease(release)).toThrow()
  // Deliberately mount rejected bytes too: this proves why publication must reject them.
  await mkdir(join(root, 'skills/orders'), { recursive: true })
  await writeFile(join(root, 'skills/orders/SKILL.md'), text)
  await ctx.plugin(Skills)
  await ctx.plugin(FileSkills, { includeDefaultRoots: false, watch: false, customSkillDirs: [join(root, 'skills')] })
  const skills = await ctx.skills.list()
  expect(skills.map(skill => skill.name)).toEqual(accepted ? ['orders'] : [])
  if (accepted) {
    expect(await ctx.skills.get('orders')).toMatchObject({ description: '查询订单', content: 'Use the configured tools.',
      invocation: { modelInvocable, userInvocable } })
  }
})
