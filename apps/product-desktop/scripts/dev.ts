/** Product assembly launches the official Electron shell and dsh Desktop profile. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
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
const require = createRequire(import.meta.url)
const assembly = require.resolve('@deepseek-harness/product-desktop/assembly.json')
const entry = pathToFileURL(join(dirname(assembly), 'lib/index.js')).href
await run(process.execPath, ['--import', 'tsx/esm', join(root, 'apps/desktop/scripts/dev.ts'), ...process.argv.slice(2)], {
  ...productDevelopmentEnvironment(root, process.env),
  DSH_DESKTOP_EXTENSION: entry,
  DSH_DESKTOP_ASSEMBLY_MANIFEST: assembly,
  DSH_DESKTOP_EXTENSION_ENV: JSON.stringify({ DSH_DESKTOP_EXTENSION: entry,
    DSH_DESKTOP_ASSEMBLY_MANIFEST: assembly }),
})
