/** Local product packaging delegates to the official desktop build pipeline. */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const packageManager = process.env.npm_execpath
if (packageManager === undefined) throw new Error('Invoke product packaging through pnpm')
const child = spawn(process.execPath, [packageManager, '--dir', 'apps/desktop', 'run', 'package', ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL('../../..', import.meta.url)), stdio: 'inherit',
  env: { ...process.env, DSH_DESKTOP_ASSEMBLY_MANIFEST: fileURLToPath(new URL('../../../packages/deepseek-harness-product/desktop/assembly.json', import.meta.url)) },
})
child.once('error', (error) => { console.error(error); process.exitCode = 1 })
child.once('exit', (code) => { process.exitCode = code ?? 1 })
