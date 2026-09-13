import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { authorizedLocalBearer, hardenLocalBridgeServer } from './local-bridge-security.js'

it('accepts only an exact bearer token', () => {
  expect(authorizedLocalBearer('Bearer private-token', 'private-token')).toBe(true)
  expect(authorizedLocalBearer('bearer private-token', 'private-token')).toBe(false)
  expect(authorizedLocalBearer('Bearer private-token-extra', 'private-token')).toBe(false)
  expect(authorizedLocalBearer(undefined, 'private-token')).toBe(false)
})

it('bounds request headers, bodies and idle connections on local bridges', () => {
  const server = createServer()
  hardenLocalBridgeServer(server)
  expect(server.requestTimeout).toBe(30_000)
  expect(server.headersTimeout).toBe(10_000)
  expect(server.keepAliveTimeout).toBe(1_000)
})
