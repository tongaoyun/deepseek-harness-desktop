import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import yaml from 'js-yaml'
import { artifactManifest, githubBuildVersion } from '../scripts/github-package.mjs'
import { gitPushFailureCode, githubSyncRequest, PACKAGE_WORKFLOW, selectPackagingWorkflow, synchronizeDesktop } from '../scripts/sync-github.mjs'
import { selectInstaller } from '../scripts/test-installed.mjs'
import { apply as recordHostModules } from './fixtures/desktop-module-diagnostics.mjs'

const commit = 'a'.repeat(40)
const tag = 'dsh-v0.2.1-alpha.2'
const repository = 'example/harness-desktop'
const identity = { PACKAGE_SOURCE_SHA: commit, GITHUB_RUN_NUMBER: '23', GITHUB_RUN_ATTEMPT: '2' }

test('Host diagnostics retain builtin module identities in workspace and installed layouts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-module-diagnostics-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const base of [
    'file:///workspace/packages/deepseek-harness-product/',
    'file:///Applications/Harness.app/Contents/Resources/app.asar/node_modules/@deepseek-harness/product-',
    'file:///C:/Harness/resources/app.asar/node_modules/@deepseek-harness/product-',
  ]) {
    const modules = ['experts/lib/remote.js', 'experts/lib/index.js', 'skills/lib/index.js'].map(path => base + path)
    const root = {}
    const output = join(directory, 'modules.json')
    recordHostModules({ root, effect: setup => setup(), appReady: { onReady: ready => ready() },
      loader: { ctx: { root }, internal: { loadCache: new Map([...modules, 'file:///unrelated/lib/index.js'].map(url => [url, {}])) },
        entries: () => [] } }, { output })
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { modules, loaderSharesRoot: true, includes: [] })
  }
})

test('installed acceptance rejects missing, ambiguous and non-native installer output', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-installer-selection-'))
  try {
    await assert.rejects(selectInstaller(directory, 'darwin'), /exactly one/u)
    writeFileSync(join(directory, 'harness.dmg'), '')
    assert.equal(await selectInstaller(directory, 'darwin'), join(directory, 'harness.dmg'))
    await assert.rejects(selectInstaller(directory, 'win32'), /exactly one/u)
    writeFileSync(join(directory, 'other.dmg'), '')
    await assert.rejects(selectInstaller(directory, 'darwin'), /exactly one/u)
    await assert.rejects(selectInstaller(directory, 'linux'), /Windows or macOS/u)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('source synchronization retries interrupted complete reads without leaking transport credentials', async () => {
  const progress = []
  let attempts = 0
  const request = githubSyncRequest('fixture-token', { sleep: async () => {}, progress: message => progress.push(message),
    fetchImpl: async (url, options) => {
      assert.equal(url, `https://api.github.com/repos/${repository}`)
      assert.equal(options.headers.Accept, 'application/vnd.github+json')
      assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28')
      assert.equal(options.headers.Authorization, 'Bearer fixture-token')
      attempts++
      if (attempts === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('proxy://user:fixture-password@host'), { code: 'ECONNRESET' }) })
      if (attempts === 2) return { ok: true, status: 200, json: async () => { throw Object.assign(new Error('interrupted body'), { code: 'UND_ERR_SOCKET' }) } }
      return Response.json({ private: false })
    } })
  assert.deepEqual(await request('GET', `/repos/${repository}`), { private: false })
  assert.equal(attempts, 3)
  assert.match(progress.join('\n'), /ECONNRESET/u)
  assert.doesNotMatch(progress.join('\n'), /fixture-password|fixture-token/u)
})

test('uncertain source mutations execute once and require reconciliation', async () => {
  for (const [method, path] of [['POST', '/user/repos'], ['POST', `/repos/${repository}/actions/workflows/product-desktop-package.yml/dispatches`],
    ['PUT', `/repos/${repository}/actions/permissions`]]) {
    let attempts = 0
    const request = githubSyncRequest('fixture-token', { fetchImpl: async () => {
      attempts++
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('fixture-secret'), { code: 'ETIMEDOUT' }) })
    } })
    await assert.rejects(request(method, path, { ref: 'main' }), error => {
      assert.match(error.message, /ETIMEDOUT.*reconcile before retrying/u)
      assert.equal(error.uncertainReleaseMutation, true)
      assert.doesNotMatch(error.message, /fixture-secret|fixture-token/u)
      return true
    })
    assert.equal(attempts, 1)
  }
})

function fixture(overrides = {}) {
  const calls = []
  const options = { repository, commit, tag, baseline: 'b'.repeat(40),
    request: async (method, path, body) => {
      calls.push({ method, path, body })
      if (path === '/user') return { login: 'example' }
      if (/^\/repos\/[^/]+\/[^/]+$/u.test(path) && method === 'GET') return { private: true, size: 1, default_branch: 'main', ...overrides }
      if (method === 'GET' && path.endsWith('/actions/permissions')) return { enabled: true, allowed_actions: 'selected' }
      if (method === 'GET' && path.endsWith('/selected-actions')) return { github_owned_allowed: true, verified_allowed: false,
        patterns_allowed: ['dtolnay/rust-toolchain@*', 'pnpm/action-setup@*'] }
      if (path.includes('/actions/workflows?')) return { workflows: [
        { id: 1, path: PACKAGE_WORKFLOW, state: 'disabled_manually' }, { id: 2, path: '.github/workflows/release.yml', state: 'active' },
      ] }
      return {}
    }, push: async (...args) => { calls.push({ push: args }) },
  }
  return { calls, options }
}

test('classifies Git network failures without disclosing credentials from diagnostics', () => {
  const secret = 'https://user:fixture-password@proxy.example'
  assert.equal(gitPushFailureCode({ stderr: `fatal: ${secret} SSL_ERROR_SYSCALL` }), 'TLS_HANDSHAKE_FAILED')
  assert.equal(gitPushFailureCode({ stderr: `fatal: ${secret} 407` }), 'PROXY_AUTHENTICATION')
  assert.equal(gitPushFailureCode({ stderr: `fatal: ${secret} connection timed out` }), 'NETWORK_TIMEOUT')
  assert.equal(gitPushFailureCode({ stderr: `fatal: ${secret} (non-fast-forward)` }), 'REMOTE_REF_CONFLICT')
  assert.equal(gitPushFailureCode({ stderr: secret, signal: 'SIGTERM' }), 'PROCESS_INTERRUPTED')
})

test('reconciles an uncertain atomic push only when both remote commits match without pushing again', async () => {
  for (const scenario of ['matching', 'mismatch', 'annotated']) {
    const mismatch = scenario === 'mismatch'
    const { options, calls } = fixture()
    const request = options.request
    let pushes = 0
    options.push = async () => { pushes++; throw new Error('TLS_HANDSHAKE_FAILED') }
    options.request = async (method, path, body) => {
      if (pushes && path.endsWith('/git/ref/heads/main')) return { object: { type: 'commit', sha: commit } }
      if (pushes && path.endsWith('/git/ref/tags/' + tag)) return { object: { type: scenario === 'annotated' ? 'tag' : 'commit', sha: (mismatch ? 'c' : 'b').repeat(40) } }
      if (path.endsWith('/git/tags/' + 'b'.repeat(40))) return { object: { type: 'commit', sha: 'b'.repeat(40) } }
      return request(method, path, body)
    }
    if (mismatch) await assert.rejects(synchronizeDesktop(options), /TLS_HANDSHAKE_FAILED/)
    else await synchronizeDesktop(options)
    assert.equal(pushes, 1)
    assert.equal(calls.some(call => call.path?.endsWith('/dispatches')), !mismatch)
  }
})

test('keeps platform versions stable across attempts of the same UTC-dated run', () => {
  assert.equal(githubBuildVersion(identity, '0.2.1-alpha.2', new Date('2026-10-12T03:00:00Z')), '0.2.1-alpha.2.20261012.23.1')
  assert.equal(githubBuildVersion(identity, '0.2.1', new Date('2026-10-12T03:00:00Z')), '0.2.1-test.20261012.23.1')
  assert.equal(githubBuildVersion({ ...identity, PACKAGE_BUILD_DATE: '2026-10-12T23:59:00Z' }, '0.2.1',
    new Date('2026-10-13T01:00:00Z')), '0.2.1-test.20261012.23.1')
  assert.throws(() => githubBuildVersion({ ...identity, PACKAGE_BUILD_DATE: 'bad' }, '0.2.1'))
  for (const invalid of [{ PACKAGE_SOURCE_SHA: 'main' }, { GITHUB_RUN_NUMBER: '0' }, { GITHUB_RUN_ATTEMPT: '2\nTOKEN=secret' }]) {
    assert.throws(() => githubBuildVersion({ ...identity, ...invalid }, '0.2.1'))
  }
})

test('refuses unknown visibility, forked, archived and unrelated build repositories before pushing', async () => {
  for (const invalid of [{ private: undefined }, { private: 'false' }, { fork: true }, { archived: true }, { default_branch: 'master' }]) {
    const { options, calls } = fixture(invalid)
    await assert.rejects(synchronizeDesktop(options))
    assert.equal(calls.some(call => call.push), false)
    assert.equal(calls.some(call => call.method === 'PUT'), false)
  }
})

test('synchronizes public and private source without changing visibility', async () => {
  for (const visibility of [false, true]) {
    const { options, calls } = fixture({ private: visibility })
    await synchronizeDesktop(options)
    assert.equal(calls.filter(call => call.push).length, 1)
    assert.equal(calls.some(call => call.body && Object.hasOwn(call.body, 'private')), false)
    assert.equal(calls.find(call => call.push).push[0], repository)
    assert.deepEqual(calls.find(call => call.path?.endsWith('/dispatches')).body, { ref: 'main', inputs: { source_sha: commit } })
  }
})

test('keeps configured mirror settings without a redundant mutation and still configures missing or enabled features', async () => {
  for (const patch of [{}, { has_issues: true }, { has_wiki: true }, { has_issues: undefined }, { size: 0, default_branch: 'master' }]) {
    const { options, calls } = fixture({ default_branch: 'main', has_issues: false, has_wiki: false, ...patch })
    const request = options.request
    options.request = async (method, path, body) => {
      if (method === 'PATCH' && Object.keys(patch).length === 0) assert.fail('Configured settings must not require another network write')
      return request(method, path, body)
    }
    await synchronizeDesktop(options)
    assert.equal(calls.filter(call => call.method === 'PATCH').length, Object.keys(patch).length === 0 ? 0 : 1)
    assert.ok(calls.some(call => call.path?.endsWith('/dispatches')))
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
      ? Array.from({ length: 100 }, (_, id) => ({ id: id + 2, path: `.github/workflows/official-${id}.yml`, state: 'active' }))
      : [{ id: 1, path: PACKAGE_WORKFLOW, state: 'disabled_manually' }] }
  }, repository)
  assert.equal(calls.filter(path => path.endsWith('/disable')).length, 100)
  assert.ok(calls.findIndex(path => path.endsWith('page=2')) < calls.findIndex(path => path.endsWith('/1/enable')))
})

test('repeated synchronization keeps already selected workflow states without forbidden disable calls', async () => {
  const calls = []
  await selectPackagingWorkflow(async (method, path) => {
    calls.push({ method, path })
    return { workflows: [
      { id: 1, path: PACKAGE_WORKFLOW, state: 'active' },
      { id: 2, path: '.github/workflows/release.yml', state: 'disabled_manually' },
      { id: 3, path: '.github/workflows/ci.yml', state: 'disabled_inactivity' },
      { id: 4, path: 'dynamic/dependabot/dependabot-updates', state: 'active' },
    ] }
  }, repository)
  assert.equal(calls.some(call => call.method === 'PUT'), false)
})

test('writes credential-free identities only after all required installers exist', () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-github-artifacts-'))
  try {
    writeFileSync(join(directory, 'Harness.zip'), 'archive')
    assert.throws(() => artifactManifest(directory, 'mac-arm64', commit, '0.2.1'), /\.dmg/u)
    writeFileSync(join(directory, 'Harness.dmg'), 'installer')
    writeFileSync(join(directory, '.env'), 'TOKEN=private')
    const manifest = artifactManifest(directory, 'mac-arm64', commit, '0.2.1')
    assert.equal(manifest.commit, commit)
    assert.equal(manifest.signing, 'unsigned')
    assert.deepEqual(manifest.artifacts.map(value => value.name), ['Harness.dmg', 'Harness.zip'])
    assert.ok(manifest.artifacts.every(value => /^[a-f0-9]{64}$/u.test(value.sha256)))
    assert.equal(JSON.stringify(manifest).includes('private'), false)
    rmSync(join(directory, 'Harness.zip'))
    assert.throws(() => artifactManifest(directory, 'mac-x64', commit, '0.2.1'), /Unsupported package target/u)
    writeFileSync(join(directory, 'Harness.exe'), '')
    assert.throws(() => artifactManifest(directory, 'win-x64', commit, '0.2.1'), /Empty/u)
    writeFileSync(join(directory, 'Other.dmg'), 'duplicate')
    assert.throws(() => artifactManifest(directory, 'mac-arm64', commit, '0.2.1'), /Expected one/u)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('hosted verification references existing tests after product migrations', () => {
  const source = readFileSync(new URL('../../../.github/workflows/product-desktop-package.yml', import.meta.url), 'utf8')
  const paths = [...source.matchAll(/\b((?:apps|packages|scripts)\/[\w./-]+(?:\.spec\.(?:ts|tsx)|\.test\.mjs|\.e2e\.ts))\b/gu)]
    .map(match => match[1])
  assert.ok(paths.length > 10)
  for (const path of paths) assert.ok(existsSync(new URL(`../../../${path}`, import.meta.url)), `Missing hosted test: ${path}`)
})

test('isolates signing and download credentials from native hosted builds', () => {
  const source = readFileSync(new URL('../../../.github/workflows/product-desktop-package.yml', import.meta.url), 'utf8')
  const workflow = yaml.load(source)
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' })
  assert.deepEqual(workflow.jobs.package.strategy.matrix.include, [
    { target: 'win-x64', runner: 'windows-2025', arch: 'x64' },
    { target: 'mac-arm64', runner: 'macos-15', arch: 'arm64' },
  ])
  const preflightSteps = workflow.jobs.preflight.steps
  const steps = workflow.jobs.package.steps
  assert.match(preflightSteps.find(step => step.name === 'Test acceptance process cleanup').run,
    /node --test apps\/product-desktop\/tests\/acceptance-process\.test\.mjs/u)
  assert.match(preflightSteps.find(step => step.name === 'Test Electron close lifecycle').run,
    /pnpm exec vitest run apps\/product-desktop\/tests\/close-electron\.spec\.ts/u)
  for (const name of ['Package Windows', 'Validate Windows signatures', 'Test all Windows installer languages']) {
    assert.equal(steps.find(step => step.name === name).shell, 'pwsh')
  }
  assert.ok(preflightSteps.findIndex(step => step.name === 'Fetch stored Harness baseline') < preflightSteps.findIndex(step => step.run?.includes('verify:upstream')))
  assert.ok(steps.findIndex(step => step.name === 'Install locked dependencies') < steps.findIndex(step => step.name === 'Verify source and native architecture'))
  assert.match(steps.find(step => step.name === 'Package Windows').run, /apps\/product-desktop run package win-x64 @ModeArgs/u)
  assert.match(steps.find(step => step.name === 'Package Windows').run, /PACKAGE_SIGNING -eq 'signed'/u)
  const windowsArgumentsIndex = steps.findIndex(step => step.name === 'Test Windows packaging arguments')
  assert.ok(windowsArgumentsIndex >= 0 && windowsArgumentsIndex < steps.findIndex(step => step.name === 'Package Windows'))
  assert.equal(steps[windowsArgumentsIndex].if, "matrix.target == 'win-x64'")
  assert.match(steps[windowsArgumentsIndex].run, /node --test apps\/product-desktop\/tests\/windows-package-arguments\.test\.mjs/u)
  assert.match(steps[windowsArgumentsIndex].run, /apps\/product-desktop\/tests\/windows-processes\.test\.mjs/u)
  assert.match(steps.find(step => step.name === 'Package macOS').run, /mode_args\+=\(--unsigned\)/u)
  assert.equal(workflow.jobs.package.needs, 'preflight')
  assert.match(workflow.jobs.package['runs-on'], /DESKTOP_SIGNING_RUNNERS/u)
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.signing.options, ['unsigned', 'internal', 'signed'])
  assert.match(steps.find(step => step.name === 'Upload installers').with.path, /\*-nightly\.yml/u)
  const archiveIndex = steps.findIndex(step => step.name === 'Test archived Host startup')
  assert.ok(archiveIndex > steps.findIndex(step => step.name === 'Package Windows'))
  assert.ok(archiveIndex > steps.findIndex(step => step.name === 'Package macOS'))
  assert.ok(archiveIndex < steps.findIndex(step => step.name === 'Upload installers'))
  assert.match(steps[archiveIndex].run, /host-process-archive\.built\.e2e\.ts --retry=0/u)
  assert.match(steps.find(step => step.name === 'Upload installers').with.path, /build-manifest\.json/u)
  assert.equal(steps.find(step => step.name === 'Upload installers').with['retention-days'], 1)
  const uiIndex = steps.findIndex(step => step.name === 'Test native Electron UI profiles')
  const installedIndex = steps.findIndex(step => step.name === 'Test installed product desktop')
  assert.ok(installedIndex > uiIndex)
  assert.ok(installedIndex < steps.findIndex(step => step.name === 'Upload desktop UI evidence'))
  assert.ok(installedIndex < steps.findIndex(step => step.name === 'Upload installers'))
  assert.match(steps[installedIndex].run, /test:installed --target/u)
  const windowsInstalledIndex = steps.findIndex(step => step.name === 'Test installed Windows product desktop')
  assert.ok(windowsInstalledIndex > uiIndex)
  assert.ok(windowsInstalledIndex < steps.findIndex(step => step.name === 'Upload desktop UI evidence'))
  assert.equal(steps[windowsInstalledIndex].shell, 'pwsh')
  assert.equal(steps[windowsInstalledIndex].if, "matrix.target == 'win-x64'")
  assert.match(steps[windowsInstalledIndex].run, /LASTEXITCODE/u)
  const ui = steps[uiIndex]
  assert.ok(uiIndex > steps.findIndex(step => step.name === 'Package Windows'))
  assert.ok(uiIndex > steps.findIndex(step => step.name === 'Package macOS'))
  assert.ok(uiIndex < steps.findIndex(step => step.name === 'Record verified artifact checksums'))
  assert.equal(ui.if, undefined)
  assert.deepEqual(ui.env, { DSH_DESKTOP_SMOKE: '1', DSH_SNAPSHOT: 'replay' })
  assert.match(ui.run, /--config vitest\.web\.config\.ts/u)
  assert.match(ui.run, /boots the built \.\* Electron assembly/u)
  const evidence = steps.find(step => step.name === 'Upload desktop UI evidence')
  assert.equal(evidence.if, 'always()')
  assert.equal(evidence.with['include-hidden-files'], true)
  assert.equal(evidence.with['if-no-files-found'], 'error')
  assert.match(evidence.with.path, /desktop-ui-.*\.json/u)
  assert.match(evidence.with.path, /electron-\*\.png/u)
  assert.equal(evidence.with['retention-days'], 14)
  const packagingEvidence = steps.find(step => step.name === 'Upload packaging diagnostics')
  assert.equal(packagingEvidence.if, 'always()')
  assert.equal(packagingEvidence.with['include-hidden-files'], true)
  assert.deepEqual(packagingEvidence.with.path.trim().split('\n'), [
    'apps/desktop/.desktop-build/packaging-runs/**/events.jsonl',
    'apps/desktop/.desktop-build/packaging-runs/**/*.log',
  ])
  assert.equal(packagingEvidence.with['retention-days'], 14)
  assert.doesNotMatch(steps.find(step => step.name === 'Upload installers').with.path, /desktop-ui|electron-\*/u)
  assert.doesNotMatch(source, /192\.168\.|release:publish|upload:latest|CSC_LINK|APPLE_API_KEY/u)
  const secretNames = [...source.matchAll(/secrets\.([A-Z_]+)/gu)].map(match => match[1])
  assert.deepEqual([...new Set(secretNames)].sort(), ['DESKTOP_DOWNLOADS_TOKEN', 'DESKTOP_INTERNAL_MAC_CERTIFICATE', 'DESKTOP_INTERNAL_MAC_PASSWORD'])
  const stage = workflow.jobs.stage
  assert.deepEqual(stage.needs, ['preflight', 'package'])
  assert.equal(stage.steps.find(step => step.env?.DESKTOP_DOWNLOADS_TOKEN).name, 'Upload and fully verify download draft')
  assert.equal(stage.steps.filter(step => JSON.stringify(step).includes('secrets.')).length, 1)
  assert.match(stage.steps.at(-1).run, /stage-github-release\.mjs/u)
  assert.doesNotMatch(JSON.stringify(workflow.jobs.package.env), /secrets\./u)
  const signingTest = steps.findIndex(step => step.name === 'Test macOS signing identity')
  assert.ok(signingTest >= 0 && signingTest < steps.findIndex(step => step.name === 'Package macOS'))
  assert.equal(steps[signingTest].if, "matrix.target != 'win-x64'")
  assert.match(steps[signingTest].run, /internal-macos-signing\.test\.mjs/u)
  for (const step of steps.filter(step => !['Package macOS', 'Test installed product desktop'].includes(step.name))) {
    assert.doesNotMatch(JSON.stringify(step), /secrets\./u)
  }
})

test('isolates reusable downloads and Rust compilation by native target before packaging', () => {
  const workflow = yaml.load(readFileSync(new URL('../../../.github/workflows/product-desktop-package.yml', import.meta.url), 'utf8'))
  const job = workflow.jobs.package
  const steps = job.steps
  const install = steps.findIndex(step => step.name === 'Install locked dependencies')
  const downloads = steps.find(step => step.name === 'Cache desktop downloads and package store')
  const rust = steps.find(step => step.name === 'Cache Rust compilation')
  for (const cache of [downloads, rust]) {
    assert.match(cache.uses, /^actions\/cache@/u)
    assert.ok(steps.indexOf(cache) < install)
    assert.match(cache.with.key, /runner\.os.*matrix\.target/u)
    assert.match(cache.with['restore-keys'], /runner\.os.*matrix\.target/u)
    assert.doesNotMatch(cache.with.path, /desktop-build|artifacts|certificate|keychain/u)
  }
  const configure = steps.find(step => step.name === 'Configure desktop cache directories')
  assert.ok(steps.indexOf(configure) < steps.indexOf(downloads))
  assert.match(configure.run, /process\.env\.RUNNER_TEMP/u)
  assert.match(configure.run, /process\.env\.GITHUB_ENV/u)
  assert.match(configure.run, /DSH_DESKTOP_PACKAGE_CACHE_DIR.*harness-desktop-package-cache/u)
  assert.match(configure.run, /ELECTRON_BUILDER_CACHE.*harness-desktop-builder-cache/u)
  assert.doesNotMatch(JSON.stringify(job.env), /runner\.temp/u)
  assert.match(downloads.with.path, /env\.DSH_DESKTOP_PACKAGE_CACHE_DIR/u)
  assert.match(downloads.with.path, /env\.ELECTRON_BUILDER_CACHE/u)
  assert.match(downloads.with.key, /pnpm-lock\.yaml.*primary-runtime\/lock\.json/u)
  assert.equal(steps.find(step => step.name === 'Set up Rust').id, 'rust')
  assert.match(rust.with.key, /steps\.rust\.outputs\.cachekey/u)
  assert.match(rust.with.key, /Cargo\.lock.*Cargo\.toml.*src\/\*\*/u)
  assert.match(rust.with.path, /env\.CARGO_TARGET_DIR/u)
  assert.match(configure.run, /CARGO_TARGET_DIR.*harness-desktop-rust/u)
  assert.match(configure.run, /PNPM_CONFIG_CACHE_DIR.*harness-pnpm-metadata-cache/u)
  assert.match(downloads.with.path, /env\.PNPM_CONFIG_CACHE_DIR/u)
})

test('internal synchronization fetches main and its own baseline without disclosing the token', () => {
  const source = readFileSync(new URL('../../../.gitea/workflows/github-desktop-sync.yml', import.meta.url), 'utf8')
  const workflow = yaml.load(source)
  assert.equal(workflow.jobs.sync.steps[0].with.ref, "${{ inputs.github_run_id && 'main' || inputs.source_sha || 'main' }}")
  assert.equal(workflow.jobs.sync.steps[0].with['fetch-depth'], 0)
  assert.doesNotMatch(source, /--depth[= ]/u)
  assert.match(source, /secrets\.DESKTOP_GITHUB_TOKEN/u)
  assert.doesNotMatch(source, /--force|--mirror|--delete|https:\/\/\$.*TOKEN/u)
  assert.match(source, /verify:upstream/u)
  assert.match(source, /deliver-desktop\.mjs/u)
  assert.match(source, /vars\.DESKTOP_GITHUB_DOWNLOAD_REPOSITORY/u)
  assert.equal(workflow.jobs.sync['timeout-minutes'], 180)
  const sync = workflow.jobs.sync.steps.find(step => step.name === 'Verify source and synchronize')
  assert.equal(sync.env.HTTPS_PROXY, '${{ secrets.DESKTOP_GITHUB_PROXY_URL }}')
  assert.equal(sync.env.NODE_USE_ENV_PROXY, '1')
  assert.equal(sync.env.DESKTOP_SOURCE_SHA, '${{ inputs.source_sha }}')
  assert.equal(sync.env.GIT_CONFIG_KEY_0, 'http.https://github.com/.version')
  assert.equal(sync.env.GIT_CONFIG_VALUE_0, 'HTTP/1.1')
  assert.deepEqual(workflow.jobs.sync.steps.filter(step => step.env?.HTTPS_PROXY !== undefined).map(step => step.name),
    ['Install locked dependencies', 'Verify source and synchronize'])
})


test('reuses identical remote source and converged settings without another push or settings write', async () => {
  const { options, calls } = fixture({ has_issues: false, has_wiki: false })
  const request = options.request
  options.request = async (method, path, body) => {
    if (path.endsWith('/git/ref/heads/main')) return { object: { type: 'commit', sha: commit } }
    if (path.endsWith('/git/ref/tags/' + tag)) return { object: { type: 'commit', sha: options.baseline } }
    if (path.includes('/actions/workflows?')) return { workflows: [{ id: 1, path: PACKAGE_WORKFLOW, state: 'active' }] }
    return request(method, path, body)
  }
  await synchronizeDesktop(options)
  assert.equal(calls.some(call => call.push || ['PUT', 'PATCH'].includes(call.method)), false)
  assert.equal(calls.filter(call => call.path?.endsWith('/dispatches')).length, 1)
})

test('continues an uncertain settings write only after reading the desired state', async () => {
  for (const confirmed of [true, false]) {
    const { options, calls } = fixture()
    const request = options.request
    let wrote = false
    options.request = async (method, path, body) => {
      if (path.endsWith('/actions/permissions') && method === 'PUT' && body.enabled === false) {
        wrote = true
        throw Object.assign(new Error('uncertain setting'), { uncertainReleaseMutation: true })
      }
      if (path.endsWith('/actions/permissions') && method === 'GET' && wrote) return { enabled: !confirmed }
      return request(method, path, body)
    }
    if (confirmed) await synchronizeDesktop(options)
    else await assert.rejects(synchronizeDesktop(options), /uncertain setting/)
    assert.equal(calls.some(call => call.push), confirmed)
  }
})

test('confirms an uncertain dispatch by the exact delivery identity without posting twice', async () => {
  const { options } = fixture()
  const request = options.request
  const deliveryId = '12345678-1234-1234-1234-123456789abc'
  let posts = 0
  options.request = async (method, path, body) => {
    if (path.endsWith('/dispatches')) {
      posts++
      throw Object.assign(new Error('lost dispatch response'), { uncertainReleaseMutation: true })
    }
    if (path.includes('/runs?')) return { workflow_runs: [{ id: 72, display_title: `Desktop ${commit} / ${deliveryId}`,
      head_sha: commit, event: 'workflow_dispatch', path: PACKAGE_WORKFLOW, status: 'in_progress' }] }
    return request(method, path, body)
  }
  await synchronizeDesktop({ ...options, deliveryId })
  assert.equal(posts, 1)
})

test('caches only successful full installer regression and always accepts the actual Windows product', () => {
  const workflow = yaml.load(readFileSync('.github/workflows/product-desktop-package.yml', 'utf8'))
  const steps = workflow.jobs.package.steps
  const lookup = steps.find(step => step.id === 'installer-regression')
  assert.equal(lookup.with['lookup-only'], true)
  for (const path of ['pnpm-lock.yaml', 'apps/desktop/installer/**', 'apps/desktop/resources/**', 'apps/desktop/assembly.json', 'apps/desktop/scripts/**', 'apps/desktop/tests/windows-*']) {
    assert.ok(lookup.with.key.includes(path))
  }
  const regression = steps.findIndex(step => step.name === 'Test all Windows installer languages')
  assert.match(steps[regression].if, /full_installer_regression.*cache-hit/u)
  const save = steps.findIndex(step => step.name === 'Save verified Windows installer inputs')
  assert.ok(save > regression)
  assert.doesNotMatch(steps[save].if, /always|failure/u)
  assert.equal(steps.find(step => step.name === 'Test installed Windows product desktop').if, "matrix.target == 'win-x64'")
})
