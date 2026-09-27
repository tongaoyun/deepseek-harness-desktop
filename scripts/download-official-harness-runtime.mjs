import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { x as extractTar } from 'tar'

const repository = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(join(repository, 'scripts', 'official-harness-runtime.json'), 'utf8'))
const values = parseArguments(process.argv.slice(2))
const target = manifest.targets[values.target]
if (!target) throw new Error(`Unsupported Harness runtime target: ${values.target}`)

const base = (process.env.XIAOYIN_PRIMARY_RUNTIME_ARTIFACT_BASE ?? manifest.baseUrl).replace(/\/$/u, '')
const url = `${base}/${encodeURIComponent(target.archive)}`
const cache = resolve(values.cache ?? join(process.env.XIAOYIN_BUILD_CACHE_DIR ?? '/tmp', 'xiaoyin-primary-runtime'))
const archive = join(cache, target.sha256)
await mkdir(cache, { recursive: true })

let bytes
try {
  bytes = await readFile(archive)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) })
  if (!response.ok) throw new Error(`Official Harness runtime download failed: ${response.status} ${url}`)
  bytes = Buffer.from(await response.arrayBuffer())
}
const actual = createHash('sha256').update(bytes).digest('hex')
if (actual !== target.sha256) throw new Error(`Official Harness runtime SHA-256 mismatch for ${target.archive}`)
await writeFile(archive, bytes)

const output = resolve(values.output)
await mkdir(output, { recursive: true })
await rm(join(output, 'primary-runtime'), { recursive: true, force: true })
await rm(join(output, 'office-skills'), { recursive: true, force: true })
await extractTar({ file: archive, cwd: output, strict: true })

for (const required of ['primary-runtime/runtime.json', 'office-skills/scripts/check_office.py']) {
  try { await readFile(join(output, required)) } catch { throw new Error(`Official Harness runtime is missing ${required}`) }
}
console.log(`Official Harness runtime ${manifest.version} ${values.target} is ready: ${output}`)

function parseArguments(args) {
  const parsed = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!['--target', '--output', '--cache'].includes(key) || !value) {
      throw new Error('Usage: download-official-harness-runtime.mjs --target <target> --output <directory> [--cache <directory>]')
    }
    parsed[key.slice(2)] = value
  }
  if (!parsed.target || !parsed.output) throw new Error('A target and output directory are required')
  return parsed
}
