/** Fixed personal expert versions remain independent of the latest package files. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { installCompanyContent } from '../../desktop/src/company-content.ts'
import { contentDigest } from '@deepseek-harness/product/company-content'
import { contentIndex, encoded } from '../../product/tests/content-fixtures.ts'
import * as Experts from '../src/index.ts'
import type { AgencyPersonaSource } from '../src/index.ts'
import { ExpertPackageStore } from '../src/expert-packages.ts'

it.each(['instructions', 'unrecorded resource'] as const)('loads the fixed personal expert when the latest version has corrupted %s', async (corruption) => {
  const root = await mkdtemp(join(tmpdir(), 'pinned-personal-expert-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  const signal = new AbortController().signal
  const files = { 'catalog.json': encoded(JSON.stringify(contentIndex('1.0.0', []))) }
  const company = await installCompanyContent(join(root, 'cache'), 'employee',
    { version: '1.0.0', sha256: contentDigest(files), files }, signal)
  const personalRoot = join(company.expertsRoot, '..', '..', 'personal-experts')
  const packages = new ExpertPackageStore(async () => personalRoot)
  const metadata = { slug: 'personal-expert', name: '个人专家', description: '订单处理', division: 'specialized', avatar: 0 }
  const old = await packages.save(metadata.slug, { ...metadata,
    prompt: 'Original {{literal}}. Read references/中文资料.md.', agents: 'Use the template without modifying it.',
    resources: { 'references/中文资料.md': encoded('固定版本参考资料'),
      'assets/模板.bin': Buffer.from([0, 128, 255]).toString('base64') } })
  const latest = await packages.save(metadata.slug, { ...metadata, prompt: 'Latest instructions', resources: {} })
  const oldRoot = join(personalRoot, metadata.slug, old.packageSha256)
  const latestRoot = join(personalRoot, metadata.slug, latest.packageSha256)
  ctx.provide('companyContent', { read: async () => company })
  ctx.provide('subagents', { getProvider: () => undefined })
  ctx.provide('settings', { configure: () => () => {}, describe: () => [{ ns: 'agency-agents', revision: 0 }] })
  ctx.provide('webServer', {})
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, prompt: SystemPrompt, tools: Tools, experts: Experts })
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify(['prompt', 'tools', 'experts'].map(name => ({ name: `cordis:${name}`,
    ...name === 'experts' ? { config: { personalContentClaimed: true,
      personalLibraries: { [createHash('sha256').update('employee').digest('hex')]: {
        enabled: [metadata.slug], customExperts: [{ ...metadata, ...latest }],
      } } } } : {} }))))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const personas = ctx.get(Experts.AGENCY_PERSONA_SERVICE) as AgencyPersonaSource | undefined
  if (!personas) throw new Error('Expert persona source did not load')
  const prompt = (hash?: string, division = metadata.division) =>
    personas.getPrompt(metadata.slug, division, 'zh', 'task', signal, hash)
  expect((await prompt()).prompt).toContain('Latest instructions')
  const damagedPath = join(latestRoot, corruption === 'instructions' ? 'config/SOUL.md' : 'unrecorded.md')
  await writeFile(damagedPath, 'Damaged latest package')
  const fixed = await prompt(old.packageSha256)
  expect(fixed.prompt).toContain(oldRoot)
  expect({ originalInstructions: fixed.prompt.includes('Original {{literal}}'),
    agentInstructions: fixed.prompt.includes('Use the template without modifying it.'),
    latestInstructions: fixed.prompt.includes('Latest instructions'),
    reference: await readFile(join(oldRoot, 'references/中文资料.md'), 'utf8'),
    templateBytes: [...await readFile(join(oldRoot, 'assets/模板.bin'))] }).toMatchInlineSnapshot(`
      {
        "agentInstructions": true,
        "latestInstructions": false,
        "originalInstructions": true,
        "reference": "固定版本参考资料",
        "templateBytes": [
          0,
          128,
          255,
        ],
      }
    `)
  const corruptionError = corruption === 'instructions' ? '公司内容校验失败' : '个人专家文件目录与保存版本不一致'
  await expect(prompt()).rejects.toThrow(corruptionError)
  await expect(prompt(latest.packageSha256)).rejects.toThrow(corruptionError)
  await expect(prompt('f'.repeat(64))).rejects.toThrow()
  await expect(prompt(old.packageSha256, 'engineering')).rejects.toThrow('没有匹配')
  await writeFile(join(oldRoot, 'references/中文资料.md'), 'Damaged pinned package')
  await expect(prompt(old.packageSha256)).rejects.toThrow('公司内容校验失败')
  expect(await readFile(damagedPath, 'utf8')).toBe('Damaged latest package')
})
