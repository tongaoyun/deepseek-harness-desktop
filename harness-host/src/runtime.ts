import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness, type HarnessNotification } from '@deepseek-ai/dsh-sdk-client'

export interface RunInput {
  prompt: string
  sessionId?: string
}

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
    if (input.prompt.trim().length === 0) {
      throw new Error('prompt must not be blank')
    }
    const harness = this.getOrCreateHarness()
    const result = await harness.run(input.prompt, {
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      onNotification,
    })
    return {
      sessionId: result.sessionId,
      finalResponse: result.finalResponse,
    }
  }

  async close(): Promise<void> {
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

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('DSH_MAX_TOKENS must be a positive integer')
  }
  return parsed
}
