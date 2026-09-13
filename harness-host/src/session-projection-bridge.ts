import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { authorizedLocalBearer, hardenLocalBridgeServer } from './local-bridge-security.js'
import { notification, type JsonRpcOutput } from './protocol.js'

const MAX_BODY_BYTES = 256 * 1024

/** Bridges Harness' in-process projection change feed to the desktop host. */
export class SessionProjectionBridge {
  private server: Server | undefined
  private readonly token = randomBytes(32).toString('hex')
  private url: string | undefined

  constructor(private readonly emit: (output: JsonRpcOutput) => void) {}

  async start(): Promise<{ url: string; token: string }> {
    if (this.url) return { url: this.url, token: this.token }
    this.server = createServer((request, response) => { void this.handle(request, response) })
    hardenLocalBridgeServer(this.server)
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', resolve)
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Session projection bridge failed to bind')
    this.url = `http://127.0.0.1:${address.port}/projection`
    return { url: this.url, token: this.token }
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.url = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    try {
      if (request.method !== 'POST' || request.url !== '/projection' || !this.authorized(request.headers.authorization)) {
        response.writeHead(404).end()
        return
      }
      const value = JSON.parse(await readBody(request)) as Record<string, unknown>
      if (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 256) throw new Error('Invalid projection sessionId')
      if (typeof value.key !== 'string' || !value.key || value.key.length > 256) throw new Error('Invalid projection key')
      if (!Number.isSafeInteger(value.seq) || Number(value.seq) < -1) throw new Error('Invalid projection sequence')
      this.emit(notification('session.projection', {
        sessionId: value.sessionId,
        key: value.key,
        value: value.value,
        seq: value.seq,
      }))
      response.writeHead(204, { 'cache-control': 'no-store' }).end()
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  }

  private authorized(value: string | undefined): boolean {
    return authorizedLocalBearer(value, this.token)
  }
}

async function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new Error('Projection update is too large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}
