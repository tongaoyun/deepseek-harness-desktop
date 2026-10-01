import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const text = async file => (await readFile(resolve(root, file), 'utf8')).trim()
const repository = await text('UPSTREAM_REPOSITORY')
const mirror = await text('UPSTREAM_MIRROR_REPOSITORY')
const tag = await text('UPSTREAM_TAG')
const commit = await text('UPSTREAM_COMMIT')

const upstreamUrl = (await run('git', ['remote', 'get-url', 'upstream'], { cwd: root })).stdout.trim()
if (upstreamUrl !== repository && upstreamUrl !== mirror) {
  await run('git', ['remote', 'add', 'upstream', repository], { cwd: root })
}
let canonicalUrl = ''
try { canonicalUrl = (await run('git', ['remote', 'get-url', 'upstream-canonical'], { cwd: root })).stdout.trim() } catch {}
if (canonicalUrl !== repository) {
  try { await run('git', ['remote', 'add', 'upstream-canonical', repository], { cwd: root }) }
  catch { await run('git', ['remote', 'set-url', 'upstream-canonical', repository], { cwd: root }) }
}
await run('git', ['fetch', '--tags', 'upstream', tag], { cwd: root, maxBuffer: 10 * 1024 * 1024 })
const { stdout } = await run('git', ['rev-parse', `${tag}^{commit}`], { cwd: root })
if (stdout.trim() !== commit) throw new Error(`upstream tag ${tag} resolved to ${stdout.trim()}, expected ${commit}`)
console.log(`verified upstream ${tag} at ${commit}; create a sync branch before applying changes`)
