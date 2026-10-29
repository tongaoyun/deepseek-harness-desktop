/** Product assembly launches the official Electron shell and dsh Desktop profile. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { productDevelopmentEnvironment } from './environment.ts'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const run = (command: string, args: string[], env = process.env) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', (code) => { if (code === 0) resolve(); else reject(new Error(`Product launcher exited: ${String(code)}`)) })
  const stop = () => { child.kill('SIGTERM') }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  child.once('exit', () => { process.off('SIGINT', stop); process.off('SIGTERM', stop) })
})
const native = process.env.DEEPSEEK_HARNESS_NATIVE_BINARY ?? join(resolve(root, process.env.CARGO_TARGET_DIR ?? 'native/deepseek-harness/target'), 'release',
  process.platform === 'win32' ? 'deepseek-harness-native.exe' : 'deepseek-harness-native')
if (!existsSync(native)) await run('cargo', ['build', '--release', '--manifest-path', join(root, 'native/deepseek-harness/Cargo.toml')])
const require = createRequire(import.meta.url)
const entry = pathToFileURL(require.resolve('@deepseek-harness/product-desktop')).href
const assembly = require.resolve('@deepseek-harness/product-desktop/assembly.json')
await run(process.execPath, ['--import', 'tsx/esm', join(root, 'apps/desktop/scripts/dev.ts'), ...process.argv.slice(2)], {
  ...productDevelopmentEnvironment(root, process.env),
  DSH_DESKTOP_EXTENSION: entry,
  DSH_DESKTOP_ASSEMBLY_MANIFEST: assembly,
  DEEPSEEK_HARNESS_NATIVE_BINARY: native,
  DSH_DESKTOP_EXTENSION_ENV: JSON.stringify({ DSH_DESKTOP_EXTENSION: entry,
    DEEPSEEK_HARNESS_NATIVE_BINARY: native, DSH_DESKTOP_ASSEMBLY_MANIFEST: assembly }),
})
