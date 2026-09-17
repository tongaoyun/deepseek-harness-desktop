import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarnessRuntime } from '../dist/runtime.js'

/**
 * The desktop restarts the host process whenever the model, the reasoning
 * effort or the capability set changes, and resumes the same session instead of
 * replaying the conversation as text. This checks that a session survives such
 * a restart with its history intact and without the replay marker.
 */
const root = await mkdtemp(join(tmpdir(), 'xiaoyin-session-continuity-'))
const requests = []
const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  requests.push(body)
  const text = requests.length === 1 ? '已记录第一轮任务。' : '第二轮完成。'
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const choice of [
    { index: 0, delta: { role: 'assistant', content: text }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: 'stop' },
  ]) {
    response.write(`data: ${JSON.stringify({ id: `continuity-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [choice] })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

const environment = {
  DEEPSEEK_API_KEY: 'local-fixture-only',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  DSH_HOME: root,
  DSH_SESSION_ROOT: join(root, 'sessions'),
  XIAOYIN_ATTACHMENT_ROOT: join(root, 'attachments'),
  XIAOYIN_SESSION_QUERY_PATH: join(root, 'session-query.sqlite'),
  XIAOYIN_LOCAL_FILE_ROOTS: '[]',
  XIAOYIN_MCP_CONNECTORS: '[]',
  DSH_CUSTOM_SKILL_DIRS: '[]',
  XIAOYIN_KNOWLEDGE_BASE_REFS: '[]',
  XIAOYIN_ALLOW_BROWSER: 'false',
  XIAOYIN_COMPUTER_USE_TOOLS: '[]',
}

let runtime = new DeepSeekHarnessRuntime(environment)
let sessionId
try {
  const first = await runtime.run({ prompt: '记住任务标记 XY-CONTINUITY。' }, () => {})
  sessionId = first.sessionId
  assert.equal(first.finalResponse, '已记录第一轮任务。')
  await runtime.close()

  // A model switch and a capability change both restart the host process while
  // the employee keeps the same conversation.
  runtime = new DeepSeekHarnessRuntime({
    ...environment,
    DSH_MODEL: 'deepseek-v4-pro',
    XIAOYIN_REASONING_EFFORT: 'high',
    XIAOYIN_KNOWLEDGE_BASE_REFS: '["kb-weekly"]',
    XIAOYIN_MCP_CONNECTORS: '[{"id":"erp-mcp","name":"erp-mcp","url":"http://127.0.0.1:1/mcp","authMode":"none","enabled":true,"toolNames":[]}]',
  })
  const second = await runtime.run({ sessionId, prompt: '继续第一轮任务。' }, () => {})
  assert.equal(second.sessionId, sessionId, 'The resumed turn must keep the session identity')
  assert.equal(second.finalResponse, '第二轮完成。')

  const resumed = JSON.stringify(requests[1]?.messages ?? [])
  assert(resumed.includes('XY-CONTINUITY'), 'The resumed turn lost the first prompt')
  assert(resumed.includes('已记录第一轮任务'), 'The resumed turn lost the first reply')
  assert(!resumed.includes('以下是同一任务在重建本地执行会话前的可见对话'), 'The conversation was replayed as text instead of resumed')

  console.log(JSON.stringify({ check: 'resumes-a-session-across-a-config-restart', passed: true, sessionId }))
  console.log(JSON.stringify({ check: 'keeps-history-without-replay', passed: true }))
} finally {
  await runtime.close().catch(() => undefined)
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
