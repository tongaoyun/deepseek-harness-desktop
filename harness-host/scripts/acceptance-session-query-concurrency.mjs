import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const hostRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const home = await mkdtemp(join(tmpdir(), 'xiaoyin-session-query-concurrency-'))
const host = resolve(hostRoot, 'dist/index.js')
const config = resolve(hostRoot, 'runtime/cordis.yml')

function start(label) {
  const child = spawn(process.execPath, [host], {
    cwd: home,
    env: {
      ...process.env,
      DSH_HOME: join(home, label),
      DSH_CORDIS_CONFIG: config,
      DSH_SESSION_ROOT: join(home, 'sessions'),
      XIAOYIN_SESSION_QUERY_PATH: join(home, 'session-query.sqlite'),
      XIAOYIN_ENABLE_SESSION_QUERY_TOOLS: 'false',
      XIAOYIN_LOCAL_FILE_ROOTS: '[]',
      XIAOYIN_MCP_CONNECTORS: '[]',
      XIAOYIN_ALLOW_BROWSER: 'false',
      XIAOYIN_ALLOW_SHELL: 'false',
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  const pending = new Map()
  let nextId = 1
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
  const closed = new Promise((resolveClose) => child.once('close', (code, signal) => {
    const detail = stderr.trim() || `exit ${code ?? signal ?? 'unknown'}`
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error(`${label} Host exited before responding: ${detail}`))
    }
    pending.clear()
    resolveClose()
  }))
  lines.on('line', (line) => {
    try {
      const value = JSON.parse(line)
      const request = pending.get(value.id)
      if (request) { pending.delete(value.id); clearTimeout(request.timer); request.resolve(value) }
    } catch { /* Protocol output is validated by the request promise timeout. */ }
  })
  const request = (method, params) => new Promise((resolveResponse, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      reject(new Error(`${label} ${method} cannot run after Host exit`)); return
    }
    const id = nextId++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${label} ${method} timed out`)) }, 30_000)
    pending.set(id, { resolve: resolveResponse, reject, timer })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`, (error) => {
      if (!error) return
      pending.delete(id); clearTimeout(timer); reject(error)
    })
  })
  const close = async () => {
    lines.close()
    let forceClose
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end()
      forceClose = setTimeout(() => child.kill('SIGKILL'), 5_000)
      forceClose.unref()
    }
    try { await closed } finally { if (forceClose) clearTimeout(forceClose) }
  }
  return { request, close }
}

const first = start('first')
const second = start('second')
try {
  const initialized = await Promise.all([first.request('host.initialize'), second.request('host.initialize')])
  for (const response of initialized) assert.equal(response.error, undefined, JSON.stringify(response))
  assert.deepEqual(initialized.map((value) => value.result?.status), ['initialized', 'initialized'])
  const searched = await Promise.all([
    first.request('session.search', { sessionIds: ['session-concurrency'], query: 'concurrency', limit: 10 }),
    second.request('session.search', { sessionIds: ['session-concurrency'], query: 'concurrency', limit: 10 }),
  ])
  for (const response of searched) {
    assert.equal(response.error, undefined)
    assert.deepEqual(response.result, { items: [] })
  }
  const stopped = await Promise.all([first.request('host.shutdown'), second.request('host.shutdown')])
  for (const response of stopped) {
    assert.equal(response.error, undefined, JSON.stringify(response))
    assert.equal(response.result?.status, 'closed')
  }
  console.log(JSON.stringify({ passed: true, checks: ['parallel-initialize', 'parallel-search', 'shared-derived-index', 'parallel-shutdown'], directory: home }))
} finally {
  await Promise.allSettled([first.close(), second.close()])
  await rm(home, { recursive: true, force: true })
}
