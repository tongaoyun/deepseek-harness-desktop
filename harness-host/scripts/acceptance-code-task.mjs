import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DeepSeekHarnessRuntime } from '../dist/runtime.js'
import { evaluationMetrics } from './evaluation-metrics.mjs'

if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required')
const skills = JSON.parse(process.env.XIAOYIN_ACCEPTANCE_SKILL_DIRS ?? '[]')
if (!skills.length) throw new Error('XIAOYIN_ACCEPTANCE_SKILL_DIRS is required')
const root = await mkdtemp(join(tmpdir(), 'xiaoyin-code-task-'))
const workspace = join(root, 'project')
const reportPath = resolve(process.env.XIAOYIN_ACCEPTANCE_REPORT ?? 'output/acceptance-code-task.json')
await mkdir(workspace)
const originalTests = [
  "import assert from 'node:assert/strict'",
  "import test from 'node:test'",
  "import { median } from './median.mjs'",
  "test('numeric ordering', () => assert.equal(median([2, 10, 3]), 3))",
  "test('even count', () => assert.equal(median([1, 4, 2, 3]), 2.5))",
  "test('empty input', () => assert.throws(() => median([])))",
  "test('preserves input', () => { const values = [3, 1, 2]; median(values); assert.deepEqual(values, [3, 1, 2]) })",
].join('\n') + '\n'
await writeFile(join(workspace, 'median.mjs'), 'export function median(values) { const sorted = values.sort(); return sorted[Math.floor(sorted.length / 2)]; }\n')
await writeFile(join(workspace, 'median.test.mjs'), originalTests)
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
git('init', '--quiet')
git('add', '.')
git('-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@localhost', 'commit', '--quiet', '-m', 'fixture')
const runTests = () => spawnSync(process.execPath, ['--test', 'median.test.mjs'], { cwd: workspace, encoding: 'utf8', timeout: 30_000 })
assert.notEqual(runTests().status, 0, 'fixture must fail before the task')
Object.assign(process.env, {
  DSH_HOME: join(root, 'home'), DSH_SESSION_ROOT: join(root, 'sessions'), DSH_CWD: workspace,
  XIAOYIN_LOCAL_FILE_ROOTS: JSON.stringify([{ id: 'project', name: '验收项目', path: workspace }]),
  XIAOYIN_MCP_CONNECTORS: '[]', XIAOYIN_COMPUTER_USE_TOOLS: '[]', XIAOYIN_ALLOW_BROWSER: 'false',
  DSH_CUSTOM_SKILL_DIRS: JSON.stringify(skills), XIAOYIN_EXECUTION_MODE: 'agent',
  XIAOYIN_TURN_TIMEOUT_MS: '240000',
})
let runtime = new DeepSeekHarnessRuntime()
const metrics = evaluationMetrics()
const calls = []
const turnFailures = []
let phase = 'execute'
let completed
const collect = (notification) => {
  metrics.collect(notification)
  const event = notification.params?.event
  if (event?.type === 'tool/call') {
    calls.push(event.data.name)
    console.log(JSON.stringify({ phase: 'tool', name: event.data.name }))
  }
  if (event?.type === 'turn/end' && event.data?.reason?.kind === 'error') {
    const error = event.data.reason.error ?? event.data.reason.failure
    turnFailures.push({ phase, message: error?.message ?? 'Unknown provider error' })
  }
}
let report
try {
  const result = await runtime.run({ prompt: '任务标记 XY-CODE-ROUNDTRIP。请使用已安装的 unit-testing 技能，修复当前项目 median.mjs 的中位数实现。先读取源码和测试，运行现有测试复现失败，再修改源码并重新运行测试。要求数字排序、偶数长度取两个中间数平均值、空数组抛出异常、不修改输入数组。禁止修改现有 median.test.mjs，不安装依赖、不联网、不委派、不提交代码。最后展示 git diff，并报告真实测试结果与任务完成状态。' }, collect)
  assert.equal(await readFile(join(workspace, 'median.test.mjs'), 'utf8'), originalTests)
  const tested = runTests()
  assert.equal(tested.status, 0, tested.stdout + tested.stderr)
  const diff = git('diff', '--', 'median.mjs')
  assert(diff.includes('median'))
  assert(calls.includes('skill'), 'the installed skill must actually be invoked')
  assert(calls.includes(process.platform === 'win32' ? 'pwsh' : 'bash'), 'tests must run through the native shell')
  assert.equal(result.outcome?.status, 'completed')
  completed = result
  const saved = await readFile(join(workspace, 'median.mjs'), 'utf8')
  await runtime.close()
  runtime = new DeepSeekHarnessRuntime()
  phase = 'restore'
  console.log(JSON.stringify({ phase, sessionId: result.sessionId }))
  const resumed = await runtime.run({ sessionId: result.sessionId, prompt: '继续刚才的任务。只读核对当前文件和测试结果，复述我第一轮给出的任务标记，并说明这次修复的四项要求是否满足。不要改动任何文件。' }, collect)
  assert.equal(resumed.sessionId, result.sessionId, 'restart must resume the original session')
  assert.equal(resumed.outcome?.status, 'completed')
  assert.equal(await readFile(join(workspace, 'median.mjs'), 'utf8'), saved)
  assert.equal(await readFile(join(workspace, 'median.test.mjs'), 'utf8'), originalTests)
  assert.match(resumed.finalResponse, /XY-CODE-ROUNDTRIP/)
  report = { passed: true, realModel: true, result, resumed, calls, diff, tests: tested.stdout }
  console.log(JSON.stringify({ passed: true, realModel: true, restoredSession: true, reportPath }))
} catch (error) {
  report = { passed: false, realModel: true, phase, completed, calls, turnFailures, error: error.message, workspace }
  throw error
} finally {
  await runtime.close()
  report.metrics = metrics.result()
  await mkdir(resolve(reportPath, '..'), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  if (report?.passed) await rm(root, { recursive: true, force: true })
}
