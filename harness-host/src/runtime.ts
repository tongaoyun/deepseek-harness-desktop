import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { DeepSeekHarness, type ContentBlock, type HarnessClient, type HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { AttachmentId, type ImageAttachmentRef, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { imageMetadata } from './local-attachment-store-plugin.js'

export interface RunInput {
  prompt: string
  sessionId?: string
  images?: ImageRunInput[]
}

export interface ImageRunInput { data: Buffer; mediaType: 'image/png' | 'image/jpeg'; name: string }

export interface HarnessRunResult {
  sessionId: string
  finalResponse: string
}

export interface HarnessRuntime {
  health(): Promise<{ status: string; runtime: string; version: string }>
  initialize(): Promise<{ status: string; runtime: string }>
  run(input: RunInput, onNotification: (value: HarnessNotification) => void): Promise<HarnessRunResult>
  close(): Promise<void>
}

export class TurnTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`任务执行超过 ${formatDuration(timeoutMs)}，已停止本轮任务，请缩小任务范围后重试`)
    this.name = 'TurnTimeoutError'
  }
}

const require = createRequire(import.meta.url)
const moduleDirectory = dirname(fileURLToPath(import.meta.url))

export class DeepSeekHarnessRuntime implements HarnessRuntime {
  private harness: DeepSeekHarness | undefined
  private readonly sessionTails = new Map<string, Promise<void>>()
  private readonly pendingRuns = new Set<Promise<unknown>>()
  private activeRuns = 0
  private readonly concurrencyWaiters: Array<() => void> = []

  constructor(private readonly extraEnv: NodeJS.ProcessEnv = {}) {}

  async health(): Promise<{ status: string; runtime: string; version: string }> {
    return {
      status: 'ready',
      runtime: 'deepseek-harness',
      version: '0.1.1-rc.2',
    }
  }

  async initialize(): Promise<{ status: string; runtime: string }> {
    await this.getOrCreateHarness().start()
    return { status: 'initialized', runtime: 'deepseek-harness' }
  }

  async run(
    input: RunInput,
    onNotification: (value: HarnessNotification) => void,
  ): Promise<HarnessRunResult> {
    const sessionId = input.sessionId ?? `session-${randomUUID().replaceAll('-', '')}`
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve()
    const execution = previous.then(async () => {
      await this.acquireConcurrencySlot()
      try {
        return await this.runNow({ ...input, sessionId }, onNotification)
      } finally {
        this.releaseConcurrencySlot()
      }
    })
    const settled = execution.then(() => undefined, () => undefined)
    this.sessionTails.set(sessionId, settled)
    this.pendingRuns.add(execution)
    void settled.finally(() => {
      this.pendingRuns.delete(execution)
      if (this.sessionTails.get(sessionId) === settled) this.sessionTails.delete(sessionId)
    })
    return execution
  }

  private async runNow(
    input: RunInput,
    onNotification: (value: HarnessNotification) => void,
  ): Promise<HarnessRunResult> {
    if (input.prompt.trim().length === 0) {
      throw new Error('prompt must not be blank')
    }
    const harness = this.getOrCreateHarness()
    const prompt = applyMemoryContext(input.prompt, process.env.XIAOYIN_MEMORY_CONTEXT)
    const images = await Promise.all((input.images ?? []).slice(0, 4).map(persistInputImage))
    const content: string | ContentBlock[] = images.length === 0 ? prompt : [
      { type: 'text', text: prompt }, ...images.map((attachment) => ({ type: 'image' as const, attachment })),
    ]
    const sessionId = input.sessionId ?? `session-${randomUUID().replaceAll('-', '')}`
    await harness.start()
    try {
      return await runSessionTurn(
        harness.client,
        sessionId,
        normalizeContent(content),
        onNotification,
        turnTimeoutMs(process.env.XIAOYIN_TURN_TIMEOUT_MS),
      )
    } catch (error) {
      if (error instanceof TurnTimeoutError && this.harness === harness) {
        this.harness = undefined
        await harness.close().catch(() => undefined)
      }
      throw error
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.pendingRuns)
    const current = this.harness
    this.harness = undefined
    await current?.close()
  }

  private async acquireConcurrencySlot(): Promise<void> {
    const limit = positiveInteger(process.env.XIAOYIN_MAX_CONCURRENT_TURNS) ?? 2
    if (this.activeRuns < limit) {
      this.activeRuns += 1
      return
    }
    await new Promise<void>((resolveWaiter) => this.concurrencyWaiters.push(resolveWaiter))
    this.activeRuns += 1
  }

  private releaseConcurrencySlot(): void {
    this.activeRuns = Math.max(0, this.activeRuns - 1)
    this.concurrencyWaiters.shift()?.()
  }

  private getOrCreateHarness(): DeepSeekHarness {
    if (this.harness !== undefined) return this.harness

    const packageJson = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/package.json')
    const runtimeBin = resolve(dirname(packageJson), 'lib/bin.js')
    const configPath = process.env.DSH_CORDIS_CONFIG
      ?? resolve(moduleDirectory, '../runtime/cordis.yml')
    const workspace = resolve(process.env.DSH_CWD ?? process.cwd())

    const maxTokens = positiveInteger(process.env.DSH_MAX_TOKENS)
    this.harness = new DeepSeekHarness({
      launch: {
        command: process.execPath,
        args: [runtimeBin],
        cwd: workspace,
        env: {
          ...process.env,
          ...this.extraEnv,
          DSH_CORDIS_CONFIG: configPath,
          DSH_CWD: workspace,
        },
      },
      cwd: workspace,
      provider: process.env.DSH_PROVIDER ?? 'deepseek-official',
      model: process.env.DSH_MODEL ?? 'deepseek-v4-flash',
      ...(maxTokens === undefined ? {} : { maxTokens }),
    })
    return this.harness
  }
}

interface SessionSubscription {
  next(): Promise<HarnessNotification>
  close(): void
}

interface SessionClient {
  prompt(sessionId: string, contentBlocks: ContentBlock[]): Promise<string>
  subscribeSessionTree(sessionId: string): SessionSubscription
}

/**
 * Collect one real turn. The upstream SDK currently treats a stale `idle`
 * emitted while restoring a persisted session as the end of the new prompt.
 * Waiting for `turn/start` prevents successful-but-empty follow-up results.
 */
export async function runSessionTurn(
  client: Pick<HarnessClient, 'prompt' | 'subscribeSessionTree'> | SessionClient,
  sessionId: string,
  content: ContentBlock[],
  onNotification: (value: HarnessNotification) => void,
  timeoutMs = 15 * 60_000,
): Promise<HarnessRunResult> {
  const subscription = client.subscribeSessionTree(sessionId)
  let receivedPrompt = false
  let turnStarted = false
  let finalResponse = ''
  let turnFailure = ''
  const deadline = Date.now() + timeoutMs
  try {
    const messageId = await client.prompt(sessionId, content)
    for (;;) {
      const notification = await nextBeforeDeadline(subscription, deadline, timeoutMs)
      if (!receivedPrompt) {
        if (!isPromptReceipt(notification, sessionId, messageId)) continue
        receivedPrompt = true
      }
      onNotification(notification)
      const event = sessionEvent(notification, sessionId)
      if (event?.type === 'turn/start') turnStarted = true
      if (event?.type === 'assistant/message') {
        turnStarted = true
        const nextText = assistantText(event)
        if (nextText.trim()) finalResponse = nextText
      }
      if (event?.type === 'turn/end') {
        const reason = record(record(event.data)?.reason)
        if (reason?.kind === 'error') turnFailure = providerFailureMessage(reason)
      }
      if (turnStarted && notification.method === 'session.status'
        && notification.params.sessionId === sessionId && notification.params.status === 'idle') break
    }
  } finally {
    subscription.close()
  }
  if (!finalResponse.trim()) throw new Error(turnFailure || '模型本轮没有返回可显示文本，请重试')
  return { sessionId, finalResponse }
}

async function nextBeforeDeadline(
  subscription: SessionSubscription,
  deadline: number,
  timeoutMs: number,
): Promise<HarnessNotification> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new TurnTimeoutError(timeoutMs)
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      subscription.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TurnTimeoutError(timeoutMs)), remaining)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function providerFailureMessage(reason: Record<string, unknown>): string {
  const error = record(reason.error) ?? record(reason.failure)
  const message = typeof error?.message === 'string' ? error.message : ''
  if (message.includes("function.name") || message.includes("tools[")) {
    return '模型工具配置不兼容，请重新启动小胤后再试'
  }
  if (message.includes('401') || message.toLowerCase().includes('unauthorized')) return '模型服务认证失败，请联系管理员检查配置'
  if (message.includes('429') || message.toLowerCase().includes('rate limit')) return '模型服务繁忙，请稍后重试'
  return message ? '模型服务未能完成本轮请求，请重试' : ''
}

function normalizeContent(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

function isPromptReceipt(notification: HarnessNotification, sessionId: string, messageId: string): boolean {
  const event = sessionEvent(notification, sessionId)
  if (event?.type !== 'agent/inbox/spliced') return false
  const data = record(event.data)
  return Array.isArray(data?.inserted) && data.inserted.some((item) => record(item)?.id === messageId)
}

function sessionEvent(notification: HarnessNotification, sessionId: string): Record<string, unknown> | undefined {
  if (notification.method !== 'session.event' || notification.params.sessionId !== sessionId) return undefined
  return record(notification.params.event)
}

function assistantText(event: Record<string, unknown>): string {
  const message = record(record(event.data)?.message)
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    const value = record(block)
    return value?.type === 'text' && typeof value.text === 'string' ? value.text : ''
  }).join('')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

async function persistInputImage(input: ImageRunInput): Promise<ImageAttachmentRef> {
  if (input.data.length === 0 || input.data.length > 5 * 1024 * 1024) throw new Error('IM image exceeds the supported size')
  const metadata = imageMetadata(input.data, input.mediaType)
  if (metadata.width > 2_560 || metadata.height > 2_560 || metadata.width * metadata.height > 4_000_000) {
    throw new Error('IM image dimensions exceed the selected model policy')
  }
  const hash = createHash('sha256').update(input.data).digest('hex')
  const root = resolve(process.env.XIAOYIN_ATTACHMENT_ROOT ?? './.xiaoyin/attachments')
  await mkdir(root, { recursive: true })
  await writeFile(resolve(root, `${hash}.image`), input.data, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  return {
    attachmentId: AttachmentId(`sha256:${hash}`), mediaType: input.mediaType as ImageMediaType,
    bytes: input.data.length, width: metadata.width, height: metadata.height,
    name: input.name.replaceAll(/[\\/]/g, '').slice(0, 100),
  }
}

export function applyMemoryContext(prompt: string, memoryContext: string | undefined): string {
  const memory = memoryContext?.trim()
  if (!memory) return prompt
  return `<xiaoyin-memory>\n${memory}\n</xiaoyin-memory>\n\n当前任务：\n${prompt}`
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('DSH_MAX_TOKENS must be a positive integer')
  }
  return parsed
}

function turnTimeoutMs(value: string | undefined): number {
  const timeout = positiveInteger(value) ?? 15 * 60_000
  if (timeout < 10_000 || timeout > 2 * 60 * 60_000) {
    throw new Error('XIAOYIN_TURN_TIMEOUT_MS must be between 10000 and 7200000')
  }
  return timeout
}

function formatDuration(value: number): string {
  if (value >= 60_000 && value % 60_000 === 0) return `${value / 60_000} 分钟`
  return `${Math.ceil(value / 1_000)} 秒`
}
