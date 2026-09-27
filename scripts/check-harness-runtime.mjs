import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DEFAULT_HARNESS_SMOKE_TIMEOUT_MS = 30_000
const MAX_HARNESS_SMOKE_TIMEOUT_MS = 600_000

export function harnessSmokeTimeout(env = process.env) {
  const value = env.XIAOYIN_HARNESS_SMOKE_TIMEOUT_MS
  if (value === undefined || value === '') return DEFAULT_HARNESS_SMOKE_TIMEOUT_MS
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('XIAOYIN_HARNESS_SMOKE_TIMEOUT_MS must be a positive integer')
  }
  const timeoutMs = Number(value)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > MAX_HARNESS_SMOKE_TIMEOUT_MS) {
    throw new Error(`XIAOYIN_HARNESS_SMOKE_TIMEOUT_MS must not exceed ${MAX_HARNESS_SMOKE_TIMEOUT_MS}`)
  }
  return timeoutMs
}

export async function checkHarnessCommand(command, args, env = process.env, timeoutMs = DEFAULT_HARNESS_SMOKE_TIMEOUT_MS, { selfTest = false, requiredCapabilities = [], expectedCapabilities = {} } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'xiaoyin-runtime-smoke-'))
  let childClosed = Promise.resolve()
  try {
    await new Promise((done, fail) => {
      const child = spawn(command, args, { cwd: temporary, env: { ...env, DSH_HOME: temporary }, stdio: ['pipe', 'pipe', 'pipe'] })
      childClosed = new Promise((closed) => child.once('close', closed))
      let settled = false
      let index = 0
      const requests = [['host.initialize', 'initialized'], ['host.health', 'ready'], ['host.shutdown', 'closed']]
      if (selfTest) requests.splice(2, 0, ['host.self-test', 'passed'])
      const lines = createInterface({ input: child.stdout })
      const stop = (error) => {
        if (settled) return
        settled = true; clearTimeout(timer); lines.close()
        if (error) { child.kill('SIGKILL'); fail(error) } else done()
      }
      const timer = setTimeout(() => stop(new Error('Packaged Harness smoke test timed out')), timeoutMs)
      child.on('error', stop)
      child.stdin.on('error', (error) => stop(error))
      child.stderr.resume()
      child.on('close', (code) => stop(code === 0 && index === requests.length ? undefined : new Error(`Packaged Harness exited ${code} after ${index} verified responses`)))
      const send = () => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: requests[index][0] })}\n`)
      lines.on('line', (line) => {
        let value
        try { value = JSON.parse(line) } catch { return }
        if (value.id !== index + 1 || index >= requests.length) return
        if (value.error || value.result?.status !== requests[index][1]) {
          stop(new Error(`Packaged Harness ${requests[index][0]} failed: ${value.error?.message ?? value.result?.status ?? 'missing status'}`)); return
        }
        if (requests[index][0] === 'host.health' && requiredCapabilities.length > 0) {
          const capabilities = value.result?.capabilities
          const missing = requiredCapabilities.filter((key) => capabilities?.[key] !== 'enabled' && capabilities?.[key] !== 'gated')
          if (missing.length) {
            stop(new Error(`Packaged Harness capabilities were not reported: ${missing.join(', ')}`)); return
          }
        }
        if (requests[index][0] === 'host.health') {
          const capabilities = value.result?.capabilities
          const mismatched = Object.entries(expectedCapabilities).filter(([key, status]) => capabilities?.[key] !== status)
          if (mismatched.length) {
            stop(new Error(`Packaged Harness capability policy mismatch: ${mismatched.map(([key, status]) => `${key} expected ${status}, got ${capabilities?.[key] ?? 'missing'}`).join(', ')}`)); return
          }
        }
        if (requests[index][0] === 'host.self-test') {
          const required = ['local-files', 'office-runtime', 'office-skills', 'libreoffice-kit', 'native-shell']
          if (process.platform === 'win32') required.push('computer-use')
          const passed = new Set((Array.isArray(value.result.checks) ? value.result.checks : []).filter((check) => check.passed === true).map((check) => check.key))
          const missing = required.filter((key) => !passed.has(key))
          if (missing.length) {
            stop(new Error(`Installed capabilities were not verified: ${missing.join(', ')}`)); return
          }
        }
        index += 1
        if (index === requests.length) child.stdin.end()
        else send()
      })
      send()
    })
  } finally {
    // Windows locks a running process's working directory even after kill is requested.
    await childClosed
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [nodeArgument, hostArgument, mode] = process.argv.slice(2)
  if ((nodeArgument === undefined) !== (hostArgument === undefined)) throw new Error('Expected both embedded Node path and Harness directory, or neither')
  if (mode && mode !== '--self-test') throw new Error(`Unknown runtime check option: ${mode}`)
  const command = resolve(nodeArgument ?? process.execPath)
  const host = resolve(hostArgument ?? fileURLToPath(new URL('../harness-host', import.meta.url)))
  const args = [resolve(host, 'dist/index.js')]
  const env = {
    ...process.env, DSH_CORDIS_CONFIG: resolve(host, 'runtime/cordis.yml'),
    DSH_BUNDLED_PRIMARY_RUNTIME: resolve(host, '..', 'primary-runtime'),
    XIAOYIN_ALLOW_SHELL: 'true', XIAOYIN_APPROVE_SHELL: 'false',
  }
  const timeoutMs = harnessSmokeTimeout()
  await checkHarnessCommand(command, args, env, timeoutMs, {
    selfTest: mode === '--self-test',
    requiredCapabilities: ['sessionPersistence', 'sessionQuery', 'sessionReference', 'present', 'workspaceChanges', 'workspaceDependencies', 'officeSkills', 'libreOfficeKit'],
    expectedCapabilities: { shell: 'enabled', persistentTerminal: 'enabled', sessionQuery: 'enabled', sessionQueryTools: 'enabled', mcpClient: 'gated' },
  })
  await checkHarnessCommand(command, args, {
    ...env, XIAOYIN_ALLOW_SHELL: 'false', XIAOYIN_ENABLE_SESSION_QUERY_TOOLS: 'false',
  }, timeoutMs, {
    expectedCapabilities: { shell: 'gated', persistentTerminal: 'gated', sessionQuery: 'enabled', sessionQueryTools: 'gated', mcpClient: 'gated' },
  })
  console.log('Harness native and restricted capability policies verified')
  if (mode === '--self-test') console.log('Installed Harness local capability self-test verified')
}
