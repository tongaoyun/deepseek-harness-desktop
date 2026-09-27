import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolNames, toolResultMessages, writeMessagesResponse } from './messages-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'xiaoyin-skill-tools-'))
const host = resolve(process.env.XIAOYIN_ACCEPTANCE_HOST ?? fileURLToPath(new URL('..', import.meta.url)))
let step = 0, approval = false
const actions = [], receipts = [], tools = new Set()
const model = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  for (const name of toolNames(body)) tools.add(name)
  receipts.push(...toolResultMessages(body))
  const name = ['skills_search', 'skills_install'][step]
  const current = step++
  const args = current === 0 ? { query: 'report' } : { id: 'report' }
  const toolCall = name ? { id: `skill-${step}`, name, input: args } : undefined
  writeMessagesResponse(response, { text: toolCall ? '' : '技能已安装，下一轮任务可用。', ...(toolCall ? { toolCalls: [toolCall] } : {}) })
})
await new Promise((done) => model.listen(0, '127.0.0.1', done))
let child
try {
  await new Promise((done, fail) => {
    child = spawn(process.env.XIAOYIN_ACCEPTANCE_NODE ?? process.execPath, [join(host, 'dist/index.js')], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
        DEEPSEEK_API_KEY: 'local-fixture-only', DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.address().port}`,
        DSH_HOME: root, DSH_CORDIS_CONFIG: join(host, 'runtime/cordis.yml'),
        DSH_CUSTOM_SKILL_DIRS: '[]', XIAOYIN_LOCAL_FILE_ROOTS: '[]', XIAOYIN_MCP_CONNECTORS: '[]',
        XIAOYIN_COMPUTER_USE_TOOLS: '[]', XIAOYIN_ALLOW_BROWSER: 'false',
      },
    })
    const send = (method, params, id = null) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params, id })}\n`)
    let completed = false
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('Skill tool transport timed out')) }, 60000)
    child.stderr.resume()
    child.once('error', (error) => { clearTimeout(timer); fail(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && completed) done()
      else fail(new Error(`Host exited ${code}`))
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const value = JSON.parse(line)
        if (value.method === 'approval.request') {
          assert.equal(value.params.toolName, 'skills_install')
          approval = true
          send('approval.respond', { approvalId: value.params.approvalId, decision: 'allow' }, 99)
        } else if (value.method === 'skill.request') {
          actions.push(value.params.action)
          if (value.params.action === 'install') assert.equal(approval, true)
          send('skill.respond', { requestId: value.params.requestId, result: value.params.action === 'search'
            ? { skills: [{ id: 'report', name: '报告技能', installState: 'available' }] }
            : { id: 'report', installed: true, availableFrom: 'next-turn' } })
        } else if (value.id === 1) {
          assert.equal(value.error, undefined)
          assert.match(value.result.finalResponse, /下一轮/)
          completed = true
          send('host.shutdown', {}, 2)
        } else if (value.id === 2) child.stdin.end()
      } catch (error) { clearTimeout(timer); child.kill('SIGKILL'); fail(error) }
    })
    send('session.run', { prompt: '查询并安装 report 技能。' }, 1)
  })
  assert.deepEqual(actions, ['search', 'install'])
  assert(tools.has('skills_search') && tools.has('skills_install'))
  assert(JSON.stringify(receipts).includes('next-turn'))
  console.log(JSON.stringify({ passed: true, realModel: false, actions, approvalBeforeInstall: approval, receiptReturnedToModel: true }))
} finally {
  if (child && child.exitCode === null) { child.kill('SIGKILL'); await new Promise((done) => child.once('close', done)) }
  await new Promise((done) => model.close(done))
  await rm(root, { recursive: true, force: true })
}
