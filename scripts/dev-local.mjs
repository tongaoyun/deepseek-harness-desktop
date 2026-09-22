import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer as createNetServer } from 'node:net'
import { createServer, loadEnv } from 'vite'
import { localDevelopmentPort, localDevelopmentTauriConfig } from './dev-local-config.mjs'

const useRealEnterpriseSession = process.env.XIAOYIN_USE_REAL_ENTERPRISE_SESSION === 'true'
process.env.VITE_SKIP_ERP_LOGIN = useRealEnterpriseSession ? 'false' : 'true'
process.env.XIAOYIN_LOCAL_DEV_REAL_SESSION = useRealEnterpriseSession ? 'true' : 'false'
process.env.XIAOYIN_LOCAL_DEV_WEBVIEW_ISOLATION = 'true'
const root = fileURLToPath(new URL('..', import.meta.url))
const backend = process.env.VITE_XIAOYIN_SERVER_URL ?? loadEnv('development', root, 'VITE_').VITE_XIAOYIN_SERVER_URL ?? 'http://192.168.2.67:30081'
const probe = createNetServer()
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(localDevelopmentPort(process.env.XIAOYIN_LOCAL_DEV_PORT), '127.0.0.1', resolve) })
const address = probe.address()
if (!address || typeof address === 'string') throw new Error('本地测试服务启动失败')
await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
const url = `http://127.0.0.1:${address.port}`
process.env.VITE_XIAOYIN_SERVER_URL = url
const server = await createServer({ root, server: { host: '127.0.0.1', port: address.port, strictPort: true,
  proxy: { '/api': { target: backend, changeOrigin: true } },
} })
await server.listen()
const config = localDevelopmentTauriConfig(url)
console.log(`本地测试预览：${url}`)
console.log(useRealEnterpriseSession
  ? '开发会话：使用正式小胤的企业登录凭据；任务数据与 WebView 仍保持隔离。'
  : '开发会话：local-development；应用数据与正常小胤独立。')
const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url))
const child = spawn(process.execPath, [cli, 'dev', '--config', JSON.stringify(config), ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: process.env, detached: process.platform !== 'win32',
})
let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try { process.kill(-child.pid, 'SIGTERM') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  void server.close()
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop)
try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(stopping ? 0 : code ?? 1))
  })
} finally { await server.close() }
