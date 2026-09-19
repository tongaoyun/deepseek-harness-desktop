import { beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runHarness, type HarnessRunInput } from './harness'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }))

beforeEach(() => vi.mocked(invoke).mockReset())

it('passes only the Rust attachment wire fields while preserving local authorization metadata', async () => {
  vi.mocked(invoke).mockResolvedValue({ sessionId: 'session', finalResponse: 'done' })
  const attachment: HarnessRunInput['attachments'][number] = {
    id: 'root:report.xlsx', rootId: 'root', rootName: '资料', rootPath: '/authorized',
    path: 'report.xlsx', name: 'report.xlsx', kind: 'file',
  }
  const request = { attachments: [attachment] } as HarnessRunInput

  await runHarness(request)

  expect(invoke).toHaveBeenCalledWith('run_harness', { request: {
    attachments: [{ id: 'root:report.xlsx', rootId: 'root', rootName: '资料', path: 'report.xlsx', name: 'report.xlsx', kind: 'file' }],
  } })
  expect(attachment.rootPath).toBe('/authorized')
})
