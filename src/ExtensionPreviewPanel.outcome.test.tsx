// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionPreviewPanel, type ExtensionPreviewConfig } from './ExtensionPreviewPanel'
import { runHarness } from './harness'

vi.mock('./harness', async (original) => ({ ...await original<object>(), runHarness: vi.fn(), cancelHarness: vi.fn(async () => true), listenHarnessNotifications: vi.fn(async () => () => {}) }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => vi.resetAllMocks())

async function fixture(check: (container: HTMLDivElement, report: ReturnType<typeof vi.fn>) => Promise<void>) {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const report = vi.fn()
  const config: ExtensionPreviewConfig = {
    employeeId: 'fixture', teamId: 'team', litellmBaseUrl: 'http://localhost', knowledgeEndpoint: '', scheduleEndpoint: '', connectors: [],
    model: 'fixture', modelApiKey: '', accessToken: '', localFileRootIds: [],
    allowShell: false, allowLsp: false, allowExternalAgents: false, allowHooks: false,
  }
  try {
    await act(async () => root.render(<ExtensionPreviewPanel target={{ kind: 'skill', id: 'fixture', version: '1.0.0', sha256: 'a'.repeat(64), knowledgeBaseRefs: [], allowLocalFiles: false }} config={config} onRunningChange={() => {}} onReport={report} />))
    await check(container, report)
  } finally { await act(async () => root.unmount()); container.remove() }
}

it('reports a preview as passed after the official turn completes', async () => {
  vi.mocked(runHarness).mockResolvedValue({ sessionId: 'fixture', finalResponse: '试运行回复' })
  await fixture(async (container, report) => {
    await act(async () => container.querySelector<HTMLButtonElement>('.extension-preview-input button')!.click())
    expect(runHarness).toHaveBeenCalledWith(expect.objectContaining({ capabilitySnapshot: expect.objectContaining({ selections: [{
      mode: 'explicit', kind: 'skill', extensionId: 'fixture', extensionVersion: '1.0.0', skillId: 'fixture',
    }] }), allowShell: false, allowLsp: false, allowExternalAgents: false, allowHooks: false }))
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ status: 'PASSED' }))
    expect(container.querySelector('.extension-preview-response')?.textContent).toContain('试运行回复')
    expect(container.querySelector('header em')?.textContent).toBe('本轮已结束')
  })
})

it('does not publish a late completed report after stop', async () => {
  let finish!: (result: Awaited<ReturnType<typeof runHarness>>) => void
  vi.mocked(runHarness).mockReturnValue(new Promise((resolve) => { finish = resolve }))
  await fixture(async (container, report) => {
    await act(async () => container.querySelector<HTMLButtonElement>('.extension-preview-input button')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('button.cancel')!.click())
    await act(async () => finish({ sessionId: 'fixture', finalResponse: '完成' }))
    expect(report).not.toHaveBeenCalled()
    expect(container.querySelector('header em')?.textContent).toBe('已取消')
  })
})
