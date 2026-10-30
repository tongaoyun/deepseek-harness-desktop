/** Product-owned self-signing and native update configuration for internal packages. */
import { execFile } from 'node:child_process'
import { open, readdir, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { productPackageMirror, productUpdateUrl } from './update-release.mjs'

export const INTERNAL_APP_ID = 'com.instudio.deepseek-harness.desktop'

/** @param {NodeJS.ProcessEnv} environment Packaging settings. @returns {{sha1: string, keychain: string}} Imported signing identity, never an automatic temporary identity. */
function identity(environment) {
  if (!/^[A-F0-9]{40}$/u.test(environment.PRODUCT_INTERNAL_CERTIFICATE_SHA1 ?? '') || !environment.PRODUCT_INTERNAL_KEYCHAIN) {
    throw new Error('Internal macOS packaging requires the imported fixed signing identity')
  }
  return { sha1: environment.PRODUCT_INTERNAL_CERTIFICATE_SHA1, keychain: environment.PRODUCT_INTERNAL_KEYCHAIN }
}

function signingArguments(environment) {
  const signing = identity(environment)
  return ['--force', '--sign', signing.sha1, '--keychain', signing.keychain, '--timestamp=none', '--options', 'runtime',
    '--entitlements', fileURLToPath(new URL('../../desktop/scripts/macos-entitlements.plist', import.meta.url))]
}

async function machoFiles(directory, preserved) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (preserved.has(path)) continue
    if (entry.isDirectory()) result.push(...await machoFiles(path, preserved))
    else if (entry.isFile()) {
      const file = await open(path, 'r')
      try {
        const bytes = Buffer.alloc(12)
        const { bytesRead } = await file.read(bytes, 0, 12, 0)
        const magic = bytes.subarray(0, 4).toString('hex')
        const fat = ['cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)
        // Java class files share FAT_MAGIC; a Mach-O fat header declares its architecture count here.
        const architectures = magic.startsWith('ca') ? bytes.readUInt32BE(4) : bytes.readUInt32LE(4)
        if (bytesRead >= 12 && (['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe'].includes(magic)
          || fat && architectures > 0 && architectures <= 32)) result.push(path)
      } finally { await file.close() }
    }
  }
  return result
}

/** @param {string} appPath Completed product application. @param {NodeJS.ProcessEnv} environment Public identity and private keychain path. @returns {Promise<void>} Signs code from deepest helpers to enclosing bundles, retaining the official prepared-runtime inventory and signatures. */
export async function signInternalApplication(appPath, environment) {
  const run = promisify(execFile)
  const args = signingArguments(environment)
  const preserved = new Set(['app.asar.unpacked/dsh', 'runtime/primary-runtime']
    .map(path => join(appPath, 'Contents/Resources', path)))
  // Signing a framework executable also seals its bundle, so its helpers must already be signed.
  const files = (await machoFiles(appPath, preserved)).sort((left, right) => right.split(sep).length - left.split(sep).length)
  for (const path of files) await run('/usr/bin/codesign', [...args, path], { timeout: 120_000 })
  await run('/usr/bin/codesign', ['--deep', ...args, appPath], { timeout: 120_000 })
  await verifyInternalApplication(appPath, environment)
}

/**
 * Reseal a signed application's root resources after qualification-only ASAR/plist edits, leaving nested code unchanged.
 * @param {string} appPath Previously verified application with unchanged nested executables and bundles.
 * @param {NodeJS.ProcessEnv} environment Fixed signing identity and private keychain.
 * @returns {Promise<void>} Rejects if the resulting application or any nested signature is invalid.
 */
export async function resignInternalApplicationResources(appPath, environment) {
  await promisify(execFile)('/usr/bin/codesign', [...signingArguments(environment), appPath], { timeout: 120_000 })
  await verifyInternalApplication(appPath, environment)
}

/** @param {string} appPath Application being distributed. @param {NodeJS.ProcessEnv} environment Pinned signing identity. @returns {Promise<void>} Rejects invalid nested signatures and a different signer or application identifier. */
export async function verifyInternalApplication(appPath, environment) {
  const signing = identity(environment)
  await promisify(execFile)('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement',
    `=identifier "${INTERNAL_APP_ID}" and certificate root = H"${signing.sha1}"`, appPath], { timeout: 120_000 })
}

/** @param {object} config Official unsigned builder configuration. @param {NodeJS.ProcessEnv} environment Explicit internal mode, feed and identity. @param {string} platform Native platform. @returns {object} Product overrides; official signing and notarization configuration is not weakened. */
export function internalBuilderConfig(config, environment, platform) {
  if (environment.PACKAGE_SIGNING !== 'internal' || environment.DSH_DESKTOP_UNSIGNED !== '1') {
    throw new Error('Internal builder configuration requires explicit internal mode and unsigned base preparation')
  }
  if (platform === 'darwin') identity(environment)
  const url = productUpdateUrl(environment.PACKAGE_DOWNLOAD_REPOSITORY)
  const afterPack = config.afterPack
  const afterSign = config.afterSign
  return { ...config, appId: INTERNAL_APP_ID,
    artifactName: 'deepseek-harness-${version}-${os}-${arch}-internal.${ext}',
    extraMetadata: { ...config.extraMetadata, dshDesktopAppId: INTERNAL_APP_ID, dshDesktopUpdateChannel: 'nightly', dshProductDistribution: 'internal',
      dshDesktopUpdateMirror: productPackageMirror(environment.PACKAGE_DOWNLOAD_REPOSITORY) },
    dmg: { ...config.dmg, format: 'UDZO' },
    publish: [{ provider: 'generic', url, channel: 'nightly' }],
    mac: { ...config.mac, notarize: false, target: ['dmg', 'zip'],
      ...(platform === 'darwin' ? { sign: async options => signInternalApplication(options.app, environment) } : {}),
    },
    afterPack: async context => {
      await afterPack(context)
      await writeFile(join(context.packager.getResourcesDir(context.appOutDir), 'app-update.yml'), JSON.stringify({
        provider: 'generic', url, channel: 'nightly', updaterCacheDirName: 'deepseek-harness-internal-updater',
      }) + '\n')
    },
    afterSign: async context => {
      await afterSign(context)
      if (platform === 'darwin') await verifyInternalApplication(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`), environment)
    },
  }
}
