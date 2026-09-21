import {
  classifyHarnessFailure,
  createHarnessFailure,
  runHarness,
  shouldRetryHarnessFailure,
  shutdownHarness,
  type HarnessFailure,
  type HarnessRunInput,
  type HarnessRunResult,
} from './harness'
import type { XiaoyinTaskProjection } from './types'

interface RecoveryCallbacks {
  getProjection: () => XiaoyinTaskProjection
  isCanceled: () => boolean
  onRetry: (sessionId: string, failure: HarnessFailure) => void
}

interface RecoveryRuntime {
  execute: (input: HarnessRunInput) => Promise<HarnessRunResult>
  reset: (taskId: string) => Promise<void>
  sessionId: () => string
}

const defaultRuntime: RecoveryRuntime = {
  execute: runHarness,
  reset: async (taskId) => { await shutdownHarness(taskId) },
  sessionId: () => `session-${crypto.randomUUID().replaceAll('-', '')}`,
}

export async function runHarnessWithRecovery(
  request: HarnessRunInput,
  callbacks: RecoveryCallbacks,
  runtime: RecoveryRuntime = defaultRuntime,
): Promise<HarnessRunResult> {
  try {
    return await runtime.execute(request)
  } catch (reason) {
    const failure = classifyHarnessFailure(reason)
    if (callbacks.isCanceled() || !shouldRetryHarnessFailure(failure, callbacks.getProjection())) throw reason
    await runtime.reset(request.taskId)
    if (callbacks.isCanceled()) throw createHarnessFailure({ code: 'XY-CANCELED', category: 'unknown', title: '任务已停止', message: '本轮已停止', infrastructure: false, retryable: false })
    const sessionId = runtime.sessionId()
    callbacks.onRetry(sessionId, failure)
    return runtime.execute({ ...request, sessionId })
  }
}
