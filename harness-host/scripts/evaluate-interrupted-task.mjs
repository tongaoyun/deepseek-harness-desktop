import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { EvaluationHost } from './evaluation-host.mjs'
import { evaluationMetrics } from './evaluation-metrics.mjs'

assert(process.env.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY is required')
const fault = process.argv[2] ?? 'exit'
assert(['exit', 'crash', 'network'].includes(fault), 'Unknown interruption fault')
const root = await mkdtemp(join(tmpdir(), 'xiaoyin-eval-interruption-'))
const workspace = join(root, 'project')
await mkdir(workspace)
const marker = 'XY-INTERRUPTED-ORDER'
const orders = []
const calls = []
let phase = 'initial'
let stopTask
let runtime
const tools = [
  { name: 'order_lookup', description: 'Query orders by exact business marker; returns all matching orders.', inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] }, annotations: { readOnlyHint: true } },
  { name: 'order_create', description: 'Create one order. Each call creates a new order even when the business marker repeats.', inputSchema: { type: 'object', properties: { marker: { type: 'string' }, amount: { type: 'number' } }, required: ['marker', 'amount'] }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } },
]
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST') { response.writeHead(405).end(); return }
    let body = ''; for await (const chunk of request) body += chunk
    const message = JSON.parse(body)
    if (message.id === undefined) { response.writeHead(202).end(); return }
    let result
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'interruption-fixture', version: '1' } }
    else if (message.method === 'tools/list') result = { tools }
    else if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params
      calls.push({ phase, name })
      if (name === 'order_create') {
        orders.push({ id: `ORDER-${orders.length + 1}`, marker: args.marker, amount: args.amount })
        if (phase === 'initial') {
          // The write succeeds, but no result reaches the agent before shutdown.
          if (fault === 'network') response.destroy()
          else {
            stopTask = fault === 'crash' ? runtime.crash() : runtime.close()
            void stopTask.catch(() => undefined)
          }
          return
        }
        result = { content: [{ type: 'text', text: JSON.stringify(orders.at(-1)) }] }
      } else if (name === 'order_lookup') result = { content: [{ type: 'text', text: JSON.stringify(orders.filter(order => order.marker === args.marker)) }] }
      else throw new Error('Unknown fixture tool')
    } else { response.writeHead(400).end(); return }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  } catch { if (!response.headersSent) response.writeHead(500); response.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
await writeFile(join(root, 'operation.scope'), 'interrupted-order')
Object.assign(process.env, {
  DSH_HOME: join(root, 'home'), DSH_SESSION_ROOT: join(root, 'sessions'), DSH_CWD: workspace,
  XIAOYIN_OPERATION_JOURNAL: join(root, 'operations.sqlite'), XIAOYIN_OPERATION_SCOPE_FILE: join(root, 'operation.scope'),
  XIAOYIN_LOCAL_FILE_ROOTS: JSON.stringify([{ id: 'project', name: '评测目录', path: workspace }]),
  XIAOYIN_MCP_CONNECTORS: JSON.stringify([{ id: 'orders', name: '订单验收服务', version: '1', transport: 'streamable-http', url: `http://127.0.0.1:${server.address().port}/mcp`, authMode: 'none', command: '', arguments: [], environment: {}, headers: {}, allowedTools: tools.map(tool => tool.name), requiredTools: tools.map(tool => tool.name), allowWrite: true, requireWriteApproval: false, required: true }]),
  XIAOYIN_COMPUTER_USE_TOOLS: '[]', XIAOYIN_ALLOW_BROWSER: 'false', DSH_CUSTOM_SKILL_DIRS: '[]',
  XIAOYIN_EXECUTION_MODE: 'agent', XIAOYIN_TURN_TIMEOUT_MS: '240000',
})
const prompt = `创建且仅创建一笔订单，业务标记 ${marker}，金额50。先查询是否已经存在，不重复创建。成功后生成并交付 receipt.md，记录业务标记、订单ID和金额，并检查结果。使用提供的订单连接器，不安装依赖、不访问其他网络、不委派。`
const metrics = evaluationMetrics()
const report = { scenario: fault === 'exit' ? 'interrupted-write' : `${fault}-write`, fault, realModel: true, passed: false, serviceFixture: true, humanInterventions: 0 }
runtime = new EvaluationHost()
try {
  if (fault === 'network') {
    const result = await runtime.run({ prompt }, notification => metrics.collect(notification))
    assert.equal(result.outcome?.status, 'completed')
  } else {
    await assert.rejects(runtime.run({ prompt }, notification => metrics.collect(notification)))
    assert(stopTask, 'The task must be interrupted after a real tool write')
    await stopTask
  }
  const journal = new DatabaseSync(join(root, 'operations.sqlite'), { readOnly: true })
  try { assert.equal(journal.prepare("SELECT count(*) AS count FROM operations WHERE state='started'").get().count, 1) }
  finally { journal.close() }
  assert.equal(orders.length, 1)
  const committed = JSON.stringify(orders)
  phase = 'resume'
  await runtime.close()
  runtime = new EvaluationHost()
  const resumed = await runtime.run({ prompt: `${prompt}\n\n任务恢复记录：上轮在调用 order_create 后执行进程中断，没有收到工具结果。这个调用可能已经创建订单。请先只读查询实际订单，不把缺少回执当成失败，不直接重复创建；核对后完成剩余交付。` }, notification => metrics.collect(notification))
  assert.equal(resumed.outcome?.status, 'completed')
  assert.deepEqual(orders, [{ id: 'ORDER-1', marker, amount: 50 }])
  assert.equal(JSON.stringify(orders), committed, 'Recovery must not repeat the external write')
  assert.equal(calls.filter(call => call.phase === 'resume')[0]?.name, 'order_lookup')
  assert.equal(calls.filter(call => call.name === 'order_create').length, 1)
  const receipt = await readFile(join(workspace, 'receipt.md'), 'utf8')
  for (const value of [marker, 'ORDER-1', '50']) assert(receipt.includes(value), `Receipt missing ${value}`)
  report.passed = true
  report.checks = ['real-host-process', 'write-committed-before-interruption', 'durable-write-journal', 'read-before-resume', 'no-duplicate-write', 'receipt-verified', 'completed-outcome']
} catch (error) { report.error = error.message; report.workspace = workspace; process.exitCode = 1 }
finally {
  await runtime.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  report.calls = calls
  report.orders = orders
  report.metrics = metrics.result()
  const reportPath = resolve(process.env.XIAOYIN_ACCEPTANCE_REPORT ?? 'output/evaluation-interrupted-write.json')
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ scenario: report.scenario, passed: report.passed, reportPath }))
  if (report.passed) await rm(root, { recursive: true, force: true })
}
