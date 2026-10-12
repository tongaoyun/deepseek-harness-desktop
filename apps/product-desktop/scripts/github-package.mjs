/** Prepare credential-free CI settings and record the produced installer identities. */
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { desktopBuildVersionPrefix } from '../../desktop/scripts/desktop-build-version.mjs'

/**
 * Number an unpublished build without querying release storage.
 * @param {NodeJS.ProcessEnv} environment GitHub run identity and requested architecture.
 * @param {string} productVersion Current desktop version.
 * @param {Date} now Build date.
 * @returns {string} Unique version for this run and attempt.
 */
export function githubBuildVersion(environment, productVersion, now = new Date()) {
  if (!/^[a-f0-9]{40}$/u.test(environment.PACKAGE_SOURCE_SHA ?? '')) throw new Error('An exact source commit is required')
  for (const name of ['GITHUB_RUN_NUMBER', 'GITHUB_RUN_ATTEMPT']) {
    if (!/^[1-9]\d*$/u.test(environment[name] ?? '')) throw new Error(`${name} must be a positive integer`)
  }
  const date = now.toISOString().slice(0, 10).replaceAll('-', '')
  return `${desktopBuildVersionPrefix(productVersion)}${date}.${environment.GITHUB_RUN_NUMBER}.${environment.GITHUB_RUN_ATTEMPT}`
}

/**
 * Hash only completed installers and their companion blockmaps.
 * @param {string} directory Target artifact directory.
 * @param {string} target Requested platform and architecture.
 * @param {string} commit Exact source commit.
 * @param {string} version Packaged desktop version.
 * @returns {object} Credential-free download manifest.
 */
export function artifactManifest(directory, target, commit, version) {
  if (!['win-x64', 'mac-arm64', 'mac-x64'].includes(target)) throw new Error('Unsupported package target')
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('An exact source commit is required')
  const names = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:exe|dmg|zip|blockmap)$/u.test(entry.name)).map(entry => entry.name).sort()
  const required = target === 'win-x64' ? ['.exe'] : ['.dmg']
  for (const extension of required) {
    if (names.filter(name => name.endsWith(extension)).length !== 1) throw new Error(`Expected one ${extension} installer for ${target}`)
  }
  return { target, commit, version, signing: 'unsigned', artifacts: names.map(name => {
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
    const productVersion = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8')).version
    const version = githubBuildVersion(environment, productVersion)
    if (commit !== environment.PACKAGE_SOURCE_SHA) throw new Error('Checkout does not match requested source')
    if (process.arch !== environment.PACKAGE_ARCH) throw new Error('Runner architecture does not match the package')
    if (!environment.GITHUB_ENV || !environment.GITHUB_STEP_SUMMARY) throw new Error('GitHub Actions output paths are required')
    if (process.platform === 'win32') {
      writeFileSync(resolve(root, 'apps/desktop/.env.windows'), 'DSH_DESKTOP_APP_ID=com.instudio.deepseek-harness.desktop\n', { flag: 'wx' })
    }
    appendFileSync(environment.GITHUB_ENV, `PACKAGE_VERSION=${version}\n`)
    appendFileSync(environment.GITHUB_STEP_SUMMARY, `Unsigned desktop acceptance build\n\nVersion: ${version}\n\nSource: ${commit}\n\n`)
  } else if (process.argv[2] === 'artifacts') {
    const target = process.env.PACKAGE_TARGET
    if (!['win-x64', 'mac-arm64', 'mac-x64'].includes(target)) throw new Error('Unsupported package target')
    const directory = resolve(root, `apps/desktop/.desktop-build/targets/${target}/unsigned-artifacts`)
    const manifest = artifactManifest(directory, target, commit, process.env.PACKAGE_VERSION)
    writeFileSync(resolve(directory, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  } else throw new Error('Select prepare or artifacts')
}
