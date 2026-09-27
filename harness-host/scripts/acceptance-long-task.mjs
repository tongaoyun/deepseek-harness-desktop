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
  response.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'long-task', model: 'deepseek-v4-flash', usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`)
  response.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`)
  response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正在执行长任务。' } })}\n\n`)
  const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 50)
  request.once('close', () => { clearInterval(keepAlive); requestClosed(); response.destroy() })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const runtime = new DeepSeekHarnessRuntime({
  DEEPSEEK_API_KEY: 'local-fixture-only',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  DSH_HOME: root,
  DSH_SESSION_ROOT: join(root, 'sessions'),
  XIAOYIN_SESSION_QUERY_PATH: join(root, 'session-query.sqlite'),
  XIAOYIN_LOCAL_FILE_ROOTS: '[]',
  XIAOYIN_MCP_CONNECTORS: '[]',
  XIAOYIN_COMPUTER_USE_TOOLS: '[]',
  DSH_CUSTOM_SKILL_DIRS: '[]',
  XIAOYIN_ALLOW_SHELL: 'false',
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
