/** Upload and fully read back a download draft on GitHub; internal delivery owns final publication. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiClient, downloadDesktopRelease, releaseDestination } from './deliver-desktop.mjs'
import { stageDesktopRelease } from './desktop-release.mjs'
import { productSigningMode } from './update-release.mjs'

async function main() {
  const { GITHUB_REPOSITORY: repository, PACKAGE_DOWNLOAD_REPOSITORY: downloads, GITHUB_RUN_ID: runId,
    PACKAGE_SOURCE_SHA: commit, GH_TOKEN: readToken, DESKTOP_DOWNLOADS_TOKEN: writeToken } = process.env
  if (![repository, downloads].every(value => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value ?? ''))
    || repository === downloads || !/^[1-9]\d*$/u.test(runId ?? '') || !/^[a-f0-9]{40}$/u.test(commit ?? '')
    || !readToken || !writeToken) throw new Error('Hosted staging requires exact source, run and separate build/download credentials')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (head !== commit || execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) {
    throw new Error('Hosted staging requires a clean checkout of the requested source')
  }
  const signing = productSigningMode(process.env.PACKAGE_SIGNING)
  const build = apiClient('https://api.github.com', `Bearer ${readToken}`)
  const github = apiClient('https://api.github.com', `Bearer ${writeToken}`)
  const destination = await github.request('GET', `/repos/${downloads}`)
  if (destination.private !== false || destination.archived || destination.fork || !destination.permissions?.push) {
    throw new Error('Hosted downloads require a writable public repository')
  }
  const run = await build.request('GET', `/repos/${repository}/actions/runs/${runId}`)
  if (run.id !== Number(runId)) throw new Error('Hosted build run identity changed')
  const version = JSON.parse(await readFile(new URL('../../desktop/package.json', import.meta.url), 'utf8')).version
  const directory = await mkdtemp(join(tmpdir(), 'harness-hosted-stage-'))
  try {
    const release = await downloadDesktopRelease(build, repository, run, directory, commit, version, {
      signing, downloadRepository: downloads, internalCertificateSHA256: process.env.PACKAGE_INTERNAL_CERTIFICATE_SHA256,
    })
    await stageDesktopRelease(release, [releaseDestination('GitHub downloads', github, downloads,
      { github: true, target: destination.default_branch })])
    console.log(`Fully verified hosted draft ${release.tag}; internal delivery must finalize both destinations`)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

try { await main() }
catch (error) { console.error(error instanceof Error ? error.message : 'Hosted release staging failed'); process.exitCode = 1 }
