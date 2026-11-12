/** Management diagnostics survive file-write failures without rejecting completed operations. */
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished, vi } from 'vitest'
import { makeLog } from '../src/log.ts'
import { logPath } from '../src/core.ts'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, appendFile: vi.fn(actual.appendFile) }
})

it.each([false, true])('retains a failed-write diagnostic and permits later logging with console unavailable=%s', async (unavailable) => {
  const home = await mkdtemp(join(tmpdir(), 'harness-skill-log-'))
  onTestFinished(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })
  vi.stubEnv('DSH_HOME', home)
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {
    if (unavailable) throw new Error('Console unavailable')
  })
  const error = Object.assign(new Error('Log file locked'), { code: 'EACCES' })
  vi.mocked(appendFile).mockRejectedValueOnce(error)
  const write = makeLog()

  await expect(write('restore', '已恢复 audit-orders')).resolves.toBeUndefined()

  expect(warning).toHaveBeenCalledWith('技能管理日志写入失败', {
    event: 'restore', detail: '已恢复 audit-orders', error: 'Error: Log file locked',
  })
  expect(warning.mock.calls).toMatchInlineSnapshot(`
    [
      [
        "技能管理日志写入失败",
        {
          "detail": "已恢复 audit-orders",
          "error": "Error: Log file locked",
          "event": "restore",
        },
      ],
    ]
  `)
  await expect(write('restore', '已恢复 second-skill')).resolves.toBeUndefined()
  const entries = (await readFile(logPath(), 'utf8')).trim().split('\n').map((line): unknown => JSON.parse(line))
  expect(entries).toEqual([expect.objectContaining({ event: 'restore', detail: '已恢复 second-skill' })])
})
