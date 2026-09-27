import { createInterface } from 'node:readline'
import { HostServer } from './server.js'
import { DeepSeekHarnessRuntime } from './runtime.js'
import type { JsonRpcOutput } from './protocol.js'
import { ApprovalBridge } from './approval-bridge.js'
import { QuestionBridge } from './question-bridge.js'
import { LocalImRuntime } from './im-runtime.js'
import { ScheduleBridge } from './schedule-bridge.js'
import { DesktopToolBridge } from './desktop-tool-bridge.js'
import { SessionProjectionBridge } from './session-projection-bridge.js'
import { publicErrorMessage } from './public-error.js'
import { data as structuredErrorData } from './errors.js'
import './xiaoyin-projections-plugin.js'

let stopping = false
const emit = (output: JsonRpcOutput): void => {
  if (stopping) return
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

const approvalBridge = new ApprovalBridge(emit)
const approvalEndpoint = await approvalBridge.start()
const questionBridge = new QuestionBridge(emit)
const questionEndpoint = await questionBridge.start()
const scheduleBridge = new ScheduleBridge(emit)
const scheduleEndpoint = await scheduleBridge.start()
const skillBridge = new DesktopToolBridge(emit, 'skill', ['search', 'inspect_github', 'install'], 95000)
const skillEndpoint = await skillBridge.start()
const projectionBridge = new SessionProjectionBridge(emit)
const projectionEndpoint = await projectionBridge.start()
const runtime = new DeepSeekHarnessRuntime({
  XIAOYIN_LOCAL_SKILL_URL: skillEndpoint.url,
  XIAOYIN_LOCAL_SKILL_TOKEN: skillEndpoint.token,
  XIAOYIN_LOCAL_SCHEDULE_URL: scheduleEndpoint.url,
  XIAOYIN_LOCAL_SCHEDULE_TOKEN: scheduleEndpoint.token,
  XIAOYIN_APPROVAL_BRIDGE_URL: approvalEndpoint.url,
  XIAOYIN_APPROVAL_BRIDGE_TOKEN: approvalEndpoint.token,
  XIAOYIN_QUESTION_BRIDGE_URL: questionEndpoint.url,
  XIAOYIN_QUESTION_BRIDGE_TOKEN: questionEndpoint.token,
  XIAOYIN_SESSION_PROJECTION_URL: projectionEndpoint.url,
  XIAOYIN_SESSION_PROJECTION_TOKEN: projectionEndpoint.token,
})
const imRuntime = new LocalImRuntime(runtime)
const server = new HostServer(
  runtime,
  emit,
  (approvalId, decision) => approvalBridge.respond(approvalId, decision),
  imRuntime,
  (questionId, answer) => questionBridge.respond(questionId, answer),
)
let chain = Promise.resolve()

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  if (stopping) return
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    emit({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error', data: structuredErrorData('XY-PARSE-ERROR', 'unknown', '请求格式错误', '请求不是有效 JSON', false, false) },
    })
    return
  }
  if (typeof value === 'object' && value !== null && ['schedule.respond', 'skill.respond'].includes(String((value as Record<string, unknown>).method))) {
    const params = (value as { params?: { requestId?: string; result?: unknown } }).params
    if (params?.requestId) ((value as Record<string, unknown>).method === 'skill.respond' ? skillBridge : scheduleBridge).respond(params.requestId, params.result)
    return
  }
  if (isInteractiveResponse(value)) {
    void server.handle(value).catch((error: unknown) => {
      process.stderr.write(`Harness approval response failure: ${publicErrorMessage(error)}\n`)
    })
    return
  }
  chain = chain.then(async () => {
    if (stopping) return
    await server.handle(value)
  }).catch((error: unknown) => {
    process.stderr.write(`Harness host failure: ${publicErrorMessage(error)}\n`)
  })
})

function isInteractiveResponse(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && ['approval.respond', 'question.respond', 'session.steer', 'session.interrupt'].includes(String((value as Record<string, unknown>).method))
}

function stop(): void {
  if (stopping) return
  stopping = true
  // EOF means the desktop has gone away: abort now, never wait for its active turn.
  void Promise.allSettled([runtime.close(), imRuntime.stop(), approvalBridge.close(), questionBridge.close(), scheduleBridge.close(), skillBridge.close(), projectionBridge.close()])
    .then(() => process.exit(0))
}

lines.on('close', stop)
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') stop()
  else throw error
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, stop)
}
