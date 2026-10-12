import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyPatches, verifyDependencies, verifyPinnedBaseline } from './upstream-boundaries.mjs'

const root = resolve(import.meta.dirname, '..')
const upstreamCommit = (await readFile(resolve(root, 'UPSTREAM_COMMIT'), 'utf8')).trim()
const upstreamTag = (await readFile(resolve(root, 'UPSTREAM_TAG'), 'utf8')).trim()
const expected = {
  UPSTREAM_REPOSITORY: 'https://github.com/deepseek-ai/deepseek-harness.git',
}

for (const [file, value] of Object.entries(expected)) {
  const actual = (await readFile(resolve(root, file), 'utf8')).trim()
  if (actual !== value) throw new Error(`${file} must be ${value}, got ${actual}`)
}

verifyPinnedBaseline(root, upstreamTag, upstreamCommit)

const desktop = JSON.parse(await readFile(resolve(root, 'apps/desktop/package.json'), 'utf8'))
if (desktop.name !== '@deepseek-ai/dsh-desktop') throw new Error('official Electron desktop package is missing')
const patches = JSON.parse(await readFile(resolve(root, 'scripts/upstream-patches/manifest.json'), 'utf8'))
verifyPatches(root, upstreamCommit, patches)
verifyDependencies(root)
console.log(`verified DeepSeek Harness ${upstreamTag} (${upstreamCommit})`)
