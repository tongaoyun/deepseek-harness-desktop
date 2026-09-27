// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ImChannelsPage } from './ImChannelsPage'
import { ChannelHistory } from './ChannelHistory'
import { configureLocalDingTalk, loadLocalImStatus, revokeLocalImPairing, retryLocalImDelivery, type LocalImStatus } from './localIm'

vi.mock('./localIm', () => ({ loadLocalImStatus: vi.fn(), configureLocalDingTalk: vi.fn(), revokeLocalImPairing: vi.fn(), allowLocalImPairing: vi.fn(), bindLocalImTask: vi.fn(), unbindLocalImTask: vi.fn(), retryLocalImDelivery: vi.fn(), removeLocalDingTalk: vi.fn(), setLocalImEnabled: vi.fn() }))
vi.mock('./DingTalkRegistration', () => ({ DingTalkRegistration: () => <div>扫码区域</div> }))
const status: LocalImStatus = { provider: 'DINGTALK', configured: true, enabled: false, connected: false, state: 'DISABLED', clientId: 'existing-app', secretConfigured: true, accessPolicy: 'pairing', notifyTaskResults: false, pendingPairings: [], pairedConversations: ['app:private:one'], conversations: [], pendingEventCount: 0 }
const props: ComponentProps<typeof ImChannelsPage> = { employeeId: 'one', teamId: 'team', litellmBaseUrl: '', knowledgeEndpoint: '', scheduleEndpoint: '', capabilitySnapshot: { schemaVersion: 2, createdAt: 'test', selections: [], artifacts: [], implicitArtifacts: [], localTools: [], requestedConnectorIds: [], connectors: [], requestedKnowledgeBaseRefs: [], knowledgeBaseRefs: [] }, model: '', modelApiKey: '', sessionToken: '', allowShell: false, allowLsp: false, allowExternalAgents: false, allowHooks: false, localTasks: [] }
let container: HTMLDivElement
let root: Root
const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === text)!
beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.mocked(loadLocalImStatus).mockResolvedValue(status)
  vi.mocked(configureLocalDingTalk).mockResolvedValue(status)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.useRealTimers() })
it('separates completed execution from failed delivery and retries sending only', async () => {
  const ready: LocalImStatus = { ...status, enabled: true, connected: true, state: 'READY', conversations: [{
    conversationKey: 'test:private:one', conversationType: 'private', conversationTitle: '验收', senderNick: '测试员工',
    lastMessage: '生成文件', lastResponse: '文件已生成', sessionId: 's', messageCount: 1, status: 'COMPLETED',
    deliveryStatus: 'FAILED', pendingDeliveryCount: 1, updatedAt: '', messages: [],
  }] }
  vi.mocked(loadLocalImStatus).mockResolvedValue(ready)
  vi.mocked(retryLocalImDelivery).mockResolvedValue({ ...ready, conversations: [{ ...ready.conversations[0], deliveryStatus: 'SENDING', pendingDeliveryCount: 0 }] })
  await act(async () => root.render(<ImChannelsPage {...props} />))
  expect(container.textContent).toContain('执行完成')
  expect(container.textContent).toContain('发送待处理')
  await act(async () => button('仅重试发送').click())
  expect(retryLocalImDelivery).toHaveBeenCalledExactlyOnceWith('test:private:one')
  expect(container.textContent).toContain('正在发送结果')
  expect(button('仅重试发送')).toBeUndefined()
})
it('retries a failed channel read and clears stale poll errors after recovery', async () => {
  vi.mocked(loadLocalImStatus).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(status)
  await act(async () => root.render(<ImChannelsPage {...props} />))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('offline')
  expect(container.querySelector<HTMLButtonElement>('.im-configure')?.disabled).toBe(true)
  await act(async () => button('重新读取频道').click())
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(container.textContent).toContain('配对管理')
  vi.mocked(loadLocalImStatus).mockRejectedValueOnce(new Error('poll failed'))
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('poll failed')
  await act(async () => button('重新读取频道').click())
  expect(container.querySelector('[role="alert"]')).toBeNull()
})
it('editing retains the same-app secret, pairing policy and disabled state', async () => {
  await act(async () => root.render(<ImChannelsPage {...props} />))
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="频道操作"]')!.click())
  await act(async () => button('编辑配置').click())
  await act(async () => button('手动配置').click())
  const secret = container.querySelector<HTMLInputElement>('input[type=password]')!
  expect(secret.required).toBe(false)
  expect(secret.placeholder).toBe('留空保留当前密钥')
  await act(async () => button('保存').click())
  expect(configureLocalDingTalk).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'existing-app', clientSecret: '', enabled: false, accessPolicy: 'pairing' }))
  expect(container.querySelector('[role=dialog]')).toBeNull()
})
it('shows paired sessions and keeps the parent dialog when confirmation is canceled by Escape', async () => {
  await act(async () => root.render(<ImChannelsPage {...props} />))
  await act(async () => button('配对管理').click())
  expect(container.textContent).not.toContain('暂无待配对请求或已配对会话')
  expect(container.textContent).toContain('已配对私聊')
  await act(async () => button('解除配对').click())
  expect(container.querySelectorAll('[role=dialog]')).toHaveLength(2)
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(container.querySelectorAll('[role=dialog]')).toHaveLength(1)
  expect(container.querySelector('#im-pairing-title')).not.toBeNull()
  expect(revokeLocalImPairing).not.toHaveBeenCalled()
})
it('matches manual setup labels and preserves the draft when returning to scan', async () => {
  await act(async () => root.render(<ImChannelsPage {...props} />))
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="频道操作"]')!.click())
  await act(async () => button('编辑配置').click())
  await act(async () => button('手动配置').click())
  expect(container.textContent).toContain('手动填写已有钉钉应用的 Client ID 和 Client Secret')
  expect(container.querySelector('label[for="im-client-id"]')?.textContent).toBe('Client ID（原 AppKey）')
  expect(container.querySelector<HTMLAnchorElement>('.im-field-heading a')?.href).toContain('open-dingtalk.github.io/developerpedia/')
  expect(container.querySelector<HTMLInputElement>('#im-client-id')?.placeholder).toBe('请输入 Client ID')
  expect(container.querySelector('.im-more-settings')?.hasAttribute('open')).toBe(false)
  const input = container.querySelector<HTMLInputElement>('#im-client-id')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'different-app')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(container.querySelector<HTMLInputElement>('#im-client-secret')?.required).toBe(true)
  await act(async () => button('返回扫码').click())
  expect(container.textContent).toContain('扫码区域')
  await act(async () => button('手动配置').click())
  expect(container.querySelector<HTMLInputElement>('#im-client-id')?.value).toBe('different-app')
  expect(configureLocalDingTalk).not.toHaveBeenCalled()
})
it('shows the screenshot empty state only after a successful empty load', async () => {
  const configure = vi.fn()
  await act(async () => root.render(<ChannelHistory onOpen={vi.fn()} onConfigure={configure} />))
  expect(container.textContent).toContain('还没有产生任何频道任务或对话')
  await act(async () => button('连接 IM 频道').click())
  expect(configure).toHaveBeenCalledOnce()
})
it('does not disguise channel read errors as an empty history', async () => {
  vi.mocked(loadLocalImStatus).mockRejectedValue(new Error('offline'))
  await act(async () => root.render(<ChannelHistory onOpen={vi.fn()} onConfigure={vi.fn()} />))
  expect(container.querySelector('[role=alert]')).not.toBeNull()
  expect(container.textContent).not.toContain('还没有产生')
})
it('opens the actual channel conversation selected in the sidebar', async () => {
  const open = vi.fn()
  vi.mocked(loadLocalImStatus).mockResolvedValue({ ...status, conversations: [{ conversationKey: 'app:group:work', conversationType: 'group', conversationTitle: '运营组', senderNick: '', lastMessage: '生成日报', lastResponse: '', sessionId: 'session', messageCount: 1, status: 'RUNNING', updatedAt: '', messages: [] }] })
  await act(async () => root.render(<ChannelHistory onOpen={open} onConfigure={vi.fn()} />))
  expect(container.textContent).toContain('运营组处理中')
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  expect(open).toHaveBeenCalledExactlyOnceWith('app:group:work')
})
