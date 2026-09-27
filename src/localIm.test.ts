import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  isTauri: () => true,
}))

describe('local IM native bridge', () => {
  beforeEach(() => invoke.mockReset())

  it('retries only delivery for the selected native conversation', async () => {
    invoke.mockResolvedValue({ configured: true })
    const { retryLocalImDelivery } = await import('./localIm')
    await retryLocalImDelivery('app:private:one')
    expect(invoke).toHaveBeenCalledWith('retry_local_im_delivery', { conversationKey: 'app:private:one' })
  })

  it('passes DingTalk credentials only to the native configure command', async () => {
    invoke.mockResolvedValue({ configured: true })
    const { configureLocalDingTalk } = await import('./localIm')
    await configureLocalDingTalk({
      clientId: 'ding-app',
      clientSecret: 'secret-value',
      enabled: true,
      accessPolicy: 'pairing',
      notifyTaskResults: true,
      harness: {
        employeeId: 'employee-1',
        teamId: '跨境运营',
        litellmBaseUrl: 'http://litellm/v1', knowledgeEndpoint: 'http://xiaoyin-server/api/v1/knowledge-bases', scheduleEndpoint: 'http://xiaoyin-server/api/v1/schedules',
        capabilitySnapshot: { schemaVersion: 2, createdAt: 'test', selections: [], artifacts: [], implicitArtifacts: [], localTools: [], requestedConnectorIds: [], connectors: [], requestedKnowledgeBaseRefs: [], knowledgeBaseRefs: [] },
        model: 'deepseek-v4-flash', modelApiKey: 'model-token', accessToken: 'employee-token',
        allowShell: false, allowLsp: false, allowExternalAgents: false, allowHooks: false,
      },
    })
    expect(invoke).toHaveBeenCalledWith('configure_local_dingtalk', {
      request: expect.objectContaining({ clientId: 'ding-app', clientSecret: 'secret-value' }),
    })
  })

  it('starts a persisted local channel without asking the UI for its secret', async () => {
    invoke.mockResolvedValue({ configured: true })
    const { startLocalIm } = await import('./localIm')
    await startLocalIm({
      employeeId: 'employee-1',
      teamId: '跨境运营',
      litellmBaseUrl: 'http://litellm/v1', knowledgeEndpoint: 'http://xiaoyin-server/api/v1/knowledge-bases', scheduleEndpoint: 'http://xiaoyin-server/api/v1/schedules',
      capabilitySnapshot: { schemaVersion: 2, createdAt: 'test', selections: [], artifacts: [], implicitArtifacts: [], localTools: [], requestedConnectorIds: [], connectors: [], requestedKnowledgeBaseRefs: [], knowledgeBaseRefs: [] },
      model: 'deepseek-v4-flash', modelApiKey: 'model-token', accessToken: 'employee-token',
      allowShell: false, allowLsp: false, allowExternalAgents: false, allowHooks: false,
    })
    expect(invoke).toHaveBeenCalledWith('start_local_im', {
      harness: expect.not.objectContaining({ clientSecret: expect.anything() }),
    })
  })

  it('stops the previous channel before starting another employee', async () => {
    let finishFirst!: (value: unknown) => void
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve }))
      .mockResolvedValue({ enabled: true })
    const { startLocalIm, stopLocalImRuntime } = await import('./localIm')
    const first = startLocalIm({ employeeId: 'one' } as Parameters<typeof startLocalIm>[0])
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    const stop = stopLocalImRuntime()
    const second = startLocalIm({ employeeId: 'two' } as Parameters<typeof startLocalIm>[0])
    expect(invoke).toHaveBeenCalledTimes(1)
    finishFirst({ enabled: true })
    await Promise.all([first, stop, second])
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'start_local_im', 'stop_local_im_runtime', 'start_local_im',
    ])
  })
})
