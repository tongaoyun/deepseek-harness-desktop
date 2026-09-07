import type { Context } from '@deepseek-ai/cordis'
import type { ComputerObservation } from './local-computer-use-plugin.js'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Request = Record<string, string | number>
export type MacRunner = (request: Request, signal: AbortSignal) => Promise<string>

export class MacComputerUseBridge {
  private observation: Omit<ComputerObservation, 'image'> | undefined
  constructor(private readonly ctx: Context, private readonly runner: MacRunner = runMacHelper) {}
  observe(maxElements: number, signal: AbortSignal) { return this.execute({ action: 'observe', maxElements }, signal) }
  click(x: number, y: number, button: 'left' | 'right', clickCount: number, maxElements: number, signal: AbortSignal) {
    return this.execute({ action: 'click', x, y, button, clickCount, maxElements }, signal)
  }
  type(text: string, maxElements: number, signal: AbortSignal) { return this.execute({ action: 'type', text, maxElements }, signal) }
  key(key: string, modifiers: string[], maxElements: number, signal: AbortSignal) { return this.execute({ action: 'key', key, modifiers: modifiers.join(','), maxElements }, signal) }
  scroll(x: number, y: number, delta: number, maxElements: number, signal: AbortSignal) { return this.execute({ action: 'scroll', x, y, delta, maxElements }, signal) }
  private async execute(request: Request, signal: AbortSignal): Promise<ComputerObservation> {
    signal.throwIfAborted()
    if (request.action !== 'observe') {
      if (!this.observation) throw new Error('请先重新观察桌面，再决定操作位置')
      request = { ...request, expectedProcessId: this.observation.activeWindow.processId, expectedWindowSignature: this.observation.activeWindow.signature ?? '', expectedWidth: this.observation.screen.width, expectedHeight: this.observation.screen.height }
    }
    const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-observe-'))
    const screenshot = join(directory, 'screen.png')
    try {
      const output = await this.runner({ ...request, screenshot }, signal)
      signal.throwIfAborted()
      const observation = JSON.parse(output) as Omit<ComputerObservation, 'image'>
      if (!Number.isFinite(observation.screen?.width) || !Number.isFinite(observation.screen?.height) || !Number.isSafeInteger(observation.activeWindow?.processId) || observation.activeWindow.processId <= 0 || !Array.isArray(observation.elements)) throw new Error('macOS 桌面返回无效观察结果')
      const image = await this.ctx.attachments.saveImage({ data: await readFile(screenshot), mediaType: 'image/png', name: 'macOS 桌面.png' })
      this.observation = observation
      return { ...observation, image }
    } catch (reason) {
      this.observation = undefined
      throw reason
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}

function runMacHelper(request: Request, signal: AbortSignal): Promise<string> {
  const binary = fileURLToPath(new URL('../native/xiaoyin-computer-use', import.meta.url))
  return new Promise((resolve, reject) => {
    execFile(binary, [JSON.stringify(request)], { signal, timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(signal.aborted ? '桌面操作已停止' : `macOS 桌面操作失败：${stderr.trim() || error.message}`))
      else resolve(stdout)
    })
  })
}
