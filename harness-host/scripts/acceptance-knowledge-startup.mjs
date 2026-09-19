import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarnessRuntime } from '../dist/runtime.js'

const hostRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const home = await mkdtemp(join(tmpdir(), 'xiaoyin-knowledge-startup-'))
const runtime = new DeepSeekHarnessRuntime({
  DSH_HOME: home,
  DSH_SESSION_ROOT: join(home, 'sessions'),
  DSH_CORDIS_CONFIG: join(hostRoot, 'runtime/cordis.yml'),
  DSH_CWD: home,
  DEEPSEEK_API_KEY: 'diagnostic-placeholder',
  DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1',
  XIAOYIN_KNOWLEDGE_ENDPOINT: 'http://127.0.0.1:9/api/v1/knowledge-bases',
  XIAOYIN_KNOWLEDGE_BASE_REFS: '[]',
  XIAOYIN_LOCAL_FILE_ROOTS: '[]',
  XIAOYIN_MCP_CONNECTORS: '[]',
  XIAOYIN_ALLOW_SHELL: 'false',
  XIAOYIN_ALLOW_EXTERNAL_AGENTS: 'false',
  XIAOYIN_ALLOW_HOOKS: 'false',
  DSH_CUSTOM_SKILL_DIRS: '[]',
  DSH_TELEMETRY_DISABLED: '1',
})

try {
  assert.equal((await runtime.initialize()).status, 'initialized')
  assert.equal((await runtime.health()).capabilities.profile, 'enabled')
  console.log(JSON.stringify({ acceptance: 'knowledge-startup', passed: true, realModel: false }))
} finally {
  await runtime.close()
  await rm(home, { recursive: true, force: true })
}
