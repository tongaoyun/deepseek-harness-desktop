// Opt-in real-model check on an isolated synthetic profile. Never reads user memories.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarnessRuntime } from '../dist/runtime.js'

if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY required via environment')
const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-memory-acceptance-'))
const file = join(directory, 'profile.json')
Object.assign(process.env, {
  DSH_HOME: directory, DSH_SESSION_ROOT: join(directory, 'sessions'), DSH_CWD: directory,
  DSH_MODEL: process.env.DSH_MODEL || 'deepseek-v4-flash', XIAOYIN_TURN_TIMEOUT_MS: '120000',
  XIAOYIN_MEMORY_CONTEXT: JSON.stringify({ profilePath: file }), XIAOYIN_LOCAL_FILE_ROOTS: '[]',
  XIAOYIN_MCP_CONNECTORS: '[]', XIAOYIN_ALLOW_BROWSER: 'false', DSH_CUSTOM_SKILL_DIRS: '[]', XIAOYIN_COMPUTER_USE_TOOLS: '[]',
})
const profile = (marker) => ({ enabled: true, collaborationStyle: '', workManual: '', entries: marker ? [{ kind: 'preference', text: `所有回答末尾附加格式标记 ${marker}。`, updatedAt: new Date().toISOString() }] : [] })
const runtime = new DeepSeekHarnessRuntime()
const results = []
let tools = 0
const trace = (notification) => { const event = notification.params?.event ?? notification.params; if (event?.type === 'tool/call') tools++ }
try {
  await writeFile(file, JSON.stringify(profile('XY-MEM-A')))
  const first = await runtime.run({ prompt: '不要调用任何工具。请回答 2+2 的结果，遵守已有输出格式。' }, trace)
  assert.match(first.finalResponse, /XY-MEM-A/)
  results.push({ check: 'new-task-uses-memory', passed: true, final: first.finalResponse })
  console.log(JSON.stringify({ check: results.at(-1).check, passed: true }))
  const override = await runtime.run({ sessionId: first.sessionId, prompt: '不要调用工具。本轮只回答 OVERRIDE_OK；不要附加任何既有格式标记，这条本轮要求优先。' }, trace)
  assert.equal(override.finalResponse.trim(), 'OVERRIDE_OK')
  results.push({ check: 'current-request-overrides-memory', passed: true, final: override.finalResponse })
  console.log(JSON.stringify({ check: results.at(-1).check, passed: true }))
  await writeFile(file, JSON.stringify(profile('XY-MEM-B')))
  const updated = await runtime.run({ prompt: '不要调用任何工具。请回答 3+3 的结果，遵守已有输出格式。' }, trace)
  assert.match(updated.finalResponse, /XY-MEM-B/)
  assert.doesNotMatch(updated.finalResponse, /XY-MEM-A/)
  results.push({ check: 'updated-memory-next-task', passed: true, final: updated.finalResponse })
  console.log(JSON.stringify({ check: results.at(-1).check, passed: true }))
  await writeFile(file, JSON.stringify(profile()))
  const forgotten = await runtime.run({ prompt: '不要调用任何工具。请回答 4+4 的结果。' }, trace)
  assert.doesNotMatch(forgotten.finalResponse, /XY-MEM-[AB]/)
  results.push({ check: 'deleted-memory-not-in-new-task', passed: true, final: forgotten.finalResponse })
  assert.equal(tools, 0)
  console.log(JSON.stringify({ check: results.at(-1).check, passed: true, tools, directory }))
} finally {
  await runtime.close()
  await writeFile(join(directory, 'result.json'), JSON.stringify({ results, tools }, null, 2))
}
