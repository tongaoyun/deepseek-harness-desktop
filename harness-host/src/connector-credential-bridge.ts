import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { authorizedLocalBearer, hardenLocalBridgeServer } from './local-bridge-security.js'
import { notification, type JsonRpcOutput } from './protocol.js'

export interface ConnectorCredentialResult { cookie?: string; token?: string; status?: number; error?: string }

/** Private transport from MCP workers to native credential stores. */
export class ConnectorCredentialBridge {
  private server: Server | undefined
  private readonly token = randomBytes(32).toString('hex')
  private readonly pending = new Map<string, { resolve: (value: ConnectorCredentialResult) => void; timer: NodeJS.Timeout }>()
  constructor(private readonly emit: (value: JsonRpcOutput) => void, private readonly domain: 'erp-cookie' | 'connector-oauth' = 'erp-cookie') {}

  async start() {
    this.server = createServer((req, res) => { void (async () => {
      try {
        if (req.method !== 'POST' || req.url !== `/${this.domain}` || !this.authorized(req.headers.authorization)) {
          res.writeHead(404).end(); return
        }
        let body = ''
        for await (const chunk of req) {
          body += String(chunk)
          if (Buffer.byteLength(body) > 8192) throw new Error('Invalid request')
        }
        const value = JSON.parse(body) as { connectorId?: unknown; url?: unknown; rejectedToken?: unknown }
        if (typeof value.connectorId !== 'string' || typeof value.url !== 'string') throw new Error('Invalid request')
        const requestId = randomUUID()
        const result = await new Promise<ConnectorCredentialResult>((resolve) => {
          const timer = setTimeout(() => this.respond(requestId, { status: 503, error: '读取连接器会话超时' }), this.domain === 'connector-oauth' ? 45000 : 15000)
          this.pending.set(requestId, { resolve, timer })
          this.emit(notification(`${this.domain}.request`, { requestId, connectorId: value.connectorId, url: value.url,
            ...(this.domain === 'connector-oauth' && typeof value.rejectedToken === 'string' ? { rejectedToken: value.rejectedToken } : {}) }))
        })
        res.writeHead(result.status ?? 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(result))
      } catch { res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ error: '连接器会话请求无效' })) }
    })() })
    hardenLocalBridgeServer(this.server)
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve) })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('连接器会话桥接不可用')
    return { url: `http://127.0.0.1:${address.port}/${this.domain}`, token: this.token }
  }

  respond(id: string, value: ConnectorCredentialResult): boolean {
    const pending = this.pending.get(id)
    if (!pending) return false
    this.pending.delete(id); clearTimeout(pending.timer); pending.resolve(value)
    return true
  }

  async close() {
    for (const id of this.pending.keys()) this.respond(id, { status: 401, error: '连接器会话已关闭' })
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private authorized(value: string | undefined): boolean {
    return authorizedLocalBearer(value, this.token)
  }
}
