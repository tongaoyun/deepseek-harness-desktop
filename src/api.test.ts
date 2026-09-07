import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelScheduledTaskExecution,
  createExpertKitDownload,
  createTaskRunArtifactDownload,
  loadBootstrap,
  loadConnectors,
  loadExpertKits,
  loadSkills,
  loadKnowledgeSource,
  loadCloudTaskRuns,
  submitAuditEvent,
  submitDeviceCapabilityReport,
  submitFeedback,
} from './api'

describe('loadBootstrap', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rereads source identity with current account headers and explicit stale-source errors', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ sourceId: '12', content: 'current' })))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const context = { endpoint: '/api/v1/knowledge-bases/', employeeId: 'employee', teamId: 'team', accessToken: 'test-token' }
    await expect(loadKnowledgeSource(context, '12')).resolves.toMatchObject({ sourceId: '12' })
    expect(fetchMock.mock.calls[0][0]).toBe('http://192.168.2.67:30081/api/v1/knowledge-bases/sources/12')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { 'X-Xiaoyin-Employee-Id': 'employee', 'X-Xiaoyin-Team-Id': 'team', Authorization: 'Bearer test-token' } })
    await expect(loadKnowledgeSource(context, '12')).rejects.toThrow('历史摘录不能作为当前依据')
    await expect(loadKnowledgeSource(context, '../files')).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('submits cancellation for one encoded execution and propagates server failure', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    await cancelScheduledTaskExecution('/api/v1/schedules/', 'employee-1', 'token', 'plan one', 'run/one')
    expect(fetchMock.mock.calls[0][0]).toBe('http://192.168.2.67:30081/api/v1/schedules/plan%20one/executions/run%2Fone/cancel')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { 'X-Xiaoyin-Employee-Id': 'employee-1', Authorization: 'Bearer token' } })
    await expect(cancelScheduledTaskExecution('/api/v1/schedules', 'employee-1', 'token', 'one', 'run')).rejects.toThrow('503')
  })

  it('loads the memory-only model credential from the control plane', async () => {
    const payload = {
      protocolVersion: '1',
      employeeId: 'local-development',
      modelApiKey: 'test-model-key',
      endpoints: {
        litellm: 'http://litellm.local/v1',
        erpMcp: 'http://erp.local/mcp',
        artifacts: '/api/v1/artifacts',
        expertKits: '/api/v1/expert-kits',
        skills: '/api/v1/skills',
        connectors: '/api/v1/connectors',
        schedules: '/api/v1/schedules',
        taskRuns: '/api/v1/task-runs',
        knowledge: '/api/v1/knowledge-bases',
      },
      capabilities: ['chat'],
      models: [],
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(loadBootstrap('local-development')).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://192.168.2.67:30081/api/v1/bootstrap',
      expect.objectContaining({
        headers: { 'X-Xiaoyin-Employee-Id': 'local-development' },
      }),
    )
  })

  it('loads the expert kit catalog and requests an encoded download path', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'kit one' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    await loadExpertKits('/api/v1/expert-kits', 'employee-1', 'token-1')
    await createExpertKitDownload('/api/v1/expert-kits/', 'kit one', 'employee-1', 'token-1')

    expect(fetchMock.mock.calls[0][0]).toBe('http://192.168.2.67:30081/api/v1/expert-kits')
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      'X-Xiaoyin-Employee-Id': 'employee-1',
      Authorization: 'Bearer token-1',
    })
    expect(fetchMock.mock.calls[1][0]).toBe('http://192.168.2.67:30081/api/v1/expert-kits/kit%20one/download')
  })

  it('loads skills and connectors through the shared enterprise catalog contract', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await loadSkills('/api/v1/skills', 'employee-1', 'token-1')
    await loadConnectors('/api/v1/connectors', 'employee-1', 'token-1')

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://192.168.2.67:30081/api/v1/skills',
      'http://192.168.2.67:30081/api/v1/connectors',
    ])
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      'X-Xiaoyin-Employee-Id': 'employee-1',
      Authorization: 'Bearer token-1',
    })
  })

  it('loads task runs and requests an employee-scoped artifact by run id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ objectKey: 'workflows/result.json' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    await loadCloudTaskRuns('/api/v1/task-runs', 'employee-1', 'token-1')
    await createTaskRunArtifactDownload('/api/v1/task-runs', 'employee-1', 'token-1', 'run one')

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://192.168.2.67:30081/api/v1/task-runs',
      'http://192.168.2.67:30081/api/v1/task-runs/run%20one/artifact',
    ])
  })

  it('submits redacted audit events without exposing a desktop audit feed', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'audit-1' }), {
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
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'feedback-1' }), { status: 201 }))
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(new Response(null, { status: 413 })))
    await expect(submitFeedback('employee', 'token', '问题', { category: 'BUG' })).rejects.toThrow('反馈编号')
    await expect(submitFeedback('employee', 'token', '问题', { category: 'BUG' })).rejects.toThrow('上传限制')
  })

})
