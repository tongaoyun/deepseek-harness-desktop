import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { DeepSeekHarness, type ContentBlock, type HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
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

const require = createRequire(import.meta.url)
const moduleDirectory = dirname(fileURLToPath(import.meta.url))

export class DeepSeekHarnessRuntime implements HarnessRuntime {
  private harness: DeepSeekHarness | undefined
  private runTail: Promise<void> = Promise.resolve()

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
    const execution = this.runTail.then(() => this.runNow(input, onNotification))
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
    const prompt = applyMemoryContext(input.prompt, process.env.XIAOYIN_MEMORY_CONTEXT)
    const images = await Promise.all((input.images ?? []).slice(0, 4).map(persistInputImage))
    const content: string | ContentBlock[] = images.length === 0 ? prompt : [
      { type: 'text', text: prompt }, ...images.map((attachment) => ({ type: 'image' as const, attachment })),
    ]
    const result = await harness.run(content, {
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      onNotification,
    })
    return {
      sessionId: result.sessionId,
      finalResponse: result.finalResponse,
    }
  }

  async close(): Promise<void> {
    await this.runTail
    const current = this.harness
    this.harness = undefined
    await current?.close()
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
