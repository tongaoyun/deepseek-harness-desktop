import { createInterface } from 'node:readline'
import { HostServer } from './server.js'
import { DeepSeekHarnessRuntime } from './runtime.js'
import type { JsonRpcOutput } from './protocol.js'

const emit = (output: JsonRpcOutput): void => {
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

const runtime = new DeepSeekHarnessRuntime()
const server = new HostServer(runtime, emit)
let chain = Promise.resolve()

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  chain = chain.then(async () => {
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
    await server.handle(value)
  }).catch((error: unknown) => {
    process.stderr.write(`Harness host failure: ${String(error)}\n`)
  })
})

lines.on('close', () => {
  void chain.finally(async () => {
    await runtime.close()
  })
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void runtime.close().finally(() => process.exit(0))
  })
}
