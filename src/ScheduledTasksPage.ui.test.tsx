// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScheduledTasksPage } from './ScheduledTasksPage'

vi.mock('./api', () => ({
  changeScheduledTask: vi.fn(),
  createScheduledTask: vi.fn(),
  deleteScheduledTask: vi.fn(),
  loadScheduledTaskExecutions: vi.fn().mockResolvedValue([]),
  loadScheduledTasks: vi.fn().mockResolvedValue([]),
}))

describe('scheduled task user flow', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div')
    document.body.append(container)
  })

  afterEach(() => container.remove())

  it('selects a preset and previews upcoming executions', async () => {
    const root = createRoot(container)
    await act(async () => {
      root.render(<ScheduledTasksPage
        accessToken="token"
        employeeId="employee-1"
        endpoint="/api/v1/schedules"
        expertKits={[{
          id: 'operations', name: '运营专家', version: '1.0.0', summary: '', category: 'ecommerce-retail', minimumDesktopVersion: '0.1.0',
          commandIds: [], skillIds: [], requiredTools: [], connectorRefs: [], knowledgeBaseRefs: [],
          permissions: { localFiles: 'deny', shell: 'deny', computerUse: 'deny', connectorRead: 'allow', connectorWrite: 'deny' },
          sha256: 'fixture', connectorIssues: [], knowledgeIssues: [], installState: 'installed', readiness: 'ready', localOnly: false,
          serverWorkflows: [{ id: 'daily', name: '日报', workflowType: 'StoreDailyReportWorkflow', version: '1', inputs: [], steps: [] }],
        }]}
      />)
      await Promise.resolve()
    })
    const create = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '新建定时任务')!
    await act(async () => create.click())
    const preset = container.querySelector<HTMLSelectElement>('select[aria-label="计划频率"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(preset, '0 18 * * *')
      preset.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(preset.value).toBe('0 18 * * *')
    expect(container.querySelector('.cron-hint')?.textContent).toContain('接下来：')

    const natural = container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(natural, '每个工作日下午 6:30 生成日报')
      natural.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const parse = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '识别时间')!
    await act(async () => parse.click())
    expect(preset.value).toBe('30 18 * * 1-5')
    expect(container.querySelector('.schedule-parse-result')?.textContent).toContain('18:30')
    await act(async () => root.unmount())
  })
})
