// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionPreviewPanel, type ExtensionPreviewConfig } from './ExtensionPreviewPanel'
import { runHarness } from './harness'
import type { TaskOutcome } from './taskOutcome'

vi.mock('./harness', async (original) => ({ ...await original<object>(), runHarness: vi.fn(), cancelHarness: vi.fn(async () => true), listenHarnessNotifications: vi.fn(async () => () => {}) }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => vi.resetAllMocks())

async function fixture(check: (container: HTMLDivElement, report: ReturnType<typeof vi.fn>) => Promise<void>) {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const report = vi.fn()
  const config: ExtensionPreviewConfig = {
    employeeId: 'fixture', teamId: 'team', litellmBaseUrl: 'http://localhost', knowledgeEndpoint: '', scheduleEndpoint: '', connectors: [],
    model: 'fixture', modelApiKey: '', accessToken: '', localFileRootIds: [], toolsMode: 'native',
    allowShell: false, allowLsp: false, allowExternalAgents: false, allowHooks: false,
  }
  try {
    await act(async () => root.render(<ExtensionPreviewPanel target={{ kind: 'skill', id: 'fixture', version: '1.0.0', sha256: 'a'.repeat(64), knowledgeBaseRefs: [], allowLocalFiles: false }} config={config} onRunningChange={() => {}} onReport={report} />))
    await check(container, report)
  } finally { await act(async () => root.unmount()); container.remove() }
}

it.each(['completed', 'needs_input', undefined] as const)('reports a preview as passed only for a completed goal: %s', async (status) => {
  const outcome: TaskOutcome | undefined = status ? { status, summary: '试运行结果', remaining: status === 'completed' ? [] : ['补充资料'], checks: [] } : undefined
  vi.mocked(runHarness).mockResolvedValue({ sessionId: 'fixture', finalResponse: '试运行回复', outcome })
  await fixture(async (container, report) => {
    await act(async () => container.querySelector<HTMLButtonElement>('.extension-preview-input button')!.click())
    expect(runHarness).toHaveBeenCalledWith(expect.objectContaining({ capabilitySnapshot: expect.objectContaining({ selections: [{
      mode: 'explicit', kind: 'skill', extensionId: 'fixture', extensionVersion: '1.0.0', skillId: 'fixture',
    }] }), toolsMode: 'native', allowShell: false, allowLsp: false, allowExternalAgents: false, allowHooks: false }))
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ status: status === 'completed' ? 'PASSED' : 'FAILED' }))
    expect(container.querySelector('.extension-preview-response')?.textContent).toContain('试运行回复')
    expect(container.querySelector('header em')?.textContent).toBe(status === 'completed' ? '已完成' : status === 'needs_input' ? '等待补充' : '本轮已结束')
  })
})

it('does not publish a late completed report after stop', async () => {
  let finish!: (result: Awaited<ReturnType<typeof runHarness>>) => void
  vi.mocked(runHarness).mockReturnValue(new Promise((resolve) => { finish = resolve }))
  await fixture(async (container, report) => {
    await act(async () => container.querySelector<HTMLButtonElement>('.extension-preview-input button')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('button.cancel')!.click())
    await act(async () => finish({ sessionId: 'fixture', finalResponse: '完成', outcome: { status: 'completed', summary: '完成', remaining: [], checks: [] } }))
    expect(report).not.toHaveBeenCalled()
    expect(container.querySelector('header em')?.textContent).toBe('已取消')
  })
})
