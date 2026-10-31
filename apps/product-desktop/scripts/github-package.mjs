/** Prepare credential-free CI settings and record the produced installer identities. */
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { desktopBuildVersionPrefix } from '../../desktop/scripts/desktop-build-version.mjs'
import { loadDesktopPackageEnvironment, validateDesktopPackageEnvironment } from '../../desktop/scripts/desktop-package-environment.mjs'
import { productSigningMode, productUpdateUrl, validateInternalSignature } from './update-release.mjs'
import { PRODUCT_DESKTOP_TARGETS } from './package-targets.mjs'

/**
 * Number an unpublished build without querying release storage.
 * @param {NodeJS.ProcessEnv} environment GitHub run identity and requested architecture.
 * @param {string} productVersion Current desktop version.
 * @param {Date} now Build date.
 * @returns {string} Version shared by every attempt of this run.
 */
export function githubBuildVersion(environment, productVersion, now = new Date()) {
  if (!/^[a-f0-9]{40}$/u.test(environment.PACKAGE_SOURCE_SHA ?? '')) throw new Error('An exact source commit is required')
  for (const name of ['GITHUB_RUN_NUMBER', 'GITHUB_RUN_ATTEMPT']) {
    if (!/^[1-9]\d*$/u.test(environment[name] ?? '')) throw new Error(`${name} must be a positive integer`)
  }
  const started = environment.PACKAGE_BUILD_DATE === undefined ? now : new Date(environment.PACKAGE_BUILD_DATE)
  if (!Number.isFinite(started.getTime())) throw new Error('A valid build start date is required')
  const date = started.toISOString().slice(0, 10).replaceAll('-', '')
  return `${desktopBuildVersionPrefix(productVersion)}${date}.${environment.GITHUB_RUN_NUMBER}.1`
}

/**
 * Hash only completed installers and their companion blockmaps.
 * @param {string} directory Target artifact directory.
 * @param {string} target Requested platform and architecture.
 * @param {string} commit Exact source commit.
 * @param {string} version Packaged desktop version.
 * @param {object} options Signing mode and public download repository; omitted produces development installers.
 * @returns {object} Credential-free download manifest.
 */
export function artifactManifest(directory, target, commit, version, options = {}) {
  if (!PRODUCT_DESKTOP_TARGETS.includes(target)) throw new Error('Unsupported package target')
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('An exact source commit is required')
  const signing = productSigningMode(options.signing)
  let update
  if (signing !== 'unsigned') {
    const record = JSON.parse(readFileSync(resolve(directory, `${target}-${signing === 'internal' ? 'internal' : 'release'}.json`), 'utf8'))
    const updateUrl = productUpdateUrl(options.downloadRepository)
    if (record.schemaVersion !== 1 || record.target !== target || record.version !== version || record.commit !== commit
      || record.dirty !== false || signing === 'signed' && record.environment !== 'production'
      || record.channel !== 'nightly' || record.publicUrl !== updateUrl) {
      throw new Error('Native signed release completion record does not match this build')
    }
    if (signing === 'internal') {
      if (record.signing !== 'internal' || record.notarized !== false) throw new Error('Invalid internal release completion record')
      validateInternalSignature(target, record.codeSigning, options.internalCertificateSHA256)
    }
    const metadata = readFileSync(resolve(directory, target === 'win-x64' ? 'nightly.yml' : 'nightly-mac.yml'))
    if (metadata.length > 64 * 1024) throw new Error('Native updater metadata exceeds limits')
    writeFileSync(resolve(directory, `${target}-nightly.yml`), metadata, { flag: 'wx' })
    update = { updateUrl, channel: 'nightly', ...(signing === 'internal' ? { codeSigning: record.codeSigning, notarized: false } : {}) }
  }
  const names = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:exe|dmg|zip|blockmap)$/u.test(entry.name)).map(entry => entry.name).sort()
  if (signing !== 'unsigned') names.push(`${target}-nightly.yml`)
  const required = target === 'win-x64' ? ['.exe'] : signing !== 'unsigned' ? ['.dmg', '.zip'] : ['.dmg']
  for (const extension of required) {
    if (names.filter(name => name.endsWith(extension)).length !== 1) throw new Error(`Expected one ${extension} installer for ${target}`)
  }
  if (signing === 'signed' && names.some(name => /-unsigned\.|-unnotarized\./u.test(name))) throw new Error('Signed release contains development artifacts')
  if (signing === 'internal' && names.some(name => !name.endsWith('.yml') && !/-internal\.(?:exe|dmg|zip)(?:\.blockmap)?$/u.test(name))) {
    throw new Error('Internal release contains artifacts from another distribution mode')
  }
  return { target, commit, version, signing, ...update, artifacts: names.map(name => {
    const bytes = readFileSync(resolve(directory, name))
    if (bytes.length === 0) throw new Error(`Empty installer: ${name}`)
    return { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }) }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const root = resolve(import.meta.dirname, '../../..')
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (process.argv[2] === 'prepare') {
    const environment = process.env
    const signing = productSigningMode(environment.PACKAGE_SIGNING)
    const productVersion = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8')).version
    const version = githubBuildVersion(environment, productVersion)
    if (commit !== environment.PACKAGE_SOURCE_SHA) throw new Error('Checkout does not match requested source')
    if (process.arch !== environment.PACKAGE_ARCH) throw new Error('Runner architecture does not match the package')
    if (!environment.GITHUB_ENV || !environment.GITHUB_STEP_SUMMARY) throw new Error('GitHub Actions output paths are required')
    if (signing === 'signed') {
      const selected = loadDesktopPackageEnvironment(process.platform, { ...environment,
        DSH_PACKAGING_PRESET: 'production', DSH_PACKAGING_CONFIG_DIR: environment.PACKAGE_SIGNING_CONFIG_DIR })
      if (selected.DSH_DESKTOP_APP_ID !== 'com.instudio.deepseek-harness.desktop'
        || selected.DSH_DESKTOP_AUTO_UPDATE_ENV !== 'production'
        || selected.DSH_DESKTOP_UPDATE_URL !== productUpdateUrl(environment.PACKAGE_DOWNLOAD_REPOSITORY)
        || selected.DSH_DESKTOP_UPDATE_CHANNEL !== 'nightly'
        || selected.DSH_DESKTOP_MANDATORY_UPDATE_ENABLED !== '0') {
        throw new Error('Signing preset must select the product identity, public nightly feed and optional updates')
      }
      validateDesktopPackageEnvironment(selected, { platform: process.platform, arch: process.arch })
      if (/[\r\n]/u.test(environment.PACKAGE_SIGNING_CONFIG_DIR)) throw new Error('Signing configuration path cannot contain newlines')
      appendFileSync(environment.GITHUB_ENV, `DSH_PACKAGING_PRESET=production\nDSH_PACKAGING_CONFIG_DIR=${environment.PACKAGE_SIGNING_CONFIG_DIR}\n`)
    } else if (process.platform === 'win32') {
      writeFileSync(resolve(root, 'apps/desktop/.env.windows'), 'DSH_DESKTOP_APP_ID=com.instudio.deepseek-harness.desktop\n', { flag: 'wx' })
    }
    appendFileSync(environment.GITHUB_ENV, `PACKAGE_VERSION=${version}\n`)
    appendFileSync(environment.GITHUB_ENV, `PACKAGE_ARTIFACT_DIRECTORY=${signing === 'signed' ? 'artifacts' : 'unsigned-artifacts'}\n`)
    appendFileSync(environment.GITHUB_STEP_SUMMARY, `${signing} desktop acceptance build\n\nVersion: ${version}\n\nSource: ${commit}\n\n`)
  } else if (process.argv[2] === 'artifacts') {
    const target = process.env.PACKAGE_TARGET
    if (!PRODUCT_DESKTOP_TARGETS.includes(target)) throw new Error('Unsupported package target')
    const signing = productSigningMode(process.env.PACKAGE_SIGNING)
    const directory = resolve(root, `apps/desktop/.desktop-build/targets/${target}/${signing === 'signed' ? 'artifacts' : 'unsigned-artifacts'}`)
    const manifest = artifactManifest(directory, target, commit, process.env.PACKAGE_VERSION,
      { signing, downloadRepository: process.env.PACKAGE_DOWNLOAD_REPOSITORY, internalCertificateSHA256: process.env.PACKAGE_INTERNAL_CERTIFICATE_SHA256 })
    writeFileSync(resolve(directory, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  } else throw new Error('Select prepare or artifacts')
}
