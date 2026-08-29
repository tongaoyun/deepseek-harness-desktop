import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  isTauri: () => true,
}))

describe('local IM native bridge', () => {
  beforeEach(() => invoke.mockReset())

  it('passes DingTalk credentials only to the native configure command', async () => {
    invoke.mockResolvedValue({ configured: true })
    const { configureLocalDingTalk } = await import('./localIm')
    await configureLocalDingTalk({
      clientId: 'ding-app',
      clientSecret: 'secret-value',
      enabled: true,
      accessPolicy: 'pairing',
      harness: {
        employeeId: 'employee-1',
        teamId: '跨境运营',
        litellmBaseUrl: 'http://litellm/v1', knowledgeEndpoint: 'http://control-plane/api/v1/knowledge-bases', connectors: [], allowedArtifacts: [],
        model: 'deepseek-v4-flash', modelApiKey: 'model-token', accessToken: 'employee-token',
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
      litellmBaseUrl: 'http://litellm/v1', knowledgeEndpoint: 'http://control-plane/api/v1/knowledge-bases', connectors: [], allowedArtifacts: [],
      model: 'deepseek-v4-flash', modelApiKey: 'model-token', accessToken: 'employee-token',
    })
    expect(invoke).toHaveBeenCalledWith('start_local_im', {
      harness: expect.not.objectContaining({ clientSecret: expect.anything() }),
    })
  })
})
