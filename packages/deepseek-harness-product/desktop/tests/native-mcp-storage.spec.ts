import { secureFixture } from './helpers/mcp-encryption.ts'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { NativeMcpStorage } from '../src/native-mcp-storage.ts'
import { assertProductMethod, isProductRuntimeMethod } from '@deepseek-harness/product/protocol'

it('encrypts connection records, isolates employees and preserves concurrent writes across main instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-secure-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const secure = secureFixture()
  let employee = 'alice'
  const first = new NativeMcpStorage(root, secure, () => employee)
  const second = new NativeMcpStorage(root, secure, () => employee)
  const signal = new AbortController().signal
  const write = (key: string) => ({ operation: 'put', employeeId: 'alice', table: 'connections', key, value: { secret: 'private-mcp-header' } })
  await Promise.all([first.invoke(write('a'), signal), second.invoke(write('b'), signal)])
  expect(await first.invoke({ operation: 'read', employeeId: 'alice' }, signal)).toMatchObject({ tables: { connections: { a: { secret: 'private-mcp-header' }, b: { secret: 'private-mcp-header' } } } })
  for (const file of await readdir(root)) expect((await readFile(join(root, file))).includes(Buffer.from('private-mcp-header'))).toBe(false)
  employee = 'bob'
  await expect(first.invoke({ operation: 'read', employeeId: 'alice' }, signal)).rejects.toThrow('session changed')
  expect(await first.invoke({ operation: 'read', employeeId: 'bob' }, signal)).toMatchObject({ tables: { connections: {} } })
  employee = 'alice'
  await first.invoke({ operation: 'delete', employeeId: 'alice', table: 'connections', key: 'a' }, signal)
  expect(await second.invoke({ operation: 'read', employeeId: 'alice' }, signal)).toMatchObject({ tables: { connections: { b: { secret: 'private-mcp-header' } } } })
  await expect(first.invoke(write('cancelled'), AbortSignal.abort())).rejects.toThrow()
  await expect(first.invoke({ ...write('bad'), table: '../file' }, signal)).rejects.toThrow()
  expect(isProductRuntimeMethod('runtime.connectors.storage')).toBe(true)
  expect(() => assertProductMethod('runtime.connectors.storage')).toThrow()
})

it('refuses plaintext persistence when OS encryption is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-secure-unavailable-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const store = new NativeMcpStorage(root, { ...secureFixture(), isEncryptionAvailable: () => false }, () => 'alice')
  await expect(store.invoke({ operation: 'read', employeeId: 'alice' }, new AbortController().signal)).rejects.toThrow('encryption is unavailable')
  expect(await readdir(root)).toEqual([])
})
