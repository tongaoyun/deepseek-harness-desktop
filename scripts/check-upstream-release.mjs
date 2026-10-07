import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TAG_PATTERN = /^dsh-v(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/u
const CHANNEL_ORDER = new Map([['alpha', 0], ['beta', 1], ['rc', 2], ['stable', 3]])

/** @param {string} tag @returns {{ tag: string, major: number, minor: number, patch: number, channel: string, iteration: number }} */
export function parseReleaseTag(tag) {
  const match = TAG_PATTERN.exec(tag)
  if (!match) throw new Error(`Invalid DeepSeek Harness release tag: ${tag}`)
  return {
    tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    channel: match[4] ?? 'stable',
    iteration: Number(match[5] ?? 0),
  }
}

/** @param {ReturnType<typeof parseReleaseTag>} left @param {ReturnType<typeof parseReleaseTag>} right @returns {number} */
export function compareReleases(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    const difference = left[key] - right[key]
    if (difference !== 0) return difference
  }
  const channelDifference = CHANNEL_ORDER.get(left.channel) - CHANNEL_ORDER.get(right.channel)
  return channelDifference || left.iteration - right.iteration
}

/** @param {string} pinnedTag @param {readonly string[]} availableTags @returns {{ update: string | null, preview: string | null }} */
export function inspectAvailableReleases(pinnedTag, availableTags) {
  const pinned = parseReleaseTag(pinnedTag)
  const releases = [...new Set(availableTags)].filter(tag => TAG_PATTERN.test(tag))
    .map(parseReleaseTag).toSorted(compareReleases)
  const eligible = releases.filter(release => release.channel === 'rc' || release.channel === 'stable')
  const update = eligible.findLast(release => compareReleases(release, pinned) > 0)?.tag ?? null
  const preview = releases.findLast(release => compareReleases(release, pinned) > 0)?.tag ?? null
  return { update, preview: preview === update ? null : preview }
}

async function main() {
  const pinnedTag = (await readFile(resolve(root, 'UPSTREAM_TAG'), 'utf8')).trim()
  const repository = (await readFile(resolve(root, 'UPSTREAM_REPOSITORY'), 'utf8')).trim()
  const { stdout } = await run('git', ['ls-remote', '--tags', '--refs', repository, 'dsh-v*'], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  })
  const availableTags = stdout.split('\n').filter(Boolean).map(line => line.split('\t')[1])
    .filter(Boolean).map(reference => reference.replace('refs/tags/', ''))
  if (availableTags.length === 0) throw new Error('DeepSeek Harness upstream returned no release tags')
  const result = inspectAvailableReleases(pinnedTag, availableTags)
  if (result.preview) console.log(`Preview available (not selected automatically): ${result.preview}`)
  if (!result.update) {
    console.log(`Pinned Harness release remains current: ${pinnedTag}`)
    return
  }
  console.log(`Harness RC/stable update available: ${pinnedTag} -> ${result.update}`)
  if (process.argv.includes('--fail-on-update')) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
