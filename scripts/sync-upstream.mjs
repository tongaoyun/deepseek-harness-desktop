import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyPinnedBaseline } from './upstream-boundaries.mjs'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const text = async file => (await readFile(resolve(root, file), 'utf8')).trim()
const repository = await text('UPSTREAM_REPOSITORY')
const tag = await text('UPSTREAM_TAG')
const commit = await text('UPSTREAM_COMMIT')

await run('git', ['fetch', repository, `refs/tags/${tag}:refs/tags/${tag}`], { cwd: root, maxBuffer: 10 * 1024 * 1024 })
verifyPinnedBaseline(root, tag, commit)
await run('git', ['push', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], { cwd: root, maxBuffer: 10 * 1024 * 1024 })
console.log(`verified upstream ${tag} at ${commit} and stored its tag in origin; create a sync branch before applying changes`)
