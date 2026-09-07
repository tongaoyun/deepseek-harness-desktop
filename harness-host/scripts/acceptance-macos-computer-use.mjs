// Opt-in: launch the compiled computer-use-fixture.swift first. Never run in CI.
import assert from 'node:assert/strict'
import { MacComputerUseBridge } from '../dist/mac-computer-use.js'

const signal = AbortSignal.timeout(45_000)
let images = 0
const bridge = new MacComputerUseBridge({ attachments: { async saveImage({ data }) {
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  return { attachmentId: `acceptance-${++images}`, mediaType: 'image/png' }
} } })
async function observe() {
  const state = await bridge.observe(80, signal)
  assert.match(state.activeWindow.title, /^xiaoyin-computer-use-fixture-/)
  return state
}
function point(state, id) {
  const node = state.elements.find((item) => item.automationId === id)
  assert.ok(node, `Missing fixture element: ${id}`)
  return [Math.round(node.x + node.width / 2), Math.round(node.y + node.height / 2)]
}
await bridge.click(...point(await observe(), 'xiaoyin-test-input'), 'left', 1, 80, signal)
await observe()
await bridge.type('小胤输入验收 ABC 123', 80, signal)
let state = await observe()
assert.equal(state.elements.find((item) => item.automationId === 'xiaoyin-test-input')?.value, '小胤输入验收 ABC 123')
await bridge.key('A', ['WIN'], 80, signal)
await observe()
await bridge.type('中文替换成功 ✓', 80, signal)
state = await observe()
await bridge.click(...point(state, 'xiaoyin-test-check'), 'left', 1, 80, signal)
state = await observe()
assert.equal(state.elements.find((item) => item.automationId === 'xiaoyin-test-result')?.value, '已收到：中文替换成功 ✓')
const canceled = new AbortController(); canceled.abort()
await assert.rejects(bridge.type('不应输入', 80, canceled.signal))
state = await observe()
assert.equal(state.elements.find((item) => item.automationId === 'xiaoyin-test-input')?.value, '中文替换成功 ✓')
console.log(JSON.stringify({ passed: true, images, checks: ['observe', 'click', 'unicode-type', 'command-a-replace', 'read-result', 'cancel-before-action'] }))
