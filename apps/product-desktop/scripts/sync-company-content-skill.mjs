import { createRequire } from 'node:module'
import { readFile, writeFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scripts = dirname(fileURLToPath(import.meta.url))

/** Keep the standalone skill validator identical to the product's public Node module. */
export async function synchronizeSkillCodec(check = true) {
  const product = createRequire(import.meta.resolve('@deepseek-harness/product-desktop'))
  const source = await readFile(product.resolve('@deepseek-harness/product/company-content'), 'utf8')
  const expected = '// Generated from @deepseek-harness/product/company-content; update with scripts/sync-company-content-skill.mjs --write.\n'
    + source.replace(/^\/\/# sourceMappingURL=.*\n?/gmu, '')
  const target = join(scripts, '../skills/harness-company-publish/scripts/company-content-codec.mjs')
  if (!check) await writeFile(target, expected)
  else if (await readFile(target, 'utf8') !== expected) throw new Error('Standalone company publication validator is stale; build the product package, then run sync-company-content-skill.mjs --write')
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const mode = process.argv.slice(2)
  if (mode.length !== 1 || !['--check', '--write'].includes(mode[0])) throw new Error('Usage: --check | --write')
  await synchronizeSkillCodec(mode[0] === '--check')
  console.log('Company publication validator synchronized')
}
