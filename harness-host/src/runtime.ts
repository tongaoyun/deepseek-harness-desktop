import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { DeepSeekHarness, type ContentBlock, type HarnessClient, type HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { AttachmentId, type ImageAttachmentRef, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { imageMetadata } from './local-attachment-store-plugin.js'
import { withTaskInstructions } from './task-instructions.js'
import { IMAGE_LIMITS } from './image-limits.js'
import { memoryContextForTask } from './memory-context.js'

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
  run(input: RunInput, onNotification: (value: HarnessNotification, rootSessionId: string) => void): Promise<HarnessRunResult>
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
  private runTail: Promise<void> = Promise.resolve()
  private closing = false
  private closeTask: Promise<void> | undefined

  constructor(private readonly extraEnv: NodeJS.ProcessEnv = {}) {}

  async health(): Promise<{ status: string; runtime: string; version: string }> {
    return {
      status: 'ready',
      runtime: 'deepseek-harness',
      version: '0.1.1-rc.2',
    }
  }

  async initialize(): Promise<{ status: string; runtime: string }> {
    try {
      await this.getOrCreateHarness().start()
    } catch (error) {
      if (this.closing) await this.closeTask?.catch(() => undefined)
      throw error
    }
    return { status: 'initialized', runtime: 'deepseek-harness' }
  }

  async run(
    input: RunInput,
    onNotification: (value: HarnessNotification, rootSessionId: string) => void,
  ): Promise<HarnessRunResult> {
    const sessionId = input.sessionId ?? `session-${randomUUID().replaceAll('-', '')}`
    const execution = this.runTail.then(() => this.runNow(
      { ...input, sessionId },
      (value) => onNotification(value, sessionId),
    ))
    this.runTail = execution.then(() => undefined, () => undefined)
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
    const prompt = withTaskInstructions(applyMemoryContext(input.prompt, process.env.XIAOYIN_MEMORY_CONTEXT))
    if ((input.images?.length ?? 0) > IMAGE_LIMITS.maxImagesPerMessage) throw new Error('单条消息最多添加 4 张图片')
    const images = await Promise.all((input.images ?? []).map(persistInputImage))
    const content: string | ContentBlock[] = images.length === 0 ? prompt : [
      { type: 'text', text: prompt }, ...images.map((attachment) => ({ type: 'image' as const, attachment })),
    ]
    const sessionId = input.sessionId ?? `session-${randomUUID().replaceAll('-', '')}`
    try {
      await harness.start()
      return await runSessionTurn(
        harness.client,
        sessionId,
        normalizeContent(content),
        onNotification,
        turnTimeoutMs(process.env.XIAOYIN_TURN_TIMEOUT_MS),
      )
    } catch (error) {
      // Do not let the native host tear down the process group before the SDK
      // has finished disposing detached shell/MCP children.
      if (this.closing) await this.closeTask?.catch(() => undefined)
      if (error instanceof TurnTimeoutError && this.harness === harness) {
        this.harness = undefined
        await harness.close().catch(() => undefined)
      }
      throw error
    }
  }

  async close(): Promise<void> {
    if (this.closeTask) return this.closeTask
    this.closing = true
    const current = this.harness
    this.harness = undefined
    // Closing the SDK actively aborts the model turn and disposes tool handles.
    // Waiting for runTail first would turn Stop into "wait until finished".
    this.closeTask = current?.close() ?? Promise.resolve()
    return this.closeTask
  }

  private getOrCreateHarness(): DeepSeekHarness {
    if (this.closing) throw new Error('本轮已停止')
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
  const streamedText = new Map<string, string>()
  const deadline = Date.now() + timeoutMs
  try {
    const messageId = await client.prompt(sessionId, content)
    for (;;) {
      const notification = await nextBeforeDeadline(subscription, deadline, timeoutMs)
      if (!receivedPrompt) {
        if (!isPromptReceipt(notification, sessionId, messageId)) continue
        receivedPrompt = true
      }
      const event = sessionEvent(notification, sessionId)
      await forwardVisibleTextSmoothly(notification, event, streamedText, onNotification)
      if (event?.type === 'turn/start') turnStarted = true
      if (event?.type === 'assistant/message') {
        turnStarted = true
        const nextText = assistantText(event)
        if (nextText.trim()) finalResponse = nextText
      }
      if (event?.type === 'turn/end') {
        const reason = record(record(event.data)?.reason)
        if (reason?.kind === 'error') turnFailure = providerFailureMessage(reason) || '本轮执行失败，已保留部分结果，请检查后继续'
        else if (reason?.kind === 'max-tokens') turnFailure = '本轮达到模型输出上限，结果尚未完成，请继续处理剩余内容'
        if (turnStarted) break
      }
      if (turnStarted && notification.method === 'session.status'
        && notification.params.sessionId === sessionId && notification.params.status === 'idle') break
    }
  } finally {
    subscription.close()
  }
  if (turnFailure) throw new Error(turnFailure)
  if (!finalResponse.trim()) throw new Error('模型本轮没有返回可显示文本，请重试')
  return { sessionId, finalResponse }
}

/**
 * Providers do not all expose token deltas consistently. Some return one large
 * `text-chunks` event (or only the final assistant message), which makes the
 * desktop UI appear frozen and then dump a whole answer at once. Normalize
 * those cases here so every consumer receives the same real incremental event
 * stream. Small native chunks pass through untouched.
 */
async function forwardVisibleTextSmoothly(
  notification: HarnessNotification,
  event: Record<string, unknown> | undefined,
  streamedText: Map<string, string>,
  onNotification: (value: HarnessNotification) => void,
): Promise<void> {
  if (event === undefined) {
    onNotification(notification)
    return
  }
  if (event.type === 'tool/call') {
    streamedText.clear()
    onNotification(notification)
    return
  }
  const data = record(event.data)
  const key = assistantStepKey(data)
  if (event.type === 'text-chunks') {
    const text = stringTexts(data?.texts)
    if (!text) {
      onNotification(notification)
      return
    }
    if (Array.from(text).length >= 18) {
      await emitIncrementalText(notification, event, text, onNotification)
    } else {
      onNotification(notification)
    }
    streamedText.set(key, `${streamedText.get(key) ?? ''}${text}`)
    return
  }
  if (event.type === 'assistant/message') {
    const finalText = assistantText(event)
    const previous = streamedText.get(key) ?? ''
    const missing = finalText.startsWith(previous) ? finalText.slice(previous.length) : ''
    if (missing) await emitIncrementalText(notification, event, missing, onNotification)
    if (finalText) streamedText.set(key, finalText)
  }
  onNotification(notification)
}

async function emitIncrementalText(
  notification: HarnessNotification,
  event: Record<string, unknown>,
  text: string,
  onNotification: (value: HarnessNotification) => void,
): Promise<void> {
  const chunks = visibleTextChunks(text)
  if (chunks.length === 1) {
    onNotification(event.type === 'text-chunks' ? notification : textChunkNotification(notification, event, text))
    return
  }
  for (const chunk of chunks) {
    onNotification(textChunkNotification(notification, event, chunk))
    await shortUiPause()
  }
}

export function visibleTextChunks(text: string): string[] {
  const characters = Array.from(text)
  if (characters.length < 18) return [text]
  const chunkSize = Math.max(4, Math.ceil(characters.length / 80))
  const chunks: string[] = []
  for (let index = 0; index < characters.length; index += chunkSize) {
    chunks.push(characters.slice(index, index + chunkSize).join(''))
  }
  return chunks
}

function textChunkNotification(
  notification: HarnessNotification,
  event: Record<string, unknown>,
  text: string,
): HarnessNotification {
  const params = notification.params as unknown as Record<string, unknown>
  return {
    ...notification,
    params: {
      ...params,
      event: {
        ...event,
        type: 'text-chunks',
        data: { turn: 0, step: 0, ...record(event.data), texts: [text] },
      },
    },
  } as HarnessNotification
}

function assistantStepKey(data: Record<string, unknown> | undefined): string {
  void data
  return 'root-visible-response'
}

function stringTexts(value: unknown): string {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join('') : ''
}

function shortUiPause(): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, 32))
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
  const normalized = message.toLocaleLowerCase('en-US')
  if (message.includes("function.name") || message.includes("tools[")) {
    return '模型工具配置不兼容，请重新启动小胤后再试'
  }
  if (message.includes('401') || normalized.includes('unauthorized')) return '模型服务认证失败，请联系管理员检查配置'
  if (message.includes('429') || normalized.includes('rate limit')) return '模型服务繁忙，请稍后重试'
  if (/context.{0,20}(length|window)|too many tokens|maximum context/u.test(normalized)) {
    return '当前会话内容过长，请新建任务或缩短上下文后重试'
  }
  if (/econnrefused|enotfound|fetch failed|network|socket hang up/u.test(normalized)) {
    return '模型服务暂时无法连接，请检查内网后重试'
  }
  if (/\b50[0-9]\b|bad gateway|service unavailable|gateway timeout/u.test(normalized)) {
    return '模型服务暂时不可用，请稍后重试'
  }
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
  if (input.data.length === 0 || input.data.length > IMAGE_LIMITS.maxImageBytes) throw new Error('图片为空或超过 10 MB，请缩小后重试')
  const metadata = imageMetadata(input.data, input.mediaType)
  if (metadata.width > IMAGE_LIMITS.maxImageDimension || metadata.height > IMAGE_LIMITS.maxImageDimension || metadata.width * metadata.height > IMAGE_LIMITS.maxImagePixels) {
    throw new Error('图片分辨率超出当前运行时范围：最长边 2560 像素、总计 400 万像素，请裁剪或缩小后重试')
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
  const memory = memoryContextForTask(prompt, memoryContext)
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
