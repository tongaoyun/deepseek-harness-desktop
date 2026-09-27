import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import {
  apply as applyHarnessMcpClient,
  type Config as HarnessMcpConfig,
} from '@deepseek-ai/dsh-mcp-client'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { rememberCapabilityNotice, flushCapabilityNotices } from './capability-notice.js'
import { HarnessError, data as errorData } from './errors.js'
import { WriteOperationJournal } from './write-operation-journal.js'

export const name = 'xiaoyin-managed-mcp'
export const inject = ['tools']

export interface ManagedConnectorConfig {
  timeoutSeconds?: number
  reconnect?: {
    enabled?: boolean
    initialDelayMs?: number
    maxDelayMs?: number
    maxAttempts?: number
  }
  id: string
  name: string
  version: string
  transport: 'streamable-http' | 'stdio'
  url: string
  authMode: 'employee-bearer' | 'erp-cookie' | 'oauth' | 'none'
  command: string
  arguments: string[]
  environment: Record<string, string>
  headers: Record<string, string>
  /** Raw MCP names selected by the immutable CapabilitySnapshot. */
  allowedTools: string[]
  /** Raw MCP names that must exist when the Session starts. */
  requiredTools: string[]
  /**
   * Server-synchronized ToolSpec annotations. This is an immutable capability
   * snapshot value, not a user-manageable allow-list. The MCP client remains
   * authoritative for the live tool set; anything absent from this snapshot
   * is treated as a write-capable tool and therefore cannot bypass approval.
   */
  readOnlyTools: string[]
  allowWrite: boolean
  requireWriteApproval: boolean
  required: boolean
}

export interface Config {
  connectors?: ManagedConnectorConfig[]
  employeeBearerTokenEnv?: string
}

export type ConnectorDiagnosticStatus = 'ready' | 'drift' | 'authentication-required' | 'access-denied' | 'unavailable'

export interface ConnectorDiagnosticResult {
  id: string
  status: ConnectorDiagnosticStatus
  latencyMs: number
  discoveredTools: string[]
  missingTools: string[]
  undeclaredTools: string[]
  error?: string
}

const ConnectorConfig = z.object({
  timeoutSeconds: z.number().default(60),
  reconnect: z.object({
    enabled: z.boolean().default(true),
    initialDelayMs: z.number().default(500),
    maxDelayMs: z.number().default(30_000),
    maxAttempts: z.number().default(10),
  }).default({ enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 }),
  id: z.string().required(),
  name: z.string().required(),
  version: z.string().default('1'),
  transport: z.union(['streamable-http', 'stdio']).default('streamable-http'),
  url: z.string().default(''),
  authMode: z.union(['employee-bearer', 'erp-cookie', 'oauth', 'none']).default('none'),
  command: z.string().default(''),
  arguments: z.array(z.string()).default([]),
  environment: z.dict(z.string()).default({}),
  headers: z.dict(z.string()).default({}),
  allowedTools: z.array(z.string()).default([]),
  requiredTools: z.array(z.string()).default([]),
  readOnlyTools: z.array(z.string()).default([]),
  allowWrite: z.boolean().default(false),
  requireWriteApproval: z.boolean().default(true),
  required: z.boolean().default(false),
})

export const Config: Schemastery<Config> = z.object({
  connectors: z.array(ConnectorConfig).default([]),
  employeeBearerTokenEnv: z.string().default('XIAOYIN_EMPLOYEE_BEARER_TOKEN'),
})

interface RegisteredConnectorTool {
  connector: ManagedConnectorConfig
  rawName: string
  readOnly: boolean
}

interface PolicyTracker {
  context: CordisContext
  installedRaw: Set<string>
  unknownPublic: Set<string>
  assertRequired(): void
}

/**
 * Mounts the official MCP client for every selected connector. The policy
 * adapter sees only ToolRuntime registrations and Harness execution events;
 * it never creates a transport, lists tools, or sends a tools/call request.
 */
export async function apply(ctx: CordisContext, config: Config = {}): Promise<void> {
  const employeeToken = config.employeeBearerTokenEnv
    ? process.env[config.employeeBearerTokenEnv]?.trim()
    : undefined
  const registered = new Map<string, RegisteredConnectorTool>()
  const scopeFile = process.env.XIAOYIN_OPERATION_SCOPE_FILE
  const journal = process.env.XIAOYIN_OPERATION_JOURNAL
    ? new WriteOperationJournal(process.env.XIAOYIN_OPERATION_JOURNAL, scopeFile
      ? () => readFileSync(scopeFile, 'utf8').trim()
      : process.env.XIAOYIN_OPERATION_SCOPE ?? '')
    : undefined
  if (journal) ctx.effect(() => () => journal.close(), 'connector write operation journal')

  for (const connector of config.connectors ?? []) {
    try {
      validateConnector(connector, employeeToken)
      const tracker = connectorPolicyContext(ctx, connector, registered)
      await applyHarnessMcpClient(tracker.context, harnessMcpConfig(connector, employeeToken))
      tracker.assertRequired()
      if (tracker.installedRaw.size === 0 && connector.allowedTools.length > 0) {
        rememberCapabilityNotice({
          kind: 'connector', id: connector.id, name: connector.name,
          reason: `${connector.name} 当前没有注册快照允许的 MCP 工具`,
        })
      }
    } catch (error) {
      const detail = connectorFailureMessage(error, connector, employeeToken)
      if (connector.required || connector.requiredTools.length > 0) throw connectorFailure(error, connector, employeeToken)
      process.stderr.write(`${detail}；本次会话跳过该连接器\n`)
      rememberCapabilityNotice({ kind: 'connector', id: connector.id, name: connector.name, reason: detail })
    }
  }

  const stopNoticeDelivery = ctx.on('agent/created', ({ agent }) => {
    flushCapabilityNotices(String(agent.session.id))
  })
  const stopApprovalPolicy = ctx.on('tools/pre-execute', (exec, next) => {
    const tool = registered.get(exec.name)
    if (!tool || tool.readOnly || !tool.connector.requireWriteApproval) return next()
    return Promise.resolve({
      kind: 'ask' as const,
      reason: `调用「${tool.connector.name}」修改工具：${tool.rawName}\n参数：${safeArguments(exec.arguments)}`,
    })
  })
  const stopWriteJournal = ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const tool = registered.get(exec.name)
    if (!journal || !tool || tool.readOnly) return next()
    return journal.execute(tool.connector, tool.rawName, exec.arguments, next, exec.signal)
  })
  ctx.effect(() => () => {
    stopNoticeDelivery()
    stopApprovalPolicy()
    stopWriteJournal()
  }, 'xiaoyin connector policy adapter')
}

/** Stable official MCP namespace. Hashing prevents sanitized connector IDs colliding. */
export function harnessServerName(id: string): string {
  const readable = id.replaceAll(/[^A-Za-z0-9_-]+/g, '_').replaceAll(/_+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 20) || 'connector'
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 10)
  return `${readable}_${digest}`.slice(0, 32)
}

export function connectorTimeoutMs(connector: Pick<ManagedConnectorConfig, 'timeoutSeconds'>): number {
  const seconds = connector.timeoutSeconds ?? 60
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new Error('连接器超时时间须为 1–600 秒')
  return seconds * 1000
}

export function hasEligibleHarnessMcpConnector(env: NodeJS.ProcessEnv): boolean {
  try {
    return configuredConnectors(env.XIAOYIN_MCP_CONNECTORS).length > 0
  } catch {
    return false
  }
}

function harnessMcpConfig(connector: ManagedConnectorConfig, employeeToken?: string): HarnessMcpConfig {
  const common = {
    serverName: harnessServerName(connector.id),
    toolCallTimeoutMs: connectorTimeoutMs(connector),
    failOnStartupError: connector.required || connector.requiredTools.length > 0,
    ...(connector.reconnect ? { reconnect: connector.reconnect } : {}),
  }
  if (connector.transport === 'stdio') {
    return {
      ...common,
      transport: 'stdio',
      command: connector.command,
      args: connector.arguments,
      env: connector.environment,
      cwd: process.env.DSH_CWD ?? process.cwd(),
    }
  }
  return {
    ...common,
    transport: 'streamable-http',
    url: connector.url,
    headers: connectorHeaders(connector, employeeToken),
  }
}

function connectorPolicyContext(
  ctx: CordisContext,
  connector: ManagedConnectorConfig,
  registered: Map<string, RegisteredConnectorTool>,
): PolicyTracker {
  const serverName = harnessServerName(connector.id)
  const allowedRaw = new Set(connector.allowedTools)
  const readOnlyRaw = new Set(connector.readOnlyTools)
  const rawByPublic = new Map([...new Set([
    ...connector.allowedTools,
    ...connector.requiredTools,
    ...connector.readOnlyTools,
  ])].map((rawName) => [officialMcpToolName(serverName, rawName), rawName]))
  const installedRaw = new Set<string>()
  const unknownPublic = new Set<string>()
  const tools = new Proxy(ctx.tools, {
    get(target, property) {
      if (property === 'register') {
        return (definition: ToolDefinition): (() => void) => {
          const rawName = rawByPublic.get(definition.name)
          if (!rawName) {
            unknownPublic.add(definition.name)
            return () => undefined
          }
          const readOnly = readOnlyRaw.has(rawName)
          if (!allowedRaw.has(rawName) || (!connector.allowWrite && !readOnly)) return () => undefined
          installedRaw.add(rawName)
          registered.set(definition.name, { connector, rawName, readOnly })
          const dispose = target.register(definition)
          return () => {
            dispose()
            installedRaw.delete(rawName)
            registered.delete(definition.name)
          }
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const context = new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') return tools
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    context,
    installedRaw,
    unknownPublic,
    assertRequired() {
      const missing = uniqueSorted(connector.requiredTools.filter((rawName) => !installedRaw.has(rawName)))
      if (missing.length > 0) throw new Error(`${connector.name} 缺少可用的必需工具：${missing.join('、')}`)
    },
  }
}

/** Connector diagnostics use the exact official client and ToolRuntime path. */
export async function diagnoseConfiguredConnectors(timeoutMs = 10_000): Promise<ConnectorDiagnosticResult[]> {
  const connectors = configuredConnectors(process.env.XIAOYIN_MCP_CONNECTORS)
  const employeeToken = process.env.XIAOYIN_EMPLOYEE_BEARER_TOKEN?.trim()
  return Promise.all(connectors.map((connector) => diagnoseConnector(connector, employeeToken, timeoutMs)))
}

export async function diagnoseConnector(
  connector: ManagedConnectorConfig,
  employeeToken: string | undefined,
  timeoutMs = 10_000,
): Promise<ConnectorDiagnosticResult> {
  const startedAt = performance.now()
  const ctx = new Context()
  try {
    validateConnector(connector, employeeToken)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const diagnostic = { ...connector, timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)), required: true }
    const tracker = connectorPolicyContext(ctx, diagnostic, new Map())
    await applyHarnessMcpClient(tracker.context, {
      ...harnessMcpConfig(diagnostic, employeeToken),
      failOnStartupError: true,
      reconnect: { enabled: false },
    })
    const discoveredTools = uniqueSorted([...tracker.installedRaw])
    const missingTools = uniqueSorted(connector.requiredTools.filter((tool) => !tracker.installedRaw.has(tool)))
    const undeclaredTools = uniqueSorted([...tracker.unknownPublic])
    return {
      id: connector.id,
      status: missingTools.length > 0 || undeclaredTools.length > 0 ? 'drift' : 'ready',
      latencyMs: elapsedMilliseconds(startedAt),
      discoveredTools,
      missingTools,
      undeclaredTools,
    }
  } catch (error) {
    const status = diagnosticFailureStatus(error)
    return {
      id: connector.id,
      status,
      latencyMs: elapsedMilliseconds(startedAt),
      discoveredTools: [],
      missingTools: [],
      undeclaredTools: [],
      error: status === 'authentication-required' ? '服务需要登录授权或凭据已失效'
        : status === 'access-denied' ? '当前凭据没有访问权限'
        : diagnosticError(error, employeeToken, [
            ...Object.values(connector.headers ?? {}),
            ...Object.values(connector.environment ?? {}),
          ]),
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

export function compareConnectorTools(
  declaredTools: string[],
  discoveredTools: string[],
): Pick<ConnectorDiagnosticResult, 'discoveredTools' | 'missingTools' | 'undeclaredTools'> {
  const declared = uniqueSorted(declaredTools)
  const discovered = uniqueSorted(discoveredTools)
  const declaredSet = new Set(declared)
  const discoveredSet = new Set(discovered)
  return {
    discoveredTools: discovered,
    missingTools: declared.filter((tool) => !discoveredSet.has(tool)),
    undeclaredTools: discovered.filter((tool) => !declaredSet.has(tool)),
  }
}

export function diagnosticFailureStatus(error: unknown): ConnectorDiagnosticStatus {
  const chain = errorChain(error)
  const status = chain.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const candidate = value as { status?: unknown; code?: unknown }
    return [candidate.status, candidate.code]
  }).find((value) => value === 401 || value === 403)
  if (status === 401 || chain.some((value) => /unauthori[sz]ed|\b401\b/i.test(safeError(value)))) return 'authentication-required'
  if (status === 403 || chain.some((value) => /forbidden|\b403\b/i.test(safeError(value)))) return 'access-denied'
  return 'unavailable'
}

export function connectorFailureMessage(error: unknown, connector: ManagedConnectorConfig, employeeToken?: string): string {
  const status = diagnosticFailureStatus(error)
  return status === 'authentication-required'
    ? '凭据已失效，请重新授权后继续任务'
    : status === 'access-denied'
      ? '当前账号或凭据没有访问权限，请检查授权范围'
      : diagnosticError(error, employeeToken, [
          ...Object.values(connector.headers ?? {}),
          ...Object.values(connector.environment ?? {}),
        ])
}

function connectorFailure(error: unknown, connector: ManagedConnectorConfig, employeeToken?: string): HarnessError {
  const status = diagnosticFailureStatus(error)
  return new HarnessError(errorData(
    status === 'authentication-required' ? 'XY-CONNECTOR-AUTH'
      : status === 'access-denied' ? 'XY-CONNECTOR-PERMISSION' : 'XY-CONNECTOR',
    'connector',
    status === 'authentication-required' ? '连接器需要重新授权'
      : status === 'access-denied' ? '连接器权限不足' : '连接器暂不可用',
    connectorFailureMessage(error, connector, employeeToken),
    true,
    false,
  ))
}

function validateConnector(connector: ManagedConnectorConfig, employeeToken?: string): void {
  connectorTimeoutMs(connector)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(connector.id)) throw new Error('连接器 ID 无效')
  if (connector.transport === 'stdio') {
    if (!connector.command.trim()) throw new Error(`${connector.name} 缺少 stdio 命令`)
    if (connector.authMode !== 'none') throw new Error(`${connector.name} 的 stdio 连接器不能使用 HTTP 认证`)
  } else {
    const endpoint = new URL(connector.url)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new Error(`${connector.name} 的 MCP 地址无效`)
    }
  }
  if (connector.authMode === 'employee-bearer' && !employeeToken) throw new Error(`${connector.name} 缺少员工登录凭据`)
  if (connector.authMode === 'oauth' && !header(connector.headers, 'authorization')) throw new Error(`${connector.name} 需要重新授权`)
  if (connector.authMode === 'erp-cookie' && !header(connector.headers, 'cookie')) throw new Error(`${connector.name} 需要重新登录`)
  const allowed = new Set(connector.allowedTools)
  const undeclaredRequired = connector.requiredTools.filter((tool) => !allowed.has(tool))
  if (undeclaredRequired.length > 0) throw new Error(`${connector.name} 的必需工具不在当前能力快照中：${undeclaredRequired.join('、')}`)
  const duplicateReadOnly = connector.readOnlyTools.filter((tool, index, values) => values.indexOf(tool) !== index)
  if (duplicateReadOnly.length > 0) throw new Error(`${connector.name} 的只读工具快照包含重复项：${uniqueSorted(duplicateReadOnly).join('、')}`)
  const undeclaredReadOnly = connector.readOnlyTools.filter((tool) => !allowed.has(tool))
  if (undeclaredReadOnly.length > 0) throw new Error(`${connector.name} 的只读工具快照不在当前能力快照中：${uniqueSorted(undeclaredReadOnly).join('、')}`)
}

function connectorHeaders(connector: ManagedConnectorConfig, employeeToken?: string): Record<string, string> {
  const headers = { ...connector.headers }
  if (connector.authMode === 'employee-bearer' && employeeToken) headers.authorization = `Bearer ${employeeToken}`
  return headers
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
  return entry?.[1]?.trim() || undefined
}

function configuredConnectors(value: string | undefined): ManagedConnectorConfig[] {
  if (!value?.trim()) return []
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('连接器诊断配置无效')
  return parsed as ManagedConnectorConfig[]
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

/** Mirrors the published dsh-mcp-client naming contract. */
export function officialMcpToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replaceAll(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= 64) return normalized
  const digest = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${digest}`
}

function errorChain(error: unknown): unknown[] {
  const result: unknown[] = []
  let current = error
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    result.push(current)
    current = current && typeof current === 'object' && 'cause' in current
      ? (current as { cause?: unknown }).cause
      : undefined
  }
  return result
}

export function diagnosticError(error: unknown, employeeToken: string | undefined, connectorSecrets: string[] = []): string {
  const messages = errorChain(error).map(safeError).filter(Boolean)
  const message = messages.at(-1) ?? messages[0] ?? '连接器不可用'
  if (/abort|timeout|timed out/i.test(message)) return '连接或 MCP 握手超时'
  const secrets = [employeeToken, ...connectorSecrets].filter((value): value is string => Boolean(value))
  let safe = message.replaceAll(/[\r\n\t]+/g, ' ').trim().slice(0, 500)
  for (const secret of secrets) if (secret.length >= 4) safe = safe.replaceAll(secret, '[REDACTED]')
    safe = safe.replaceAll(/Bearer\s+[A-Za-z0-9._~+-]+/gi, 'Bearer [REDACTED]')
  return safe || '连接器不可用'
}

function safeArguments(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text.length > 1000 ? `${text.slice(0, 1000)}…` : text
  } catch {
    return '[无法显示参数]'
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
