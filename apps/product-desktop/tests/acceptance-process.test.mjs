import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runAcceptanceProcess } from '../scripts/acceptance-process.mjs'
import { stopInstalledProcesses } from '../scripts/installed-processes.mjs'
import { processIsRunning as alive } from './process-running.mjs'

const fixture = fileURLToPath(new URL('./fixtures/acceptance-process-tree.mjs', import.meta.url))

async function waitFor(observe) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = await observe()
    if (value) return value
    await delay(20)
  }
  throw new Error('Fixture did not reach the expected state')
}

async function treeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-acceptance-tree-'))
  const ready = join(directory, 'ready.json')
  const cancellation = new AbortController()
  let pending
  let pids = []
  t.after(async () => {
    cancellation.abort()
    if (pending) await pending.catch(() => {})
    for (const pid of pids) {
      if (!alive(pid)) continue
      if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000, stdio: 'ignore' })
      else process.kill(pid, 'SIGKILL')
    }
    await waitFor(() => pids.every(pid => !alive(pid)))
    await rm(directory, { recursive: true, force: true })
  })
  return {
    cancellation,
    start(timeoutMs) {
      pending = runAcceptanceProcess(process.execPath, [fixture, ready], { timeoutMs, signal: cancellation.signal })
      // Readiness assertions may fail before the command settles.
      void pending.catch(() => {})
      return pending
    },
    async ready() {
      pids = await waitFor(async () => {
        try { return JSON.parse(await readFile(ready, 'utf8')) }
        catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error }
      })
      assert.equal(pids.length, 2)
      assert.ok(pids.every(alive))
      return pids
    },
  }
}

test('acceptance reports success, nonzero exit and startup failure without retaining abort listeners', async () => {
  const cancellation = new AbortController()
  await runAcceptanceProcess(process.execPath, ['-e', ''], { timeoutMs: 10_000, signal: cancellation.signal })
  assert.equal(getEventListeners(cancellation.signal, 'abort').length, 0)
  await assert.rejects(runAcceptanceProcess(process.execPath, ['-e', 'process.exit(7)'], { timeoutMs: 10_000, signal: cancellation.signal }), /code 7/u)
  assert.equal(getEventListeners(cancellation.signal, 'abort').length, 0)
  await assert.rejects(runAcceptanceProcess(join(tmpdir(), 'missing-harness-acceptance-executable'), [], { timeoutMs: 10_000 }), { code: 'ENOENT' })
  for (const timeoutMs of [0, -1, NaN, Infinity]) {
    await assert.rejects(runAcceptanceProcess(process.execPath, [], { timeoutMs }), /positive integer/u)
  }
  cancellation.abort(new Error('Already cancelled'))
  await assert.rejects(runAcceptanceProcess(process.execPath, ['-e', 'throw new Error("must not start")'],
    { timeoutMs: 10_000, signal: cancellation.signal }), /Already cancelled/u)
})

test('deadline rejects a hung acceptance and stops its real descendant', { timeout: 30_000 }, async t => {
  const fixture = await treeFixture(t)
  const result = fixture.start(5000)
  const pids = await fixture.ready()
  await assert.rejects(result, /timed out after 5000 ms/u)
  assert.equal(getEventListeners(fixture.cancellation.signal, 'abort').length, 0)
  await waitFor(() => pids.every(pid => !alive(pid)))
})

test('cancellation rejects acceptance and joins its real process tree', { timeout: 30_000 }, async t => {
  const fixture = await treeFixture(t)
  const result = fixture.start(20_000)
  const pids = await fixture.ready()
  fixture.cancellation.abort()
  await assert.rejects(result, /cancelled/u)
  assert.equal(getEventListeners(fixture.cancellation.signal, 'abort').length, 0)
  await waitFor(() => pids.every(pid => !alive(pid)))
})

test('Windows installation recovery stops orphaned executables only inside the private installation',
  { skip: process.platform !== 'win32' ? 'Requires Windows executable-path process inspection' : false, timeout: 40_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-installation-processes-'))
    const installation = join(directory, 'Installed App')
    let installed = false
    let outside
    let outsideExit
    let pids = []
    t.after(async () => {
      try { if (installed) stopInstalledProcesses(installation) }
      finally {
        try {
          // Failed recovery must still join the fixture processes before removing the installation.
          for (const pid of pids) {
            if (alive(pid)) execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'],
              { windowsHide: true, timeout: 10_000, stdio: 'ignore' })
          }
          await waitFor(() => pids.every(pid => !alive(pid)))
        }
        finally {
          if (outside) { outside.kill('SIGKILL'); await outsideExit }
        }
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    })
    await mkdir(installation)
    installed = true
    const executable = join(installation, 'acceptance-node.exe')
    await copyFile(process.execPath, executable)
    const ready = join(directory, 'ready.json')
    const owned = spawn(executable, [fixture, ready, 'leave-descendant'], { stdio: 'ignore' })
    const ownedExit = new Promise(resolve => owned.once('close', resolve))
    outside = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    outsideExit = new Promise(resolve => outside.once('close', resolve))
    pids = await waitFor(async () => {
      try { return JSON.parse(await readFile(ready, 'utf8')) }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error }
    })
    await ownedExit
    assert.equal(alive(pids[0]), false)
    assert.equal(alive(pids[1]), true)
    const paths = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$image = (Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $env:HARNESS_ACCEPTANCE_PID)).ExecutablePath
ConvertTo-Json -Compress -InputObject @{ installation = $env:HARNESS_ACCEPTANCE_INSTALLATION; image = $image }
`], { encoding: 'utf8', timeout: 20_000, windowsHide: true,
      env: { ...process.env, HARNESS_ACCEPTANCE_PID: String(pids[1]), HARNESS_ACCEPTANCE_INSTALLATION: installation } })
    t.diagnostic(`Executable-path ownership: ${paths.trim()}`)
    stopInstalledProcesses(installation)
    await waitFor(() => !alive(pids[1]))
    assert.equal(alive(outside.pid), true)
  })
