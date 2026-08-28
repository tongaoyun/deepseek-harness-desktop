import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createExpertKitDownload,
  createTaskRunArtifactDownload,
  loadBootstrap,
  loadConnectors,
  loadExpertKits,
  loadSkills,
  loadCloudTaskRuns,
} from './api'

describe('loadBootstrap', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads non-secret desktop configuration from the control plane', async () => {
    const payload = {
      protocolVersion: '1',
      employeeId: 'local-development',
      endpoints: {
        litellm: 'http://litellm.local/v1',
        erpMcp: 'http://erp.local/mcp',
        artifacts: '/api/v1/artifacts',
        expertKits: '/api/v1/expert-kits',
        skills: '/api/v1/skills',
        connectors: '/api/v1/connectors',
        schedules: '/api/v1/schedules',
        taskRuns: '/api/v1/task-runs',
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

})
