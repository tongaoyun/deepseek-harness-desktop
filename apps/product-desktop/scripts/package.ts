/** Local product packaging delegates to the official desktop build pipeline. */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { productPackagingAssembly } from './packaging-assembly.mjs'
import { observeOfficeProcesses } from './office-process-diagnostics.mjs'
import { withInternalMacIdentity } from './internal-signing.mjs'
import { writeInternalBuildRecord } from './internal-record.mjs'
import { verifyInternalApplication } from './internal-package.mjs'
import { parseDesktopPackageInvocation } from '../../desktop/scripts/package-target.ts'
import { PRODUCT_DESKTOP_TARGETS } from './package-targets.mjs'
const target = parseDesktopPackageInvocation(process.argv.slice(2)).target.name
if (!PRODUCT_DESKTOP_TARGETS.includes(target)) throw new Error('Product desktop supports Windows x64 and macOS ARM64')
const packageManager = process.env.npm_execpath
if (packageManager === undefined) throw new Error('Invoke product packaging through pnpm')
const root = fileURLToPath(new URL('../../..', import.meta.url))
const toolEnvironment = { ...process.env }
for (const key of ['PACKAGE_INTERNAL_CERTIFICATE_BASE64', 'PACKAGE_INTERNAL_CERTIFICATE_FILE', 'PACKAGE_INTERNAL_CERTIFICATE_PASSWORD']) delete toolEnvironment[key]
const crate = join(root, 'native/deepseek-harness/Cargo.toml')
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', crate],
  { cwd: root, env: toolEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })) as { target_directory?: unknown }
if (typeof metadata.target_directory !== 'string') throw new Error('Cargo did not return its target directory')
const assembly = productPackagingAssembly(
  fileURLToPath(new URL('../../../packages/deepseek-harness-product/desktop/assembly.json', import.meta.url)), metadata.target_directory)
if (!process.argv.includes('--check')) {
  execFileSync('cargo', ['build', '--release', '--manifest-path', crate], { cwd: root, env: toolEnvironment, stdio: 'inherit' })
  const binary = join(metadata.target_directory, 'release', process.platform === 'win32' ? 'deepseek-harness-native.exe' : 'deepseek-harness-native')
  if (!existsSync(binary)) throw new Error('Product native sidecar was not produced by Cargo')
}
const temporary = mkdtempSync(join(tmpdir(), 'harness-product-assembly-'))
try {
  const manifest = join(temporary, 'assembly.json')
  writeFileSync(manifest, JSON.stringify(assembly), { mode: 0o600, flag: 'wx' })
  const evidenceRoot = join(root, 'apps/desktop/.desktop-build/packaging-runs')
  if (process.platform === 'darwin') mkdirSync(evidenceRoot, { recursive: true })
  const officeEvidence = process.platform === 'darwin' ? mkdtempSync(join(evidenceRoot, 'office-')) : undefined
  const packageAction = async (environment: NodeJS.ProcessEnv) => {
    const args = process.argv.slice(2)
    if (!args.includes(target)) args.unshift(target)
    if (environment.PACKAGE_SIGNING === 'internal' && !args.includes('--unsigned')) args.push('--unsigned')
    if (environment.PACKAGE_SIGNING === 'internal' && !args.includes('--check')) {
      rmSync(join(root, 'apps/desktop/.desktop-build/targets', target, 'unsigned-artifacts'), { recursive: true, force: true })
    }
    const child = spawn(process.execPath, [packageManager, '--dir', 'apps/desktop', 'run', 'package', ...args], {
      cwd: root, stdio: 'inherit', env: { ...environment, DSH_DESKTOP_ASSEMBLY_MANIFEST: manifest },
    })
    const diagnostics = new AbortController()
    const observation = officeEvidence !== undefined && child.pid !== undefined
      ? observeOfficeProcesses(child.pid, officeEvidence, { signal: diagnostics.signal })
        .catch(() => { console.error('Office process diagnostics unavailable; packaging outcome is unchanged.') })
      : Promise.resolve()
    const stop = () => { child.kill('SIGTERM') }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      await new Promise<void>((resolve, reject) => {
        let startupError: Error | undefined
        child.once('error', (error) => { startupError = error })
        child.once('close', (code) => {
          if (startupError !== undefined) { reject(startupError); return }
          process.exitCode = code ?? 1
          resolve()
        })
      })
    } finally {
      diagnostics.abort()
      await observation
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    }
    if (process.exitCode === undefined || process.exitCode === 0) {
      if (environment.PACKAGE_SIGNING === 'internal' && process.platform === 'darwin' && !args.includes('--check')) {
        await verifyInternalApplication(join(root, 'apps/desktop/.desktop-build/targets', target, 'unsigned-artifacts',
          'mac-arm64', 'DeepSeek Harness.app'), environment)
      }
      if (environment.PACKAGE_SIGNING === 'internal' && !args.some(arg => ['--check', '--dir', '--prepare-only'].includes(arg))) {
        await writeInternalBuildRecord(root, args, environment)
      }
    }
  }
  if (process.env.PACKAGE_SIGNING === 'internal' && process.platform === 'darwin' && !process.argv.includes('--check')) {
    await withInternalMacIdentity(process.env, packageAction)
  } else await packageAction(process.env)
} finally { rmSync(temporary, { recursive: true, force: true }) }
