/** Main-process MCP proxy keeps employee and connector credentials out of Host. */
import { randomUUID } from 'node:crypto'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

interface Connector {
  readonly visibility?: string
  readonly id: string
  readonly status: string
  readonly transport: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutSeconds?: number
}

/** Credential-owning HTTP relay for the existing Harness MCP client. */
export class ConnectorProxy {
  private readonly server: Server
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<void>>()
  private readonly key = randomUUID()
  private origin: string | undefined
  private readonly catalogSource: (signal: AbortSignal) => Promise<unknown>

  constructor(catalogSource: (signal: AbortSignal) => Promise<unknown>,
    serveStdio?: (request: IncomingMessage, response: ServerResponse, connector: unknown, signal: AbortSignal) => Promise<void>) {
    this.catalogSource = catalogSource
    this.server = createServer((request, response) => {
      if (this.lifetime.signal.aborted) { response.destroy(); return }
      const abort = new AbortController()
      response.once('close', () => { abort.abort() })
      const lifetime = AbortSignal.any([abort.signal, this.lifetime.signal])
      const operation = (async () => {
        if (request.headers.authorization !== `Bearer ${this.key}`) throw new Error('Unauthorized relay')
        const id = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname.slice(1))
        const value = await this.catalogSource(lifetime)
        lifetime.throwIfAborted()
        if (!Array.isArray(value)) throw new Error('Invalid connector catalog')
        const connector = value.find((entry: Connector) => entry.id === id) as Connector | undefined
        if (connector?.status !== 'ready') {
          throw new Error('Connector authorization is unavailable')
        }
        const signal = AbortSignal.any([lifetime, AbortSignal.timeout((connector.timeoutSeconds ?? 60) * 1000)])
        if (connector.transport === 'stdio' && connector.visibility === 'PERSONAL' && serveStdio) {
          await serveStdio(request, response, connector, signal)
          return
        }
        if (connector.transport !== 'streamable-http' || connector.url === undefined) throw new Error('Invalid connector transport')
        const chunks: Buffer[] = []
        let length = 0
        for await (const chunk of request) {
          const value: unknown = chunk
          if (!(value instanceof Uint8Array)) throw new Error('Invalid MCP request bytes')
          const bytes = Buffer.from(value)
          length += bytes.length
          if (length > 2 * 1024 * 1024) throw new Error('MCP request exceeds size limit')
          chunks.push(bytes)
        }
        const headers = new Headers({ ...connector.headers })
        for (const name of ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
          const value = request.headers[name]
          if (typeof value === 'string') headers.set(name, value)
        }
        const upstream = await fetch(connector.url, {
          method: request.method ?? 'GET', headers, signal, redirect: 'error',
          ...(length === 0 ? {} : { body: Buffer.concat(chunks) }),
        })
        response.statusCode = upstream.status
        for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version']) {
          const value = upstream.headers.get(name)
          if (value !== null) response.setHeader(name, value)
        }
        if (upstream.body === null) response.end()
        else {
          const reader = upstream.body.getReader()
          await pipeline(Readable.from((async function* () {
            try {
              for (;;) {
                const result = await reader.read()
                if (result.done) return
                yield result.value
              }
            } finally { reader.releaseLock() }
          })()), response, { signal })
        }
      })().catch(() => {
        if (response.destroyed) return
        if (response.headersSent) response.destroy()
        else { response.statusCode = 502; response.end('Connector request failed') }
      })
      this.operations.add(operation)
      void operation.finally(() => this.operations.delete(operation)).catch(() => undefined)
    })
  }

  /** Start a private loopback endpoint before preparing the Host environment. */
  async start(): Promise<void> {
    if (this.lifetime.signal.aborted) throw new Error('Connector relay is closed')
    if (this.server.listening) return
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve() })
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('Connector relay did not bind')
    this.origin = `http://127.0.0.1:${address.port}`
  }

  /** Replace upstream addresses and credentials with private relay capabilities.
   * @param value Main-process catalog containing upstream credentials.
   * @returns Host-safe MCP configuration.
   */
  catalog(value: unknown): unknown {
    if (this.origin === undefined || !Array.isArray(value)) throw new Error('Connector relay is unavailable')
    return value.map((entry: Connector) => entry.transport === 'streamable-http' || entry.visibility === 'PERSONAL' ? {
      ...entry, url: `${this.origin}/${encodeURIComponent(entry.id)}`,
      transport: 'streamable-http', command: undefined, arguments: [],
      headers: { Authorization: `Bearer ${this.key}` }, environment: {},
    } : entry)
  }

  /** Abort in-flight MCP calls, close loopback connections and await catalog and stdio cleanup. */
  async close(): Promise<void> {
    this.lifetime.abort()
    this.server.closeAllConnections()
    try {
      if (this.server.listening) {
        await new Promise<void>((resolve, reject) => this.server.close((error) => { if (error) reject(error); else resolve() }))
      }
    } finally { await Promise.allSettled([...this.operations]) }
  }
}
