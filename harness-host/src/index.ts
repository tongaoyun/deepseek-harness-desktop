import { createInterface } from 'node:readline'
import { HostServer } from './server.js'
import { DeepSeekHarnessRuntime } from './runtime.js'
import type { JsonRpcOutput } from './protocol.js'
import { ApprovalBridge } from './approval-bridge.js'

const emit = (output: JsonRpcOutput): void => {
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

const approvalBridge = new ApprovalBridge(emit)
const approvalEndpoint = await approvalBridge.start()
const runtime = new DeepSeekHarnessRuntime({
  XIAOYIN_APPROVAL_BRIDGE_URL: approvalEndpoint.url,
  XIAOYIN_APPROVAL_BRIDGE_TOKEN: approvalEndpoint.token,
})
const server = new HostServer(runtime, emit, (approvalId, decision) => approvalBridge.respond(approvalId, decision))
let chain = Promise.resolve()

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
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
  if (isApprovalResponse(value)) {
    void server.handle(value).catch((error: unknown) => {
      process.stderr.write(`Harness approval response failure: ${String(error)}\n`)
    })
    return
  }
  chain = chain.then(async () => {
    await server.handle(value)
  }).catch((error: unknown) => {
    process.stderr.write(`Harness host failure: ${String(error)}\n`)
  })
})

function isApprovalResponse(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).method === 'approval.respond'
}

async function close(): Promise<void> {
  await runtime.close()
  await approvalBridge.close()
}

lines.on('close', () => {
  void chain.finally(close)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void close().finally(() => process.exit(0))
  })
}
