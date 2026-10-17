/** Validate signing-machine routing before queuing product release jobs. */
import { posix, win32 } from 'node:path'
import { productSigningMode, productUpdateUrl } from './update-release.mjs'

/**
 * Require explicit native signing machines and their external configuration directories.
 * @param {NodeJS.ProcessEnv} environment Public workflow variables; omitted mode selects hosted unsigned builds.
 * @returns {void} Throws before any signing job is queued when routing is incomplete.
 */
export function validateSigningRunners(environment) {
  if (productSigningMode(environment.PACKAGE_SIGNING) === 'unsigned') return
  productUpdateUrl(environment.PACKAGE_DOWNLOAD_REPOSITORY)
  let runners
  let directories
  try {
    runners = JSON.parse(environment.SIGNING_RUNNERS)
    directories = JSON.parse(environment.SIGNING_CONFIG_DIRS)
  } catch { throw new Error('Signed updates require DESKTOP_SIGNING_RUNNERS and DESKTOP_SIGNING_CONFIG_DIRS JSON objects') }
  for (const target of ['win-x64', 'mac-arm64', 'mac-x64']) {
    const labels = runners?.[target]
    const directory = directories?.[target]
    if (!Array.isArray(labels) || labels.length < 4 || labels.some(label => typeof label !== 'string' || !label.trim())
      || !labels.includes('self-hosted') || !labels.includes(target === 'win-x64' ? 'Windows' : 'macOS')
      || !labels.includes(target === 'mac-arm64' ? 'ARM64' : 'X64')
      || typeof directory !== 'string' || !(target === 'win-x64' ? win32 : posix).isAbsolute(directory)) {
      throw new Error(`Signed updates require an explicitly labelled native signing machine and absolute config directory for ${target}`)
    }
  }
}

if (process.argv[1] === import.meta.filename) validateSigningRunners(process.env)
