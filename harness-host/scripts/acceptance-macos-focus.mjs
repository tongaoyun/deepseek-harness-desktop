// Opt-in native focus-change acceptance; only disposable fixture windows are used.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { MacComputerUseBridge } from '../dist/mac-computer-use.js'

const home = await mkdtemp(join(tmpdir(), 'xiaoyin-focus-test-'))
const binary = join(home, 'xiaoyin-computer-use-fixture-focus')
execFileSync('xcrun', ['swiftc', fileURLToPath(new URL('../native/computer-use-fixture.swift', import.meta.url)), '-o', binary])
const bridge = new MacComputerUseBridge({ attachments: { async saveImage() { return { attachmentId: 'test' } } } })
const signal = AbortSignal.timeout(30_000)
const first = spawn(binary, [], { stdio: 'ignore' })
let second
async function waitForApp(pid, observe) {
  for (let i = 0; i < 20; i++) {
    const result = await observe()
    if (result.activeWindow.processId === pid) return result
    await setTimeout(100)
  }
  throw new Error('Fixture did not become foreground')
}
try {
  await waitForApp(first.pid, () => bridge.observe(20, signal))
  second = spawn(binary, [], { stdio: 'ignore' })
  const probe = new MacComputerUseBridge({ attachments: { async saveImage() { return { attachmentId: 'probe' } } } })
  await waitForApp(second.pid, () => probe.observe(20, signal))
  await assert.rejects(bridge.type('不得输入到其他应用', 20, signal), /未执行操作/)
  await assert.rejects(bridge.type('不得直接重试', 20, signal), /先重新观察/)
  const observation = await probe.observe(20, signal)
  assert.equal(observation.elements.find((item) => item.automationId === 'xiaoyin-test-input')?.value, '')
  const helper = fileURLToPath(new URL('../native/xiaoyin-computer-use', import.meta.url))
  assert.throws(() => execFileSync(helper, [JSON.stringify({ action: 'type', text: '旧窗口', expectedProcessId: second.pid, expectedWindowSignature: 'stale-window', expectedWidth: observation.screen.width, expectedHeight: observation.screen.height, screenshot: join(home, 'unused.png') })], { stdio: ['ignore', 'pipe', 'pipe'] }), /未执行操作/)
  console.log(JSON.stringify({ passed: true, checks: ['foreground-change-blocks-input', 'failure-requires-observe', 'no-text-written', 'stale-window-rejected'] }))
} finally { first.kill('SIGTERM'); second?.kill('SIGTERM') }
