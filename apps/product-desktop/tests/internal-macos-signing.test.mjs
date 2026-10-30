import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { internalCertificateIdentity, withInternalMacIdentity } from '../scripts/internal-signing.mjs'
import { internalBuilderConfig, INTERNAL_APP_ID, resignInternalApplicationResources } from '../scripts/internal-package.mjs'

for (const [tool, path] of [['system LibreSSL', '/usr/bin:/bin'], ['configured OpenSSL', process.env.PATH]]) {
  test(`native custom signing with ${tool} signs unsigned framework helpers and preserves nested code`,
  { skip: process.platform !== 'darwin', timeout: 120_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-signing-test-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const execute = promisify(execFile)
    const identity = join(directory, 'identity')
    const ambient = join(directory, 'ambient.cnf')
    await writeFile(ambient, '[req]\nx509_extensions = invalid\n[invalid]\nnotAnExtension = unsupported\n')
    t.diagnostic((await execute('openssl', ['version'], { env: { ...process.env, PATH: path } })).stdout.trim())
    await execute(process.execPath, [new URL('../scripts/create-internal-identity.mjs', import.meta.url).pathname,
      '--directory', identity], { env: { ...process.env, PATH: path, OPENSSL_CONF: ambient }, timeout: 60_000 })
    const metadata = JSON.parse(await readFile(join(identity, 'identity.json'), 'utf8'))
    internalCertificateIdentity(await readFile(join(identity, 'certificate.pem'), 'utf8'), metadata.certificateSHA256)
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
    const framework = join(application, 'Contents/Frameworks/Electron Framework.framework')
    const version = join(framework, 'Versions/A')
    await mkdir(join(version, 'Helpers'), { recursive: true })
    await mkdir(join(version, 'Resources'))
    for (const name of ['Electron Framework', 'Helpers/chrome_crashpad_handler']) {
      const executable = join(version, name)
      await cp('/usr/bin/true', executable)
      await execute('/usr/bin/codesign', ['--remove-signature', executable])
    }
    const frameworkInfo = join(version, 'Resources/Info.plist')
    await writeFile(frameworkInfo, JSON.stringify({ CFBundleIdentifier: `${INTERNAL_APP_ID}.framework`,
      CFBundleExecutable: 'Electron Framework', CFBundlePackageType: 'FMWK', CFBundleVersion: '1.0.0' }))
    await execute('/usr/bin/plutil', ['-convert', 'xml1', frameworkInfo])
    await symlink('A', join(framework, 'Versions/Current'))
    for (const name of ['Electron Framework', 'Helpers', 'Resources']) {
      await symlink(`Versions/Current/${name}`, join(framework, name))
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
      const executables = [join(helper, 'Contents/MacOS/Helper'), join(version, 'Electron Framework'),
        join(version, 'Helpers/chrome_crashpad_handler')]
      const hashes = () => Promise.all(executables.map(async path => createHash('sha256').update(await readFile(path)).digest('hex')))
      const nestedBytes = await hashes()
      await writeFile(resource, 'version B')
      await resignInternalApplicationResources(application, environment)
      assert.deepEqual(await hashes(), nestedBytes)
      await execute('/usr/bin/plutil', ['-replace', 'CFBundleVersion', '-string', '2', join(helper, 'Contents/Info.plist')])
      await assert.rejects(resignInternalApplicationResources(application, environment))
    })
  })
}
