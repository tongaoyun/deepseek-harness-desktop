/** Main-process MCP proxy keeps employee and connector credentials out of Host. */
import { randomUUID } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { deadline, idleWatchdog } from '@deepseek-ai/dsh-timeout'
import { z } from 'zod'

/** Header and idle deadlines apply to forwarding; active streams have no total deadline. */
export interface ConnectorProxyPolicy {
  readonly responseTimeoutMs: number
  readonly streamIdleTimeoutMs: number
}

/** Validate deployment-owned relay deadlines.
 * @param value Product configuration, or undefined for the standard deadlines.
 * @returns Header and idle limits independent of tool-call timeouts.
 */
export function resolveConnectorProxyPolicy(value?: unknown): ConnectorProxyPolicy {
  return z.object({ responseTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
    streamIdleTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(120_000) }).strict().parse(value ?? {})
}

interface Connector {
  readonly visibility?: string
  readonly id: string
  readonly version: string
  readonly status: string
  readonly transport: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
}

/** Credential-owning HTTP relay for the existing Harness MCP client. */
export class ConnectorProxy {
  private readonly server: Server
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<void>>()
  private readonly key = randomUUID()
  private origin: string | undefined
  private readonly catalogSource: (signal: AbortSignal, ids: readonly string[]) => Promise<unknown>

  constructor(catalogSource: (signal: AbortSignal, ids: readonly string[]) => Promise<unknown>,
    serveStdio?: (request: IncomingMessage, response: ServerResponse, connector: unknown, signal: AbortSignal) => Promise<void>,
    policy: ConnectorProxyPolicy = resolveConnectorProxyPolicy()) {
    this.catalogSource = catalogSource
    this.server = createServer((request, response) => {
      if (this.lifetime.signal.aborted) { response.destroy(); return }
      const abort = new AbortController()
      response.once('close', () => { abort.abort() })
      const lifetime = AbortSignal.any([abort.signal, this.lifetime.signal])
      const operation = (async () => {
        if (request.headers.authorization !== `Bearer ${this.key}`) throw new Error('Unauthorized relay')
        const parts = new URL(request.url ?? '/', 'http://localhost').pathname.slice(1).split('/')
        if (parts.length !== 2) throw new Error('Invalid connector relay address')
        const [id, version] = parts.map(part => decodeURIComponent(part))
        if (!id || !version) throw new Error('Missing connector version')
        const value = await this.catalogSource(lifetime, [id])
        lifetime.throwIfAborted()
        if (!Array.isArray(value)) throw new Error('Invalid connector catalog')
        const connector = value.find((entry: Connector) => entry.id === id) as Connector | undefined
        if (connector?.status !== 'ready') {
          throw new Error('Connector authorization is unavailable')
        }
        if (connector.version !== version) {
          response.statusCode = 409
          response.end('Connector version changed; prepare a new task')
          return
        }
        if (connector.transport === 'stdio' && serveStdio) {
          await serveStdio(request, response, connector, lifetime)
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
        using idle = idleWatchdog(lifetime, policy.streamIdleTimeoutMs, 'CONNECTOR_STREAM_IDLE_TIMEOUT')
        let upstream: Response
        {
          using header = deadline(lifetime, policy.responseTimeoutMs, 'CONNECTOR_RESPONSE_TIMEOUT')
          upstream = await fetch(connector.url, {
            method: request.method ?? 'GET', headers,
            signal: AbortSignal.any([header.signal, idle.signal]), redirect: 'error',
            ...(length === 0 ? {} : { body: Buffer.concat(chunks) }),
          })
        }
        response.statusCode = upstream.status
        for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version']) {
          const value = upstream.headers.get(name)
          if (value !== null) response.setHeader(name, value)
        }
        if (upstream.body === null) response.end()
        else {
          const reader = upstream.body.getReader()
          let cancellation: Promise<void> | undefined
          const cancel = (): Promise<void> => cancellation ??= reader.cancel(idle.signal.reason)
          const iterator: AsyncIterator<Uint8Array> = {
            async next() {
              const result = await reader.read()
              return result.done ? { done: true, value: undefined } : result
            },
          }
          try {
            using _abortReader = addAbortListener(idle.signal, () => {
              void cancel().catch(() => {
                // The forwarding operation awaits this cleanup and owns its failure.
              })
            })
            await pipeline(Readable.from((async function* () {
              for (;;) {
                const result = await idle.next(iterator)
                idle.signal.throwIfAborted()
                if (result.done) return
                yield result.value
              }
            })()), response, { signal: idle.signal })
          } finally {
            try { await cancel() }
            finally { reader.releaseLock() }
          }
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
    return value.map((entry: Connector) => entry.transport === 'streamable-http' || entry.transport === 'stdio' ? {
      ...entry, url: `${this.origin}/${encodeURIComponent(entry.id)}/${encodeURIComponent(entry.version)}`,
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
