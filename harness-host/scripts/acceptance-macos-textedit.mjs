// Opt-in real-model acceptance. Launches TextEdit on synthetic files only.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarnessRuntime } from '../dist/runtime.js'
import { MacComputerUseBridge } from '../dist/mac-computer-use.js'

if (process.platform !== 'darwin') throw new Error('macOS only')
if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY required via environment')
const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-textedit-'))
const document = join(directory, 'acceptance.txt')
const warmup = join(directory, 'warmup.txt')
const original = '验收文档：数量 12，金额 287.50；标记 XY-TEXTEDIT。'
await writeFile(document, original)
await writeFile(warmup, '小胤临时验收窗口，请勿修改此文件。')
Object.assign(process.env, {
  DSH_HOME: directory, DSH_SESSION_ROOT: join(directory, 'sessions'), DSH_CWD: directory,
  DSH_MODEL: process.env.DSH_MODEL || 'deepseek-v4-flash', XIAOYIN_TURN_TIMEOUT_MS: '300000',
  XIAOYIN_LOCAL_FILE_ROOTS: '[]',
  XIAOYIN_MCP_CONNECTORS: '[]', XIAOYIN_ALLOW_BROWSER: 'false', DSH_CUSTOM_SKILL_DIRS: '[]',
  XIAOYIN_COMPUTER_USE_TOOLS: JSON.stringify(['computer_use_observe', 'computer_use_click', 'computer_use_type', 'computer_use_key', 'computer_use_scroll']),
})
// Setup launches the application; opening the target file is left to the model.
execFileSync('open', ['-n', '-a', 'TextEdit', warmup])
const runtime = new DeepSeekHarnessRuntime()
const stop = () => { void runtime.close() }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
const calls = []
const observations = []
const trace = (notification) => {
  const event = notification.params?.event ?? notification.params
  if (event?.type === 'tool/call') {
    calls.push({ name: event.data?.name, arguments: event.data?.arguments })
    console.log(JSON.stringify({ phase: 'tool', name: event.data?.name }))
  }
  if (event?.type === 'tool/result') {
    for (const block of event.data?.message?.content ?? []) {
      for (const content of block.content ?? []) {
        if (content.type !== 'text') continue
        try { const value = JSON.parse(content.text); if (Array.isArray(value.elements)) observations.push(value) } catch { /* Errors aren't observations. */ }
      }
    }
  }
}
console.log(JSON.stringify({ phase: 'started', directory }))
try {
  await runtime.initialize()
  const result = await runtime.run({ prompt: `这是 TextEdit（文本编辑）真实应用验收。应用已由测试准备程序打开 warmup.txt；你负责通过界面打开目标文件、编辑、保存和重新打开核对。仅用 computer_use_*，禁止文件、命令、浏览器或子 Agent 工具，不操作其他应用或非测试文档。先观察确认前台是 TextEdit；若不是则停止。用文件打开对话框打开 ${document}（macOS 的 WIN 表示 Command，Command+O 打开，Command+Shift+G 可输入完整路径）。读取原文，将数量增加 3、金额增加 42.50，保留标记与中文。保存到原 txt 文件，不修改 warmup.txt。保存后关闭目标文档，再通过打开对话框重新打开同一路径，读取内容核对；不要重复加数。每步根据新观察判断弹窗和加载状态，失败先重新观察，不盲打。最后报告实际数量金额与是否回读成功。只对 ${directory} 中的测试文档操作。` }, trace)
  const saved = await readFile(document, 'utf8')
  await writeFile(join(directory, 'result.json'), JSON.stringify({ result, saved, calls, observations }, null, 2))
  assert.equal(calls[0]?.name, 'computer_use_observe')
  assert.ok(calls.every((call) => call.name.startsWith('computer_use_')))
  assert.match(saved, /数量\s*15/)
  assert.match(saved, /金额\s*330(?:\.00)?/)
  assert.match(saved, /XY-TEXTEDIT/)
  assert.equal(await readFile(warmup, 'utf8'), '小胤临时验收窗口，请勿修改此文件。')
  const hasSavedText = (state) => state?.activeWindow.signature?.startsWith('acceptance.txt|') && state.elements.some((item) => item.controlType === 'AXTextArea' && /数量\s*15/.test(item.value) && /330/.test(item.value))
  assert.ok(hasSavedText(observations.at(-1)), 'Final TextEdit observation must show saved text')
  const continuationStart = calls.length
  const continuation = await runtime.run({ sessionId: result.sessionId, prompt: `继续仅用 computer_use_* 操作 TextEdit 中刚才的 ${document}。先观察，然后关闭该测试文档，再用打开对话框重新打开这个完整路径，只读核对数量、金额和标记。不编辑不保存，不操作 warmup 或其他文档。` }, trace)
  assert.equal(await readFile(document, 'utf8'), saved)
  assert.ok(hasSavedText(observations.at(-1)))
  assert.match(continuation.finalResponse, /15/)
  assert.match(continuation.finalResponse, /330/)
  const continuationCalls = calls.slice(continuationStart)
  const keyCalls = continuationCalls.filter((call) => call.name === 'computer_use_key').map((call) => typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments)
  assert.ok(keyCalls.some((input) => input.key === 'W' && input.modifiers?.includes('WIN')), 'Must close the test document before rereading')
  assert.ok(keyCalls.some((input) => input.key === 'O' && input.modifiers?.includes('WIN')), 'Must reopen via the file dialog')
  assert.ok(!keyCalls.some((input) => input.key === 'S' && input.modifiers?.includes('WIN')), 'Read-only continuation must not save')
  await writeFile(join(directory, 'continuation.json'), JSON.stringify({ continuation, calls, observations }, null, 2))
  // Independent bounded-observation regression, after the autonomous task.
  const bridge = new MacComputerUseBridge({ attachments: { saveImage: async () => ({}) } })
  const signal = new AbortController().signal
  let state = await bridge.observe(100, signal)
  assert.equal(state.activeWindow.processId, observations.at(-1).activeWindow.processId)
  assert.ok(hasSavedText(state))
  await bridge.key('O', ['WIN'], 100, signal)
  state = await bridge.observe(100, signal)
  assert.ok(state.elements.some((item) => item.automationId === 'open-panel'))
  await bridge.key('G', ['WIN', 'SHIFT'], 100, signal)
  state = await bridge.observe(8, signal)
  assert.ok(state.elements.some((item) => item.automationId === 'PathTextField'), 'Path input must survive a small observation limit')
  const identities = state.elements.map((item) => JSON.stringify([item.controlType, item.automationId, item.x, item.y]))
  assert.equal(new Set(identities).size, identities.length)
  await bridge.key('ESC', [], 100, signal)
  await bridge.observe(100, signal)
  await bridge.key('ESC', [], 100, signal)
  assert.equal(await readFile(document, 'utf8'), saved)
  console.log(JSON.stringify({ phase: 'passed', saved, directory, calls: calls.length }))
} finally {
  await runtime.close()
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  // Never force-quit TextEdit: an existing user document could have joined it.
  await writeFile(join(directory, 'trace.json'), JSON.stringify({ calls, observations }, null, 2))
}
