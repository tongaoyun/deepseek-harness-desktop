import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { it, onTestFinished } from 'vitest'

function detail(error: unknown): string {
  return error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
}

it('loads from an exact module URL when the profile cannot resolve the private package name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-harness-expert-kit-readme-'))
  const profile = join(root, 'profile')
  const readme = join(root, 'expert-kit', 'README.md')
  await mkdir(profile, { recursive: true })
  await mkdir(join(root, 'expert-kit'), { recursive: true })
  await writeFile(readme, '# Order expert\n\nUse the order connector.\n', 'utf8')

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(`${profile}/`).href
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(Loader)
  await ctx.plugin(SkillRegistry)

  let stage = 'resolve module'
  try {
    const pluginUrl = import.meta.resolve('@deepseek-ai/dsh-expert-kit-readme')
    stage = 'import module'
    const imported = await ctx.loader.import(pluginUrl) as { readonly name?: unknown; readonly inject?: unknown }
    if (imported.name !== 'deepseek-harness-expert-kit-readme' || JSON.stringify(imported.inject) !== '["skills"]') {
      throw new Error(`Unexpected Expert Kit README plugin exports from ${pluginUrl}`)
    }
    stage = 'mount Loader row'
    await ctx.loader.root.update([{
      id: 'expert-kit-readme',
      name: pluginUrl,
      config: {
        entries: [{ name: 'expert-kit-orders', description: 'Order operations', path: readme }],
      },
    }])
    await ctx.loader.await()

    const entry = ctx.loader.resolve('expert-kit-readme')
    if (entry.fiber === undefined) throw new Error(`Loader did not start ${pluginUrl}`)
    stage = 'activate plugin'
    await entry.fiber.await()
    stage = 'list skills'
    const listed = (await ctx.skills.list()).map(({ name, description, provider }) => ({ name, description, provider }))
    if (JSON.stringify(listed) !== JSON.stringify([
      { name: 'expert-kit-orders', description: 'Order operations', provider: 'deepseek-harness-expert-kit-readme' },
    ])) throw new Error(`Unexpected skill catalog: ${JSON.stringify(listed)}`)
    stage = 'load skill'
    const loaded = await ctx.skills.get('expert-kit-orders')
    if (loaded?.content !== '# Order expert\n\nUse the order connector.\n' || loaded.path !== await realpath(readme)) {
      throw new Error(`Unexpected loaded skill: ${JSON.stringify(loaded)}`)
    }
  } catch (error) {
    throw new Error(`Expert Kit README Loader test failed during ${stage}: ${detail(error)}`)
  }
})
