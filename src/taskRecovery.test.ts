import { describe, expect, it, vi } from 'vitest'
import { createXiaoyinTaskProjection, type HarnessRunInput } from './harness'
import { runHarnessWithRecovery } from './taskRecovery'

const request = { taskId: 'task', sessionId: 'old' } as HarnessRunInput

describe('runHarnessWithRecovery', () => {
  it('does not restart a turn stopped during recovery', async () => {
    let canceled = false
    const execute = vi.fn().mockRejectedValue({ code: 'XY-CANCELED', category: 'unknown', title: '任务已停止', message: '本轮已停止', infrastructure: false, retryable: false })
    const onRetry = vi.fn()
    await expect(runHarnessWithRecovery(request, {
      getProjection: createXiaoyinTaskProjection, isCanceled: () => canceled, onRetry,
    }, { execute, reset: async () => { canceled = true }, sessionId: () => 'fresh' })).rejects.toThrow('本轮已停止')
    expect(execute).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })
  it('retries one transient pre-tool failure with a fresh session', async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce({ code: 'XY-MODEL', category: 'model', title: '模型未能完成任务', message: '模型未返回结果', infrastructure: false, retryable: true })
      .mockResolvedValueOnce({ sessionId: 'fresh', finalResponse: '完成' })
    const reset = vi.fn().mockResolvedValue(undefined)
    const onRetry = vi.fn()
    await expect(runHarnessWithRecovery(request, {
      getProjection: createXiaoyinTaskProjection,
      isCanceled: () => false,
      onRetry,
    }, { execute, reset, sessionId: () => 'fresh' })).resolves.toMatchObject({ finalResponse: '完成' })
    expect(reset).toHaveBeenCalledWith('task')
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'fresh' }))
    expect(onRetry).toHaveBeenCalledWith('fresh', expect.objectContaining({ code: 'XY-MODEL' }))
  })

  it('does not retry after a tool starts', async () => {
    const execute = vi.fn().mockRejectedValue({ code: 'XY-MODEL', category: 'model', title: '模型未能完成任务', message: '模型未返回结果', infrastructure: false, retryable: true })
    const reset = vi.fn().mockResolvedValue(undefined)
    await expect(runHarnessWithRecovery(request, {
      getProjection: () => ({ ...createXiaoyinTaskProjection(), steps: [{
        id: 'tool', kind: 'tool', label: '运行命令', status: 'completed', startedAt: new Date().toISOString(),
      }] }),
      isCanceled: () => false,
      onRetry: vi.fn(),
    }, { execute, reset, sessionId: () => 'fresh' })).rejects.toMatchObject({ code: 'XY-MODEL', retryable: true })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(reset).not.toHaveBeenCalled()
  })

  it('does not restart a transient failure when cancellation arrives during recovery', async () => {
    let canceled = false
    const execute = vi.fn().mockRejectedValue({ code: 'XY-MODEL', category: 'model', title: '模型未能完成任务', message: '模型服务暂时无响应', infrastructure: false, retryable: true })
    const onRetry = vi.fn()
    const reset = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      canceled = true
    })
    await expect(runHarnessWithRecovery(request, {
      getProjection: createXiaoyinTaskProjection,
      isCanceled: () => canceled,
      onRetry,
    }, { execute, reset, sessionId: () => 'fresh' })).rejects.toMatchObject({ code: 'XY-CANCELED', retryable: false })
    expect(execute).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })
})
