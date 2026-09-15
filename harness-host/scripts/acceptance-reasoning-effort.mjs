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
  received.push({ model: body.model, effort: body.reasoning_effort, thinking: body.thinking })
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const choice of [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }]) {
    response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [choice] })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
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
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'ultra']) {
    await run('gpt-5.6-sol', effort)
    assert.deepEqual(received.at(-1), { model: 'gpt-5.6-sol', effort, thinking: undefined })
    console.log(JSON.stringify({ check: 'reasoning-wire-parameter', effort, passed: true }))
  }
  const count = received.length
  await assert.rejects(run('gpt-5.5', 'ultra'))
  assert.equal(received.length, count, 'Unsupported effort reached the provider')
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
