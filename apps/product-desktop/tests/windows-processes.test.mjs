import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { originalWindowsProcesses, windowsProcessDescendants, windowsProcessSnapshot } from './windows-processes.mjs'

const row = (pid, parent, started) => ({ pid, parent, started, command: '', image: '' })

test('process ancestry excludes stale parent identifiers and retains live nested descendants', () => {
  const root = row(100, 1, '500')
  const child = row(200, 100, '600')
  const nested = row(300, 200, '700')
  const unrelated = row(400, 200, '200')
  assert.deepEqual(windowsProcessDescendants([nested, unrelated, child, root, row(500, 400, '300')], root.pid), [child, nested])
  assert.deepEqual(windowsProcessDescendants([root, child, nested, row(100, 300, '500')], root.pid), [child, nested])
  assert.throws(() => windowsProcessDescendants([], root.pid), /exited before/u)
  assert.throws(() => windowsProcessDescendants([row(100, 1, '')], 100), /no creation time/u)
})

test('a reused PID is exited while the same original process remains a failure', () => {
  const original = row(676, 100, '639000000000000001')
  assert.deepEqual(originalWindowsProcesses([original], [original]), [original])
  assert.deepEqual(originalWindowsProcesses([row(676, 900, '639000000000000002')], [original]), [])
  assert.deepEqual(originalWindowsProcesses([], [original]), [])
  assert.throws(() => originalWindowsProcesses([row(676, 100, '')], [original]), /no creation time/u)
})

test('Windows snapshots identify a real owned child and observe its actual exit',
  { skip: process.platform !== 'win32' ? 'Requires Windows CIM process creation times' : false, timeout: 60_000 }, async t => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const closed = once(child, 'close')
    t.after(async () => { child.kill(); await closed })
    await once(child, 'spawn')
    const snapshot = await windowsProcessSnapshot()
    const identity = snapshot.find(process => process.pid === child.pid)
    assert.ok(identity)
    assert.ok(windowsProcessDescendants(snapshot, process.pid).some(process => process.pid === child.pid))
    assert.deepEqual(originalWindowsProcesses(snapshot, [identity]), [identity])
    child.kill()
    await closed
    assert.deepEqual(originalWindowsProcesses(await windowsProcessSnapshot(), [identity]), [])
  })
