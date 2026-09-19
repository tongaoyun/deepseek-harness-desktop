// Exercises the production Cordis composition and tool events with a local model stub.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarnessRuntime } from '../dist/runtime.js'

const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-outcome-acceptance-'))
let scenario
let requests = 0
let suppliedReport = false
let serverFailure
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/chat/completions')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const names = body.tools.map((tool) => tool.function.name)
    const discovery = names.includes('tool_discover') && !names.includes('task_report')
    assert.ok(discovery || names.includes('task_report'), 'production tool list must offer discovery or reporting')
    requests++
    const report = scenario && !suppliedReport && !discovery
    if (report) suppliedReport = true
    const delta = discovery && scenario
      ? { role: 'assistant', tool_calls: [{ index: 0, id: `discover-${requests}`, type: 'function', function: { name: 'tool_discover', arguments: '{"groups":["workflow"]}' } }] }
      : report ? { role: 'assistant', tool_calls: [{ index: 0, id: `report-${requests}`, type: 'function', function: { name: 'task_report', arguments: JSON.stringify(scenario) } }] }
        : { role: 'assistant', content: '受控验收回复' }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: discovery && scenario || report ? 'tool_calls' : 'stop' }]) {
      response.write(`data: ${JSON.stringify({ id: `completion-${requests}`, object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', choices: [choice] })}\n\n`)
    }
    response.end('data: [DONE]\n\n')
  } catch (error) {
    serverFailure = error
    response.writeHead(500); response.end('Controlled provider fixture failed')
  }
})
let runtime
let deadline
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  runtime = new DeepSeekHarnessRuntime({
    DEEPSEEK_API_KEY: 'local-fixture-only', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    DSH_HOME: directory, DSH_SESSION_ROOT: join(directory, 'sessions'), XIAOYIN_ATTACHMENT_ROOT: join(directory, 'attachments'),
    XIAOYIN_LOCAL_FILE_ROOTS: '[]', XIAOYIN_MCP_CONNECTORS: '[]', DSH_CUSTOM_SKILL_DIRS: '[]',
    XIAOYIN_ALLOW_BROWSER: 'false', XIAOYIN_COMPUTER_USE_TOOLS: '[]',
  })
  deadline = setTimeout(() => { void runtime.close() }, 30_000)
  for (const status of ['completed', 'needs_input', undefined]) {
    const before = requests
    scenario = status ? { status, summary: '受控任务结果', remaining: status === 'completed' ? [] : ['提供统计月份'], checks: [] } : undefined
    suppliedReport = false
    const calls = []
    const result = await runtime.run({ prompt: '验收任务结果传输。' }, (notification) => {
      const event = notification.params?.event
      if (event?.type === 'tool/call') calls.push(event.data.name)
    })
    assert.ifError(serverFailure)
    assert.equal(result.outcome.status, status ?? 'answered')
    assert.equal(requests - before, status ? 3 : 1, 'a direct answer must not request a report')
    assert.equal(result.finalResponse, '受控验收回复')
    if (scenario) {
      assert.deepEqual(result.outcome, scenario)
      assert.ok(calls.includes('task_report'))
    }
    console.log(JSON.stringify({ check: status ?? 'missing-report', passed: true, toolCalls: calls }))
  }
  console.log(JSON.stringify({ providerRequests: requests, realModel: false }))
} finally {
  clearTimeout(deadline)
  await runtime?.close()
  await new Promise((resolve) => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
