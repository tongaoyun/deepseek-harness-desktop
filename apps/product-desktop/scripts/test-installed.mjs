/** Exercise a private installation of the release artifact, then uninstall it. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { runAcceptanceProcess } from './acceptance-process.mjs'
import { stopInstalledProcesses } from './installed-processes.mjs'
import { productSigningMode } from './update-release.mjs'
import { withInternalMacIdentity } from './internal-signing.mjs'
import { PRODUCT_DESKTOP_TARGETS } from './package-targets.mjs'

const root = resolve(import.meta.dirname, '../../..')

/** @param {string} directory Installer output directory. @param {string} platform Native OS. @returns {Promise<string>} Unique release installer; missing or ambiguous output fails before installation. */
export async function selectInstaller(directory, platform) {
  if (!['win32', 'darwin'].includes(platform)) throw new Error('Installed desktop acceptance requires Windows or macOS')
  const extension = platform === 'darwin' ? '.dmg' : '.exe'
  const entries = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(extension))
  if (entries.length !== 1) throw new Error(`Expected exactly one ${extension} installer`)
  return join(directory, entries[0].name)
}

function windowsSetup(installer, destination, uninstall = false) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$arguments = if ($env:HARNESS_UNINSTALL -eq '1') { '/S _?=' + $env:HARNESS_INSTALL_DIR } else { '/CURRENTUSER /S /D=' + $env:HARNESS_INSTALL_DIR }
$process = Start-Process -FilePath $env:HARNESS_INSTALLER -ArgumentList $arguments -PassThru
if (-not $process.WaitForExit(120000)) { & taskkill.exe /PID $process.Id /T /F; $process.WaitForExit(); throw 'Installer timed out' }
if ($process.ExitCode -ne 0) { throw ('Installer failed: ' + $process.ExitCode) }
`], { stdio: 'inherit', timeout: 150_000,
    env: { ...process.env, HARNESS_INSTALLER: installer, HARNESS_INSTALL_DIR: destination, HARNESS_UNINSTALL: uninstall ? '1' : '0' } })
}

async function runAcceptance(executable, target, installationRoot) {
  const manager = process.env.npm_execpath
  if (!manager) throw new Error('Run installed acceptance through pnpm')
  const cancellation = new AbortController()
  const stop = signal => cancellation.abort(new Error(`Received ${signal}`))
  const interrupt = () => stop('SIGINT')
  const terminate = () => stop('SIGTERM')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    await runAcceptanceProcess(process.execPath, [manager, 'exec', 'vitest', 'run', '--config', 'vitest.web.config.ts',
      'apps/web/tests/deepseek-harness-catalog.e2e.ts', '-t', 'boots the installed product Electron assembly',
      // Budget preparation, full UI coverage and native restart; allow two minutes for cleanup.
      '--testTimeout=900000', '--hookTimeout=120000',
      '--reporter=default', '--reporter=json', `--outputFile=.artifacts/desktop-installed-${target}.json`], {
      cwd: root, timeoutMs: 1_080_000, signal: cancellation.signal,
      env: { ...process.env, DSH_DESKTOP_SMOKE: '1', DSH_SNAPSHOT: 'replay',
        DSH_INSTALLED_EXECUTABLE: executable, DSH_INSTALLED_ROOT: installationRoot },
    })
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}

async function main() {
  if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Installed desktop acceptance requires Windows or macOS')
  const { values } = parseArgs({ options: { target: { type: 'string' }, installer: { type: 'string' } } })
  const target = values.target
  const nativeTarget = process.platform === 'darwin' ? `mac-${process.arch}` : `win-${process.arch}`
  if (!PRODUCT_DESKTOP_TARGETS.includes(target) || target !== nativeTarget) throw new Error('Use the native package target')
  const installer = values.installer === undefined
    ? await selectInstaller(join(root, 'apps/desktop/.desktop-build/targets', target,
      productSigningMode(process.env.PACKAGE_SIGNING) === 'signed' ? 'artifacts' : 'unsigned-artifacts'), process.platform)
    : resolve(values.installer)
  if (!installer.endsWith(process.platform === 'darwin' ? '.dmg' : '.exe')) throw new Error('Use a native installer')
  const stage = await mkdtemp(join(tmpdir(), 'harness-installed-ui-'))
  const destination = join(stage, 'Installed App')
  let mounted = false
  let installed = false
  try {
    let executable
    if (process.platform === 'darwin') {
      const mount = join(stage, 'volume')
      execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, installer], { stdio: 'inherit', timeout: 120_000 })
      mounted = true
      const apps = (await readdir(mount, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
      if (apps.length !== 1) throw new Error('Expected exactly one application in the DMG')
      const application = join(destination, apps[0].name)
      execFileSync('ditto', [join(mount, apps[0].name), application], { stdio: 'inherit', timeout: 120_000 })
      executable = join(application, 'Contents/MacOS/DeepSeek Harness')
    } else {
      try { windowsSetup(installer, destination) }
      finally {
        try { await access(join(destination, 'Uninstall DeepSeek Harness.exe')); installed = true }
        catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      executable = join(destination, 'DeepSeek Harness.exe')
    }
    await access(executable)
    await runAcceptance(executable, target, stage)
  } finally {
    try {
      if (installed) {
        stopInstalledProcesses(destination)
        windowsSetup(join(destination, 'Uninstall DeepSeek Harness.exe'), destination, true)
      }
    } finally {
      try {
        if (mounted) execFileSync('hdiutil', ['detach', join(stage, 'volume')], { stdio: 'inherit', timeout: 120_000 })
      } finally { await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const operation = process.platform === 'darwin' && process.env.PACKAGE_SIGNING === 'internal'
    ? withInternalMacIdentity(process.env, async environment => {
      // Only the private installation test inherits the imported keychain, never PKCS#12 inputs.
      const original = process.env
      process.env = environment
      try { await main() } finally { process.env = original }
    })
    : main()
  await operation.catch(error => { console.error(error.message); process.exitCode = 1 })
}
