import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { DeepSeekHarnessNativeProcess } from '../src/deepseek-harness-native-process.ts'

const spawning = vi.hoisted(() => ({ spawn: vi.fn<(file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => unknown>() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: spawning.spawn,
}))
afterEach(() => { vi.unstubAllEnvs(); spawning.spawn.mockReset() })

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn((_signal: string) => { queueMicrotask(() => { child.emit('exit', 0, null) }); return true }),
  })
  let requestId = ''
  child.stdin.on('data', (chunk: Buffer) => { requestId = (JSON.parse(chunk.toString()) as { request_id: string }).request_id })
  spawning.spawn.mockReturnValue(child)
  const sidecar = new DeepSeekHarnessNativeProcess(process.execPath, '/native-data')
  const respond = (error: string | null = null) => {
    child.stdout.write(`${JSON.stringify({ protocol: 'deepseek-harness.native.v1', request_id: requestId,
      result: error === null ? { ready: true } : undefined, error: error === null ? null : { message: error } })}\n`)
  }
  return { sidecar, child, respond }
}

it('shares startup readiness and uses the native credential-scrubbed environment', async () => {
  vi.stubEnv('MODEL_API_KEY', 'fixture-only')
  vi.stubEnv('PRIVATE_PASSWORD', 'fixture-only')
  vi.stubEnv('DEEPSEEK_HARNESS_SESSION_TOKEN', 'fixture-only')
  vi.stubEnv('DSH_HOME', '/private-profile')
  vi.stubEnv('HARNESS_TEST_LOCALE', 'fixture-locale')
  const { sidecar, respond } = fixture()
  const first = sidecar.start()
  let secondReady = false
  const second = sidecar.start().then(() => { secondReady = true })
  try {
    await Promise.resolve()
    expect(secondReady).toBe(false)
    expect(spawning.spawn).toHaveBeenCalledOnce()
    const env = spawning.spawn.mock.calls[0]![2].env
    expect(env).toMatchObject({ DEEPSEEK_HARNESS_NATIVE_DATA_DIR: '/native-data', HARNESS_TEST_LOCALE: 'fixture-locale' })
    for (const name of ['MODEL_API_KEY', 'PRIVATE_PASSWORD', 'DEEPSEEK_HARNESS_SESSION_TOKEN', 'DSH_HOME']) expect(env[name]).toBeUndefined()
    respond()
    await Promise.all([first, second])
    expect(secondReady).toBe(true)
  } finally { await sidecar.stop() }
})

it('joins failed startup cleanup before allowing a fresh process', async () => {
  const { sidecar, child, respond } = fixture()
  const failure = expect(sidecar.start()).rejects.toThrow('Not ready')
  respond('Not ready')
  await failure
  expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  expect(sidecar['child']).toBeUndefined()
  expect(sidecar['starting']).toBeUndefined()
  await expect(sidecar.invoke('health')).rejects.toThrow('unavailable')
  const next = sidecar.start()
  respond()
  await next
  expect(spawning.spawn).toHaveBeenCalledTimes(2)
  await sidecar.stop()
})


it('contains stdin stream errors and rejects startup after joining the process', async () => {
  const { sidecar, child } = fixture()
  const failure = expect(sidecar.start()).rejects.toThrow('Broken pipe')
  child.stdin.destroy(new Error('Broken pipe'))
  await failure
  expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  expect(sidecar['pending'].size).toBe(0)
  expect(sidecar['child']).toBeUndefined()
})
