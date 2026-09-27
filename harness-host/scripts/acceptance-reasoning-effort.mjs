import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarnessRuntime } from '../dist/runtime.js'

const home = await mkdtemp(join(tmpdir(), 'xiaoyin-reasoning-'))
const received = []
const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  received.push({ model: body.model, effort: body.output_config?.effort, thinking: body.thinking?.type })
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const events = [
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  response.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
async function run(model, effort) {
  const root = join(home, `${model}-${effort}`)
  const runtime = new DeepSeekHarnessRuntime({
    DEEPSEEK_API_KEY: 'fixture', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    DSH_HOME: root, DSH_SESSION_ROOT: join(root, 'sessions'), DSH_MODEL: model, DSH_REASONING_EFFORT: effort,
    XIAOYIN_ALLOW_BROWSER: 'false', XIAOYIN_COMPUTER_USE_TOOLS: '[]', XIAOYIN_MCP_CONNECTORS: '[]',
  })
  try { await runtime.run({ prompt: 'Reply OK' }, () => {}) }
  finally { await runtime.close() }
}
try {
  // The official DeepSeek provider advertises only `low` for the fixture
  // model. Unsupported values must be rejected before a provider request.
  for (const effort of ['low']) {
    await run('deepseek-v4-pro', effort)
    assert.deepEqual(received.at(-1), { model: 'deepseek-v4-pro', effort, thinking: 'enabled' })
    console.log(JSON.stringify({ check: 'reasoning-wire-parameter', effort, passed: true }))
  }
  const count = received.length
  await assert.rejects(run('deepseek-v4-flash', 'invalid'))
  assert.equal(received.length, count, 'Unsupported effort reached the provider')
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
