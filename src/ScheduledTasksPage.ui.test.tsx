// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScheduledTask, loadScheduledTasks, updateScheduledTask } from './api'
import { ScheduledTasksPage } from './ScheduledTasksPage'

vi.mock('./api', () => ({
  changeScheduledTask: vi.fn(),
  createScheduledTask: vi.fn(),
  createTaskRunArtifactDownload: vi.fn(),
  deleteScheduledTask: vi.fn(),
  loadScheduledTaskExecutions: vi.fn().mockResolvedValue([]),
  loadScheduledTasks: vi.fn().mockResolvedValue([]),
  updateScheduledTask: vi.fn(),
}))

describe('scheduled task user flow', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div')
    document.body.append(container)
  })

  afterEach(() => container.remove())

  it('routes AI creation into a new Xiaoyin conversation', async () => {
    const onCreateWithXiaoyin = vi.fn()
    const root = createRoot(container)
    await act(async () => {
      root.render(<ScheduledTasksPage
        accessToken="token"
        employeeId="employee-1"
        endpoint="/api/v1/schedules"
        onCreateWithXiaoyin={onCreateWithXiaoyin}
      />)
      await Promise.resolve()
    })

    const createWithAI = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '通过小胤创建')!
    await act(async () => createWithAI.click())

    expect(onCreateWithXiaoyin).toHaveBeenCalledOnce()
    expect(container.querySelector('.schedule-modal')).toBeNull()
    await act(async () => root.unmount())
  })

  it('selects a preset and previews upcoming executions', async () => {
    const root = createRoot(container)
    await act(async () => {
      root.render(<ScheduledTasksPage
        accessToken="token"
        employeeId="employee-1"
        endpoint="/api/v1/schedules"
        onCreateWithXiaoyin={() => undefined}
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

  it('creates a generic agent schedule without selecting an expert kit', async () => {
    vi.mocked(createScheduledTask).mockResolvedValue({
      id: 'schedule-1', name: '竞品追踪',
      expertKitId: 'xiaoyin-agent', expertKitVersion: '1', workflowId: 'agent-prompt',
      workflowType: 'AgentPromptWorkflow', workflowVersion: '1', cronExpression: '0 9 * * 1-5',
      timeZone: 'Asia/Shanghai', inputs: { prompt: '整理竞品动态' }, status: 'ACTIVE',
      createdAt: '2026-09-03T00:00:00Z', updatedAt: '2026-09-03T00:00:00Z',
    })
    const root = createRoot(container)
    await act(async () => {
      root.render(<ScheduledTasksPage accessToken="token" employeeId="employee-1"
        endpoint="/api/v1/schedules" onCreateWithXiaoyin={() => undefined} />)
      await Promise.resolve()
    })
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '新建定时任务')!.click())
    const name = container.querySelector<HTMLInputElement>('input[placeholder="描述你的任务"]')!
    const prompt = container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      setValue(name, '竞品追踪')
      setValue(prompt, '整理竞品动态')
    })
    await act(async () => container.querySelector<HTMLFormElement>('form.schedule-modal')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))

    expect(createScheduledTask).toHaveBeenCalledWith('/api/v1/schedules', 'employee-1', 'token', expect.objectContaining({
      name: '竞品追踪', expertKitId: 'xiaoyin-agent', workflowId: 'agent-prompt',
      inputs: { prompt: '整理竞品动态' },
    }))
    await act(async () => root.unmount())
  })

  it('edits an existing schedule in place', async () => {
    const task = {
      id: 'schedule-1', name: '竞品追踪',
      expertKitId: 'xiaoyin-agent', expertKitVersion: '1', workflowId: 'agent-prompt',
      workflowType: 'AgentPromptWorkflow', workflowVersion: '1', cronExpression: '0 9 * * 1-5',
      timeZone: 'Asia/Shanghai', inputs: { prompt: '整理竞品动态' }, status: 'PAUSED' as const,
      createdAt: '2026-09-03T00:00:00Z', updatedAt: '2026-09-03T00:00:00Z',
    }
    vi.mocked(loadScheduledTasks).mockResolvedValue([task])
    vi.mocked(updateScheduledTask).mockResolvedValue({ ...task, name: '午间竞品追踪', cronExpression: '0 12 * * 1-5' })
    const root = createRoot(container)
    await act(async () => {
      root.render(<ScheduledTasksPage accessToken="token" employeeId="employee-1"
        endpoint="/api/v1/schedules" onCreateWithXiaoyin={() => undefined} />)
      await Promise.resolve()
    })
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="任务操作"]')!.click())
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '编辑任务')!.click())
    expect(container.querySelector('.schedule-modal h2')?.textContent).toBe('编辑定时任务')
    const name = container.querySelector<HTMLInputElement>('input[placeholder="描述你的任务"]')!
    await act(async () => setValue(name, '午间竞品追踪'))
    await act(async () => container.querySelector<HTMLFormElement>('form.schedule-modal')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))

    expect(updateScheduledTask).toHaveBeenCalledWith('/api/v1/schedules', 'employee-1', 'token', 'schedule-1',
      expect.objectContaining({ name: '午间竞品追踪', inputs: { prompt: '整理竞品动态' } }))
    expect(container.textContent).toContain('午间竞品追踪')
    await act(async () => root.unmount())
  })
})

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}
