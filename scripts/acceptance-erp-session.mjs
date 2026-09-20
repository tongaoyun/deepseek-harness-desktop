import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

if (process.platform !== 'darwin') throw new Error('This native acceptance requires macOS.')
const root = fileURLToPath(new URL('..', import.meta.url))
const identifier = `com.instudio.xiaoyin.auth-test.${randomUUID()}`
const reports = []
let seed = true
let identityStatus = 200
let logout = false
let workspaceAction = ''
let child
let childExit
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true })

const browserScript = `
let busy = false;
let completedWorkspaceAction = '';
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const control = await (await fetch('/control')).json();
    if (control.logout) await window.__TAURI_INTERNALS__.invoke('clear_erp_session');
    const result = await window.__TAURI_INTERNALS__.invoke('erp_session');
    await fetch('/report', {method: 'POST', body: JSON.stringify({
      authenticated: result.authenticated, code: result.diagnostic.code,
      cookieCount: result.diagnostic.cookieCount, runId: result.diagnostic.runId
    })});
    if (result.authenticated && control.workspaceAction && control.workspaceAction !== completedWorkspaceAction) {
      const fixture = {drafts: {'new-task': {prompt: 'native workspace fixture', model: 'test-model',
        attachments: [], directories: [], knowledgeRefs: [], connectorIds: [], updatedAt: 1}}, recentDirectories: []};
      const employeeId = 'local-development';
      const state = control.workspaceAction === 'seed'
        ? (await window.__TAURI_INTERNALS__.invoke('save_local_workspace_state', {employeeId, state: fixture}), fixture)
        : await window.__TAURI_INTERNALS__.invoke('load_local_workspace_state', {employeeId});
      let ownerRejected = false;
      if (control.workspaceAction === 'read') {
        try { await window.__TAURI_INTERNALS__.invoke('load_local_workspace_state', {employeeId: 'another-employee'}); }
        catch { ownerRejected = true; }
      }
      completedWorkspaceAction = control.workspaceAction;
      await fetch('/report', {method: 'POST', body: JSON.stringify({
        code: control.workspaceAction === 'seed' ? 'workspace_saved' : 'workspace_restored',
        prompt: state.drafts['new-task']?.prompt, ownerRejected
      })});
    }
  } catch (error) {
    await fetch('/report', {method: 'POST', body: JSON.stringify({error: error?.code ?? String(error)})});
  } finally { busy = false; }
}, 300);
`
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost')
  response.setHeader('Cache-Control', 'no-store')
  if (url.pathname === '/seed') {
    if (seed) response.setHeader('Set-Cookie', 'SESSION=session-fixture; Path=/; HttpOnly; SameSite=Lax')
    response.end('<!doctype html><title>Session fixture</title>')
  } else if (url.pathname === '/identity') {
    const valid = request.headers.cookie?.includes('SESSION=session-fixture')
    response.writeHead(valid ? identityStatus : 401, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ operId: 'local-development', oper: 'Local acceptance' }))
  } else if (url.pathname === '/api/v1/employee-auth/identity') {
    const valid = request.method === 'GET' && request.headers['x-erp-session'] === 'session-fixture'
    response.writeHead(valid ? identityStatus : 401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(valid && identityStatus === 200 ? {
      success: true,
      data: { employeeId: 'local-development', teamId: '', employeeName: 'Local acceptance' },
    } : { success: false }))
  } else if (url.pathname === '/control') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ logout, workspaceAction }))
  } else if (url.pathname === '/report') {
    let body = ''
    for await (const chunk of request) body += chunk
    reports.push(JSON.parse(body))
    response.end('ok')
  } else if (url.pathname === '/acceptance.js') {
    response.setHeader('Content-Type', 'text/javascript')
    response.end(browserScript)
  } else {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><title>ERP session acceptance</title>${url.searchParams.has('window') ? '' : '<script src="/acceptance.js"></script>'}`)
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://localhost:${server.address().port}`
const env = { ...process.env, VITE_XIAOYIN_SERVER_URL: origin,
  XIAOYIN_ERP_COOKIE_URL: `${origin}/`, XIAOYIN_ERP_USER_URL: `${origin}/identity` }
const config = {
  identifier, productName: 'Xiaoyin Auth Acceptance',
  build: { devUrl: origin, beforeDevCommand: '' },
  app: { windows: [
    { label: 'main', title: 'Xiaoyin Auth Acceptance', width: 920, height: 660 },
    { label: 'erp-login', url: `${origin}/seed`, title: 'Session fixture', visible: false },
  ] },
}

function start(command, args) {
  reports.length = 0
  child = spawn(command, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-6000) })
  childExit = new Promise(resolve => {
    child.once('error', error => { reports.push({ error: error.message }); resolve() })
    child.once('exit', code => { if (code) console.error(output); resolve() })
  })
}

async function stop() {
  if (!child) return
  try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  await childExit
  child = undefined
  await delay(500)
}

async function waitFor(code, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('Acceptance interrupted')
    const result = reports.find(report => report.code === code || report.error === code)
    if (result) return result
    if (reports.some(report => report.error)) throw new Error(JSON.stringify(reports.at(-1)))
    await delay(200)
  }
  throw new Error(`Timed out waiting for ${code}: ${JSON.stringify(reports.slice(-3))}`)
}

const binary = fileURLToPath(new URL('../src-tauri/target/debug/xiaoyin-desktop', import.meta.url))
try {
  const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url))
  start(process.execPath, [cli, 'dev', '--no-watch', '--config', JSON.stringify(config)])
  const initial = await waitFor('authenticated', 180_000)
  assert.equal(initial.cookieCount, 1)
  console.log('PASS: session-only WebView cookie validated and saved')
  workspaceAction = 'seed'
  const saved = await waitFor('workspace_saved')
  assert.equal(saved.prompt, 'native workspace fixture')
  await stop()
  seed = false
  workspaceAction = 'read'
  start(binary, [])
  const restored = await waitFor('authenticated')
  assert.notEqual(restored.runId, initial.runId)
  assert.equal(restored.cookieCount, 1)
  console.log('PASS: new process restored the session without a login response')
  const workspace = await waitFor('workspace_restored')
  assert.equal(workspace.prompt, 'native workspace fixture')
  assert.equal(workspace.ownerRejected, true)
  workspaceAction = ''
  console.log('PASS: native workspace state survived restart and rejected another employee')

  reports.length = 0
  identityStatus = 503
  await waitFor('identity_unavailable')
  await stop()
  identityStatus = 200
  start(binary, [])
  await waitFor('authenticated')
  console.log('PASS: service failure preserved credentials for restart')

  reports.length = 0
  logout = true
  await waitFor('cookie_missing')
  await stop()
  logout = false
  start(binary, [])
  await waitFor('cookie_missing')
  console.log('PASS: logout removed WebView and saved credentials across restart')
  await stop()
  seed = true
  start(binary, [])
  await waitFor('authenticated')
  reports.length = 0
  seed = false
  identityStatus = 401
  await waitFor('session_rejected')
  await stop()
  identityStatus = 200
  start(binary, [])
  await waitFor('cookie_missing')
  console.log('PASS: ERP rejection removed saved credentials across restart')
} finally {
  logout = true
  if (child) await delay(500)
  await stop()
  await new Promise(resolve => server.close(resolve))
}
