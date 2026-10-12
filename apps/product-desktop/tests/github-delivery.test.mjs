import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import yaml from 'js-yaml'
import { artifactManifest, githubBuildVersion } from '../scripts/github-package.mjs'
import { PACKAGE_WORKFLOW, selectPackagingWorkflow, synchronizeDesktop } from '../scripts/sync-github.mjs'

const commit = 'a'.repeat(40)
const tag = 'dsh-v0.2.1-alpha.2'
const repository = 'example/harness-desktop'
const identity = { PACKAGE_SOURCE_SHA: commit, GITHUB_RUN_NUMBER: '23', GITHUB_RUN_ATTEMPT: '2' }

function fixture(overrides = {}) {
  const calls = []
  const options = { repository, commit, tag,
    request: async (method, path, body) => {
      calls.push({ method, path, body })
      if (path === '/user') return { login: 'example' }
      if (/^\/repos\/[^/]+\/[^/]+$/u.test(path) && method === 'GET') return { private: true, size: 1, default_branch: 'main', ...overrides }
      if (path.includes('/actions/workflows?')) return { workflows: [
        { id: 1, path: PACKAGE_WORKFLOW }, { id: 2, path: '.github/workflows/release.yml' },
      ] }
      return {}
    }, push: async (...args) => { calls.push({ push: args }) },
  }
  return { calls, options }
}

test('numbers each platform with the same source, UTC date, run and attempt', () => {
  assert.equal(githubBuildVersion(identity, '0.2.1-alpha.2', new Date('2026-10-12T03:00:00Z')), '0.2.1-alpha.2.20261012.23.2')
  assert.equal(githubBuildVersion(identity, '0.2.1', new Date('2026-10-12T03:00:00Z')), '0.2.1-test.20261012.23.2')
  for (const invalid of [{ PACKAGE_SOURCE_SHA: 'main' }, { GITHUB_RUN_NUMBER: '0' }, { GITHUB_RUN_ATTEMPT: '2\nTOKEN=secret' }]) {
    assert.throws(() => githubBuildVersion({ ...identity, ...invalid }, '0.2.1'))
  }
})

test('refuses public, forked, archived and unrelated build repositories before pushing', async () => {
  for (const invalid of [{ private: false }, { fork: true }, { archived: true }, { default_branch: 'master' }]) {
    const { options, calls } = fixture(invalid)
    await assert.rejects(synchronizeDesktop(options))
    assert.equal(calls.some(call => call.push), false)
    assert.equal(calls.some(call => call.method === 'PUT'), false)
  }
})

test('rejects malformed destinations and unpinned source before accessing GitHub', async () => {
  for (const invalid of [{ repository: 'https://github.com/example/repo' }, { repository: 'example/repo?token=secret' },
    { commit: 'main' }, { tag: 'latest' }]) {
    const { options, calls } = fixture()
    await assert.rejects(synchronizeDesktop({ ...options, ...invalid }))
    assert.deepEqual(calls, [])
  }
})

test('disables Actions during source upload, selects only packaging, then dispatches the exact commit', async () => {
  const { options, calls } = fixture()
  await synchronizeDesktop(options)
  const disable = calls.findIndex(call => call.body?.enabled === false)
  const push = calls.findIndex(call => call.push)
  const upstreamDisable = calls.findIndex(call => call.path?.endsWith('/2/disable'))
  const enable = calls.findIndex(call => call.body?.enabled === true)
  assert.ok(disable < push && push < upstreamDisable && upstreamDisable < enable)
  assert.deepEqual(calls[push].push, [repository, commit, tag])
  assert.equal(calls.some(call => call.path?.endsWith('/1/enable')), true)
  assert.deepEqual(calls.at(-1).body, { ref: 'main', inputs: { source_sha: commit } })
  assert.equal(calls.some(call => call.path?.includes('/releases')), false)
})

test('creates only a private empty repository under the authenticated owner or selected organization', async () => {
  for (const owner of ['example', 'enterprise']) {
    const { options, calls } = fixture()
    await synchronizeDesktop({ ...options, repository: `${owner}/harness-desktop`, create: true })
    const creation = calls.find(call => call.method === 'POST' && call.path.endsWith('/repos'))
    assert.equal(creation.path, owner === 'example' ? '/user/repos' : '/orgs/enterprise/repos')
    assert.equal(creation.body.private, true)
    assert.equal(creation.body.auto_init, false)
  }
})

test('upload and workflow failures leave Actions disabled and never dispatch', async () => {
  for (const failure of ['push', 'workflow']) {
    const { options, calls } = fixture()
    if (failure === 'push') options.push = async () => { throw new Error('divergent branch') }
    else {
      const request = options.request
      options.request = async (...args) => args[1].includes('/actions/workflows?') ? { workflows: [] } : request(...args)
    }
    await assert.rejects(synchronizeDesktop(options))
    assert.equal(calls.some(call => call.body?.enabled === false), true)
    assert.equal(calls.some(call => call.body?.enabled === true), false)
    assert.equal(calls.some(call => call.path?.endsWith('/dispatches')), false)
  }
})

test('inspects every workflow page before enabling packaging', async () => {
  const calls = []
  await selectPackagingWorkflow(async (method, path) => {
    calls.push(path)
    if (method !== 'GET') return {}
    return { workflows: path.endsWith('page=1')
      ? Array.from({ length: 100 }, (_, id) => ({ id: id + 2, path: `.github/workflows/official-${id}.yml` }))
      : [{ id: 1, path: PACKAGE_WORKFLOW }] }
  }, repository)
  assert.equal(calls.filter(path => path.endsWith('/disable')).length, 100)
  assert.ok(calls.findIndex(path => path.endsWith('page=2')) < calls.findIndex(path => path.endsWith('/1/enable')))
})

test('writes credential-free identities only after all required installers exist', () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-github-artifacts-'))
  try {
    writeFileSync(join(directory, 'Harness.dmg'), 'installer')
    assert.throws(() => artifactManifest(directory, 'mac-arm64', commit, '0.2.1'), /\.zip/u)
    writeFileSync(join(directory, 'Harness.zip'), 'archive')
    writeFileSync(join(directory, '.env'), 'TOKEN=private')
    const manifest = artifactManifest(directory, 'mac-arm64', commit, '0.2.1')
    assert.equal(manifest.commit, commit)
    assert.equal(manifest.signing, 'unsigned')
    assert.deepEqual(manifest.artifacts.map(value => value.name), ['Harness.dmg', 'Harness.zip'])
    assert.ok(manifest.artifacts.every(value => /^[a-f0-9]{64}$/u.test(value.sha256)))
    assert.equal(JSON.stringify(manifest).includes('private'), false)
    writeFileSync(join(directory, 'Harness.exe'), '')
    assert.throws(() => artifactManifest(directory, 'win-x64', commit, '0.2.1'), /Empty/u)
    writeFileSync(join(directory, 'Other.dmg'), 'duplicate')
    assert.throws(() => artifactManifest(directory, 'mac-arm64', commit, '0.2.1'), /Expected one/u)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('uses three native hosted runners and product packaging without publishing or signing credentials', () => {
  const source = readFileSync(new URL('../../../.github/workflows/product-desktop-package.yml', import.meta.url), 'utf8')
  const workflow = yaml.load(source)
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.deepEqual(workflow.jobs.package.strategy.matrix.include, [
    { target: 'win-x64', runner: 'windows-2025', arch: 'x64' },
    { target: 'mac-arm64', runner: 'macos-15', arch: 'arm64' },
    { target: 'mac-x64', runner: 'macos-15-intel', arch: 'x64' },
  ])
  const steps = workflow.jobs.package.steps
  for (const name of ['Package Windows', 'Validate Windows signatures and installer lifecycle']) {
    assert.equal(steps.find(step => step.name === name).shell, 'pwsh')
  }
  assert.ok(steps.findIndex(step => step.name === 'Fetch stored Harness baseline') < steps.findIndex(step => step.run?.includes('verify:upstream')))
  assert.ok(steps.findIndex(step => step.name === 'Install locked dependencies') < steps.findIndex(step => step.name === 'Verify source and native architecture'))
  assert.match(steps.find(step => step.name === 'Package Windows').run, /apps\/product-desktop run package win-x64 --unsigned/u)
  assert.match(steps.find(step => step.name === 'Package macOS').run, /apps\/product-desktop run package.*--unsigned/u)
  assert.match(steps.find(step => step.name === 'Upload installers').with.path, /build-manifest\.json/u)
  assert.doesNotMatch(source, /192\.168\.|secrets\.|release:publish|upload:latest|CSC_LINK|APPLE_API_KEY/u)
})

test('internal synchronization fetches main and its own baseline without disclosing the token', () => {
  const source = readFileSync(new URL('../../../.gitea/workflows/github-desktop-sync.yml', import.meta.url), 'utf8')
  const workflow = yaml.load(source)
  assert.equal(workflow.jobs.sync.steps[0].with.ref, 'main')
  assert.match(source, /secrets\.GITHUB_DESKTOP_TOKEN/u)
  assert.doesNotMatch(source, /--force|--mirror|--delete|https:\/\/\$.*TOKEN/u)
  assert.match(source, /verify:upstream/u)
})
