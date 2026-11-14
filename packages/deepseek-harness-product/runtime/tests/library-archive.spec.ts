import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { readLibraryArchive } from '../src/library-archive.ts'

function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const bytes = Buffer.from('中文模板 {{literal}}\u0000')
  const target = { type: 'deliverables/presented', data: { turn: 1, callId: 'call', files: [{ path: 'exports/中文模板.bin' }] } }
  const readEvent = vi.fn(async () => ({ session: { cwd: '/workspace' }, target }))
  const stat = vi.fn(async () => ({ absolutePath: '/workspace/exports/中文模板.bin', version: 'v1', bytes: bytes.length }))
  const readBytes = vi.fn(async (_scope: unknown, _path: string, options: { range: { offset: number; length: number } }) => ({
    absolutePath: '/workspace/exports/中文模板.bin', version: 'v1', bytes: bytes.length, offset: options.range.offset,
    data: bytes.subarray(options.range.offset, options.range.offset + Math.min(3, options.range.length)),
  }))
  ctx.provide('sessionQuery', { readEvent })
  ctx.provide('workspaceFiles', { stat, readBytes })
  ctx.provide('sandboxPolicy', { workspaceRoot: '/fallback' })
  const input = { sessionId: 'session', seq: 3, index: 0, maxBytes: 1024 }
  return { ctx, input, bytes, target, readEvent, stat, readBytes }
}

it('archives exact native deliverable bytes using trusted event coordinates and Session file authority', async () => {
  const f = fixture(), signal = new AbortController().signal
  const result = await readLibraryArchive(f.ctx, f.input, signal)
  expect(result.name).toBe('中文模板.bin')
  expect(Buffer.from(result.dataBase64, 'base64')).toEqual(f.bytes)
  expect(f.readEvent).toHaveBeenCalledWith({ sessionId: 'session', seq: 3, before: 0, after: 0 }, signal)
  expect(f.stat).toHaveBeenCalledTimes(2)
  expect(f.readBytes.mock.calls.every(([scope, path]) => JSON.stringify(scope) === JSON.stringify({ sessionId: 'session', workspaceRoot: '/workspace' })
    && path === 'exports/中文模板.bin')).toBe(true)
})

it('rejects renderer paths, non-deliverable events and absent file indices before reading files', async () => {
  const f = fixture(), signal = new AbortController().signal
  await expect(readLibraryArchive(f.ctx, { ...f.input, path: '/private/file' }, signal)).rejects.toThrow()
  expect(f.readEvent).not.toHaveBeenCalled()
  await expect(readLibraryArchive(f.ctx, { ...f.input, index: 2 }, signal)).rejects.toThrow('unavailable')
  f.target.type = 'message'
  await expect(readLibraryArchive(f.ctx, f.input, signal)).rejects.toThrow('unavailable')
  expect(f.stat).not.toHaveBeenCalled()
})

it('rejects oversize and changing files rather than archiving a partial version', async () => {
  const f = fixture(), signal = new AbortController().signal
  await expect(readLibraryArchive(f.ctx, { ...f.input, maxBytes: 1 }, signal)).rejects.toThrow('upload policy')
  expect(f.readBytes).not.toHaveBeenCalled()
  f.stat.mockResolvedValueOnce({ absolutePath: '/workspace/exports/中文模板.bin', version: 'v1', bytes: f.bytes.length })
    .mockResolvedValueOnce({ absolutePath: '/workspace/exports/中文模板.bin', version: 'v2', bytes: f.bytes.length })
  await expect(readLibraryArchive(f.ctx, f.input, signal)).rejects.toThrow('changed')
})

it('stops reading after employee cancellation', async () => {
  const f = fixture(), owner = new AbortController()
  f.readBytes.mockImplementationOnce(async () => {
    owner.abort(new Error('employee changed'))
    return { absolutePath: '/workspace/exports/中文模板.bin', version: 'v1', bytes: f.bytes.length, offset: 0, data: f.bytes }
  })
  await expect(readLibraryArchive(f.ctx, f.input, owner.signal)).rejects.toThrow('employee changed')
  expect(f.readBytes).toHaveBeenCalledOnce()
})
