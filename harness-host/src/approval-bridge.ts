import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { notification, type JsonRpcOutput } from './protocol.js'

const MAX_BODY_BYTES = 16 * 1024
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

export type ApprovalDecision = 'allow' | 'reject'

interface PendingApproval {
  resolve: (decision: ApprovalDecision | 'unavailable') => void
  timer: NodeJS.Timeout
}

export class ApprovalBridge {
  private server: Server | undefined
  private readonly token = randomBytes(32).toString('hex')
  private readonly pending = new Map<string, PendingApproval>()
  private url: string | undefined

  constructor(private readonly emit: (output: JsonRpcOutput) => void) {}

  async start(): Promise<{ url: string; token: string }> {
    if (this.url !== undefined) return { url: this.url, token: this.token }
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('Approval bridge failed to bind')
    this.url = `http://127.0.0.1:${address.port}/approval`
    return { url: this.url, token: this.token }
  }

  respond(approvalId: string, decision: ApprovalDecision): boolean {
    const pending = this.pending.get(approvalId)
    if (pending === undefined) return false
    this.pending.delete(approvalId)
    clearTimeout(pending.timer)
    pending.resolve(decision)
    return true
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve('unavailable')
    }
    this.pending.clear()
    const server = this.server
    this.server = undefined
    this.url = undefined
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  private async handleHttp(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    try {
      if (request.method !== 'POST' || request.url !== '/approval' || !this.authorized(request.headers.authorization)) {
        response.writeHead(404).end()
        return
      }
      const value = parseApprovalRequest(JSON.parse(await readBody(request)))
      const approvalId = randomUUID()
      const decision = await new Promise<ApprovalDecision | 'unavailable'>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(approvalId)
          resolve('unavailable')
        }, APPROVAL_TIMEOUT_MS)
        timer.unref()
        this.pending.set(approvalId, { resolve, timer })
        this.emit(notification('approval.request', { approvalId, ...value }))
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ outcome: decision === 'allow' ? 'allowed-once' : decision === 'reject' ? 'rejected' : 'unavailable' }))
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  }

  private authorized(value: string | undefined): boolean {
    const supplied = value?.startsWith('Bearer ') ? value.slice(7) : ''
    const left = Buffer.from(supplied)
    const right = Buffer.from(this.token)
    return left.length === right.length && timingSafeEqual(left, right)
  }
}

function parseApprovalRequest(value: unknown): { toolName: string; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid approval request')
  const record = value as Record<string, unknown>
  if (typeof record.toolName !== 'string' || record.toolName.length === 0 || record.toolName.length > 200) {
    throw new Error('Invalid approval tool name')
  }
  const reason = typeof record.reason === 'string' ? record.reason : '该操作需要员工确认。'
  if (reason.length > 12 * 1024) throw new Error('Approval reason is too long')
  return { toolName: record.toolName, reason }
}

async function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new Error('Approval request is too large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}
