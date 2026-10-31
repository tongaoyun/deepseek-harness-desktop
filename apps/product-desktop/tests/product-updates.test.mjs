import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { dump, load } from 'js-yaml'
import { artifactManifest } from '../scripts/github-package.mjs'
import { collectDesktopRelease, publishDesktopRelease, RELEASE_TARGETS } from '../scripts/desktop-release.mjs'
import { productSigningMode, productUpdateUrl } from '../scripts/update-release.mjs'
import { validateSigningRunners } from '../scripts/signing-runners.mjs'
import { releaseDestination } from '../scripts/deliver-desktop.mjs'
import { createElectronBuilderConfig } from '../../desktop/scripts/electron-builder-config.mjs'
import { createMacOSAppUpdateConfig, resolveMacOSAppUpdateFeed } from '../../desktop/scripts/macos-app-update-config.mjs'

const repository = 'example/harness-downloads'
const commit = 'a'.repeat(40)
const productVersion = '0.2.1-alpha.4'
const version = `${productVersion}.20261017.12.1`
const run = { id: 101, head_sha: commit, status: 'completed', conclusion: 'success', run_number: 12,
  run_attempt: 1, created_at: '2026-10-17T09:00:00Z' }
const hash = (bytes, algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding)

test('embeds the product feed through the native builder and keeps signing, ZIP delivery and optional policy independent', () => {
  const environment = { DSH_DESKTOP_APP_ID: 'com.instudio.deepseek-harness.desktop',
    DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DSH_DESKTOP_UPDATE_URL: productUpdateUrl(repository),
    DSH_DESKTOP_UPDATE_CHANNEL: 'nightly', DSH_DESKTOP_MANDATORY_UPDATE_ENABLED: '0',
    DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)', DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
    APPLE_KEYCHAIN_PROFILE: 'test-config-only' }
  const config = createElectronBuilderConfig(environment, 'darwin', 'arm64')
  assert.equal(config.appId, environment.DSH_DESKTOP_APP_ID)
  assert.equal(config.extraMetadata.dshDesktopUpdateChannel, 'nightly')
  assert.equal(Object.hasOwn(config.extraMetadata, 'dshMandatoryUpdatePolicy'), false)
  assert.equal(config.mac.forceCodeSigning, true)
  assert.equal(config.mac.notarize, true)
  assert.deepEqual(config.mac.target, ['dmg', 'zip'])
  assert.deepEqual(createMacOSAppUpdateConfig(resolveMacOSAppUpdateFeed(config.publish), 'product-cache'), {
    provider: 'generic', url: productUpdateUrl(repository), channel: 'nightly', updaterCacheDirName: 'product-cache',
  })
  const development = createElectronBuilderConfig({ ...environment, DSH_DESKTOP_UNSIGNED: '1' }, 'darwin', 'arm64')
  assert.equal(development.publish, null)
  assert.deepEqual(development.mac.target, ['dmg'])
})

async function stageSigned(t, change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'harness-native-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stage = join(root, 'stage')
  await mkdir(stage)
  for (const target of RELEASE_TARGETS) {
    const directory = join(root, target)
    const output = join(stage, target)
    await mkdir(directory)
    await mkdir(output)
    const extensions = target === 'win-x64' ? ['exe'] : ['dmg', 'zip']
    const files = []
    for (const extension of extensions) {
      const name = `harness-${version}-${target}.${extension}`
      const bytes = Buffer.from(`synthetic signed ${target} ${extension}`)
      await writeFile(join(directory, name), bytes)
      files.push({ url: name, sha512: hash(bytes, 'sha512', 'base64'), size: bytes.length })
    }
    const metadata = { version, files, path: files[0].url, sha512: files[0].sha512 }
    const record = { schemaVersion: 1, target, version, commit, dirty: false,
      environment: 'production', channel: 'nightly', publicUrl: productUpdateUrl(repository) }
    change({ metadata, record, target })
    await writeFile(join(directory, target === 'win-x64' ? 'nightly.yml' : 'nightly-mac.yml'), dump(metadata))
    await writeFile(join(directory, `${target}-release.json`), JSON.stringify(record))
    const manifest = artifactManifest(directory, target, commit, version, { signing: 'signed', downloadRepository: repository })
    await writeFile(join(output, 'build-manifest.json'), JSON.stringify(manifest))
    for (const artifact of manifest.artifacts) await writeFile(join(output, artifact.name), await readFile(join(directory, artifact.name)))
  }
  return stage
}

test('publishes native feeds for one verified version and offers only Apple Silicon Mac updates', async t => {
  const directory = await stageSigned(t)
  const release = await collectDesktopRelease(directory, run, commit, productVersion, { signing: 'signed', downloadRepository: repository })
  assert.equal(release.prerelease, false)
  assert.equal(JSON.parse(await readFile(join(directory, 'build-manifest.json'), 'utf8')).signing, 'signed')
  const windows = load(await readFile(join(directory, 'nightly.yml'), 'utf8'))
  const mac = load(await readFile(join(directory, 'nightly-mac.yml'), 'utf8'))
  assert.equal(windows.version, version)
  assert.equal(windows.files.length, 1)
  assert.equal(mac.files.length, 2)
  assert.ok(mac.path.endsWith('-mac-arm64.zip'))
  for (const feed of [windows, mac]) {
    for (const entry of feed.files) {
      assert.ok(entry.url.startsWith(`https://github.com/${repository}/releases/download/v${version}/`))
      assert.doesNotMatch(entry.url, /latest|token|employee|deepseek\.com/u)
    }
  }
  const require = createRequire(new URL('../../desktop/package.json', import.meta.url))
  const { MacUpdater } = require('electron-updater')
  const files = mac.files.map(info => ({ info, url: new URL(info.url) }))
  const selected = MacUpdater.filterFilesForArch(files, true).filter(file => file.url.pathname.endsWith('.zip'))
  assert.equal(selected.length, 1)
  assert.ok(selected[0].url.pathname.includes('arm64'))
  assert.equal(MacUpdater.filterFilesForArch(files, false).length, 0)
})

test('rejects feed tampering, another version, remote URLs, another architecture and missing update packages', async t => {
  for (const kind of ['hash', 'version', 'url', 'arch', 'size', 'missing', 'duplicates']) {
    const directory = await stageSigned(t, ({ metadata, target }) => {
      if (target !== 'mac-arm64') return
      if (kind === 'hash') metadata.files[0].sha512 = 'A'.repeat(86) + '=='
      if (kind === 'version') metadata.version = '9.9.9'
      if (kind === 'url') metadata.files[0].url = 'https://untrusted.invalid/application.zip'
      if (kind === 'arch') metadata.files[1].url = metadata.files[0].url
      if (kind === 'size') metadata.files[0].size++
      if (kind === 'missing') metadata.files = metadata.files.filter(file => !file.url.endsWith('.zip'))
      if (kind === 'duplicates') metadata.files.push(metadata.files[0])
    })
    await assert.rejects(collectDesktopRelease(directory, run, commit, productVersion, { signing: 'signed', downloadRepository: repository }))
    await assert.rejects(readFile(join(directory, 'nightly.yml')), { code: 'ENOENT' })
  }
})

test('requires the native signed completion record and matching signing mode rather than trusting a file extension', async t => {
  for (const property of ['dirty', 'commit', 'publicUrl', 'channel']) {
    await assert.rejects(stageSigned(t, ({ record }) => {
      record[property] = property === 'dirty' ? true : 'invalid'
    }), /completion record/u)
  }
  const directory = await stageSigned(t)
  await assert.rejects(collectDesktopRelease(directory, run, commit, productVersion), /build manifest/u)
  await assert.rejects(collectDesktopRelease(directory, run, commit, productVersion,
    { signing: 'signed', downloadRepository: 'other/downloads' }), /configuration/u)
})

test('validates native signing machines before queuing jobs and never falls back to unsigned on invalid settings', () => {
  const environment = { PACKAGE_SIGNING: 'signed', PACKAGE_DOWNLOAD_REPOSITORY: repository,
    SIGNING_RUNNERS: JSON.stringify({ 'win-x64': ['self-hosted', 'Windows', 'X64', 'product-signing-win'],
      'mac-arm64': ['self-hosted', 'macOS', 'ARM64', 'product-signing-arm'] }),
    SIGNING_CONFIG_DIRS: JSON.stringify({ 'win-x64': 'C:\\ProductSigning', 'mac-arm64': '/private/product-signing' }) }
  validateSigningRunners(environment)
  validateSigningRunners({})
  assert.throws(() => validateSigningRunners({ ...environment, SIGNING_RUNNERS: '{}' }), /win-x64/u)
  assert.throws(() => validateSigningRunners({ ...environment, SIGNING_CONFIG_DIRS: 'invalid' }), /JSON/u)
  assert.throws(() => validateSigningRunners({ ...environment, PACKAGE_SIGNING: 'automatic' }), /signing mode/u)
  assert.throws(() => productSigningMode(''), /signing mode/u)
  assert.throws(() => productUpdateUrl('example/repo?token=secret'), /repository/u)
})

test('a signed release cannot move the update feed backwards or publish before both destinations are verified', async () => {
  const release = { version, tag: `v${version}`, prerelease: false, body: 'signed test release', files: [
    { name: 'native.exe', size: 10, sha256: 'a'.repeat(64) },
    { name: 'nightly.yml', size: 10, sha256: 'b'.repeat(64) },
  ] }
  const operations = []
  function destination(name, latestVersion, badHash = false) {
    let remote
    const assets = []
    return { name, latest: async () => latestVersion === undefined ? undefined : { tag_name: `v${latestVersion}` },
      find: async () => remote, create: async () => {
        operations.push(`${name}:create`)
        remote = { id: name, tag_name: release.tag, prerelease: false, draft: true, body: release.body, html_url: name }
        return remote
      }, assets: async () => assets, recoverAsset: async (_remote, asset) => asset,
      upload: async (id, file) => { assets.push(file); return file },
      hash: async asset => badHash ? 'bad' : asset.sha256,
      finalize: async () => { operations.push(`${name}:finalize`); remote.draft = false } }
  }
  await assert.rejects(publishDesktopRelease(release, [destination('internal'), destination('public', '9.9.9')]), /backwards/u)
  assert.deepEqual(operations, [])
  await assert.rejects(publishDesktopRelease(release, [destination('internal'), destination('public', undefined, true)]), /checksum/u)
  assert.equal(operations.some(value => value.endsWith(':finalize')), false)
  operations.length = 0
  await publishDesktopRelease(release, [destination('internal'), destination('public')])
  assert.deepEqual(operations, ['internal:create', 'public:create', 'internal:finalize', 'public:finalize'])
})

test('only a complete signed GitHub release is marked as the latest product download', async () => {
  const calls = []
  const client = { request: async (...args) => { calls.push(args); return {} } }
  const destination = releaseDestination('GitHub', client, repository, { github: true, target: commit })
  await destination.create({ tag: `v${version}`, version, body: 'signed', prerelease: false })
  assert.equal(calls.at(-1)[2].prerelease, false)
  assert.equal(calls.at(-1)[2].make_latest, 'false')
  await destination.finalize(1, { prerelease: false })
  assert.deepEqual(calls.at(-1)[2], { draft: false, make_latest: 'true' })
  await destination.finalize(2, { prerelease: true })
  assert.deepEqual(calls.at(-1)[2], { draft: false, make_latest: 'false' })
})
