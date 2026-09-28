import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const run = promisify(execFile)
const expected = {
  UPSTREAM_REPOSITORY: 'https://github.com/deepseek-ai/deepseek-harness.git',
  UPSTREAM_TAG: 'dsh-v0.1.7-rc.2',
  UPSTREAM_COMMIT: '477b4f420553e8a52c2fbccc464d7561b239c443',
}

for (const [file, value] of Object.entries(expected)) {
  const actual = (await readFile(resolve(root, file), 'utf8')).trim()
  if (actual !== value) throw new Error(`${file} must be ${value}, got ${actual}`)
}

const upstreamUrl = (await run('git', ['remote', 'get-url', 'upstream'], { cwd: root })).stdout.trim()
if (upstreamUrl !== expected.UPSTREAM_REPOSITORY) {
  throw new Error(`upstream remote must be ${expected.UPSTREAM_REPOSITORY}, got ${upstreamUrl}`)
}

const tagCommit = (await run('git', ['rev-parse', `${expected.UPSTREAM_TAG}^{commit}`], { cwd: root })).stdout.trim()
if (tagCommit !== expected.UPSTREAM_COMMIT) {
  throw new Error(`upstream tag ${expected.UPSTREAM_TAG} must resolve to ${expected.UPSTREAM_COMMIT}, got ${tagCommit}`)
}

const desktop = JSON.parse(await readFile(resolve(root, 'apps/desktop/package.json'), 'utf8'))
if (desktop.name !== '@deepseek-ai/dsh-desktop') throw new Error('official Electron desktop package is missing')
console.log(`verified DeepSeek Harness ${expected.UPSTREAM_TAG} (${expected.UPSTREAM_COMMIT})`)
