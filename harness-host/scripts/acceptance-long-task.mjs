import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarnessRuntime } from '../dist/runtime.js'

const root = await mkdtemp(join(tmpdir(), 'xiaoyin-long-task-'))
let requestStarted
let requestClosed
const started = new Promise((resolve) => { requestStarted = resolve })
const closed = new Promise((resolve) => { requestClosed = resolve })
const server = createServer((request, response) => {
  requestStarted()
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  response.write(`data: ${JSON.stringify({ id: 'long-task', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', choices: [{ index: 0, delta: { role: 'assistant', content: '正在执行长任务。' }, finish_reason: null }] })}\n\n`)
  const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 50)
  request.once('close', () => { clearInterval(keepAlive); requestClosed(); response.destroy() })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const runtime = new DeepSeekHarnessRuntime({
  DEEPSEEK_API_KEY: 'local-fixture-only',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  DSH_HOME: root,
  DSH_SESSION_ROOT: join(root, 'sessions'),
  XIAOYIN_ATTACHMENT_ROOT: join(root, 'attachments'),
  XIAOYIN_LOCAL_FILE_ROOTS: '[]',
  XIAOYIN_MCP_CONNECTORS: '[]',
  XIAOYIN_COMPUTER_USE_TOOLS: '[]',
  XIAOYIN_ALLOW_BROWSER: 'false',
})

try {
  const run = runtime.run({ sessionId: 'long-task', prompt: '执行一个不会自行结束的长任务。' }, () => {})
  await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('长任务没有进入模型请求')), 5_000))])
  const began = performance.now()
  assert.equal((await runtime.interrupt('long-task')).interrupted, true)
  const result = await run
  assert.equal(result.interrupted, true)
  const elapsedMs = Math.round(performance.now() - began)
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('停止后模型请求仍未关闭')), 2_000))])
  assert(elapsedMs < 2_000, `停止耗时 ${elapsedMs}ms，超过 2s`)
  console.log(JSON.stringify({ check: 'real-long-task-interrupt', passed: true, elapsedMs, realModel: false, providerRequestAborted: true, interrupted: result.interrupted }))
} finally {
  await runtime.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
