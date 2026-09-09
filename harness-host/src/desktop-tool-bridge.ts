import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { notification, type JsonRpcOutput } from './protocol.js'

/** Keeps desktop-owned operations behind an authenticated local transport. */
export class DesktopToolBridge {
  private server?: Server
  private readonly token = randomBytes(32).toString('hex')
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; timer: NodeJS.Timeout }>()
  constructor(private readonly emit: (value: JsonRpcOutput) => void, private readonly domain: string,
    private readonly actions: string[], private readonly timeoutMs: number) {}
  async start() {
    this.server = createServer((req, res) => { void (async () => {
      try {
        if (req.method !== 'POST' || req.url !== `/${this.domain}` || req.headers.authorization !== `Bearer ${this.token}`) { res.writeHead(404).end(); return }
        let body = ''
        for await (const chunk of req) { body += String(chunk); if (Buffer.byteLength(body) > 64000) throw new Error('请求过大') }
        const value = JSON.parse(body) as { action?: unknown; input?: unknown }
        if (!this.actions.includes(String(value.action))) throw new Error('不支持的桌面操作')
        const requestId = randomUUID()
        const result = await new Promise<unknown>((resolve) => {
          const timer = setTimeout(() => this.respond(requestId, { error: '桌面未确认操作结果，请先查询当前状态，不要直接重复操作' }), this.timeoutMs)
          this.pending.set(requestId, { resolve, timer })
          this.emit(notification(`${this.domain}.request`, { requestId, action: value.action, input: value.input }))
        })
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
      } catch (error) { res.writeHead(400).end(JSON.stringify({ error: String(error) })) }
    })() })
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve) })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Desktop tool bridge unavailable')
    return { url: `http://127.0.0.1:${address.port}/${this.domain}`, token: this.token }
  }
  respond(id: string, value: unknown): boolean {
    const pending = this.pending.get(id)
    if (!pending) return false
    this.pending.delete(id); clearTimeout(pending.timer); pending.resolve(value)
    return true
  }
  async close() {
    for (const id of this.pending.keys()) this.respond(id, { error: '桌面已退出，未确认操作结果' })
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
  }
}
