import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, resolve, join } from 'node:path'
import { lstat, mkdir, open, rm, symlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import {
  DeepSeekHarness,
  type HarnessClient,
  type HarnessNotification,
  type SdkPromptContentBlock,
} from '@deepseek-ai/dsh-sdk-client'
import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session/surface'
import { visibleTaskPrompt, withTaskInstructions } from './task-instructions.js'
import { IMAGE_LIMITS } from './image-limits.js'
import { memoryContextForTask } from './memory-context.js'
import { initialXiaoyinTaskView, reduceEvent, type XiaoyinTaskState, type XiaoyinTaskView } from './xiaoyin-projections-plugin.js'
import { hasEligibleHarnessMcpConnector } from './managed-mcp-plugin.js'
import { HarnessError, data as errorData, errorDataForProvider, type HarnessErrorData } from './errors.js'

// Session artifacts use the official runtime's stable encoding across Node versions.
const SESSION_COMPRESSION = 'zstd'

export interface RunInput {
  prompt: string
  sessionId?: string
  images?: ImageRunInput[]
}

export interface ImageRunInput { data: Buffer; mediaType: 'image/png' | 'image/jpeg'; name: string }

export interface HarnessRunResult {
  sessionId: string
  finalResponse: string
  /** True when the employee interrupted the turn before it completed. */
  interrupted?: boolean
}

export interface SessionInspection {
  sessionId: string
  status: 'idle' | 'running' | 'completed' | 'failed' | 'unknown'
  updatedAt: string
  lastEventType?: string
  pendingTools: number
  projection?: XiaoyinTaskView
  /** Raw Harness Session journal consumed by the official browser Conversation assembler. */
  events?: Array<Record<string, unknown>>
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string }>
}

export interface SessionSearchHit {
  sessionId: string
  excerpt: string
  updatedAt: string
}

export interface SessionSearchPage {
  items: SessionSearchHit[]
  nextCursor?: string
}

export interface ProviderCheckResult {
  status: 'available' | 'unauthorized' | 'unreachable' | 'unconfigured'
  latencyMs: number
  detail: string
}

export interface HarnessRuntime {
  health(): Promise<{ status: string; runtime: string; version: string; capabilities?: Record<string, 'enabled' | 'gated' | 'unconfigured'> }>
  initialize(): Promise<{ status: string; runtime: string }>
  run(input: RunInput, onNotification: (value: HarnessNotification, rootSessionId: string) => void): Promise<HarnessRunResult>
  inspectSession?(sessionId: string): Promise<SessionInspection | undefined>
  steer?(sessionId: string, text: string): Promise<unknown>
  interrupt?(sessionId: string): Promise<{ interrupted: boolean }>
  fork?(sessionId: string, atSeq?: number): Promise<{ sessionId: string }>
  searchSessions?(sessionIds: string[], query: string, limit?: number, cursor?: string): Promise<SessionSearchPage>
  checkProvider?(): Promise<ProviderCheckResult>
  close(): Promise<void>
}

export class TurnTimeoutError extends HarnessError {
  constructor(readonly timeoutMs: number) {
    super(errorData('XY-TIMEOUT', 'timeout', '任务运行超时', `任务执行超过 ${formatDuration(timeoutMs)}，已停止本轮任务，请缩小任务范围后重试`, false, false))
    this.name = 'TurnTimeoutError'
  }
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const harnessPackagePath = require.resolve('@deepseek-ai/dsh/package.json')
const harnessPackageDirectory = dirname(harnessPackagePath)
const harnessPackage = require(harnessPackagePath) as { version?: unknown }
const HARNESS_VERSION = typeof harnessPackage.version === 'string' && harnessPackage.version.length > 0
  ? harnessPackage.version
  : 'unknown'

// These plugins are product-mounted through cordis.yml but are intentionally
// not dependencies of the upstream `dsh` package. The official launcher
// resolves bare entries from `$DSH_HOME/profiles/node_modules`, so an employee
// home outside the packaged runtime needs a small, product-owned fallback.
const EXTERNAL_HARNESS_PLUGINS = [
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-tool-pwsh-persistent',
  '@deepseek-ai/dsh-tool-session-query',
  '@deepseek-ai/dsh-workspace-changes',
] as const

export async function ensureExternalHarnessPlugins(env: NodeJS.ProcessEnv): Promise<void> {
  const dshHome = env.DSH_HOME
  if (!dshHome) return
  const fallbackRoot = join(resolve(dshHome), 'profiles', 'node_modules')
  const packageRoot = resolve(moduleDirectory, '../node_modules')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  for (const packageName of EXTERNAL_HARNESS_PLUGINS) {
    const source = resolve(packageRoot, packageName)
    try {
      await lstat(source)
    } catch {
      continue
    }
    const target = resolve(fallbackRoot, packageName)
    try {
      await lstat(target)
      continue
    } catch {
      // The fallback is created below. Existing profile-managed entries remain
      // authoritative and are never replaced by the product adapter.
    }
    await mkdir(dirname(target), { recursive: true })
    try {
      await symlink(source, target, linkType)
    } catch (error) {
      try {
        await lstat(target)
      } catch {
        throw error
      }
    }
  }
}

export function hasConfiguredLspServers(value: string | undefined): boolean {
  if (!value?.trim()) return false
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed) || Object.keys(parsed).length === 0) return false
    return Object.values(parsed).every((server) => {
      if (!isRecord(server) || typeof server.command !== 'string' || !server.command.trim() || !isRecord(server.extensionToLanguage)) return false
      const extensions = Object.entries(server.extensionToLanguage)
      return extensions.length > 0 && extensions.every(([extension, language]) => /^\.[^\s/]+$/u.test(extension) && typeof language === 'string' && Boolean(language.trim()))
    })
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messagesSseText(value: string): string {
  const chunks: string[] = []
  for (const line of value.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue
    try {
      const event: unknown = JSON.parse(line.slice(5).trim())
      if (!isRecord(event) || event.type !== 'content_block_delta' || !isRecord(event.delta) || event.delta.type !== 'text_delta' || typeof event.delta.text !== 'string') continue
      chunks.push(event.delta.text)
    } catch { /* malformed provider data is treated as an empty response */ }
  }
  return chunks.join('')
}

export function hasHarnessPackage(name: string): boolean {
  try {
    require.resolve(name)
    return true
  } catch {
    // Most core profile plugins are transitive dependencies of dsh rather
    // than direct dependencies of the desktop adapter. Resolve from the
    // launcher package as well, otherwise health would report false gaps for
    // a perfectly valid bundled profile.
    try {
      require.resolve(name, { paths: [harnessPackageDirectory] })
      return true
    } catch {
      return false
    }
  }
}

function officialCapability(name: string): 'enabled' | 'unconfigured' {
  return hasHarnessPackage(name) ? 'enabled' : 'unconfigured'
}

function optionalCapability(name: string, enabled: boolean, disabled: 'gated' | 'unconfigured' = 'gated'): 'enabled' | 'gated' | 'unconfigured' {
  return enabled ? (hasHarnessPackage(name) ? 'enabled' : 'unconfigured') : disabled
}

function configuredPrimaryRuntime(env: NodeJS.ProcessEnv): boolean {
  return Boolean((env.DSH_PRIMARY_RUNTIME ?? env.DSH_BUNDLED_PRIMARY_RUNTIME)?.trim())
}

export function assertHarnessDependencyClosure(): void {
  const missing = EXTERNAL_HARNESS_PLUGINS.filter((name) => !hasHarnessPackage(name))
  if (missing.length > 0) throw new Error(`Harness 官方插件依赖缺失：${missing.join('、')}`)
}

export class DeepSeekHarnessRuntime implements HarnessRuntime {
  private harness: DeepSeekHarness | undefined
  private initialized = false
  private runTail: Promise<void> = Promise.resolve()
  /** Set by interrupt(); consulted at the running turn's abort boundary. */
  private interruptRequested = false
  private closing = false
  private closeTask: Promise<void> | undefined
  constructor(private readonly extraEnv: NodeJS.ProcessEnv = {}) {}

  private environment(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.extraEnv }
  }

  async health(): Promise<{ status: string; runtime: string; version: string; capabilities: Record<string, 'enabled' | 'gated' | 'unconfigured'> }> {
    const env = this.environment()
    const modelConfigured = env.XIAOYIN_MODEL_PROVIDER_CONFIGURED === 'true' || Boolean(env.DEEPSEEK_API_KEY?.trim())
    return {
      status: this.initialized ? 'ready' : 'uninitialized',
      runtime: 'deepseek-harness',
      version: HARNESS_VERSION,
      capabilities: {
        // Keep package presence separate from runtime registration. The
        // profile is only considered active after the official launcher has
        // successfully started all composed plugins.
        profile: this.initialized ? 'enabled' : 'gated',
        modelProvider: modelConfigured ? 'gated' : 'unconfigured',
        agentLoop: officialCapability('@deepseek-ai/dsh-agent-loop'),
        sessionController: officialCapability('@deepseek-ai/dsh-api-session-controller'),
        sessionPersistence: officialCapability('@deepseek-ai/dsh-session-persistence-jsonl'),
        sessionCheckpoint: officialCapability('@deepseek-ai/dsh-session-checkpoint-policy'),
        sessionProjection: officialCapability('@deepseek-ai/dsh-session-projection'),
        projectionCache: officialCapability('@deepseek-ai/dsh-session-projection-cache'),
        sandbox: officialCapability('@deepseek-ai/dsh-sandbox-local'),
        approval: officialCapability('@deepseek-ai/dsh-user-approval'),
        planMode: officialCapability('@deepseek-ai/dsh-plan-mode'),
        askUser: officialCapability('@deepseek-ai/dsh-tool-ask-user'),
        filesystem: officialCapability('@deepseek-ai/dsh-tool-fs'),
        fileSearch: officialCapability('@deepseek-ai/dsh-tool-fs-search'),
        skills: officialCapability('@deepseek-ai/dsh-skill'),
        commands: officialCapability('@deepseek-ai/dsh-commands'),
        commandFeedback: officialCapability('@deepseek-ai/dsh-command-feedback'),
        subagent: officialCapability('@deepseek-ai/dsh-subagent'),
        todo: officialCapability('@deepseek-ai/dsh-tool-todo'),
        goal: officialCapability('@deepseek-ai/dsh-goal'),
        ralph: optionalCapability('@deepseek-ai/dsh-tool-ralph', env.XIAOYIN_ENABLE_RALPH === 'true'),
        workflow: officialCapability('@deepseek-ai/dsh-tool-workflow'),
        compaction: officialCapability('@deepseek-ai/dsh-compaction-basic'),
        toolResultPruner: officialCapability('@deepseek-ai/dsh-compaction-tool-result-pruner'),
        tokenMeter: officialCapability('@deepseek-ai/dsh-token-meter'),
        jobs: officialCapability('@deepseek-ai/dsh-jobs-local'),
        workspaceChanges: officialCapability('@deepseek-ai/dsh-workspace-changes'),
        workspaceDependencies: optionalCapability('@deepseek-ai/dsh-tool-workspace-dependencies', configuredPrimaryRuntime(env), 'unconfigured'),
        officeSkills: optionalCapability('@deepseek-ai/dsh-skill-office', configuredPrimaryRuntime(env), 'unconfigured'),
        libreOfficeKit: optionalCapability('@deepseek-ai/libreoffice-kit', configuredPrimaryRuntime(env), 'unconfigured'),
        webSearch: optionalCapability('@deepseek-ai/dsh-web-search-deepseek', modelConfigured, 'unconfigured'),
        webFetch: optionalCapability('@deepseek-ai/dsh-web-fetch-http', modelConfigured, 'unconfigured'),
        settings: officialCapability('@deepseek-ai/dsh-settings-file'),
        credentials: officialCapability('@deepseek-ai/dsh-credentials-local'),
        llmRetry: officialCapability('@deepseek-ai/dsh-llm-retry'),
        outputRetention: officialCapability('@deepseek-ai/dsh-output-retention'),
        spillPolicy: officialCapability('@deepseek-ai/dsh-spill-policy'),
        timeoutPolicy: officialCapability('@deepseek-ai/dsh-tool-call-timeout-policy'),
        sessionQuery: officialCapability('@deepseek-ai/dsh-session-query-sqlite'),
        sessionQueryTools: optionalCapability('@deepseek-ai/dsh-tool-session-query', env.XIAOYIN_ENABLE_SESSION_QUERY_TOOLS !== 'false'),
        sessionReference: optionalCapability('@deepseek-ai/dsh-session-reference', env.XIAOYIN_ENABLE_SESSION_REFERENCES !== 'false'),
        mcpClient: optionalCapability('@deepseek-ai/dsh-mcp-client', hasEligibleHarnessMcpConnector(env)),
        mcpResources: optionalCapability('@deepseek-ai/dsh-mcp-resources', hasEligibleHarnessMcpConnector(env)),
        persistentTerminal: optionalCapability('@deepseek-ai/dsh-terminal', env.XIAOYIN_ALLOW_SHELL !== 'false'),
        lsp: optionalCapability('@deepseek-ai/dsh-lsp', env.XIAOYIN_ALLOW_LSP !== 'false' && hasConfiguredLspServers(env.XIAOYIN_LSP_SERVERS), 'unconfigured'),
        codexSubagent: optionalCapability('@deepseek-ai/dsh-subagent-codex', env.XIAOYIN_ALLOW_EXTERNAL_AGENTS !== 'false' && env.XIAOYIN_ENABLE_CODEX_SUBAGENT === 'true', 'unconfigured'),
        claudeSubagent: optionalCapability('@deepseek-ai/dsh-subagent-claude-code', env.XIAOYIN_ALLOW_EXTERNAL_AGENTS !== 'false' && env.XIAOYIN_ENABLE_CLAUDE_SUBAGENT === 'true', 'unconfigured'),
        acpSubagent: optionalCapability('@deepseek-ai/dsh-subagent-acp', env.XIAOYIN_ALLOW_EXTERNAL_AGENTS !== 'false' && Boolean(env.XIAOYIN_ACP_COMMAND), 'unconfigured'),
        dshSubagent: optionalCapability('@deepseek-ai/dsh-subagent-dsh-sdk', env.XIAOYIN_ALLOW_EXTERNAL_AGENTS !== 'false' && env.XIAOYIN_ENABLE_DSH_SUBAGENT === 'true', 'unconfigured'),
        officialAttachment: officialCapability('@deepseek-ai/dsh-attachment-local'),
        officialFilesystem: officialCapability('@deepseek-ai/dsh-tool-fs'),
        present: optionalCapability('@deepseek-ai/dsh-tool-present', true),
        shell: optionalCapability('@deepseek-ai/dsh-bash-local', env.XIAOYIN_ALLOW_SHELL !== 'false'),
        browser: env.XIAOYIN_ALLOW_BROWSER === 'true' ? 'enabled' : 'gated',
        codexHooks: optionalCapability('@deepseek-ai/dsh-hooks-codex', env.XIAOYIN_ALLOW_HOOKS !== 'false' && Boolean(env.XIAOYIN_CODEX_HOOKS_CONFIG)),
        claudeHooks: optionalCapability('@deepseek-ai/dsh-hooks-claude-code', env.XIAOYIN_ALLOW_HOOKS !== 'false' && Boolean(env.XIAOYIN_CLAUDE_HOOKS_CONFIG)),
      },
    }
  }

  async initialize(): Promise<{ status: string; runtime: string }> {
    try {
      assertHarnessDependencyClosure()
      const env = this.environment()
      await ensureExternalHarnessPlugins(env)
      await this.getOrCreateHarness().start()
      this.initialized = true
    } catch (error) {
      if (this.closing) await this.closeTask?.catch(() => undefined)
      throw error
    }
    return { status: 'initialized', runtime: 'deepseek-harness' }
  }

  async inspectSession(sessionId: string): Promise<SessionInspection | undefined> {
    if (!/^[-a-zA-Z0-9_:.]{1,256}$/u.test(sessionId)) throw new Error('sessionId is invalid')
    return inspectOfficialSession(sessionId, this.environment())
  }

  async searchSessions(sessionIds: string[], query: string, limit = 100, cursor?: string): Promise<SessionSearchPage> {
    if (!Array.isArray(sessionIds) || sessionIds.some((id) => !/^[-a-zA-Z0-9_:.]{1,256}$/u.test(id))) throw new Error('sessionIds are invalid')
    if (typeof query !== 'string' || !query.trim()) return { items: [] }
    return searchOfficialSessions(sessionIds, query, limit, cursor, this.environment())
  }

  async checkProvider(): Promise<ProviderCheckResult> {
    const env = this.environment()
    const key = env.DEEPSEEK_API_KEY?.trim()
    const baseUrl = env.DEEPSEEK_BASE_URL?.trim()
    const model = env.DSH_MODEL?.trim() || 'deepseek-v4-flash'
    if (!key || !baseUrl) return { status: 'unconfigured', latencyMs: 0, detail: '模型地址或凭据未配置' }
    let endpoint: URL
    try {
      const base = new URL(baseUrl)
      if (!['http:', 'https:'].includes(base.protocol)) throw new Error('unsupported protocol')
      const root = base.toString().replace(/\/+$/u, '')
      endpoint = new URL(`${base.pathname.replace(/\/+$/u, '').endsWith('/v1') ? root : `${root}/v1`}/messages`)
    } catch {
      return { status: 'unreachable', latencyMs: 0, detail: '模型地址无效' }
    }
    const startedAt = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }], max_tokens: 16, stream: true, thinking: { type: 'disabled' } }),
        redirect: 'error',
        signal: controller.signal,
      })
      const latencyMs = Date.now() - startedAt
      try {
        if (response.status === 401 || response.status === 403) return { status: 'unauthorized', latencyMs, detail: '模型凭据未被服务接受' }
        if (response.status === 429) return { status: 'unreachable', latencyMs, detail: '模型生成服务繁忙' }
        if (!response.ok) return { status: 'unreachable', latencyMs, detail: `模型服务返回 HTTP ${response.status}` }
        if (!messagesSseText(await response.text()).trim()) return { status: 'unreachable', latencyMs, detail: '模型生成响应无有效内容' }
        return { status: 'available', latencyMs, detail: '模型生成可用' }
      } finally {
        await response.body?.cancel().catch(() => undefined)
      }
    } catch (error) {
      const latencyMs = Date.now() - startedAt
      return { status: 'unreachable', latencyMs, detail: error instanceof Error && error.name === 'AbortError' ? '模型生成检查超时' : '模型服务无法访问' }
    } finally {
      clearTimeout(timeout)
    }
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
    const env = this.environment()
    await ensureExternalHarnessPlugins(env)
    const prompt = withTaskInstructions(applyMemoryContext(input.prompt, env.XIAOYIN_MEMORY_CONTEXT), {
      useOfficialPresent: true,
    })
    if ((input.images?.length ?? 0) > IMAGE_LIMITS.maxImagesPerMessage) throw new Error('单条消息最多添加 4 张图片')
    const images = (input.images ?? []).map(encodedInputImage)
    const content: SdkPromptContentBlock[] = [
      { type: 'text', text: prompt },
      ...images,
    ]
    const sessionId = input.sessionId ?? `session-${randomUUID().replaceAll('-', '')}`
    try {
      await startHarnessWithRegistrationRecovery(harness)
      this.initialized = true
      const interrupted = await runSessionTurn(
        harness.client,
        sessionId,
        content,
        onNotification,
        turnTimeoutMs(env.XIAOYIN_TURN_TIMEOUT_MS),
        () => this.interruptRequested,
      )
      if (!interrupted) this.interruptRequested = false
      return interrupted
    } catch (error) {
      // Do not let the native host tear down the process group before the SDK
      // has finished disposing detached shell/MCP children.
      if (this.closing) await this.closeTask?.catch(() => undefined)
      if ((error instanceof TurnTimeoutError || isAgentContextFailure(error)) && this.harness === harness) {
        this.harness = undefined
        await harness.close().catch(() => undefined)
      }
      throw error
    }
  }

  /**
   * Steer one employee message into the running turn's next step boundary.
   * Not serialized behind runTail: it must reach the live agent while a run
   * is in flight.
   */
  async steer(sessionId: string, text: string): Promise<unknown> {
    const harness = this.harness
    if (harness === undefined || this.interruptRequested) throw new Error('本轮没有正在运行的任务')
    return harness.client.request('session/steer', { sessionId, contentBlocks: [{ type: 'text', text }] } as never)
  }

  /**
   * Ask the running turn to stop as a user cancellation, preserving partial
   * results. Harmless when nothing is running.
   */
  async interrupt(sessionId: string): Promise<{ interrupted: boolean }> {
    const harness = this.harness
    if (harness === undefined) return { interrupted: false }
    this.interruptRequested = true
    try {
      const result = await harness.client.request('session/interrupt', { sessionId } as never) as { interrupted?: boolean }
      return { interrupted: result?.interrupted === true }
    } catch {
      return { interrupted: false }
    }
  }

  async fork(sessionId: string, atSeq?: number): Promise<{ sessionId: string }> {
    const harness = this.harness
    if (harness === undefined) throw new Error('本轮没有可分叉的会话')
    const request = atSeq === undefined ? { sessionId } : { sessionId, atSeq }
    const result = await harness.client.request('session/fork', request) as { sessionId?: unknown }
    if (typeof result?.sessionId !== 'string' || !result.sessionId) throw new Error('会话分叉未返回新的会话')
    return { sessionId: result.sessionId }
  }

  /**
   * Fork the session before its last prompt so the caller can re-run that turn
   * with the earlier context intact. Runs between turns, never concurrently
   * with an active run.
   */
  async close(): Promise<void> {
    if (this.closeTask) return this.closeTask
    this.closing = true
    const current = this.harness
    this.harness = undefined
    this.initialized = false
    // Closing the SDK actively aborts the model turn and disposes tool handles.
    // Waiting for runTail first would turn Stop into "wait until finished".
    this.closeTask = current?.close() ?? Promise.resolve()
    return this.closeTask
  }

  private getOrCreateHarness(): DeepSeekHarness {
    if (this.closing) throw new HarnessError(errorData('XY-CANCELED', 'unknown', '任务已停止', '本轮已停止', false, false))
    if (this.harness !== undefined) return this.harness

    const env = this.environment()
    const workspace = resolve(env.DSH_CWD ?? process.cwd())

    const maxTokens = positiveInteger(env.DSH_MAX_TOKENS)
    const reasoningEffort = env.DSH_REASONING_EFFORT?.trim()
    if (reasoningEffort && !['low', 'medium', 'high', 'xhigh', 'ultra'].includes(reasoningEffort)) throw new Error('Invalid reasoning effort')
    this.harness = new DeepSeekHarness({
      profile: 'sdk',
      initializeTimeoutMs: 60_000,
      cwd: workspace,
      processCwd: workspace,
      // Pass the employee-scoped home through the official SDK option as
      // well as the environment. The launcher uses this option to resolve
      // the profile's cordis.patch.yml before composing the sdk profile;
      // relying on an inherited environment alone is ambiguous when the
      // packaged Windows host starts with a different working directory.
      ...(env.DSH_HOME?.trim() ? { dshHome: env.DSH_HOME } : {}),
      patches: [env.DSH_CORDIS_CONFIG?.trim() || resolve(moduleDirectory, '../runtime/cordis.yml')],
      env: {
        ...env,
        DSH_CWD: workspace,
        // Session telemetry can include complete conversation content after
        // feedback. Xiaoyin keeps it off until the desktop owns an opt-in UI.
        DSH_TELEMETRY_DISABLED: '1',
      },
      provider: env.DSH_PROVIDER ?? 'deepseek-official',
      model: env.DSH_MODEL ?? 'deepseek-v4-flash',
      ...(reasoningEffort ? { reasoningEffort: reasoningEffort as NonNullable<NonNullable<ConstructorParameters<typeof DeepSeekHarness>[0]>['reasoningEffort']> } : {}),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    })
    return this.harness
  }
}

function isAgentContextFailure(error: unknown): boolean {
  return error instanceof HarnessError && error.data.code === 'XY-AGENT-CONTEXT'
}

async function startHarnessWithRegistrationRecovery(harness: DeepSeekHarness): Promise<void> {
  try {
    await harness.start()
  } catch (error) {
    if (!isSessionAlreadyRegisteredError(error)) throw error
    // The official SDK replaces its failed client after a rejected handshake;
    // wait for that cleanup before asking it to establish the handshake again.
    await delay(50)
    await harness.start()
  }
}


interface SessionSubscription {
  next(): Promise<HarnessNotification>
  close(): void
}

interface SessionClient {
  prompt(sessionId: string, contentBlocks: SdkPromptContentBlock[]): Promise<string>
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
  content: SdkPromptContentBlock[],
  onNotification: (value: HarnessNotification) => void,
  timeoutMs = 15 * 60_000,
  isInterrupted?: () => boolean,
): Promise<HarnessRunResult> {
  const subscription = client.subscribeSessionTree(sessionId)
  let receivedPrompt = false
  let turnStarted = false
  let abortedByInterrupt = false
  let finalResponse = ''
  let turnFailure: HarnessErrorData | undefined
  const pendingTools = new Set<string>()
  const pendingApprovals = new Set<string>()
  const pendingQuestions = new Set<string>()
  const streamedText = new Map<string, string>()
  const deadline = Date.now() + timeoutMs
  try {
    const messageId = await promptWithSessionRegistrationRecovery(client, sessionId, content, deadline, timeoutMs)
    for (;;) {
      const notification = await beforeDeadline(() => subscription.next(), deadline, timeoutMs)
      if (!receivedPrompt) {
        if (!isPromptReceipt(notification, sessionId, messageId)) continue
        receivedPrompt = true
      }
      const event = sessionEvent(notification, sessionId)
      const data = record(event?.data)
      if (event?.type === 'tool/call' && typeof data?.callId === 'string') pendingTools.add(data.callId)
      if (event?.type === 'tool/result') {
        const message = record(data?.message)
        const blocks = message?.content
        if (typeof message?.toolCallId === 'string') pendingTools.delete(message.toolCallId)
        for (const block of Array.isArray(blocks) ? blocks : []) {
          const result = record(block)
          if (result?.type === 'tool-result' && typeof result.toolCallId === 'string') pendingTools.delete(result.toolCallId)
        }
      }
      if (event?.type === 'approval/request' && typeof data?.approvalId === 'string') pendingApprovals.add(data.approvalId)
      if (event?.type === 'approval/decision' && typeof data?.approvalId === 'string') pendingApprovals.delete(data.approvalId)
      if (event?.type === 'question/request' && typeof data?.questionId === 'string') pendingQuestions.add(data.questionId)
      if (event?.type === 'question/answered' && typeof data?.questionId === 'string') pendingQuestions.delete(data.questionId)
      forwardVisibleText(notification, event, streamedText, onNotification)
      if (event?.type === 'turn/start') turnStarted = true
      if (event?.type === 'assistant/message') {
        turnStarted = true
        const nextText = assistantText(event)
        if (nextText.trim()) finalResponse = nextText
      }
      if (event?.type === 'turn/end') {
        const reason = record(record(event.data)?.reason)
        switch (reason?.kind) {
          case 'completed':
            break
          case 'error':
            turnFailure = errorDataForProvider(reason)
            break
          case 'max-tokens':
            turnFailure = errorData('XY-MAX-TOKENS', 'model', '模型输出已达上限', '本轮达到模型输出上限，结果尚未完成，请继续处理剩余内容', false, false)
            break
          case 'aborted':
            if (isInterrupted?.()) { abortedByInterrupt = true; break }
            turnFailure = errorData('XY-ABORTED', 'unknown', '任务已停止', '本轮已停止，已保留停止前的部分结果', false, false)
            break
          case 'blocked':
            turnFailure = errorData('XY-BLOCKED', 'permission', '任务未进入执行', '本轮输入未进入执行，请检查权限或运行状态后重试', false, false)
            break
          case 'interrupted':
            turnFailure = errorData('XY-INTERRUPTED', 'local-agent', '任务被中断', '本轮执行被意外中断，已保留中断前的部分结果，请检查后继续', true, false)
            break
          default:
            turnFailure = errorData('XY-UNKNOWN-TURN', 'unknown', '任务状态未知', '本轮以未知状态结束，不能确认任务已完成', false, false)
        }
        if (turnStarted) break
      }
      if (turnStarted && notification.method === 'session.status'
        && notification.params.sessionId === sessionId && notification.params.status === 'idle') {
        // Some providers acknowledge session/interrupt by returning to idle
        // without emitting a turn/end(aborted) event. Preserve the same
        // cancellation contract for both event shapes.
        if (isInterrupted?.()) abortedByInterrupt = true
        break
      }
    }
  } finally {
    subscription.close()
  }
  if (turnFailure && !(abortedByInterrupt)) throw new HarnessError(turnFailure)
  if (pendingTools.size && !(abortedByInterrupt)) throw new HarnessError(errorData('XY-UNCERTAIN-TOOL', 'connector', '工具结果待核对', '本轮仍有工具操作未取得结果，请先核对实际结果后继续', false, false))
  if ((pendingApprovals.size || pendingQuestions.size) && !abortedByInterrupt) {
    throw new HarnessError(errorData('XY-PENDING-INTERACTION', 'permission', '任务仍在等待操作', '本轮结束时仍有待审批或待回答事项，已暂停后续队列', false, false))
  }
  // A completed turn without visible text is legitimate (file edits, plan
  // delivery); the desktop renders the turn from its streamed segments.
  return { sessionId, finalResponse, ...(abortedByInterrupt ? { interrupted: true } : {}) }
}

/**
 * Preserve provider deltas and fill in text for providers that only emit a
 * final message. Never delay the event reader for presentation effects.
 */
function forwardVisibleText(
  notification: HarnessNotification,
  event: Record<string, unknown> | undefined,
  streamedText: Map<string, string>,
  onNotification: (value: HarnessNotification) => void,
): void {
  if (event === undefined) {
    onNotification(notification)
    return
  }
  const data = record(event.data)
  if (event.type === 'assistant/stream') {
    if (data?.type === 'start') {
      streamedText.clear()
      onNotification(notification)
    } else if (data?.type === 'chunk') {
      const chunk = record(data.chunk)
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        const key = assistantStepKey(data)
        streamedText.set(key, `${streamedText.get(key) ?? ''}${chunk.text}`)
        onNotification(textChunkNotification(notification, event, chunk.text))
      }
    }
    return
  }
  const key = assistantStepKey(data)
  if (event.type === 'text-chunks') {
    const text = stringTexts(data?.texts)
    if (!text) {
      onNotification(notification)
      return
    }
    onNotification(notification)
    streamedText.set(key, `${streamedText.get(key) ?? ''}${text}`)
    return
  }
  if (event.type === 'assistant/message') {
    const finalText = assistantText(event)
    const previous = streamedText.get(key) ?? ''
    const missing = finalText.startsWith(previous) ? finalText.slice(previous.length) : ''
    if (missing) onNotification(textChunkNotification(notification, event, missing))
    if (finalText) streamedText.set(key, finalText)
  }
  onNotification(notification)
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

/** Streamed text is keyed per turn and step so a segment survives the tool calls
 *  around it: text between tool calls is its own segment, never cleared away. */
function assistantStepKey(data: Record<string, unknown> | undefined): string {
  return `${integer(data?.turn) ?? 0}:${integer(data?.step) ?? 0}`
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function stringTexts(value: unknown): string {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join('') : ''
}

async function beforeDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
  timeoutMs: number,
): Promise<T> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new TurnTimeoutError(timeoutMs)
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TurnTimeoutError(timeoutMs)), remaining)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * A restored official session can finish registration just after the SDK
 * server's first lookup. In that narrow case the server rejects the lookup
 * with "already exists" even though no prompt was accepted. Re-issue only
 * this lookup once; all provider/model requests remain single-dispatch.
 */
async function promptWithSessionRegistrationRecovery(
  client: Pick<SessionClient, 'prompt'>,
  sessionId: string,
  content: SdkPromptContentBlock[],
  deadline: number,
  timeoutMs: number,
): Promise<string> {
  try {
    return await beforeDeadline(() => client.prompt(sessionId, content), deadline, timeoutMs)
  } catch (error) {
    if (!isSessionAlreadyRegisteredError(error)) throw error
    await beforeDeadline(() => delay(50), deadline, timeoutMs)
    return beforeDeadline(() => client.prompt(sessionId, content), deadline, timeoutMs)
  }
}

function isSessionAlreadyRegisteredError(error: unknown): boolean {
  return /session\s+"[^"\n]+"\s+already exists/u.test(error instanceof Error ? error.message : String(error))
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

function encodedInputImage(input: ImageRunInput): SdkPromptContentBlock {
  if (input.data.length === 0 || input.data.length > IMAGE_LIMITS.maxImageBytes) throw new Error('图片为空或超过 10 MB，请缩小后重试')
  return {
    type: 'image',
    data: input.data.toString('base64'),
    mimeType: input.mediaType,
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

export function hasAuthorizedRoots(value: string | undefined): boolean {
  if (!value?.trim()) return false
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.length > 0
  } catch {
    return true
  }
}

/** Read the same JSONL persistence backend mounted by the official sdk profile. */
async function inspectOfficialSession(sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<SessionInspection | undefined> {
  const root = resolve(env.DSH_SESSION_ROOT ?? resolve(env.DSH_HOME ?? '.dsh', 'sessions'))
  let context: Context | undefined
  try {
    context = new Context()
    const persistence = new JsonlSessionPersistence(context, { root, compression: SESSION_COMPRESSION })
    const snapshot = await persistence.stat(sessionId as never)
    if (!snapshot) return undefined
    const handle = await persistence.open(sessionId as never, 'read')
    try {
      const { events } = await handle.read()
      const state = events.reduce<XiaoyinTaskState>((current, event) => reduceEvent(current, event), { value: initialXiaoyinTaskView(), toolNames: {} })
      const projection = state.value
      const messages = rebuildSessionMessages(events)
      const pendingTools = projection.steps.filter((step) => step.kind === 'tool' && step.status === 'running').length
      const lastEvent = events.at(-1)
      const status = projection.status === 'running' ? 'running' : projection.status === 'completed' ? 'completed' : projection.status === 'failed' ? 'failed' : projection.status === 'canceled' ? 'idle' : 'unknown'
      return {
        sessionId,
        status,
        updatedAt: projection.updatedAt,
        ...(lastEvent?.type ? { lastEventType: lastEvent.type } : {}),
        pendingTools,
        projection,
        // The official browser Conversation assembler replays the Session
        // journal itself. Keep this separate from the product projection so
        // callers never mistake a Xiaoyin view for authoritative history.
        events: events as unknown as Array<Record<string, unknown>>,
        messages,
      }
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  } finally {
    await disposeCordisContext(context)
  }
}

async function searchOfficialSessions(sessionIds: string[], query: string, limit: number, cursor: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<SessionSearchPage> {
  let rebuiltCorruptIndex = false
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await searchOfficialSessionsOnce(sessionIds, query, limit, cursor, env)
    } catch (error) {
      if (!rebuiltCorruptIndex && isCorruptSessionQueryIndex(error)) {
        const queryPath = resolve(env.XIAOYIN_SESSION_QUERY_PATH ?? resolve(env.DSH_HOME ?? '.dsh', 'session-query.sqlite'))
        await rebuildCorruptSessionQueryIndex(queryPath)
        rebuiltCorruptIndex = true
        continue
      }
      if (attempt >= 8 || !(isTransientSessionQueryIndexError(error) || await isIndexCreationRace(error, env))) throw error
      await delay(Math.min(50 * (2 ** attempt), 2_000))
    }
  }
}

async function rebuildCorruptSessionQueryIndex(queryPath: string): Promise<void> {
  rebuild: for (;;) {
    let lock
    try {
      lock = await open(`${queryPath}.rebuild.lock`, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await delay(50)
        try {
          const info = await lstat(`${queryPath}.rebuild.lock`)
          if (Date.now() - info.mtimeMs > 30_000) {
            await rm(`${queryPath}.rebuild.lock`, { force: true })
            continue rebuild
          }
        } catch (reason) {
          if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return
          throw reason
        }
      }
      throw new Error('session-search derived index rebuild lock timed out')
    }
    try {
      await Promise.all([queryPath, `${queryPath}-wal`, `${queryPath}-shm`].map((path) => rm(path, { force: true })))
      return
    } finally {
      await lock.close()
      await rm(`${queryPath}.rebuild.lock`, { force: true })
    }
  }
}

async function acquireSessionQueryIndexLock(queryPath: string): Promise<{ close: () => Promise<void> }> {
  const lockPath = `${queryPath}.access.lock`
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      return {
        close: async () => {
          await handle.close()
          await rm(lockPath, { force: true })
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const info = await lstat(lockPath)
        if (Date.now() - info.mtimeMs > 30_000) {
          await rm(lockPath, { force: true })
          continue
        }
      } catch (reason) {
        if ((reason as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw reason
      }
      await delay(50)
    }
  }
  throw new Error('session-search derived index access lock timed out')
}

function isCorruptSessionQueryIndex(error: unknown): boolean {
  const messages: string[] = []
  let current: unknown = error
  for (let depth = 0; current !== undefined && depth < 6; depth += 1) {
    messages.push(current instanceof Error ? current.message : String(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return /database disk image is malformed|file is not a database|SQLITE_CORRUPT|SQLITE_NOTADB/iu.test(messages.join('\n'))
}

async function searchOfficialSessionsOnce(sessionIds: string[], query: string, limit: number, cursor: string | undefined, env: NodeJS.ProcessEnv): Promise<SessionSearchPage> {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 200)) : 100
  const ids = [...new Set(sessionIds)]
  if (ids.length === 0) return { items: [] }
  const root = resolve(env.DSH_SESSION_ROOT ?? resolve(env.DSH_HOME ?? '.dsh', 'sessions'))
  const queryPath = resolve(env.XIAOYIN_SESSION_QUERY_PATH ?? resolve(env.DSH_HOME ?? '.dsh', 'session-query.sqlite'))
  const indexLock = await acquireSessionQueryIndexLock(queryPath)
  const context = new Context()
  try {
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(JsonlSessionPersistence, { root, compression: SESSION_COMPRESSION })
    await context.plugin(SqliteSessionQueryEngine, { path: queryPath, openAt: 'first-search', defaultLimit: boundedLimit, maxLimit: boundedLimit })
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(query)) return await searchCjkSessions(context, ids, query.trim(), boundedLimit, cursor)
    const page = await context.sessionQuery.searchSessions({
      query: query.trim(),
      sessionFilters: [{ kind: 'id', values: ids.map((id) => SessionId(id)) }],
      limit: boundedLimit,
      ...(cursor ? { cursor: cursor as never } : {}),
    })
    return {
      items: page.items.map((hit) => ({ sessionId: String(hit.header.id), updatedAt: new Date(hit.bestMatch.time).toISOString(), excerpt: hit.bestMatch.snippet })),
      ...(page.nextCursor ? { nextCursor: String(page.nextCursor) } : {}),
    }
  } finally {
    try { await disposeCordisContext(context) } finally { await indexLock.close() }
  }
}

async function searchCjkSessions(context: Context, ids: string[], query: string, limit: number, cursor?: string): Promise<SessionSearchPage> {
  const fingerprint = createHash('sha256').update(JSON.stringify([ids, query])).digest('hex')
  let offset = 0
  if (cursor !== undefined) {
    const parsed = /^scan-v1:([1-9]\d*):([a-f0-9]{64})$/u.exec(cursor)
    if (!parsed || parsed[2] !== fingerprint || !Number.isSafeInteger(Number(parsed[1])) || Number(parsed[1]) >= ids.length) throw new Error('Session search cursor is invalid for this query')
    offset = Number(parsed[1])
  }
  const items: SessionSearchHit[] = []
  const lowerQuery = query.toLocaleLowerCase()
  while (offset < ids.length && items.length < limit) {
    const batch = ids.slice(offset, offset + 4)
    const matchesBySession = await Promise.all(batch.map(async (sessionId) => {
      try { return await context.sessionQuery.filterEvents(SessionId(sessionId), [{ kind: 'text', text: query }]) }
      catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return []; throw error }
    }))
    for (const matches of matchesBySession) {
      const sessionId = ids[offset++]!
      const match = matches.at(-1)
      if (match) {
        const index = match.text.toLocaleLowerCase().indexOf(lowerQuery)
        items.push({ sessionId, updatedAt: new Date(match.time).toISOString(), excerpt: match.text.slice(Math.max(0, index - 60), Math.max(0, index - 60) + 240) })
      }
      if (items.length >= limit) break
    }
  }
  return { items, ...(offset < ids.length ? { nextCursor: `scan-v1:${offset}:${fingerprint}` } : {}) }
}

async function isIndexCreationRace(error: unknown, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!/is not an empty or recognized derived index/iu.test(String((error as { message?: unknown } | undefined)?.message ?? error))) return false
  const queryPath = resolve(env.XIAOYIN_SESSION_QUERY_PATH ?? resolve(env.DSH_HOME ?? '.dsh', 'session-query.sqlite'))
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(queryPath, { readOnly: true })
    try {
      const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: unknown }>
      return rows.some((row) => ['persisted_sessions', 'search_state', 'persisted_docs'].includes(String(row.name)))
    } finally { database.close() }
  } catch { return false }
}

function isTransientSessionQueryIndexError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current !== undefined && depth < 6; depth += 1) {
    const value = current as { message?: unknown; cause?: unknown }
    if (/database is locked|database table is locked|SQLITE_BUSY|no such table: (?:persisted_sessions|search_state|persisted_docs)/iu.test(String(value?.message ?? current))) return true
    current = value?.cause
  }
  return false
}

/** Cordis owns async plugin cleanup on the root Fiber, not Context itself. */
async function disposeCordisContext(context: Context | undefined): Promise<void> {
  if (context === undefined) return
  const fiber = (context as unknown as { fiber?: { dispose?: () => Promise<void> } }).fiber
  await fiber?.dispose?.()
}

/** Rebuild the product transcript from the Harness surface, never from a second local store. */
function rebuildSessionMessages(events: readonly unknown[]): Array<{ id: string; role: 'user' | 'assistant'; text: string }> {
  try {
    const surface = foldSurface(events as never).nodes
    return surface.flatMap((seq) => {
      const event = events[Number(seq)] as Record<string, unknown> | undefined
      if (!event || !['user/message', 'assistant/message'].includes(String(event.type))) return []
      const message = deriveEventMessage(event as never) as Record<string, unknown> | null
      if (!message || (message.role !== 'user' && message.role !== 'assistant')) return []
      if (message.role === 'user' && record(message.source)?.kind !== 'user') return []
      const content = Array.isArray(message.content) ? message.content : []
      const text = content.flatMap((block) => {
        const value = block as Record<string, unknown>
        return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : []
      }).join('')
      const visibleText = message.role === 'user' ? visibleTaskPrompt(text) : text
      if (!visibleText.trim()) return []
      return [{ id: typeof message.id === 'string' ? message.id : `${event.type}:${seq}`, role: message.role, text: visibleText }]
    })
  } catch {
    // A projection can still be useful when a future event vocabulary cannot be folded.
    return events.flatMap((event, index) => {
      const value = event as Record<string, unknown>
      if (value?.type !== 'assistant/message' && value?.type !== 'user/message') return []
      const data = value.type === 'user/message' ? value.data : (value.data as Record<string, unknown> | undefined)?.message
      if (value.type === 'user/message' && record((data as Record<string, unknown> | undefined)?.source)?.kind !== 'user') return []
      const content = (data as Record<string, unknown> | undefined)?.content
      const text = Array.isArray(content) ? content.flatMap((block) => {
        const item = block as Record<string, unknown>
        return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
      }).join('') : ''
      const visibleText = value.type === 'user/message' ? visibleTaskPrompt(text) : text
      return visibleText.trim() ? [{ id: `${value.type}:${index}`, role: value.type === 'user/message' ? 'user' as const : 'assistant' as const, text: visibleText }] : []
    })
  }
}
