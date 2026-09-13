import { timingSafeEqual } from 'node:crypto'
import type { Server } from 'node:http'

export function hardenLocalBridgeServer(server: Server): void {
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 1_000
}

export function authorizedLocalBearer(value: string | undefined, token: string): boolean {
  const supplied = value?.startsWith('Bearer ') ? value.slice(7) : ''
  const left = Buffer.from(supplied)
  const right = Buffer.from(token)
  return left.length === right.length && timingSafeEqual(left, right)
}
