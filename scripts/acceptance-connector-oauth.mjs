import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { WriteOperationJournal } from '../harness-host/dist/write-operation-journal.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const employeeId = 'local-development'
let base = '', child, childExit, challenge = '', refreshes = 0, revocations = 0, rejectNext = false
const queued = [], pending = new Map(), checks = []
const script = `setInterval(async () => {
  for (const item of await (await fetch('/control')).json()) {
    void window.__TAURI_INTERNALS__.invoke(item.command, item.args).then(
      result => fetch('/report', {method:'POST', body:JSON.stringify({id:item.id,result})}),
      error => fetch('/report', {method:'POST', body:JSON.stringify({id:item.id,error:String(error)})})
    );
  }
}, 150);`
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, base || 'http://localhost')
    let body = ''; for await (const chunk of req) body += chunk
    res.setHeader('Cache-Control', 'no-store')
    const json = (value, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
    if (url.pathname === '/control') return json(queued.splice(0))
    if (url.pathname === '/report') {
      const message = JSON.parse(body), request = pending.get(message.id)
      if (request) {
        pending.delete(message.id); clearTimeout(request.timer)
        if (message.error) request.reject(new Error(message.error))
        else request.resolve(message.result)
      }
      return json({})
    }
    if (url.pathname === '/acceptance.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(script)
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['orders:read'] })
    if (url.pathname.startsWith('/.well-known/')) return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, revocation_endpoint: `${base}/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true })
    if (url.pathname === '/register') return json({ ...JSON.parse(body), client_id: 'native-fixture' }, 201)
    if (url.pathname === '/authorize') {
      challenge = url.searchParams.get('code_challenge')
      const callback = new URL(url.searchParams.get('redirect_uri'))
      callback.searchParams.set('code', 'native-code'); callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('iss', base)
      return res.writeHead(302, { Location: callback.href }).end()
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(body)
      if (params.get('grant_type') === 'authorization_code') assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), challenge)
      else { assert.equal(params.get('refresh_token'), `fixture-refresh-${refreshes}`); refreshes += 1 }
      return json({ access_token: `fixture-access-${refreshes}`, refresh_token: `fixture-refresh-${refreshes}`, token_type: 'Bearer', expires_in: refreshes ? 300 : 1, scope: 'orders:read' })
    }
    if (url.pathname === '/revoke') { revocations += 1; return json({}) }
    if (url.pathname === '/mcp') {
      if (rejectNext) { rejectNext = false; return json({}, 401) }
      if (req.headers.authorization !== `Bearer fixture-access-${refreshes}`) return json({}, 401)
      if (req.method !== 'POST') return json({}, 405)
      const message = JSON.parse(body)
      if (message.id === undefined) return res.writeHead(202).end()
      const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'OAuth acceptance', version: '1' } } : { tools: [] }
      return json({ jsonrpc: '2.0', id: message.id, result })
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><title>连接器授权验收</title><p>连接器授权验收</p><script src="/acceptance.js"></script>')
  } catch { res.writeHead(500).end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
base = `http://localhost:${server.address().port}`
const connector = { id: 'oauth-fixture', name: 'OAuth 验收', version: '1', status: 'ready', transport: 'streamable-http', url: `${base}/mcp`, authMode: 'oauth', enabled: true, toolNames: [] }
const config = { identifier: 'com.instudio.xiaoyin.desktop.local-test', build: { devUrl: base, beforeDevCommand: '' }, app: { windows: [
  { label: 'main', title: '连接器授权验收', width: 920, height: 660 },
] } }
function rpc(command, args) {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${command}`)) }, 180000)
    pending.set(id, { resolve, reject, timer }); queued.push({ id, command, args })
  })
}
const authorization = action => rpc('connector_authorization', { request: { employeeId, connector, action } })
const diagnose = () => rpc('diagnose_connectors', { request: { employeeId, accessToken: 'fixture', connectors: [connector] } })
function start(command, args) {
  child = spawn(command, args, { cwd: root, env: { ...process.env, VITE_SKIP_DINGTALK_LOGIN: 'true', XIAOYIN_LOCAL_DEV_WEBVIEW_ISOLATION: 'true' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let tail = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { tail = (tail + chunk).slice(-5000) })
  childExit = new Promise(resolve => { child.once('exit', code => { if (code) console.error(tail); resolve() }); child.once('error', error => { console.error(error.message); resolve() }) })
}
async function stop() {
  if (!child) return
  try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  await childExit; child = undefined
}
const report = { scenario: 'native-connector-oauth', passed: false, checks }
try {
  start(process.execPath, [fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url)), 'dev', '--no-watch', '--config', JSON.stringify(config)])
  assert.equal((await authorization('status')).status, 'disconnected')
  const account = await authorization('authorize')
  assert.equal(account.status, 'authorized'); assert.equal(account.scope, 'orders:read')
  assert(!JSON.stringify(account).includes('fixture-access')); assert(!JSON.stringify(account).includes('fixture-refresh'))
  checks.push('browser-pkce-and-keyring'); console.log('PASS: browser authorization and native keyring')
  const results = await Promise.all([diagnose(), diagnose()])
  assert(results.every(value => value[0].status === 'ready')); assert.equal(refreshes, 1)
  checks.push('serialized-refresh-and-mcp-discovery'); console.log('PASS: concurrent workers share one token refresh')
  const checkpointAt = new Date().toISOString()
  const checkpoint = { id: 'restart-checkpoint', name: '恢复验收', source: 'DESKTOP', status: 'RUNNING', createdAt: checkpointAt, updatedAt: checkpointAt,
    monitor: { status: 'running', activity: '正在提交订单', operationScope: randomUUID(), executionStarted: true, updatedAt: checkpointAt,
      steps: [{ id: 'write', kind: 'tool', label: '提交订单', status: 'running', toolName: 'order_create', startedAt: checkpointAt }], artifacts: [] },
    messages: [{ role: 'user', text: '创建订单' }, { role: 'assistant', text: '已核对价格', pending: true }] }
  await rpc('save_local_task', { employeeId, task: checkpoint })
  await stop()
  start(fileURLToPath(new URL('../src-tauri/target/debug/xiaoyin-desktop', import.meta.url)), [])
  assert.equal((await authorization('status')).status, 'authorized')
  assert.equal((await diagnose())[0].status, 'ready'); assert.equal(refreshes, 1)
  checks.push('restart-restores-keyring'); console.log('PASS: restart restores authorization')
  assert.deepEqual(await rpc('load_local_task', { employeeId, id: checkpoint.id }), checkpoint)
  assert.equal(await rpc('load_local_task', { employeeId: `${employeeId}-other`, id: checkpoint.id }), null)
  checks.push('native-checkpoint-survives-restart-and-account-isolation'); console.log('PASS: native restart preserves pending text, tool state and execution scope')
  rejectNext = true
  assert.equal((await diagnose())[0].status, 'authentication-required')
  assert.equal((await diagnose())[0].status, 'ready'); assert.equal(refreshes, 2)
  checks.push('401-refresh-without-replay'); console.log('PASS: rejected request is not replayed; next request refreshes')
  const taskId = 'journal-acceptance'
  const key = createHash('sha256').update(JSON.stringify([employeeId, taskId])).digest('hex')
  const journalPath = resolve(homedir(), 'Library/Application Support', config.identifier, 'task-operations', `${key}.sqlite`)
  const journal = new WriteOperationJournal(journalPath, 'native-turn')
  const target = { ...connector, command: '', arguments: [] }
  try {
    await assert.rejects(journal.execute(target, 'order_create', { marker: 'NATIVE-ORDER' }, async () => { throw new Error('No receipt') }))
    const records = await rpc('task_write_operations', { request: { employeeId, taskId } })
    assert.equal(records.length, 1); assert.equal(records[0].tool, 'order_create')
    const resolved = await rpc('task_write_operations', { request: { employeeId, taskId, resolution: { id: records[0].id, applied: false, evidence: '已核对测试订单，确认没有创建' } } })
    assert.equal(resolved.length, 0)
    const receipt = { content: [{ type: 'text', text: 'NATIVE-ORDER' }] }
    assert.deepEqual(await journal.execute(target, 'order_create', { marker: 'NATIVE-ORDER' }, async () => receipt), receipt)
  } finally { journal.close() }
  checks.push('native-write-review-and-explicit-retry'); console.log('PASS: native operation review permits an explicitly verified retry')
  assert.equal((await authorization('disconnect')).status, 'disconnected'); assert.equal(revocations, 1)
  assert.equal((await diagnose())[0].status, 'authentication-required')
  checks.push('disconnect-revokes-running-worker-access'); console.log('PASS: disconnect revokes access')
  report.passed = true
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  if (child) { try { await authorization('disconnect') } catch { /* Best effort fixture cleanup. */ } }
  await stop()
  for (const item of pending.values()) clearTimeout(item.timer)
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  const reportPath = resolve(process.env.XIAOYIN_ACCEPTANCE_REPORT ?? 'output/acceptance-connector-oauth.json')
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ passed: report.passed, reportPath }))
}
