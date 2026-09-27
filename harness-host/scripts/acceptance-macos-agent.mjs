// Explicit local acceptance only. Uses the real runtime/model and an isolated document window.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarnessRuntime } from '../dist/runtime.js'

if (process.platform !== 'darwin') throw new Error('macOS only')
if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required; never place a key in this script')
const scenario = process.argv[2] ?? 'complete'
if (!['complete', 'cancel', 'unavailable'].includes(scenario)) throw new Error('Use complete, cancel, or unavailable')
const home = await mkdtemp(join(tmpdir(), 'xiaoyin-agent-desktop-'))
const document = join(home, 'acceptance.txt')
await writeFile(document, '验收文档：数量 12，金额 287.50；标记 XY-DESKTOP-AGENT。')
const binary = join(home, 'xiaoyin-computer-use-fixture-agent')
execFileSync('xcrun', ['swiftc', fileURLToPath(new URL('../native/computer-use-fixture.swift', import.meta.url)), '-o', binary])
Object.assign(process.env, {
  DSH_HOME: home, DSH_SESSION_ROOT: join(home, 'sessions'), DSH_CWD: home,
  DSH_MODEL: process.env.DSH_MODEL || 'deepseek-v4-flash', XIAOYIN_TURN_TIMEOUT_MS: '240000',
  XIAOYIN_LOCAL_FILE_ROOTS: '[]', XIAOYIN_MCP_CONNECTORS: '[]',
  XIAOYIN_COMPUTER_USE_TOOLS: JSON.stringify(['computer_use_observe', 'computer_use_click', 'computer_use_type', 'computer_use_key', 'computer_use_scroll']),
  XIAOYIN_ALLOW_BROWSER: 'false', DSH_CUSTOM_SKILL_DIRS: '[]',
})
const runtime = new DeepSeekHarnessRuntime()
const fixture = spawn(binary, [document], { stdio: 'ignore' })
console.log(JSON.stringify({ phase: 'started', directory: home, fixturePid: fixture.pid }))
const calls = []
const observations = []
let lastTool = ''
let canceled = false
try {
  await runtime.initialize()
  if (scenario === 'unavailable') {
    // Only the synthetic fixture path is made unreadable as a file; no user data is involved.
    const { rename, mkdir } = await import('node:fs/promises')
    await rename(document, join(home, 'original.txt'))
    await mkdir(document)
  }
  const result = await runtime.run({ prompt: '这是本机应用操作验收。仅使用 computer_use_* 工具操作前台名为 xiaoyin-computer-use-fixture-agent 的测试窗口，不操作其他应用，不使用文件、命令或子 Agent 工具。先观察界面，点击打开测试文档读取原始内容；将数量增加 3、金额增加 42.50，保留原有标记，保存文档；然后点击重新读取磁盘，核对实际保存的内容。遇到失败先重新观察，不盲目重复写入；打不开文档则不要猜测或覆盖内容，停止并说明。若前台不是指定测试窗口则停止并说明。最后用中文给出核对结果。' }, (notification) => {
    const event = notification.params?.event ?? notification.params
    if (event?.type === 'tool/call') {
      const name = event.data?.name
      calls.push(name)
      lastTool = name
      console.log(JSON.stringify({ phase: 'tool', name }))
    }
    if (event?.type === 'tool/result') {
      for (const block of event.data?.message?.content ?? []) {
        for (const content of block.content ?? []) {
          if (content.type !== 'text') continue
          try { const value = JSON.parse(content.text); if (Array.isArray(value.elements)) observations.push(value) } catch { /* Tool errors are not observations. */ }
        }
      }
      console.log(JSON.stringify({ phase: 'tool-result', name: lastTool }))
      if (scenario === 'cancel' && lastTool === 'computer_use_type' && !canceled) {
        canceled = true
        console.log(JSON.stringify({ phase: 'cancel-requested' }))
        void runtime.close()
      }
    }
  }).catch((error) => { if (canceled) return { finalResponse: '中途停止已完成', sessionId: '' }; throw error })
  const saved = await readFile(scenario === 'unavailable' ? join(home, 'original.txt') : document, 'utf8')
  await writeFile(join(home, 'result.json'), JSON.stringify({ ...result, saved, calls, observations }, null, 2))
  assert.equal(calls[0], 'computer_use_observe')
  assert.ok(calls.every((name) => name.startsWith('computer_use_')))
  const statuses = observations.flatMap((state) => state.elements.filter((item) => item.automationId === 'xiaoyin-test-result').map((item) => item.value))
  const lastInput = observations.at(-1)?.elements.find((item) => item.automationId === 'xiaoyin-test-input')?.value
  if (scenario === 'complete') {
    assert.match(saved, /15/); assert.match(saved, /330(?:\.00)?/)
    for (const status of ['已打开测试文档', '已保存到磁盘', '已从磁盘重新读取']) assert.ok(statuses.includes(status))
    assert.equal(lastInput, saved)
  }
  else {
    assert.equal(saved, '验收文档：数量 12，金额 287.50；标记 XY-DESKTOP-AGENT。')
    if (scenario === 'cancel') {
      assert.equal(canceled, true)
      assert.equal(calls.at(-1), 'computer_use_type')
      assert.match(lastInput, /15/)
      assert.match(lastInput, /330/)
      assert.ok(!statuses.includes('已保存到磁盘'))
    }
    else { assert.match(result.finalResponse, /失败|无法|不能|不可|打不开/); assert.ok(!calls.includes('computer_use_type')) }
  }
  assert.match(saved, /XY-DESKTOP-AGENT/)
  if (scenario === 'complete') {
    const continuation = await runtime.run({ sessionId: result.sessionId, prompt: '继续刚才的测试任务。仅使用 computer_use_* 观察指定测试窗口，并点击重新读取磁盘进行只读核对，告诉我当前数量、金额和标记。不要再次应用增加规则，不要输入文字或保存，不操作其他应用。' }, () => {})
    assert.equal(await readFile(document, 'utf8'), saved)
    assert.match(continuation.finalResponse, /15/)
    assert.match(continuation.finalResponse, /330/)
    await writeFile(join(home, 'continuation.json'), JSON.stringify(continuation, null, 2))
    console.log(JSON.stringify({ phase: 'continuation-passed', unchanged: true }))
  }
  console.log(JSON.stringify({ phase: 'passed', scenario, saved, calls: calls.length, directory: home }))
} finally {
  await runtime.close()
  fixture.kill('SIGTERM')
}
