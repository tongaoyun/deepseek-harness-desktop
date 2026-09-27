import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarnessRuntime } from '../dist/runtime.js'
import { writeMessagesResponse } from './messages-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'xiaoyin-skill-loading-'))
const sources = [
  ['standalone/api-design', 'api-design', 'SELECTED_STANDALONE'],
  ['fullstack/api-design', 'api-design', 'SELECTED_KIT'],
  ['fullstack/code-review', 'code-review', 'REVIEW_ONLY'],
]
for (const [path, name, marker] of sources) {
  await mkdir(join(root, path), { recursive: true })
  await writeFile(join(root, path, 'SKILL.md'), `---\nname: ${name}\ndescription: Verify the installed development skill selection.\n---\n\n# ${name}\n\n${marker}\n`)
}
let expected
let toolMessages = []
let step = 0
const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  toolMessages = body.messages
  const toolCall = step++ === 0
    ? { id: 'load-skill', name: 'skill', input: { name: 'api-design' } }
    : undefined
  writeMessagesResponse(response, { text: toolCall ? '' : '技能加载验收完成。', ...(toolCall ? { toolCalls: [toolCall] } : {}) })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  for (const scenario of [
    { name: 'standalone-priority', directories: ['standalone/api-design', 'fullstack/code-review'], marker: 'SELECTED_STANDALONE' },
    { name: 'selected-kit-priority', directories: ['fullstack/api-design', 'fullstack/code-review'], marker: 'SELECTED_KIT' },
    { name: 'disabled', directories: ['fullstack/code-review'], marker: 'unknown or no longer available' },
    { name: 'uninstalled', directories: [], marker: 'unknown or no longer available' },
  ]) {
    expected = scenario.marker
    step = 0
    const runtime = new DeepSeekHarnessRuntime({
      DEEPSEEK_API_KEY: 'local-fixture-only', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      DSH_HOME: join(root, scenario.name), DSH_SESSION_ROOT: join(root, scenario.name, 'sessions'),
      XIAOYIN_LOCAL_FILE_ROOTS: '[]',
      XIAOYIN_MCP_CONNECTORS: '[]', XIAOYIN_COMPUTER_USE_TOOLS: '[]', XIAOYIN_ALLOW_BROWSER: 'false',
      DSH_CUSTOM_SKILL_DIRS: JSON.stringify(scenario.directories.map((path) => join(root, path))),
    })
    try {
      await runtime.run({ prompt: '验收 api-design 技能加载。' }, () => {})
      const loaded = JSON.stringify(toolMessages)
      assert(loaded.includes(expected), `${scenario.name}: ${loaded}`)
      if (expected === 'SELECTED_STANDALONE') assert(!loaded.includes('SELECTED_KIT'))
      if (expected === 'SELECTED_KIT') assert(!loaded.includes('SELECTED_STANDALONE'))
      console.log(JSON.stringify({ scenario: scenario.name, passed: true, realModel: false }))
    } finally {
      await runtime.close()
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
