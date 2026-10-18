import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { closeElectronAcceptance } from '../scripts/close-electron.mjs'
import { terminateAcceptanceTree } from '../scripts/acceptance-process.mjs'
import { processIsRunning } from './process-running.mjs'

async function waitFor<T>(observe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = await observe()
    if (value !== undefined) return value
    await delay(20)
  }
  throw new Error('Acceptance close fixture did not reach the expected state')
}

it('joins an ordinary close without retaining a process listener', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform !== 'win32' })
  const exited = once(child, 'close')
  onTestFinished(async () => { await terminateAcceptanceTree(child); await exited })
  const before = child.listenerCount('close')
  await closeElectronAcceptance({ process: () => child, close: () => { child.kill('SIGKILL'); return Promise.resolve() } })
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  expect(child.listenerCount('close')).toBeLessThanOrEqual(before)
})

it('fails a stalled Electron close after terminating its real child and grandchild', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-electron-close-'))
  const resources: { stopChild?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try { await resources.stopChild?.() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  const ready = join(directory, 'ready.json')
  const fixture = fileURLToPath(new URL('./fixtures/acceptance-process-tree.mjs', import.meta.url))
  const child = spawn(process.execPath, [fixture, ready], { stdio: 'ignore', detached: process.platform !== 'win32' })
  const exited = once(child, 'close')
  resources.stopChild = async () => { await terminateAcceptanceTree(child); await exited }
  const pids = await waitFor(async () => {
    try { return JSON.parse(await readFile(ready, 'utf8')) as number[] }
    catch (error) { if (error instanceof SyntaxError || error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error }
  })
  await expect(closeElectronAcceptance({ process: () => child, close: () => new Promise(() => {}) }, 1000))
    .rejects.toThrow('close timed out after 1000 ms: {"applicationClosed":false,"processClosed":false,')
  await waitFor(async () => {
    return pids.every(pid => !processIsRunning(pid)) ? true : undefined
  })
  expect(child.listenerCount('close')).toBe(0)
}, 30_000)

it('distinguishes a completed Playwright close from an owned process still running', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform !== 'win32' })
  const exited = once(child, 'close')
  onTestFinished(async () => { await terminateAcceptanceTree(child); await exited })
  await expect(closeElectronAcceptance({ process: () => child, close: () => Promise.resolve() }, 1000))
    .rejects.toThrow('close timed out after 1000 ms: {"applicationClosed":true,"processClosed":false,')
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
})

it('distinguishes a stopped process from a Playwright close still pending', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', detached: process.platform !== 'win32' })
  const exited = once(child, 'close')
  onTestFinished(async () => { await terminateAcceptanceTree(child); await exited })
  await exited
  await expect(closeElectronAcceptance({ process: () => child, close: () => new Promise(() => {}) }, 1000))
    .rejects.toThrow('close timed out after 1000 ms: {"applicationClosed":false,"processClosed":true,')
})

it('preserves a close error after joining the owned process', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform !== 'win32' })
  const exited = once(child, 'close')
  onTestFinished(async () => { await terminateAcceptanceTree(child); await exited })
  const failure = new Error('Fixture close failed')
  await expect(closeElectronAcceptance({ process: () => child, close: () => Promise.reject(failure) }))
    .rejects.toBe(failure)
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
})
