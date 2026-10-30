import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { officeHelperProcesses, observeOfficeProcesses } from '../scripts/office-process-diagnostics.mjs'

test('Office diagnostics inspect only owned native helpers through transitive ancestry', () => {
  const table = ' 31 21 /private/Engine With Spaces/libreoffice-kit\n21 11 /node\n11 1 /pnpm\n41 1 /other/libreoffice-kit\n51 11 /libreoffice-kit-unrelated\n'
  assert.deepEqual(officeHelperProcesses(table, 11), [{ pid: 31, parentPid: 21 }])
  assert.deepEqual(officeHelperProcesses(table, 999), [])
})

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-office-diagnostics-'))
  const cancellation = new AbortController()
  const operations = []
  const cleanup = []
  t.after(async () => {
    cancellation.abort()
    for (const action of cleanup) action()
    await Promise.allSettled(operations)
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, cancellation, operations, cleanup }
}

test('slow helpers are sampled once without changing or retrying their conversion', async t => {
  const { directory, cancellation } = await fixture(t)
  let clock = 0
  const calls = []
  await observeOfficeProcesses(11, directory, {
    signal: cancellation.signal, pollMs: 1, sampleAfterMs: 20, now: () => clock,
    async readProcesses() {
      clock += 10
      if (clock > 50) cancellation.abort()
      return '21 11 /engine/libreoffice-kit'
    },
    async sample(pid, path) { calls.push({ pid, path }) },
  })
  assert.deepEqual(calls, [{ pid: 21, path: join(directory, 'office-21.log') }])
  const events = (await readFile(join(directory, 'office-processes.log'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(events.map(({ event }) => event), ['helper-observed', 'helper-sample'])
  assert.equal(events[1].elapsedMs, 20)
})

test('stopping diagnostics cancels and joins an active sampler', { timeout: 10_000 }, async t => {
  const { directory, cancellation, operations, cleanup } = await fixture(t)
  const started = Promise.withResolvers()
  const cancelled = Promise.withResolvers()
  const release = Promise.withResolvers()
  let scan = 0
  let finished = false
  const operation = observeOfficeProcesses(11, directory, {
    signal: cancellation.signal, pollMs: 1, sampleAfterMs: 1, now: () => scan,
    async readProcesses() { scan++; return '21 11 /engine/libreoffice-kit' },
    async sample(_pid, _path, signal) {
      signal.addEventListener('abort', () => cancelled.resolve(), { once: true })
      started.resolve()
      await cancelled.promise
      await release.promise
      signal.throwIfAborted()
    },
  }).finally(() => { finished = true })
  operations.push(operation)
  cleanup.push(() => release.resolve())
  await started.promise
  cancellation.abort()
  await cancelled.promise
  assert.equal(finished, false)
  release.resolve()
  await operation
  assert.equal(finished, true)
})

test('a sampler failure records only its code and does not retry or conceal conversion results', async t => {
  const { directory, cancellation } = await fixture(t)
  let scan = 0
  await observeOfficeProcesses(11, directory, {
    signal: cancellation.signal, pollMs: 1, sampleAfterMs: 1, now: () => scan,
    async readProcesses() { if (++scan > 3) cancellation.abort(); return '21 11 /engine/libreoffice-kit' },
    async sample() { throw Object.assign(new Error('sensitive diagnostic command output'), { code: 1 }) },
  })
  const log = await readFile(join(directory, 'office-processes.log'), 'utf8')
  assert.match(log, /"event":"sample-failed","pid":21,"code":"1"/u)
  assert.doesNotMatch(log, /sensitive/u)
  assert.equal(log.match(/helper-sample/gu).length, 1)
})

test('records sampler termination separately when execFile supplies no exit code', async t => {
  const { directory, cancellation } = await fixture(t)
  let scan = 0
  await observeOfficeProcesses(11, directory, {
    signal: cancellation.signal, pollMs: 1, sampleAfterMs: 1, now: () => scan,
    async readProcesses() { if (++scan > 3) cancellation.abort(); return '21 11 /engine/libreoffice-kit' },
    async sample() { throw Object.assign(new Error('private arguments'), { code: null, signal: 'SIGKILL', killed: true }) },
  })
  const log = await readFile(join(directory, 'office-processes.log'), 'utf8')
  const failure = log.trim().split('\n').map(JSON.parse).find(({ event }) => event === 'sample-failed')
  assert.equal(failure.code, 'null')
  assert.equal(failure.signal, 'SIGKILL')
  assert.equal(failure.killed, true)
  assert.ok(failure.elapsedMs >= 1)
  assert.doesNotMatch(log, /private arguments/u)
})

test('macOS sampler captures a real private subprocess and leaves it running',
  { skip: process.platform !== 'darwin', timeout: 15_000 }, async t => {
    const { directory, cancellation, operations } = await fixture(t)
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const closed = once(child, 'close')
    t.after(async () => { child.kill('SIGKILL'); await closed })
    await once(child.stdout, 'data')
    const file = join(directory, `office-${child.pid}.log`)
    const operation = observeOfficeProcesses(process.pid, directory, {
      signal: cancellation.signal, pollMs: 10, sampleAfterMs: 1,
      async readProcesses() {
        try {
          const output = await readFile(file, 'utf8')
          if (output.includes('Call graph:')) cancellation.abort()
        } catch (error) { if (error.code !== 'ENOENT') throw error }
        return `${child.pid} ${process.pid} /private/libreoffice-kit`
      },
    })
    operations.push(operation)
    await operation
    assert.match(await readFile(file, 'utf8'), /Call graph:/u)
    assert.equal(child.exitCode, null)
    assert.equal(child.signalCode, null)
  })

test('cancelling a real macOS sampler waits until its process has exited',
  { skip: process.platform !== 'darwin', timeout: 15_000 }, async t => {
    const { directory, cancellation, operations } = await fixture(t)
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const closed = once(child, 'close')
    t.after(async () => { child.kill('SIGKILL'); await closed })
    await once(child.stdout, 'data')
    const operation = observeOfficeProcesses(process.pid, directory, {
      signal: cancellation.signal, pollMs: 1, sampleAfterMs: 1,
      async readProcesses() { return `${child.pid} ${process.pid} /private/libreoffice-kit` },
    })
    operations.push(operation)
    let sampler
    const deadline = Date.now() + 5000
    while (sampler === undefined && Date.now() < deadline) {
      const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid=,comm='])
      for (const line of stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+\/usr\/bin\/sample\s*$/u.exec(line)
        if (match && Number(match[2]) === process.pid) sampler = Number(match[1])
      }
      if (sampler === undefined) await delay(10)
    }
    assert.notEqual(sampler, undefined, 'Sampler must be running before cancellation')
    cancellation.abort()
    await operation
    assert.throws(() => process.kill(sampler, 0), { code: 'ESRCH' })
    assert.equal(child.exitCode, null)
    assert.equal(child.signalCode, null)
  })
