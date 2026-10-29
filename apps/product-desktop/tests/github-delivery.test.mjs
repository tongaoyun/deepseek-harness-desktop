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
      if (path.endsWith('/git/ref/heads/main')) return { object: { type: 'commit', sha: commit } }
      if (path.endsWith('/git/ref/tags/' + tag)) return { object: { type: scenario === 'annotated' ? 'tag' : 'commit', sha: (mismatch ? 'c' : 'b').repeat(40) } }
      if (path.endsWith('/git/tags/' + 'b'.repeat(40))) return { object: { type: 'commit', sha: 'b'.repeat(40) } }
      return request(method, path, body)
    }
    if (mismatch) await assert.rejects(synchronizeDesktop(options), /TLS_HANDSHAKE_FAILED/)
    else await synchronizeDesktop(options)
    assert.equal(pushes, 1)
    assert.equal(calls.some(call => call.path?.endsWith('/dispatches')), !mismatch)
  }
})

test('numbers each platform with the same source, UTC date, run and attempt', () => {
  assert.equal(githubBuildVersion(identity, '0.2.1-alpha.2', new Date('2026-10-12T03:00:00Z')), '0.2.1-alpha.2.20261012.23.2')
  assert.equal(githubBuildVersion(identity, '0.2.1', new Date('2026-10-12T03:00:00Z')), '0.2.1-test.20261012.23.2')
  assert.equal(githubBuildVersion({ ...identity, PACKAGE_BUILD_DATE: '2026-10-12T23:59:00Z' }, '0.2.1',
    new Date('2026-10-13T01:00:00Z')), '0.2.1-test.20261012.23.2')
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
    assert.deepEqual(artifactManifest(directory, 'mac-x64', commit, '0.2.1').artifacts.map(value => value.name), ['Harness.dmg'])
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

test('uses native hosted development runners or explicitly configured signing machines without publishing credentials', () => {
  const source = readFileSync(new URL('../../../.github/workflows/product-desktop-package.yml', import.meta.url), 'utf8')
  const workflow = yaml.load(source)
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' })
  assert.deepEqual(workflow.jobs.package.strategy.matrix.include, [
    { target: 'win-x64', runner: 'windows-2025', arch: 'x64' },
    { target: 'mac-arm64', runner: 'macos-15', arch: 'arm64' },
    { target: 'mac-x64', runner: 'macos-15-intel', arch: 'x64' },
  ])
  const preflightSteps = workflow.jobs.preflight.steps
  const steps = workflow.jobs.package.steps
  assert.match(preflightSteps.find(step => step.name === 'Test acceptance process cleanup').run,
    /node --test apps\/product-desktop\/tests\/acceptance-process\.test\.mjs/u)
  assert.match(preflightSteps.find(step => step.name === 'Test Electron close lifecycle').run,
    /pnpm exec vitest run apps\/product-desktop\/tests\/close-electron\.spec\.ts/u)
  for (const name of ['Package Windows', 'Validate Windows signatures and installer lifecycle']) {
    assert.equal(steps.find(step => step.name === name).shell, 'pwsh')
  }
  assert.ok(preflightSteps.findIndex(step => step.name === 'Fetch stored Harness baseline') < preflightSteps.findIndex(step => step.run?.includes('verify:upstream')))
  assert.ok(steps.findIndex(step => step.name === 'Install locked dependencies') < steps.findIndex(step => step.name === 'Verify source and native architecture'))
  const productModulesIndex = steps.findIndex(step => step.name === 'Build product modules for packaging and acceptance tests')
  assert.ok(productModulesIndex > steps.findIndex(step => step.name === 'Install locked dependencies'))
  assert.ok(productModulesIndex < steps.findIndex(step => step.name === 'Package Windows'))
  assert.ok(productModulesIndex < steps.findIndex(step => step.name === 'Package macOS'))
  assert.match(steps[productModulesIndex].run, /@deepseek-harness\/product-skills.*@deepseek-harness\/product-experts.*build/u)
  assert.match(steps.find(step => step.name === 'Package Windows').run, /apps\/product-desktop run package win-x64 @ModeArgs/u)
  assert.match(steps.find(step => step.name === 'Package Windows').run, /PACKAGE_SIGNING -eq 'signed'/u)
  const windowsArgumentsIndex = steps.findIndex(step => step.name === 'Test Windows packaging arguments')
  assert.ok(windowsArgumentsIndex >= 0 && windowsArgumentsIndex < steps.findIndex(step => step.name === 'Package Windows'))
  assert.equal(steps[windowsArgumentsIndex].if, "matrix.target == 'win-x64'")
  assert.match(steps[windowsArgumentsIndex].run, /node --test apps\/product-desktop\/tests\/windows-package-arguments\.test\.mjs/u)
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
  const packagingEvidence = steps.find(step => step.name === 'Upload failed packaging diagnostics')
  assert.equal(packagingEvidence.if, 'failure()')
  assert.equal(packagingEvidence.with['include-hidden-files'], true)
  assert.deepEqual(packagingEvidence.with.path.trim().split('\n'), [
    'apps/desktop/.desktop-build/packaging-runs/**/events.jsonl',
    'apps/desktop/.desktop-build/packaging-runs/**/*.log',
  ])
  assert.equal(packagingEvidence.with['retention-days'], 14)
  assert.doesNotMatch(steps.find(step => step.name === 'Upload installers').with.path, /desktop-ui|electron-\*/u)
  assert.doesNotMatch(source, /192\.168\.|release:publish|upload:latest|CSC_LINK|APPLE_API_KEY/u)
  const secretNames = [...source.matchAll(/secrets\.([A-Z_]+)/gu)].map(match => match[1])
  assert.deepEqual([...new Set(secretNames)].sort(), ['DESKTOP_INTERNAL_MAC_CERTIFICATE', 'DESKTOP_INTERNAL_MAC_PASSWORD'])
  assert.doesNotMatch(JSON.stringify(workflow.jobs.package.env), /secrets\./u)
  for (const step of steps.filter(step => !['Package macOS', 'Test installed product desktop'].includes(step.name))) {
    assert.doesNotMatch(JSON.stringify(step), /secrets\./u)
  }
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
