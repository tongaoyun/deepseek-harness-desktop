import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { appendFile, glob, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarnessRuntime } from '../dist/runtime.js'

const root = await mkdtemp(join(tmpdir(), 'xiaoyin-session-recovery-'))
let phase = 'initial'
let failure
let requests = 0
let stopRuntime
let streamDelivered
const firstDelta = new Promise((resolve) => { streamDelivered = resolve })
const server = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests++
    if (phase === 'restored') {
      assert(JSON.stringify(body.messages).includes('XY-SESSION-PERSISTED'))
      assert(JSON.stringify(body.messages).includes('已记录第一轮任务'))
    }
    if (phase === 'retry') assert(JSON.stringify(body.messages).includes('XY-FAILED-TURN'))
    if (phase === 'cancel-restored') assert(JSON.stringify(body.messages).includes('XY-CANCELED-TURN'))
    if (phase === 'fail') {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'controlled invalid request', type: 'invalid_request_error' } }))
      return
    }
    if (phase === 'cancel') {
      stopRuntime()
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const text = phase === 'initial' ? '已记录第一轮任务' : '会话恢复验证完成'
    for (const choice of [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: 'stop' }]) {
      response.write(`data: ${JSON.stringify({ id: 'recovery-' + requests, object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', choices: [choice] })}\n\n`)
      if (phase === 'initial' && choice.delta.content) {
        let timer
        try {
          await Promise.race([firstDelta, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Live text was not forwarded before model completion')), 5_000) })])
        } finally { clearTimeout(timer) }
      }
    }
    response.end('data: [DONE]\n\n')
  } catch (error) {
    failure = error
    response.writeHead(400)
    response.end('recovery assertion failed')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const environment = {
  DEEPSEEK_API_KEY: 'local-fixture-only', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  DSH_HOME: root, DSH_SESSION_ROOT: join(root, 'sessions'), XIAOYIN_ATTACHMENT_ROOT: join(root, 'attachments'),
  XIAOYIN_SESSION_QUERY_PATH: join(root, 'session-query.sqlite'),
  XIAOYIN_LOCAL_FILE_ROOTS: '[]', XIAOYIN_MCP_CONNECTORS: '[]', DSH_CUSTOM_SKILL_DIRS: '[]',
  XIAOYIN_ALLOW_BROWSER: 'false', XIAOYIN_COMPUTER_USE_TOOLS: '[]',
}
let runtime = new DeepSeekHarnessRuntime(environment)
try {
  const initial = await runtime.run({ prompt: '记住任务标记 XY-SESSION-PERSISTED。' }, (notification) => {
    if (notification.params.event?.type === 'text-chunks') streamDelivered()
  })
  assert.ifError(failure)
  console.log(JSON.stringify({ check: 'live-text-before-model-completion', passed: true }))
  await assert.doesNotReject(runtime.searchSessions([initial.sessionId], 'PERSISTED', 10))
  await runtime.close()
  await writeFile(environment.XIAOYIN_SESSION_QUERY_PATH, 'not a sqlite database')
  const logs = []
  for await (const path of glob('**/session.v3.jsonl', { cwd: environment.DSH_SESSION_ROOT })) logs.push(join(environment.DSH_SESSION_ROOT, path))
  assert.equal(logs.length, 1, 'Expected one current Session JSONL generation')
  await appendFile(logs[0], '{"type":"assistant/chunk","torn":"XY-TORN-TAIL"')
  runtime = new DeepSeekHarnessRuntime(environment)
  const rebuilt = await runtime.searchSessions([initial.sessionId], 'PERSISTED', 10)
  assert(rebuilt.items.some((item) => item.sessionId === initial.sessionId), 'Derived search index was not rebuilt from Session JSONL')
  phase = 'restored'
  const restored = await runtime.run({ sessionId: initial.sessionId, prompt: '继续第一轮任务。' }, () => {})
  assert.equal(restored.sessionId, initial.sessionId)
  assert.equal((await readFile(logs[0], 'utf8')).includes('XY-TORN-TAIL'), false, 'Torn JSONL tail was not repaired before resume')
  assert.ifError(failure)
  console.log(JSON.stringify({ check: 'restart-with-history', passed: true, derivedIndexRebuilt: true, tornTailRecovered: true }))

  phase = 'fail'
  await assert.rejects(runtime.run({ sessionId: initial.sessionId, prompt: 'XY-FAILED-TURN' }, () => {}))
  phase = 'retry'
  await runtime.run({ sessionId: initial.sessionId, prompt: '重试失败任务。' }, () => {})
  assert.ifError(failure)
  console.log(JSON.stringify({ check: 'retry-failed-turn', passed: true }))

  phase = 'cancel'
  let closed
  stopRuntime = () => { closed = runtime.close() }
  await assert.rejects(runtime.run({ sessionId: initial.sessionId, prompt: 'XY-CANCELED-TURN' }, () => {}))
  await closed
  runtime = new DeepSeekHarnessRuntime(environment)
  phase = 'cancel-restored'
  await runtime.run({ sessionId: initial.sessionId, prompt: '继续被中断的任务。' }, () => {})
  assert.ifError(failure)
  console.log(JSON.stringify({ check: 'resume-canceled-turn', passed: true, realModel: false }))
} finally {
  await runtime.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
}
