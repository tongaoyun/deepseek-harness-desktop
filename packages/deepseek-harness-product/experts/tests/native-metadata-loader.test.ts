/** Published expert metadata must remain readable by the native Loader composition. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { companyContentRelease, contentDigest } from '@deepseek-harness/product/company-content'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import * as Experts from '../src/index.ts'
import { AGENCY_LIBRARY_SERVICE, type AgencyExpertLibrary } from '../src/expert-library.ts'

it('loads quoted YAML text and excludes malformed or non-text metadata before persona execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-metadata-loader-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, 'engineering'))
  const cases = [
    { slug: 'quoted-colon', description: '"Review: orders"', text: 'Review: orders' },
    { slug: 'quoted-boolean', description: '"true"', text: 'true' },
    { slug: 'quoted-number', description: '"123"', text: '123' },
    { slug: 'comment', description: 'Review orders # author comment', text: 'Review orders' },
    { slug: 'raw-colon', description: 'Review: orders' },
    { slug: 'boolean', description: 'true' },
    { slug: 'number', description: '123' },
    { slug: 'broken-extra', description: 'Orders\nextra: [broken' },
  ]
  for (const entry of cases) {
    const document = `---\nname: ${entry.slug}\ndescription: ${entry.description}\n---\nPersona for ${entry.slug}.`
    const files = { [`experts/engineering/${entry.slug}.md`]: Buffer.from(document).toString('base64') }
    const release = { version: '1.0.0', sha256: contentDigest(files), files }
    if (entry.text === undefined) expect(() => companyContentRelease(release), entry.slug).toThrow()
    else expect(companyContentRelease(release).files, entry.slug).toEqual(files)
    await writeFile(join(root, 'engineering', `${entry.slug}.md`), document)
  }
  ctx.provide('subagents', { getProvider: () => undefined })
  ctx.provide('settings', { configure: () => () => {}, describe: () => [{ ns: 'agency-agents', revision: 0 }] })
  ctx.provide('webServer', {})
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, prompt: SystemPrompt, tools: Tools, experts: Experts })
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    { name: 'cordis:prompt' }, { name: 'cordis:tools' },
    { name: 'cordis:experts', config: { root, divisions: ['engineering'] } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const library = ctx.get(AGENCY_LIBRARY_SERVICE) as AgencyExpertLibrary | undefined
  const persona = ctx.get(Experts.AGENCY_PERSONA_SERVICE) as Experts.AgencyPersonaSource | undefined
  if (!library || !persona) throw new Error('Expert services did not load')
  const catalog = await library.catalog()
  expect(catalog.experts.map(expert => ({ slug: expert.slug, description: expert.description })))
    .toEqual(cases.filter(entry => entry.text !== undefined)
      .map(entry => ({ slug: entry.slug, description: entry.text }))
      .sort((left, right) => left.slug.localeCompare(right.slug)))
  for (const entry of cases) {
    const reading = persona.getPrompt(entry.slug, 'engineering', 'en')
    if (entry.text === undefined) await expect(reading, entry.slug).rejects.toThrow()
    else await expect(reading, entry.slug).resolves.toEqual({ prompt: `Persona for ${entry.slug}.` })
  }
}, 30_000)
