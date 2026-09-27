import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarnessRuntime } from '../dist/runtime.js'
import { toolNames, toolResultMessages, writeMessagesResponse } from './messages-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'xiaoyin-tool-policy-'))
const workspace = join(root, 'workspace')
await mkdir(workspace)

let requestedTools = []
let schemaBytes = []
let toolReplies = []
const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  assert(Array.isArray(body.tools), 'The model request must include tool schemas')
  const names = toolNames(body)
  requestedTools.push(names)
  schemaBytes.push(Buffer.byteLength(JSON.stringify(body.tools)))
  toolReplies.push(JSON.stringify(toolResultMessages(body)))
  writeMessagesResponse(response, {
    text: '工具可见性验收完成。',
  })
})

const officialFiles = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'present']
const productFiles = ['local_files_roots', 'local_files_list', 'local_files_search', 'local_files_read_text', 'local_files_publish']
const shellTools = ['bash', 'pwsh']
const removedTerminalTools = ['terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list']
const sessionQueryTools = ['session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read']
const browserTools = [
  'mcp__playwright-mcp__browser_navigate',
  'mcp__playwright-mcp__browser_snapshot',
  'mcp__playwright-mcp__browser_take_screenshot',
  'mcp__playwright-mcp__browser_tabs',
]
const removedDiscoveryTool = ['tool', 'discover'].join('_')
const removedOutcomeTool = ['task', 'report'].join('_')
const browserExecutable = process.env.XIAOYIN_BROWSER_EXECUTABLE || [
  process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '',
  process.platform === 'darwin' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : '',
  process.platform === 'win32' ? `${process.env.PROGRAMFILES || ''}\\Google\\Chrome\\Application\\chrome.exe` : '',
  process.platform === 'win32' ? `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe` : '',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
].find((candidate) => candidate && existsSync(candidate)) || ''

function containsAll(names, expected, scenario) {
  for (const name of expected) assert(names.has(name), `${scenario}: missing ${name}`)
}

function containsNone(names, forbidden, scenario) {
  for (const name of forbidden) assert(!names.has(name), `${scenario}: unexpected ${name}`)
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  const scenarios = [
    { name: 'native-default', shell: 'true', roots: [], mode: 'native', executionMode: 'agent', files: officialFiles, forbiddenFiles: productFiles, hasShell: true, query: true, browser: false },
    { name: 'native-no-shell', shell: 'false', roots: [], mode: 'native', executionMode: 'agent', files: officialFiles, forbiddenFiles: productFiles, hasShell: false, query: false, browser: false },
    { name: 'native-authorized-roots', shell: 'false', roots: [{ id: 'workspace', name: 'Workspace', path: workspace }], mode: 'native', executionMode: 'agent', files: officialFiles, forbiddenFiles: productFiles, hasShell: false, query: true, browser: false },
    { name: 'native-plan-authorized-roots', shell: 'false', roots: [{ id: 'workspace', name: 'Workspace', path: workspace }], mode: 'native', executionMode: 'plan', files: officialFiles, forbiddenFiles: productFiles, hasShell: false, query: true, browser: false },
  ]
  if (browserExecutable) scenarios.push({ name: 'native-browser', shell: 'false', roots: [], mode: 'native', executionMode: 'agent', files: officialFiles, forbiddenFiles: productFiles, hasShell: false, query: false, browser: true })
  else console.log(JSON.stringify({ scenario: 'native-browser', skipped: true, reason: '未检测到 Chromium，可通过 XIAOYIN_BROWSER_EXECUTABLE 指定' }))
  for (const scenario of scenarios) {
    requestedTools = []
    schemaBytes = []
    toolReplies = []
    const home = join(root, scenario.name)
    const runtime = new DeepSeekHarnessRuntime({
      DEEPSEEK_API_KEY: 'local-fixture-only',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      DSH_HOME: home,
      DSH_SESSION_ROOT: join(home, 'sessions'),
      DSH_CWD: workspace,
      XIAOYIN_LOCAL_FILE_ROOTS: JSON.stringify(scenario.roots),
      XIAOYIN_ALLOW_SHELL: scenario.shell,
      XIAOYIN_MCP_CONNECTORS: '[]',
      XIAOYIN_COMPUTER_USE_TOOLS: '[]',
      XIAOYIN_ALLOW_BROWSER: String(scenario.browser),
      XIAOYIN_BROWSER_EXECUTABLE: browserExecutable,
      XIAOYIN_ENABLE_SESSION_QUERY_TOOLS: String(scenario.query),
      XIAOYIN_ALLOW_EXTERNAL_AGENTS: 'false',
      XIAOYIN_EXECUTION_MODE: scenario.executionMode,
      DSH_CUSTOM_SKILL_DIRS: '[]',
    })
    try {
      const result = await runtime.run({ prompt: '验收本轮可用工具 policyhistorymarker。' }, () => {})
      assert.equal(requestedTools.length, 1, `${scenario.name}: preset should keep one stable request`)
      const initial = new Set(requestedTools[0])
      if (scenario.mode === 'native') {
        containsAll(initial, ['exit_plan_mode'], scenario.name)
        containsNone(initial, [...removedTerminalTools, ...(scenario.query ? [] : sessionQueryTools), removedOutcomeTool, removedDiscoveryTool], scenario.name)
        assert(schemaBytes[0] > 0, `${scenario.name}: preset model tool schema is empty`)
      }
      const names = new Set(requestedTools.at(-1))
      if (scenario.mode === 'native') {
        containsAll(names, ['exit_plan_mode'], scenario.name)
      }
      containsAll(names, scenario.files, scenario.name)
      containsNone(names, scenario.forbiddenFiles, scenario.name)
      if (scenario.hasShell) {
        containsAll(names, [process.platform === 'win32' ? 'pwsh' : 'bash'], scenario.name)
      } else {
        containsNone(names, shellTools, scenario.name)
      }
      containsNone(names, removedTerminalTools, scenario.name)
      containsNone(names, ['run_code'], scenario.name)
      if (scenario.mode === 'native' && scenario.query) containsAll(names, sessionQueryTools, scenario.name)
      else containsNone(names, sessionQueryTools, scenario.name)
      if (scenario.browser && scenario.mode === 'native') containsAll(names, browserTools, scenario.name)
      else containsNone(names, browserTools, scenario.name)
      if (!scenario.query) {
        const history = await runtime.searchSessions([result.sessionId], 'policyhistorymarker', 10)
        assert(history.items.some((item) => item.sessionId === result.sessionId), `${scenario.name}: desktop Session Query history is unavailable`)
        if (scenario.name === 'native-no-shell') {
          const second = await runtime.run({ prompt: '请再次验收中文历史检索。' }, () => {})
          assert.deepEqual(new Set(requestedTools.at(-2)), initial, 'follow-up turn should start with the same minimal tools')
          const ids = ['session-missing-history', result.sessionId, second.sessionId]
          const firstPage = await runtime.searchSessions(ids, '验收', 1)
          assert.deepEqual(firstPage.items.map((item) => item.sessionId), [result.sessionId])
          assert(firstPage.nextCursor, 'Chinese session search must provide a continuation cursor')
          const secondPage = await runtime.searchSessions(ids, '验收', 1, firstPage.nextCursor)
          assert.deepEqual(secondPage.items.map((item) => item.sessionId), [second.sessionId])
          assert.equal(secondPage.nextCursor, undefined)
          await assert.rejects(runtime.searchSessions(ids, '其他查询', 1, firstPage.nextCursor), /cursor/i)
        }
      }
      console.log(JSON.stringify({ scenario: scenario.name, passed: true, model: 'local-fixture', initialTools: [...initial], initialSchemaBytes: schemaBytes[0], expandedTools: names.size }))
    } finally {
      await runtime.close()
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
