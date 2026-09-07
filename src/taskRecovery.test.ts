import { describe, expect, it, vi } from 'vitest'
import { createTaskMonitor, type HarnessRunInput } from './harness'
import { runHarnessWithRecovery } from './taskRecovery'

const request = { taskId: 'task', sessionId: 'old' } as HarnessRunInput

describe('runHarnessWithRecovery', () => {
  it('does not restart a turn stopped during recovery', async () => {
    let canceled = false
    const execute = vi.fn().mockRejectedValue(new Error('模型本轮没有返回可显示文本'))
    const onRetry = vi.fn()
    await expect(runHarnessWithRecovery(request, {
      getMonitor: createTaskMonitor, isCanceled: () => canceled, onRetry,
    }, { execute, reset: async () => { canceled = true }, sessionId: () => 'fresh' })).rejects.toThrow('本轮已停止')
    expect(execute).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })
  it('retries one transient pre-tool failure with a fresh session', async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error('模型本轮没有返回可显示文本'))
      .mockResolvedValueOnce({ sessionId: 'fresh', finalResponse: '完成' })
    const reset = vi.fn().mockResolvedValue(undefined)
    const onRetry = vi.fn()
    await expect(runHarnessWithRecovery(request, {
      getMonitor: createTaskMonitor,
      isCanceled: () => false,
      onRetry,
    }, { execute, reset, sessionId: () => 'fresh' })).resolves.toMatchObject({ finalResponse: '完成' })
    expect(reset).toHaveBeenCalledWith('task')
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'fresh' }))
    expect(onRetry).toHaveBeenCalledWith('fresh', expect.objectContaining({ code: 'XY-MODEL' }))
  })

  it('does not retry after a tool starts', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('模型本轮没有返回可显示文本'))
    const reset = vi.fn().mockResolvedValue(undefined)
    await expect(runHarnessWithRecovery(request, {
      getMonitor: () => ({ ...createTaskMonitor(), steps: [{
        id: 'tool', kind: 'tool', label: '运行命令', status: 'completed', startedAt: new Date().toISOString(),
      }] }),
      isCanceled: () => false,
      onRetry: vi.fn(),
    }, { execute, reset, sessionId: () => 'fresh' })).rejects.toThrow('模型本轮')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(reset).not.toHaveBeenCalled()
  })
})
