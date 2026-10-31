/** Record completed internal artifacts independently from Developer ID and Authenticode releases. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readDesktopBuildCommit } from '../../desktop/scripts/desktop-build-commit.mjs'
import { productUpdateUrl } from './update-release.mjs'
import { PRODUCT_DESKTOP_TARGETS } from './package-targets.mjs'

/** @param {string} root Repository root. @param {string[]} args Official package arguments. @param {NodeJS.ProcessEnv} environment Explicit distribution settings. @returns {Promise<void>} Writes a source-bound completion record only after native packaging succeeds. */
export async function writeInternalBuildRecord(root, args, environment) {
  const target = args.find(arg => PRODUCT_DESKTOP_TARGETS.includes(arg))
  const index = args.indexOf('--build-version')
  const version = index < 0 ? JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).version : args[index + 1]
  if (!target || !version) throw new Error('Internal packaging requires an explicit target and package version')
  const certificateSHA256 = environment.PACKAGE_INTERNAL_CERTIFICATE_SHA256
  if (target !== 'win-x64' && !/^[A-F0-9]{64}$/u.test(certificateSHA256 ?? '')) throw new Error('Internal macOS completion record requires the pinned identity')
  const source = readDesktopBuildCommit(root)
  const record = { schemaVersion: 1, target, version, ...source, signing: 'internal',
    channel: 'nightly', publicUrl: productUpdateUrl(environment.PACKAGE_DOWNLOAD_REPOSITORY),
    codeSigning: target === 'win-x64' ? { type: 'unsigned' } : { type: 'self-signed', certificateSHA256 }, notarized: false }
  await writeFile(join(root, 'apps/desktop/.desktop-build/targets', target, 'unsigned-artifacts', `${target}-internal.json`),
    JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
}
