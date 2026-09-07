import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function checkHarnessCommand(command, args, env = process.env, timeoutMs = 30_000) {
  const temporary = await mkdtemp(join(tmpdir(), 'xiaoyin-runtime-smoke-'))
  try {
    await new Promise((done, fail) => {
      const child = spawn(command, args, { cwd: temporary, env: { ...env, DSH_HOME: temporary }, stdio: ['pipe', 'pipe', 'pipe'] })
      let settled = false
      let index = 0
      const requests = [['host.initialize', 'initialized'], ['host.health', 'ready'], ['host.shutdown', 'closed']]
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
        index += 1
        if (index === requests.length) child.stdin.end()
        else send()
      })
      send()
    })
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [node, host] = process.argv.slice(2)
  if (!node || !host) throw new Error('Expected embedded Node path and Harness directory')
  await checkHarnessCommand(resolve(node), [resolve(host, 'dist/index.js')], {
    ...process.env, DSH_CORDIS_CONFIG: resolve(host, 'runtime/cordis.yml'),
    XIAOYIN_ALLOW_SHELL: 'true', XIAOYIN_APPROVE_SHELL: 'false',
  })
  console.log('Packaged Harness initialize, health and shutdown responses verified')
}
