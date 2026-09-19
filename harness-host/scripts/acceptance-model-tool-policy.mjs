import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarnessRuntime } from '../dist/runtime.js'

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
  const names = body.tools.map((tool) => tool.function?.name)
  requestedTools.push(names)
  schemaBytes.push(Buffer.byteLength(JSON.stringify(body.tools)))
  toolReplies.push(JSON.stringify(body.messages.filter((message) => message.role === 'tool')))
  const discover = names.includes('tool_discover') && !names.includes('task_report')
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const choice of [
    { index: 0, delta: discover ? { role: 'assistant', tool_calls: [{ index: 0, id: `discover-${requestedTools.length}`, type: 'function', function: { name: 'tool_discover', arguments: JSON.stringify({ groups: ['files', 'office', 'knowledge', 'connectors', 'skills', 'web', 'code', 'desktop', 'workflow', 'other'] }) } }] } : { role: 'assistant', content: '工具可见性验收完成。' }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: discover ? 'tool_calls' : 'stop' },
  ]) {
    response.write(`data: ${JSON.stringify({ id: 'tool-policy-completion', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', choices: [choice] })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
})

const officialFiles = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'present']
const productFiles = ['local_files_roots', 'local_files_list', 'local_files_search', 'local_files_read_text', 'local_files_publish']
const shellTools = ['bash', 'pwsh', 'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list']
const sessionQueryTools = ['session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read']
const browserTools = ['browser_open', 'browser_snapshot', 'browser_screenshot', 'browser_downloads']

function containsAll(names, expected, scenario) {
  for (const name of expected) assert(names.has(name), `${scenario}: missing ${name}`)
}

function containsNone(names, forbidden, scenario) {
  for (const name of forbidden) assert(!names.has(name), `${scenario}: unexpected ${name}`)
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  for (const scenario of [
    { name: 'native-default', shell: 'true', roots: [], mode: 'native', files: officialFiles, forbiddenFiles: productFiles, hasShell: true, query: true, browser: false },
    { name: 'native-no-shell', shell: 'false', roots: [], mode: 'native', files: officialFiles, forbiddenFiles: productFiles, hasShell: false, query: false, browser: false },
    { name: 'native-authorized-roots', shell: 'false', roots: [{ id: 'workspace', name: 'Workspace', path: workspace }], mode: 'native', files: productFiles, forbiddenFiles: officialFiles, hasShell: false, query: true, browser: false },
    { name: 'native-browser', shell: 'false', roots: [], mode: 'native', files: officialFiles, forbiddenFiles: productFiles, hasShell: false, query: false, browser: true },
    { name: 'ptc-no-shell', shell: 'false', roots: [], mode: 'ptc', files: [], forbiddenFiles: [...officialFiles, ...productFiles], hasShell: false, query: true, browser: false },
  ]) {
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
      XIAOYIN_ATTACHMENT_ROOT: join(root, 'attachments'),
      XIAOYIN_LOCAL_FILE_ROOTS: JSON.stringify(scenario.roots),
      XIAOYIN_ALLOW_SHELL: scenario.shell,
      XIAOYIN_TOOLS_MODE: scenario.mode,
      XIAOYIN_MCP_CONNECTORS: '[]',
      XIAOYIN_COMPUTER_USE_TOOLS: '[]',
      XIAOYIN_ALLOW_BROWSER: String(scenario.browser),
      XIAOYIN_ENABLE_SESSION_QUERY_TOOLS: String(scenario.query),
      XIAOYIN_ALLOW_EXTERNAL_AGENTS: 'false',
      DSH_CUSTOM_SKILL_DIRS: '[]',
    })
    try {
      const result = await runtime.run({ prompt: '验收本轮可用工具 policyhistorymarker。' }, () => {})
      assert.equal(requestedTools.length, scenario.mode === 'ptc' ? 1 : 2, `${scenario.name}: discovery should add exactly one request`)
      const initial = new Set(requestedTools[0])
      if (scenario.mode === 'native') {
        containsAll(initial, ['tool_discover'], scenario.name)
        containsNone(initial, [...officialFiles, ...productFiles, ...shellTools, ...sessionQueryTools, ...browserTools, 'task_report'], scenario.name)
        assert(initial.size <= 6 && schemaBytes[0] < 10000, `${scenario.name}: initial model tool schema was not reduced (${initial.size} tools, ${schemaBytes[0]} bytes: ${[...initial].join(', ')})`)
      }
      const names = new Set(requestedTools.at(-1))
      if (scenario.mode === 'native') {
        assert(toolReplies.at(-1).includes('office_xlsx_recalculate'), `${scenario.name}: office instructions were not delivered after discovery`)
        assert(toolReplies.at(-1).includes(scenario.roots.length ? 'local_files_publish' : 'present'), `${scenario.name}: publishing instructions did not match file policy`)
      }
      containsAll(names, scenario.files, scenario.name)
      containsNone(names, scenario.forbiddenFiles, scenario.name)
      if (scenario.hasShell) {
        containsAll(names, [process.platform === 'win32' ? 'pwsh' : 'bash', ...shellTools.slice(2)], scenario.name)
      } else {
        containsNone(names, shellTools, scenario.name)
      }
      if (scenario.mode === 'ptc') containsAll(names, ['run_code'], scenario.name)
      else containsNone(names, ['run_code'], scenario.name)
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
