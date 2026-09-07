import { createInterface } from 'node:readline'
import { HostServer } from './server.js'
import { DeepSeekHarnessRuntime } from './runtime.js'
import type { JsonRpcOutput } from './protocol.js'
import { ApprovalBridge } from './approval-bridge.js'
import { LocalImRuntime } from './im-runtime.js'
import { ScheduleBridge } from './schedule-bridge.js'

let stopping = false
const emit = (output: JsonRpcOutput): void => {
  if (stopping) return
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

const approvalBridge = new ApprovalBridge(emit)
const approvalEndpoint = await approvalBridge.start()
const scheduleBridge = new ScheduleBridge(emit)
const scheduleEndpoint = await scheduleBridge.start()
const runtime = new DeepSeekHarnessRuntime({
  XIAOYIN_LOCAL_SCHEDULE_URL: scheduleEndpoint.url,
  XIAOYIN_LOCAL_SCHEDULE_TOKEN: scheduleEndpoint.token,
  XIAOYIN_APPROVAL_BRIDGE_URL: approvalEndpoint.url,
  XIAOYIN_APPROVAL_BRIDGE_TOKEN: approvalEndpoint.token,
})
const imRuntime = new LocalImRuntime(runtime)
const server = new HostServer(
  runtime,
  emit,
  (approvalId, decision) => approvalBridge.respond(approvalId, decision),
  imRuntime,
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
      error: { code: -32700, message: 'Parse error' },
    })
    return
  }
  if (typeof value === 'object' && value !== null && (value as Record<string, unknown>).method === 'schedule.respond') {
    const params = (value as { params?: { requestId?: string; result?: unknown } }).params
    if (params?.requestId) scheduleBridge.respond(params.requestId, params.result)
    return
  }
  if (isApprovalResponse(value)) {
    void server.handle(value).catch((error: unknown) => {
      process.stderr.write(`Harness approval response failure: ${String(error)}\n`)
    })
    return
  }
  chain = chain.then(async () => {
    if (stopping) return
    await server.handle(value)
  }).catch((error: unknown) => {
    process.stderr.write(`Harness host failure: ${String(error)}\n`)
  })
})

function isApprovalResponse(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).method === 'approval.respond'
}

function stop(): void {
  if (stopping) return
  stopping = true
  // EOF means the desktop has gone away: abort now, never wait for its active turn.
  void Promise.allSettled([runtime.close(), imRuntime.stop(), approvalBridge.close(), scheduleBridge.close()])
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
