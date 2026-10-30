import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { internalCertificateIdentity, withInternalMacIdentity } from '../scripts/internal-signing.mjs'
import { internalBuilderConfig, INTERNAL_APP_ID, resignInternalApplicationResources } from '../scripts/internal-package.mjs'

for (const [tool, path] of [['system LibreSSL', '/usr/bin:/bin'], ['configured OpenSSL', process.env.PATH]]) {
  test(`native custom signing with ${tool} preserves nested code and rejects damaged signatures`,
  { skip: process.platform !== 'darwin', timeout: 120_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-signing-test-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const execute = promisify(execFile)
    const identity = join(directory, 'identity')
    await execute(process.execPath, [new URL('../scripts/create-internal-identity.mjs', import.meta.url).pathname,
      '--directory', identity], { env: { ...process.env, PATH: path }, timeout: 60_000 })
    const metadata = JSON.parse(await readFile(join(identity, 'identity.json'), 'utf8'))
    try { internalCertificateIdentity(await readFile(join(identity, 'certificate.pem'), 'utf8'), metadata.certificateSHA256) }
    catch (error) {
      t.diagnostic((await execute('openssl', ['version'], { env: { ...process.env, PATH: path } })).stdout.trim())
      t.diagnostic(await readFile(join(identity, 'certificate.pem'), 'utf8'))
      throw error
    }
    const application = join(directory, 'Harness.app')
    const helper = join(application, 'Contents/Frameworks/Helper.app')
    for (const [path, identifier, name] of [[application, INTERNAL_APP_ID, 'Harness'], [helper, `${INTERNAL_APP_ID}.helper`, 'Helper']]) {
      await mkdir(join(path, 'Contents/MacOS'), { recursive: true })
      await cp('/usr/bin/true', join(path, 'Contents/MacOS', name))
      const plist = join(path, 'Contents/Info.plist')
      await writeFile(plist, JSON.stringify({ CFBundleIdentifier: identifier, CFBundleExecutable: name,
        CFBundlePackageType: 'APPL', CFBundleVersion: '1', CFBundleShortVersionString: '1.0.0' }))
      await execute('/usr/bin/plutil', ['-convert', 'xml1', plist])
    }
    await mkdir(join(application, 'Contents/Resources'))
    const resource = join(application, 'Contents/Resources/qualification.txt')
    await writeFile(resource, 'version A')
    await withInternalMacIdentity({ PACKAGE_INTERNAL_CERTIFICATE_FILE: join(identity, 'identity.p12'),
      PACKAGE_INTERNAL_CERTIFICATE_PASSWORD: await readFile(join(identity, 'password'), 'utf8'),
      PACKAGE_INTERNAL_CERTIFICATE_SHA256: metadata.certificateSHA256,
    }, async environment => {
      let officialChecked = false
      const config = internalBuilderConfig({ mac: {}, afterPack: async () => {}, afterSign: async () => { officialChecked = true } }, {
        ...environment, PACKAGE_SIGNING: 'internal', DSH_DESKTOP_UNSIGNED: '1', PACKAGE_DOWNLOAD_REPOSITORY: 'example/downloads',
      }, 'darwin')
      await config.mac.sign({ app: application })
      await config.afterSign({ appOutDir: directory, packager: { appInfo: { productFilename: 'Harness' } } })
      assert.equal(officialChecked, true)
      const executable = join(helper, 'Contents/MacOS/Helper')
      const nestedBytes = createHash('sha256').update(await readFile(executable)).digest('hex')
      await writeFile(resource, 'version B')
      await resignInternalApplicationResources(application, environment)
      assert.equal(createHash('sha256').update(await readFile(executable)).digest('hex'), nestedBytes)
      await execute('/usr/bin/plutil', ['-replace', 'CFBundleVersion', '-string', '2', join(helper, 'Contents/Info.plist')])
      await assert.rejects(resignInternalApplicationResources(application, environment))
    })
  })
}
