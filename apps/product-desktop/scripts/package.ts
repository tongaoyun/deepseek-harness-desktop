/** Local product packaging delegates to the official desktop build pipeline. */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { productPackagingAssembly } from './packaging-assembly.mjs'
import { observeOfficeProcesses } from './office-process-diagnostics.mjs'
const packageManager = process.env.npm_execpath
if (packageManager === undefined) throw new Error('Invoke product packaging through pnpm')
const root = fileURLToPath(new URL('../../..', import.meta.url))
const crate = join(root, 'native/deepseek-harness/Cargo.toml')
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', crate],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })) as { target_directory?: unknown }
if (typeof metadata.target_directory !== 'string') throw new Error('Cargo did not return its target directory')
const assembly = productPackagingAssembly(
  fileURLToPath(new URL('../../../packages/deepseek-harness-product/desktop/assembly.json', import.meta.url)), metadata.target_directory)
if (!process.argv.includes('--check')) {
  execFileSync('cargo', ['build', '--release', '--manifest-path', crate], { cwd: root, stdio: 'inherit' })
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
  const child = spawn(process.execPath, [packageManager, '--dir', 'apps/desktop', 'run', 'package', ...process.argv.slice(2)], {
    cwd: root, stdio: 'inherit', env: { ...process.env, DSH_DESKTOP_ASSEMBLY_MANIFEST: manifest },
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
} finally { rmSync(temporary, { recursive: true, force: true }) }
