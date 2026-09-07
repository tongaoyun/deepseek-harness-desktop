import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { access, writeFile } from 'node:fs/promises'
import { MacComputerUseBridge } from './mac-computer-use.js'

it('passes macOS actions as data and attaches a fresh observation', async () => {
  const requests: Record<string, string | number>[] = []
  const ctx = { attachments: { async saveImage() { return { attachmentId: 'screen' } } } } as unknown as Context
  const bridge = new MacComputerUseBridge(ctx, async (request) => {
    requests.push(request)
    await writeFile(String(request.screenshot), 'test image')
    return JSON.stringify({ screen: { width: 1440, height: 900 }, activeWindow: { title: 'Test', processId: 1 }, elements: [{ name: '输入', value: '中文实际值', automationId: 'field', controlType: 'AXTextField', x: 1, y: 2, width: 30, height: 40 }], truncated: false })
  })
  await bridge.observe(100, new AbortController().signal)
  const result = await bridge.type('中文 " $(do-not-run)', 100, new AbortController().signal)
  expect(requests[1]).toMatchObject({ action: 'type', text: '中文 " $(do-not-run)', expectedProcessId: 1, expectedWidth: 1440, expectedHeight: 900 })
  expect(result.image).toMatchObject({ attachmentId: 'screen' })
  expect(result.elements[0].value).toBe('中文实际值')
  await expect(access(String(requests[0].screenshot))).rejects.toThrow()
})

it('requires a new observation before actions and invalidates it after a native failure', async () => {
  let calls = 0
  const ctx = { attachments: { async saveImage() { return {} } } } as unknown as Context
  const bridge = new MacComputerUseBridge(ctx, async (request) => {
    calls++
    if (request.action !== 'observe') throw new Error('前台应用已变化，未执行操作')
    await writeFile(String(request.screenshot), 'image')
    return JSON.stringify({ screen: { width: 1440, height: 900 }, activeWindow: { title: 'Test', processId: 1 }, elements: [], truncated: false })
  })
  const signal = new AbortController().signal
  await expect(bridge.type('不能盲打', 10, signal)).rejects.toThrow('先重新观察')
  expect(calls).toBe(0)
  await bridge.observe(10, signal)
  await expect(bridge.type('切换了应用', 10, signal)).rejects.toThrow('未执行操作')
  await expect(bridge.type('不能盲目重试', 10, signal)).rejects.toThrow('先重新观察')
  expect(calls).toBe(2)
})

it('cleans temporary screenshots on invalid observations and cancellation after execution', async () => {
  let screenshot = ''
  let saves = 0
  const ctx = { attachments: { async saveImage() { saves++; return {} } } } as unknown as Context
  const bridge = new MacComputerUseBridge(ctx, async (request) => {
    screenshot = String(request.screenshot)
    await writeFile(screenshot, 'test image')
    return '{}'
  })
  await expect(bridge.observe(10, new AbortController().signal)).rejects.toThrow('无效观察结果')
  await expect(access(screenshot)).rejects.toThrow()
  const abort = new AbortController()
  const canceled = new MacComputerUseBridge(ctx, async (request) => {
    screenshot = String(request.screenshot)
    await writeFile(screenshot, 'test image')
    abort.abort()
    return '{}'
  })
  await expect(canceled.observe(10, abort.signal)).rejects.toThrow()
  await expect(access(screenshot)).rejects.toThrow()
  expect(saves).toBe(0)
})

it('does not run aborted actions and surfaces permission failures', async () => {
  const ctx = {} as Context
  let calls = 0
  const bridge = new MacComputerUseBridge(ctx, async () => { calls++; throw new Error('请开启辅助功能') })
  const abort = new AbortController(); abort.abort()
  await expect(bridge.observe(10, abort.signal)).rejects.toThrow()
  expect(calls).toBe(0)
  await expect(bridge.observe(10, new AbortController().signal)).rejects.toThrow('辅助功能')
})
