import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const run = promisify(execFile)
const upstreamCommit = (await readFile(resolve(root, 'UPSTREAM_COMMIT'), 'utf8')).trim()
const upstreamTag = (await readFile(resolve(root, 'UPSTREAM_TAG'), 'utf8')).trim()
const upstreamMirror = (await readFile(resolve(root, 'UPSTREAM_MIRROR_REPOSITORY'), 'utf8')).trim()
const expected = {
  UPSTREAM_REPOSITORY: 'https://github.com/deepseek-ai/deepseek-harness.git',
}

for (const [file, value] of Object.entries(expected)) {
  const actual = (await readFile(resolve(root, file), 'utf8')).trim()
  if (actual !== value) throw new Error(`${file} must be ${value}, got ${actual}`)
}

if (!/^dsh-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(upstreamTag)) {
  throw new Error(`UPSTREAM_TAG must be a pinned DeepSeek Harness release tag, got ${upstreamTag}`)
}

const upstreamUrl = (await run('git', ['remote', 'get-url', 'upstream'], { cwd: root })).stdout.trim()
if (upstreamUrl !== expected.UPSTREAM_REPOSITORY && upstreamUrl !== upstreamMirror) {
  throw new Error(`upstream remote must be ${expected.UPSTREAM_REPOSITORY} or ${upstreamMirror}, got ${upstreamUrl}`)
}
let canonicalRemote = ''
try { canonicalRemote = (await run('git', ['remote', 'get-url', 'upstream-canonical'], { cwd: root })).stdout.trim() } catch {}
if (canonicalRemote !== '' && canonicalRemote !== expected.UPSTREAM_REPOSITORY) {
  throw new Error(`upstream-canonical remote must be ${expected.UPSTREAM_REPOSITORY}, got ${canonicalRemote}`)
}

const tagCommit = (await run('git', ['rev-parse', `${upstreamTag}^{commit}`], { cwd: root })).stdout.trim()
if (tagCommit !== upstreamCommit) {
  throw new Error(`upstream tag ${upstreamTag} must resolve to ${upstreamCommit}, got ${tagCommit}`)
}

const desktop = JSON.parse(await readFile(resolve(root, 'apps/desktop/package.json'), 'utf8'))
if (desktop.name !== '@deepseek-ai/dsh-desktop') throw new Error('official Electron desktop package is missing')
console.log(`verified DeepSeek Harness ${upstreamTag} (${upstreamCommit})`)
