import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function verifyReleaseIdentity({ refName, commit, mainCommit, version }) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'package.json contains an invalid release version')
  assert.equal(refName, `v${version}`, `Release tag ${refName} does not match package version ${version}`)
  assert.match(commit, /^[0-9a-f]{40}$/i, 'GITHUB_SHA must be a full commit SHA')
  assert.equal(commit.toLowerCase(), mainCommit.toLowerCase(), 'Release tag must point to the current main commit')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  execFileSync('git', ['fetch', '--force', '--no-tags', '--depth=1', 'origin', 'main:refs/remotes/origin/main'], { stdio: 'inherit' })
  const mainCommit = execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim()
  verifyReleaseIdentity({
    refName: process.env.GITHUB_REF_NAME,
    commit: process.env.GITHUB_SHA,
    mainCommit,
    version: packageJson.version,
  })
  console.log(`Release ${process.env.GITHUB_REF_NAME} points to current main commit ${mainCommit}`)
}
