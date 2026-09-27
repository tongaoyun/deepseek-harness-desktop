import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createExpertKitDownload,
  loadBootstrap,
  resolveServerEndpoint,
  localScheduleNamespace,
  loadConnectors,
  loadExpertKits,
  loadSkills,
  loadKnowledgeSource,
  uploadKnowledgeDocument,
  submitAuditEvent,
  submitDeviceCapabilityReport,
  submitFeedback,
} from './api'

describe('loadBootstrap', () => {
  it('keeps local plans in their existing namespace without a bootstrap schedule endpoint', () => {
    expect(localScheduleNamespace()).toBe('http://192.168.2.67:30081/api/v1/schedules')
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  it('proxies development browser requests while preserving native endpoints and the schedule namespace', async () => {
    vi.stubEnv('DEV', true)
    vi.stubEnv('VITE_XIAOYIN_DEV_PROXY', 'true')
    vi.stubEnv('VITE_XIAOYIN_SERVER_URL', 'http://192.168.2.67:30081')
    vi.stubGlobal('window', { location: { origin: 'http://localhost:1421' } })
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(wire({ models: [] }))))
    vi.stubGlobal('fetch', fetchMock)
    await loadBootstrap('employee', 'session')
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:1421/api/v1/bootstrap')
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer session', 'X-Xiaoyin-Employee-Id': 'employee', 'X-Requested-With': 'XMLHttpRequest',
    })
    expect(resolveServerEndpoint('/api/v1/knowledge-bases')).toBe('http://192.168.2.67:30081/api/v1/knowledge-bases')
    expect(localScheduleNamespace()).toBe('http://192.168.2.67:30081/api/v1/schedules')
    vi.stubEnv('DEV', false)
    await loadBootstrap('employee', 'session')
    expect(fetchMock.mock.calls[1][0]).toBe('http://192.168.2.67:30081/api/v1/bootstrap')
  })

  it('rereads source identity with current account headers and explicit stale-source errors', async () => {
    const sourceId = '123e4567-e89b-12d3-a456-426614174000'
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(wire({ sourceId, content: 'current' }))))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const context = { endpoint: '/api/v1/knowledge-bases/', employeeId: 'employee', teamId: 'team', sessionToken: 'test-token' }
    await expect(loadKnowledgeSource(context, sourceId)).resolves.toMatchObject({ sourceId })
    expect(fetchMock.mock.calls[0][0]).toBe(`http://192.168.2.67:30081/api/v1/knowledge-bases/sources/${sourceId}`)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { 'X-Xiaoyin-Employee-Id': 'employee', 'X-Xiaoyin-Team-Id': 'team', Authorization: 'Bearer test-token' } })
    await expect(loadKnowledgeSource(context, sourceId)).rejects.toThrow('历史摘录不能作为当前依据')
    await expect(loadKnowledgeSource(context, '../files')).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('loads the memory-only model credential from the control plane', async () => {
    const payload = {
      protocolVersion: '1',
      employeeId: 'local-development',
      modelApiKey: 'test-model-key',
      endpoints: {
        litellm: 'http://litellm.local/v1',
        artifacts: '/api/v1/artifacts',
        expertKits: '/api/v1/expert-kits',
        skills: '/api/v1/skills',
        connectors: '/api/v1/connectors',
        knowledge: '/api/v1/knowledge-bases',
      },
      capabilities: ['chat'],
      models: [],
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(wire(payload)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(loadBootstrap('local-development')).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://192.168.2.67:30081/api/v1/bootstrap',
      expect.objectContaining({
        headers: { 'X-Xiaoyin-Employee-Id': 'local-development', 'X-Requested-With': 'XMLHttpRequest' },
      }),
    )
  })

  it('loads the expert kit catalog and requests an encoded download path', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wire([])), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wire({ id: 'kit one' })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    await loadExpertKits('/api/v1/expert-kits', 'employee-1', 'token-1')
    await createExpertKitDownload('/api/v1/expert-kits/', 'kit one', 'employee-1', 'token-1')

    expect(fetchMock.mock.calls[0][0]).toBe('http://192.168.2.67:30081/api/v1/expert-kits?page=1&size=100')
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      'X-Xiaoyin-Employee-Id': 'employee-1', 'X-Requested-With': 'XMLHttpRequest',
      Authorization: 'Bearer token-1',
    })
    expect(fetchMock.mock.calls[1][0]).toBe('http://192.168.2.67:30081/api/v1/expert-kits/kit%20one/artifacts')
  })

  it('loads skills and connectors through the shared enterprise catalog contract', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wire([])), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wire([])), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await loadSkills('/api/v1/skills', 'employee-1', 'token-1')
    await loadConnectors('/api/v1/connectors', 'employee-1', 'token-1')

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://192.168.2.67:30081/api/v1/skills?page=1&size=100',
      'http://192.168.2.67:30081/api/v1/connectors?page=1&size=100',
    ])
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      'X-Xiaoyin-Employee-Id': 'employee-1',
      Authorization: 'Bearer token-1',
    })
  })

  it('bounds extension authorization and knowledge document uploads', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wire({ id: 'kit', version: '1.0.0', sha256: 'a'.repeat(64), url: 'https://example.test/kit', expiresAt: '2099-01-01T00:00:00Z' })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wire({ id: 'doc', name: 'notes.txt', status: 'INDEXED' })), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await createExpertKitDownload('/api/v1/expert-kits', 'kit', 'employee-1', 'token-1')
    await uploadKnowledgeDocument('/api/v1/knowledge-bases', 'employee-1', 'team-1', 'token-1', 'kb-1', new File(['notes'], 'notes.txt'))

    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(fetchMock.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('submits redacted audit events without exposing a desktop audit feed', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wire({ id: 'audit-1' })), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    await submitAuditEvent('/api/v1/audit-events', 'employee-1', 'token-1', {
      source: 'DESKTOP', category: 'TOOL', action: 'local_file_read', outcome: 'SUCCEEDED',
      resourceType: 'desktop-task', resourceId: 'task-1', summary: '读取完成',
    })

    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/audit-events')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('arguments')
  })

  it('submits the current device capability snapshot', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await submitDeviceCapabilityReport('/api/v1/device-capabilities', 'employee-1', 'token-1', {
      deviceId: '00000000-0000-4000-8000-000000000001', desktopVersion: '0.1.0',
      platform: 'macos', architecture: 'aarch64', displayCount: 1, displayScalePercents: [200],
      capabilities: [{ key: 'harness', status: 'READY', detail: '本地 Agent 已就绪' }],
    })

    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/device-capabilities')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).capabilities).toEqual([
      { key: 'harness', status: 'READY', detail: '本地 Agent 已就绪' },
    ])
  })

  it('submits feedback with reproducible desktop context', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(wire({ id: 'feedback-1' })), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await submitFeedback('employee-1', 'token-1', '任务运行失败', {
      category: 'BUG', desktopVersion: '0.1.0', deviceId: 'device-1', taskId: 'task-1',
    }, [new File(['image'], 'shot.png', { type: 'image/png' })])

    const body = fetchMock.mock.calls[0][1].body as FormData
    expect(body.getAll('images')).toHaveLength(1)
    expect(JSON.parse(await (body.get('feedback') as Blob).text())).toEqual({
      message: '任务运行失败', category: 'BUG', desktopVersion: '0.1.0', deviceId: 'device-1', taskId: 'task-1',
    })
  })

  it('does not report success without a ticket and explains upload failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(wire({})))).mockResolvedValueOnce(new Response(null, { status: 413 })))
    await expect(submitFeedback('employee', 'token', '问题', { category: 'BUG' })).rejects.toThrow('反馈编号')
    await expect(submitFeedback('employee', 'token', '问题', { category: 'BUG' })).rejects.toThrow('上传限制')
  })

})

function wire(data: unknown) {
  return Array.isArray(data)
    ? { success: true, data, totalCount: data.length, pageSize: 20, pageIndex: 1, totalPages: data.length ? 1 : 0 }
    : { success: true, data }
}
