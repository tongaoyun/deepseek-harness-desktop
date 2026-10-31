import assert from 'node:assert/strict'
import { X509Certificate, createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { dump, load } from 'js-yaml'
import { internalCertificateIdentity, withInternalMacIdentity } from '../scripts/internal-signing.mjs'
import { internalBuilderConfig, INTERNAL_APP_ID } from '../scripts/internal-package.mjs'
import { validateSigningRunners } from '../scripts/signing-runners.mjs'
import { artifactManifest } from '../scripts/github-package.mjs'
import { collectDesktopRelease, RELEASE_TARGETS } from '../scripts/desktop-release.mjs'
import { productUpdateUrl } from '../scripts/update-release.mjs'
import { createElectronBuilderConfig } from '../../desktop/scripts/electron-builder-config.mjs'

const pem = await readFile(new URL('./fixtures/internal-test-certificate.pem', import.meta.url), 'utf8')
const certificate = new X509Certificate(pem)
const pin = certificate.fingerprint256.replaceAll(':', '')
const now = Date.parse(certificate.validFrom) + 60_000
const repository = 'example/harness-internal-downloads'
const environment = { PACKAGE_SIGNING: 'internal', DSH_DESKTOP_UNSIGNED: '1',
  PACKAGE_DOWNLOAD_REPOSITORY: repository, PACKAGE_INTERNAL_CERTIFICATE_SHA256: pin,
  PRODUCT_INTERNAL_CERTIFICATE_SHA1: certificate.fingerprint.replaceAll(':', ''), PRODUCT_INTERNAL_KEYCHAIN: '/private/signing.keychain-db' }

test('requires the fixed, valid, self-signed code-signing certificate', () => {
  assert.equal(internalCertificateIdentity(pem, pin, now).sha256, pin)
  assert.throws(() => internalCertificateIdentity(pem, 'A'.repeat(64), now), /pinned/u)
  assert.throws(() => internalCertificateIdentity(pem, '', now), /SHA-256/u)
  for (const time of [Date.parse(certificate.validFrom) - 1, Date.parse(certificate.validTo)]) {
    assert.throws(() => internalCertificateIdentity(pem, pin, time), /valid/u)
  }
})

test('isolates import credentials until packaging settles and cleans up after import or packaging failure', async () => {
  for (const failure of ['none', 'import', 'action']) {
    let owned
    let list = ['/original.keychain-db']
    const operations = []
    const run = async (command, args) => {
      assert.equal(command, '/usr/bin/security')
      operations.push(args[0])
      if (args[0] === 'create-keychain') owned = args.at(-1)
      if (args[0] === 'import' && failure === 'import') throw new Error('Import failed')
      if (args[0] === 'find-certificate') return pem
      if (args[0] === 'list-keychains') {
        if (args[3] === '-s') { list = args.slice(4); return '' }
        return list.map(path => `    "${path}"`).join('\n')
      }
      return ''
    }
    const action = async child => {
      assert.equal(child.PACKAGE_INTERNAL_CERTIFICATE_BASE64, undefined)
      assert.equal(child.PACKAGE_INTERNAL_CERTIFICATE_PASSWORD, undefined)
      assert.equal(child.PRODUCT_INTERNAL_KEYCHAIN, owned)
      assert.ok(list.includes(owned))
      await access(join(owned, '..', 'identity.p12'))
      await Promise.resolve()
      assert.equal(operations.includes('delete-keychain'), false)
      list.push('/concurrently-added.keychain-db')
      if (failure === 'action') throw new Error('Packaging failed')
    }
    const result = withInternalMacIdentity({ ...environment, PACKAGE_INTERNAL_CERTIFICATE_BASE64: 'AAAA',
      PACKAGE_INTERNAL_CERTIFICATE_PASSWORD: 'fixture-private-value' }, action, run)
    if (failure === 'none') await result
    else await assert.rejects(result, failure === 'import' ? /Import failed/u : /Packaging failed/u)
    assert.equal(operations.at(-1), 'delete-keychain')
    assert.deepEqual(list, failure === 'import' ? ['/original.keychain-db'] : ['/original.keychain-db', '/concurrently-added.keychain-db'])
    await assert.rejects(access(join(owned, '..')), { code: 'ENOENT' })
  }
})

test('refuses ambiguous import sources and a substituted identity without invoking packaging', async () => {
  for (const change of [{ PACKAGE_INTERNAL_CERTIFICATE_FILE: '/other.p12' }, { PACKAGE_INTERNAL_CERTIFICATE_SHA256: 'B'.repeat(64) }]) {
    let called = false
    await assert.rejects(withInternalMacIdentity({ ...environment, PACKAGE_INTERNAL_CERTIFICATE_BASE64: 'AAAA',
      PACKAGE_INTERNAL_CERTIFICATE_PASSWORD: 'fixture', ...change }, async () => { called = true },
    async (command, args) => args[0] === 'find-certificate' ? pem : ''))
    assert.equal(called, false)
  }
})

test('embeds internal native feeds without changing the official unsigned or Developer ID configuration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-internal-feed-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const official = createElectronBuilderConfig({ DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_APP_ID: 'com.deepseek.harness' }, 'darwin', 'arm64')
  const mac = internalBuilderConfig(official, environment, 'darwin')
  assert.equal(mac.appId, INTERNAL_APP_ID)
  assert.equal(mac.mac.notarize, false)
  assert.equal(typeof mac.mac.sign, 'function')
  assert.equal(official.mac.sign, undefined)
  assert.deepEqual(mac.mac.target, ['dmg', 'zip'])
  assert.equal(mac.publish[0].url, productUpdateUrl(repository))
  assert.equal(mac.extraMetadata.dshMandatoryUpdatePolicy, undefined)
  assert.equal(mac.extraMetadata.dshDesktopUpdateMirror.githubRepository, repository)
  assert.equal(mac.extraMetadata.dshDesktopUpdateMirror.packageUrl,
    'http://www.instudio.me:6206/traefik/gitea/api/packages/instudio/generic/deepseek-harness-desktop-internal/')
  assert.equal(mac.dmg.format, 'ULFO')
  assert.equal(official.dmg.format, 'ULMO')
  assert.equal(official.publish, null)
  assert.deepEqual(official.mac.target, ['dmg'])
  assert.throws(() => internalBuilderConfig(official, { ...environment, DSH_DESKTOP_UNSIGNED: '0' }, 'darwin'), /explicit/u)
  let packed = false
  const config = internalBuilderConfig({ ...official, afterPack: async () => { packed = true } }, environment, 'darwin')
  await config.afterPack({ appOutDir: directory, packager: { getResourcesDir: path => path } })
  assert.equal(packed, true)
  assert.equal(load(await readFile(join(directory, 'app-update.yml'), 'utf8')).url, productUpdateUrl(repository))
  const windows = internalBuilderConfig(createElectronBuilderConfig({ DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_APP_ID: INTERNAL_APP_ID }, 'win32', 'x64'), environment, 'win32')
  assert.equal(windows.win.forceCodeSigning, false)
  assert.equal(windows.win.signtoolOptions.publisherName, undefined)
  assert.deepEqual(windows.extraMetadata.dshDesktopUpdateMirror, mac.extraMetadata.dshDesktopUpdateMirror)
})

test('requires certificate secrets and keeps internal and formal feeds separate before queuing jobs', () => {
  const config = { ...environment, INTERNAL_CERTIFICATE_CONFIGURED: 'true', SIGNED_DOWNLOAD_REPOSITORY: 'example/formal-downloads' }
  validateSigningRunners(config)
  for (const change of [{ INTERNAL_CERTIFICATE_CONFIGURED: 'false' }, { PACKAGE_INTERNAL_CERTIFICATE_SHA256: '' },
    { PACKAGE_DOWNLOAD_REPOSITORY: config.SIGNED_DOWNLOAD_REPOSITORY }]) {
    assert.throws(() => validateSigningRunners({ ...config, ...change }))
  }
})

const commit = 'a'.repeat(40)
const productVersion = '0.2.1-rc.2'
const version = `${productVersion}.20261019.31.1`
const run = { id: 31, head_sha: commit, status: 'completed', conclusion: 'success', run_number: 31,
  run_attempt: 1, created_at: '2026-10-19T08:00:00Z' }

async function stageInternal(t, change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'harness-internal-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stage = join(root, 'stage')
  await mkdir(stage)
  for (const target of RELEASE_TARGETS) {
    const directory = join(root, target)
    const output = join(stage, target)
    await mkdir(directory)
    await mkdir(output)
    const files = []
    for (const extension of target === 'win-x64' ? ['exe'] : ['dmg', 'zip']) {
      const name = `harness-${version}-${target}-internal.${extension}`
      const bytes = Buffer.from(`synthetic internal ${target} ${extension}`)
      await writeFile(join(directory, name), bytes)
      files.push({ url: name, sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length })
    }
    const record = { schemaVersion: 1, target, version, commit, dirty: false, signing: 'internal', notarized: false,
      channel: 'nightly', publicUrl: productUpdateUrl(repository),
      codeSigning: target === 'win-x64' ? { type: 'unsigned' } : { type: 'self-signed', certificateSHA256: pin } }
    const metadata = { version, files }
    change(record, metadata, target)
    await writeFile(join(directory, target === 'win-x64' ? 'nightly.yml' : 'nightly-mac.yml'), dump(metadata))
    await writeFile(join(directory, `${target}-internal.json`), JSON.stringify(record))
    const manifest = artifactManifest(directory, target, commit, version,
      { signing: 'internal', downloadRepository: repository, internalCertificateSHA256: pin })
    await writeFile(join(output, 'build-manifest.json'), JSON.stringify(manifest))
    for (const file of manifest.artifacts) await writeFile(join(output, file.name), await readFile(join(directory, file.name)))
  }
  return stage
}

test('publishes self-signed Mac and unsigned Windows as explicit internal native updates', async t => {
  const directory = await stageInternal(t)
  const release = await collectDesktopRelease(directory, run, commit, productVersion,
    { signing: 'internal', downloadRepository: repository, internalCertificateSHA256: pin })
  assert.equal(release.prerelease, false)
  assert.match(release.body, /未经过 Apple 公证/u)
  assert.equal(load(await readFile(join(directory, 'nightly-mac.yml'), 'utf8')).files.length, 4)
  assert.equal(load(await readFile(join(directory, 'nightly.yml'), 'utf8')).files.length, 1)
})

test('rejects changed certificate, false signing facts, stale source and corrupt native update payloads', async t => {
  for (const change of [{ dirty: true }, { commit: 'b'.repeat(40) }, { notarized: true }, { codeSigning: { type: 'developer-id' } }]) {
    await assert.rejects(stageInternal(t, record => Object.assign(record, change)))
  }
  const options = { signing: 'internal', downloadRepository: repository, internalCertificateSHA256: pin }
  const wrongPin = await stageInternal(t)
  await assert.rejects(collectDesktopRelease(wrongPin, run, commit, productVersion, { ...options, internalCertificateSHA256: 'B'.repeat(64) }), /pinned/u)
  const corrupt = await stageInternal(t, (record, metadata) => { metadata.files[0].sha512 = 'A'.repeat(86) + '==' })
  await assert.rejects(collectDesktopRelease(corrupt, run, commit, productVersion, options), /SHA-512/u)
  await assert.rejects(readFile(join(corrupt, 'nightly.yml')), { code: 'ENOENT' })
})
