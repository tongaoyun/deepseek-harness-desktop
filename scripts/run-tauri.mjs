import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveTauriServerUrl, tauriSecurityConfig } from './tauri-security-config.mjs'

const args = process.argv.slice(2)
const command = args[0]
if (command === 'dev' || command === 'build') {
  const serverUrl = resolveTauriServerUrl(command)
  process.env.VITE_XIAOYIN_SERVER_URL = serverUrl
  args.push('--config', JSON.stringify(tauriSecurityConfig(serverUrl)))
}

const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url))
const child = spawn(process.execPath, [cli, ...args], { env: process.env, stdio: 'inherit' })
child.once('error', (error) => {
  console.error(`Unable to start Tauri: ${error.message}`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1
})
