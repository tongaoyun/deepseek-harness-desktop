import { rememberCapabilityNotice, flushCapabilityNotices } from './capability-notice.js'
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { apply as applyHarnessMcpClient } from '@deepseek-ai/dsh-mcp-client'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-sdk-client'
import { mcpResultContent } from './mcp-result-content.js'
import { erpCookieFetch, ErpCookieError } from './erp-cookie-fetch.js'
import { connectorOAuthFetch } from './connector-oauth-fetch.js'
import { WriteOperationJournal, UncertainOperationError } from './write-operation-journal.js'
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  SdkHttpError,
  SseError,
  UnauthorizedError,
  type CallToolResult,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

export const name = 'xiaoyin-managed-mcp'
export const inject = ['tools', 'attachments']

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
  transport: 'streamable-http' | 'sse' | 'stdio'
  url: string
  authMode: 'employee-bearer' | 'erp-cookie' | 'oauth' | 'none'
  command: string
  arguments: string[]
  environment: Record<string, string>
  headers: Record<string, string>
  allowedTools: string[]
  requiredTools: string[]
  readOnlyTools?: string[]
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
  transport: z.union(['streamable-http', 'sse', 'stdio']).default('streamable-http'),
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

interface InstalledTool {
  name: string
  raw: Tool
  dispose: () => void
}

interface ConnectorBinding {
  connector: ManagedConnectorConfig
  client: Client
  transport: Transport
  journal: WriteOperationJournal | undefined
  installed: InstalledTool[]
  namesByRawTool: Map<string, string>
  reconnectAttempt: number
  reconnectTimer?: NodeJS.Timeout
  refreshQueue: Promise<void>
  closed: boolean
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const connectors = config.connectors ?? []
  const employeeToken = config.employeeBearerTokenEnv
    ? process.env[config.employeeBearerTokenEnv]?.trim()
    : undefined
  const bindings: ConnectorBinding[] = []
  const mutatingTools = new Map<string, string>()
  const registeredNames = new Set<string>()
  const scopeFile = process.env.XIAOYIN_OPERATION_SCOPE_FILE
  const journal = process.env.XIAOYIN_OPERATION_JOURNAL
    ? new WriteOperationJournal(process.env.XIAOYIN_OPERATION_JOURNAL, scopeFile
      ? () => readFileSync(scopeFile, 'utf8').trim() : process.env.XIAOYIN_OPERATION_SCOPE ?? '') : undefined
  if (journal) ctx.effect(() => () => journal.close(), 'write operation journal')

  for (const connector of connectors) {
    if (shouldUseHarnessMcpClient(connector)) {
      try {
        await applyHarnessMcpClient(ctx, harnessMcpConfig(connector, employeeToken))
        debug(`${connector.name}: connected through dsh-mcp-client`)
      } catch (error) {
        const message = connectorFailureMessage(error, connector, employeeToken)
        if (connector.required) {
          await cleanupBindings(bindings, mutatingTools)
          throw new Error(message)
        }
        process.stderr.write(`${message}；本次会话跳过该连接器\n`)
      // The employee asked for this connector: the turn says it was skipped
      // instead of quietly answering without it.
      rememberCapabilityNotice({ kind: 'connector', id: connector.id, name: connector.name, reason: message })
      }
      continue
    }
    let client: Client | undefined
    let binding: ConnectorBinding | undefined
    try {
      validateConnector(connector, employeeToken)
      client = new Client({ name: `xiaoyin-desktop-${connector.id}`, version: '0.1.0' })
      const transport = createTransport(connector, employeeToken)
      const activeBinding: ConnectorBinding = {
        connector,
        client,
        transport,
        journal,
        installed: [],
        namesByRawTool: new Map(),
        reconnectAttempt: 0,
        refreshQueue: Promise.resolve(),
        closed: false,
      }
      binding = activeBinding
      transport.onclose = () => {
        if (!activeBinding.closed && bindings.includes(activeBinding) && activeBinding.client === client) {
          scheduleReconnect(ctx, activeBinding, employeeToken, registeredNames, mutatingTools)
        }
      }
      await client.connect(transport, connectorRequestOptions(connector))

      const discovered = await discoverConnectorTools(client, connectorRequestOptions(connector).timeout)
      const tools = selectTools(
        discovered,
        connector.allowedTools,
        connector.requiredTools,
        connector.allowWrite,
        connector.name,
      )
      installConnectorTools(ctx, activeBinding, tools, registeredNames, mutatingTools, employeeToken, journal)
      client.setNotificationHandler('notifications/tools/list_changed', () => {
        activeBinding.refreshQueue = activeBinding.refreshQueue
          .then(() => refreshConnectorTools(ctx, activeBinding, registeredNames, mutatingTools, employeeToken, journal))
          .catch((error) => logConnectorRefreshFailure(activeBinding.connector, employeeToken, error))
      })
      bindings.push(activeBinding)
      debug(`${connector.name}: connected, registered=${tools.length}`)
    } catch (error) {
      if (client) await closeQuietly(client)
      const message = connectorFailureMessage(error, connector, employeeToken)
      if (connector.required) {
        await cleanupBindings(bindings, mutatingTools)
        throw new Error(message)
      }
      process.stderr.write(`${message}；本次会话跳过该连接器\n`)
      // The employee asked for this connector: the turn says it was skipped
      // instead of quietly answering without it.
      rememberCapabilityNotice({ kind: 'connector', id: connector.id, name: connector.name, reason: message })
      if (binding) {
        bindings.push(binding)
        scheduleReconnect(ctx, binding, employeeToken, registeredNames, mutatingTools)
      }
    }
  }

  // Connectors connect before any session exists; the gaps they reported are
  // delivered against the session that is starting.
  const stopNoticeDelivery = ctx.on('agent/created', ({ agent }) => {
    flushCapabilityNotices(String(agent.session.id))
  })

  const stopApprovalPolicy = ctx.on('tools/pre-execute', (exec, next) => {
    const connectorName = mutatingTools.get(exec.name)
    if (!connectorName) return next()
    return Promise.resolve({
      kind: 'ask' as const,
      reason: `调用「${connectorName}」修改工具：${exec.name}\n参数：${safeArguments(exec.arguments)}`,
    })
  })

  ctx.effect(() => async () => {
    stopNoticeDelivery()
    stopApprovalPolicy()
    for (const binding of bindings) binding.closed = true
    for (const binding of bindings) if (binding.reconnectTimer) clearTimeout(binding.reconnectTimer)
    await cleanupBindings(bindings, mutatingTools)
  }, 'xiaoyin managed MCP connectors')
}

/**
 * Use the upstream MCP bridge only when the connector has no Xiaoyin policy
 * overlay to preserve. Restricted, authenticated, or journaled connectors
 * stay on the product adapter so allow-lists and write audits remain intact.
 */
export function shouldUseHarnessMcpClient(connector: ManagedConnectorConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.XIAOYIN_MCP_IMPLEMENTATION !== 'harness') return false
  if (connector.transport === 'sse') return false
  if (connector.authMode !== 'none' && connector.authMode !== 'employee-bearer') return false
  if (connector.allowedTools.length > 0 || connector.requiredTools.length > 0) return false
  if (!connector.allowWrite || connector.requireWriteApproval) return false
  return !env.XIAOYIN_OPERATION_JOURNAL
}

export function hasEligibleHarnessMcpConnector(env: NodeJS.ProcessEnv): boolean {
  try {
    return configuredConnectors(env.XIAOYIN_MCP_CONNECTORS).some((connector) => shouldUseHarnessMcpClient(connector, env))
  } catch {
    return false
  }
}

function harnessMcpConfig(connector: ManagedConnectorConfig, employeeToken?: string) {
  const serverName = harnessServerName(connector.id)
  if (connector.transport === 'stdio') {
    return {
      transport: 'stdio' as const,
      serverName,
      command: connector.command,
      args: connector.arguments,
      env: connector.environment,
      cwd: process.env.DSH_CWD ?? process.cwd(),
      toolCallTimeoutMs: (connector.timeoutSeconds ?? 60) * 1000,
      failOnStartupError: connector.required,
      ...(connector.reconnect ? { reconnect: connector.reconnect } : {}),
    }
  }
  return {
    transport: 'streamable-http' as const,
    serverName,
    url: connector.url,
    headers: {
      ...connector.headers,
      ...(connector.authMode === 'employee-bearer' && employeeToken ? { authorization: `Bearer ${employeeToken}` } : {}),
    },
    toolCallTimeoutMs: (connector.timeoutSeconds ?? 60) * 1000,
    failOnStartupError: connector.required,
    ...(connector.reconnect ? { reconnect: connector.reconnect } : {}),
  }
}

/** Keep dsh-mcp-client server names collision-safe after product id sanitizing. */
export function harnessServerName(id: string): string {
  const readable = id.replaceAll(/[^A-Za-z0-9_-]+/g, '_').replaceAll(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'connector'
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 10)
  return `${readable}_${digest}`.slice(0, 32)
}

export function connectorRequestOptions(connector: Pick<ManagedConnectorConfig, 'timeoutSeconds'>): { timeout: number; maxTotalTimeout: number } {
  const seconds = connector.timeoutSeconds ?? 60
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new Error('连接器超时时间须为 1–600 秒')
  return { timeout: seconds * 1000, maxTotalTimeout: seconds * 1000 }
}

/**
 * Provider-facing function names have a stricter grammar than MCP tool names.
 * Keep the original MCP name inside `execute`, while exposing a stable safe name
 * to the model. Prefixing also prevents collisions with Xiaoyin's local tools.
 */
export function uniqueHarnessToolName(connectorId: string, toolName: string, used: Set<string>): string {
  const normalized = `mcp_${connectorId}_${toolName}`
    .replaceAll(/[^a-zA-Z0-9_-]+/g, '_')
    .replaceAll(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  const base = (normalized || 'mcp_tool').slice(0, 60)
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${base.slice(0, 55)}_${suffix}`
    suffix += 1
  }
  return candidate
}

export async function diagnoseConfiguredConnectors(
  timeoutMs = 10_000,
): Promise<ConnectorDiagnosticResult[]> {
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
  let client: Client | undefined
  try {
    validateConnector(connector, employeeToken)
    client = new Client({ name: `xiaoyin-diagnostics-${connector.id}`, version: '0.1.0' })
    await client.connect(createTransport(connector, employeeToken), {
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
    })
    const discovered = await discoverConnectorTools(client, timeoutMs)
    const comparison = compareConnectorTools(connector.allowedTools, discovered.map((tool) => tool.name))
    const selected = new Set(discovered.filter((tool) => (!connector.allowedTools.length || connector.allowedTools.includes(tool.name))
      && (connector.allowWrite || isTrustedReadOnly(tool))).map((tool) => tool.name))
    comparison.missingTools = uniqueSorted([...comparison.missingTools, ...connector.requiredTools.filter((name) => !selected.has(name))])
    return {
      id: connector.id,
      status: comparison.missingTools.length > 0 || comparison.undeclaredTools.length > 0 ? 'drift' : 'ready',
      latencyMs: elapsedMilliseconds(startedAt),
      discoveredTools: comparison.discoveredTools,
      missingTools: comparison.missingTools,
      undeclaredTools: comparison.undeclaredTools,
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
      error: status === 'authentication-required' ? (connector.authMode === 'erp-cookie' ? 'ERP 登录已失效，请重新扫码登录' : '服务需要登录授权或凭据已失效')
        : status === 'access-denied' ? (connector.authMode === 'erp-cookie' ? 'ERP MCP 来源未授权、登录账号与任务不一致或账号没有访问权限' : '当前凭据没有访问权限')
        : diagnosticError(error, employeeToken, [
        ...Object.values(connector.headers ?? {}),
        ...Object.values(connector.environment ?? {}),
      ]),
    }
  } finally {
    if (client) await closeQuietly(client)
  }
}

export function diagnosticFailureStatus(error: unknown): ConnectorDiagnosticStatus {
  if (error instanceof UnauthorizedError) return 'authentication-required'
  const status = error instanceof SdkHttpError || error instanceof ErpCookieError ? error.status : error instanceof SseError ? error.code : undefined
  if (status === 401) return 'authentication-required'
  if (status === 403) return 'access-denied'
  return 'unavailable'
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
    undeclaredTools: declared.length === 0 ? [] : discovered.filter((tool) => !declaredSet.has(tool)),
  }
}

export function selectTools(
  discovered: Tool[],
  allowedTools: string[],
  requiredTools: string[],
  allowWrite: boolean,
  connectorName = 'MCP',
): Tool[] {
  const allowed = new Set(allowedTools)
  const selected = discovered.filter((tool) => (allowed.size === 0 || allowed.has(tool.name))
    && (allowWrite || isTrustedReadOnly(tool)))
  const selectedNames = new Set(selected.map((tool) => tool.name))
  const missing = uniqueSorted(requiredTools.filter((name) => !selectedNames.has(name)))
  if (missing.length) throw new Error(`${connectorName} 缺少可用的必需工具：${missing.join('、')}。请检查工具配置和写入权限`)
  return selected
}

function isTrustedReadOnly(tool: Tool): boolean {
  return tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true
}

export async function discoverConnectorTools(
  client: Pick<Client, 'listTools'>,
  timeoutMs: number,
  refresh = false,
): Promise<Tool[]> {
  const deadline = Date.now() + timeoutMs
  const tools = new Map<string, Tool>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('MCP 工具发现超时')
    const result = await client.listTools(cursor ? { cursor } : {}, {
      timeout: remaining,
      maxTotalTimeout: remaining,
      ...(refresh ? { cacheMode: 'refresh' as const } : {}),
    })
    for (const tool of result.tools) {
      if (tools.has(tool.name)) throw new Error(`MCP 返回重复工具：${tool.name}`)
      tools.set(tool.name, tool)
      if (tools.size > 5000) throw new Error('MCP 工具数量超过 5000')
    }
    cursor = result.nextCursor
    if (!cursor) return [...tools.values()]
    if (cursors.has(cursor)) throw new Error('MCP 工具列表游标重复')
    cursors.add(cursor)
  }
  throw new Error('MCP 工具列表超过 100 页')
}

export function connectorFailureMessage(error: unknown, connector: ManagedConnectorConfig, employeeToken?: string): string {
  const status = diagnosticFailureStatus(error)
  const prefix = status === 'authentication-required' ? 'XY-CONNECTOR-AUTH' : status === 'access-denied' ? 'XY-CONNECTOR-PERMISSION' : 'XY-CONNECTOR'
  const detail = status === 'authentication-required'
    ? connector.authMode === 'erp-cookie' ? 'ERP 登录已失效，请重新扫码登录后继续任务' : '凭据已失效，请在连接器详情更新凭据后继续任务'
    : status === 'access-denied' ? '当前账号或凭据没有访问权限，请检查授权范围'
    : diagnosticError(error, employeeToken, [...Object.values(connector.headers ?? {}), ...Object.values(connector.environment ?? {})])
  return `[${prefix}] ${connector.name} (${connector.id})：${detail}`
}

function validateConnector(connector: ManagedConnectorConfig, employeeToken: string | undefined): void {
  connectorRequestOptions(connector)
  validateReconnectPolicy(connector.reconnect)
  if (!['none', 'employee-bearer', 'erp-cookie', 'oauth'].includes(connector.authMode)) throw new Error('连接器认证方式无效')
  if (connector.authMode === 'erp-cookie' || connector.authMode === 'oauth') {
    if (connector.transport === 'stdio') throw new Error('ERP 扫码会话仅支持 HTTP/SSE 连接器')
    if (Object.keys(connector.headers ?? {}).some((key) => ['cookie', 'authorization'].includes(key.toLowerCase()))) {
      throw new Error('ERP 扫码会话不能同时配置 Cookie 或 Authorization 请求头')
    }
  }
  if (!connector.id.trim() || !connector.name.trim()) throw new Error('连接器标识或名称为空')
  if (!['streamable-http', 'sse', 'stdio'].includes(connector.transport)) {
    throw new Error(`不支持传输协议 ${connector.transport}`)
  }
  if (connector.transport === 'stdio') {
    if (!connector.command.trim()) throw new Error('stdio 连接器缺少启动命令')
    return
  }
  const url = new URL(connector.url)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('连接器地址必须使用 HTTP(S)')
  if (connector.authMode === 'employee-bearer' && !employeeToken) {
    throw new Error('缺少员工访问令牌')
  }
}

function validateReconnectPolicy(policy: ManagedConnectorConfig['reconnect']): void {
  if (!policy) return
  for (const [name, value] of [
    ['initialDelayMs', policy.initialDelayMs],
    ['maxDelayMs', policy.maxDelayMs],
    ['maxAttempts', policy.maxAttempts],
  ] as const) {
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`连接器重连参数 ${name} 须为非负整数`)
  }
  if ((policy.initialDelayMs ?? 500) > (policy.maxDelayMs ?? 30_000)) {
    throw new Error('连接器重连参数 maxDelayMs 不能小于 initialDelayMs')
  }
  if ((policy.initialDelayMs ?? 500) > 3_600_000 || (policy.maxDelayMs ?? 30_000) > 3_600_000) {
    throw new Error('连接器重连延迟不能超过 1 小时')
  }
  if ((policy.maxAttempts ?? 10) > 100) throw new Error('连接器重连次数不能超过 100')
}

function createTransport(connector: ManagedConnectorConfig, employeeToken: string | undefined): Transport {
  if (connector.transport === 'stdio') {
    return new StdioClientTransport({
      command: connector.command,
      args: connector.arguments ?? [],
      env: connector.environment ?? {},
      stderr: 'pipe',
    })
  }
  const token = connector.authMode === 'employee-bearer' ? employeeToken : undefined
  const headers = new Headers(connector.headers ?? {})
  if (token) headers.set('authorization', `Bearer ${token}`)
  const options = {
    ...(connector.authMode === 'erp-cookie' ? { fetch: erpCookieFetch(connector) } : {}),
    ...(connector.authMode === 'oauth' ? { fetch: connectorOAuthFetch(connector) } : {}),
    requestInit: { headers },
  }
  return connector.transport === 'sse'
    ? new SSEClientTransport(new URL(connector.url), options)
    : new StreamableHTTPClientTransport(new URL(connector.url), options)
}

function safeArguments(value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    return serialized.length <= 4_000 ? serialized : `${serialized.slice(0, 4_000)}…`
  } catch {
    return '参数无法展示'
  }
}

export function toHarnessTool(
  ctx: Context,
  client: Client,
  tool: Tool,
  connector: ManagedConnectorConfig,
  registeredName = tool.name,
  employeeToken?: string,
  journal?: WriteOperationJournal,
): ToolDefinition {
  return {
    name: registeredName,
    description: tool.description ?? `${connector.name} MCP 工具 ${tool.name}`,
    parameters: tool.inputSchema,
    output: {
      schema: {},
      render: (_args, value) => value as unknown as ContentBlock[],
    },
    async execute(args, exec) {
      try {
        const arguments_ = asArguments(args, connector.name)
        const call = () => client.callTool(
          { name: tool.name, arguments: arguments_ },
          { ...connectorRequestOptions(connector), signal: exec.signal },
        )
        const mutating = !isTrustedReadOnly(tool)
        const result = journal && mutating ? await journal.execute(connector, tool.name, arguments_, call, exec.signal) : await call()
        if (result.isError) throw new Error(renderMcpContent(result, connector.name))
        return await mcpResultContent(result, ctx.attachments, connector.name, exec.signal)
      } catch (error) {
        if (error instanceof UncertainOperationError) throw error
        throw new Error(connectorFailureMessage(error, connector, employeeToken))
      }
    },
    isConcurrencySafe: () => isTrustedReadOnly(tool),
    // A connector call has no other bound the harness can enforce: the MCP
    // client's own timeout does not cover a stream that stalls mid-response.
    // Declaring the deadline lets the tool-call timeout policy abort the call
    // through `exec.signal`, which this execute already forwards.
    timeoutMs: connectorRequestOptions(connector).timeout + 15_000,
  }
}

function asArguments(value: unknown, connectorName: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw new Error(`${connectorName} MCP 工具参数必须是对象`)
}

function renderMcpContent(result: CallToolResult, connectorName: string): string {
  const texts = result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
  return texts.join('\n') || `${connectorName} MCP 工具返回错误`
}

function installConnectorTools(
  ctx: Context,
  binding: ConnectorBinding,
  tools: Tool[],
  registeredNames: Set<string>,
  mutatingTools: Map<string, string>,
  employeeToken: string | undefined,
  journal: WriteOperationJournal | undefined,
  client: Client = binding.client,
): void {
  const previous = binding.installed
  for (const installed of previous) {
    installed.dispose()
    mutatingTools.delete(installed.name)
  }
  const created: InstalledTool[] = []
  try {
    for (const tool of tools) {
      const registeredName = binding.namesByRawTool.get(tool.name)
        ?? uniqueHarnessToolName(binding.connector.id, tool.name, registeredNames)
      binding.namesByRawTool.set(tool.name, registeredName)
      registeredNames.add(registeredName)
      const dispose = ctx.tools.register(toHarnessTool(
        ctx, client, tool, binding.connector, registeredName, employeeToken, journal,
      ))
      if (!isTrustedReadOnly(tool)
        && binding.connector.requireWriteApproval) mutatingTools.set(registeredName, binding.connector.name)
      created.push({ name: registeredName, raw: tool, dispose })
    }
    binding.installed = created
  } catch (error) {
    for (const installed of created) {
      installed.dispose()
      mutatingTools.delete(installed.name)
    }
    binding.installed = []
    // Restore the previous generation if a new registration collides. This
    // keeps a transient server update from leaving the connector unusable.
    if (previous.length > 0) {
      binding.installed = previous.map((installed) => {
        const dispose = ctx.tools.register(toHarnessTool(
          ctx, client, installed.raw, binding.connector, installed.name, employeeToken, journal,
        ))
        if (!isTrustedReadOnly(installed.raw)
          && binding.connector.requireWriteApproval) mutatingTools.set(installed.name, binding.connector.name)
        return { ...installed, dispose }
      })
    }
    throw error
  }
}

async function refreshConnectorTools(
  ctx: Context,
  binding: ConnectorBinding,
  registeredNames: Set<string>,
  mutatingTools: Map<string, string>,
  employeeToken: string | undefined,
  journal: WriteOperationJournal | undefined,
): Promise<void> {
  if (binding.closed) return
  const discovered = await discoverConnectorTools(
    binding.client,
    connectorRequestOptions(binding.connector).timeout,
    true,
  )
  const tools = selectTools(
    discovered,
    binding.connector.allowedTools,
    binding.connector.requiredTools,
    binding.connector.allowWrite,
    binding.connector.name,
  )
  installConnectorTools(ctx, binding, tools, registeredNames, mutatingTools, employeeToken, journal)
  binding.reconnectAttempt = 0
  debug(`${binding.connector.name}: tools refreshed, registered=${tools.length}`)
}

function scheduleReconnect(
  ctx: Context,
  binding: ConnectorBinding,
  employeeToken: string | undefined,
  registeredNames: Set<string>,
  mutatingTools: Map<string, string>,
): void {
  const reconnect = binding.connector.reconnect
  if (reconnect?.enabled === false || binding.reconnectTimer || binding.closed) return
  const maxAttempts = reconnect?.maxAttempts ?? 10
  if (binding.reconnectAttempt >= maxAttempts) {
    process.stderr.write(`${binding.connector.name}：MCP 连接已断开，重连次数已达上限；保留最后一组工具\n`)
    return
  }
  const initial = reconnect?.initialDelayMs ?? 500
  const maximum = reconnect?.maxDelayMs ?? 30_000
  const delay = Math.min(maximum, initial * (2 ** binding.reconnectAttempt))
  binding.reconnectAttempt += 1
  debug(`${binding.connector.name}: reconnect scheduled in ${delay}ms (attempt ${binding.reconnectAttempt}/${maxAttempts})`)
  binding.reconnectTimer = setTimeout(() => {
    delete binding.reconnectTimer
    void reconnectBinding(ctx, binding, employeeToken, registeredNames, mutatingTools)
  }, delay)
  binding.reconnectTimer.unref?.()
}

async function reconnectBinding(
  ctx: Context,
  binding: ConnectorBinding,
  employeeToken: string | undefined,
  registeredNames: Set<string>,
  mutatingTools: Map<string, string>,
): Promise<void> {
  if (binding.closed) return
  let nextClient: Client | undefined
  try {
    nextClient = new Client({ name: `xiaoyin-desktop-${binding.connector.id}`, version: '0.1.0' })
    const nextTransport = createTransport(binding.connector, employeeToken)
    nextTransport.onclose = () => {
      if (!binding.closed && binding.client === nextClient) {
        scheduleReconnect(ctx, binding, employeeToken, registeredNames, mutatingTools)
      }
    }
    await nextClient.connect(nextTransport, connectorRequestOptions(binding.connector))
    const discovered = await discoverConnectorTools(nextClient, connectorRequestOptions(binding.connector).timeout)
    const tools = selectTools(
      discovered,
      binding.connector.allowedTools,
      binding.connector.requiredTools,
      binding.connector.allowWrite,
      binding.connector.name,
    )
    const oldClient = binding.client
    installConnectorTools(ctx, binding, tools, registeredNames, mutatingTools, employeeToken, binding.journal, nextClient)
    binding.client = nextClient
    binding.transport = nextTransport
    nextClient.setNotificationHandler('notifications/tools/list_changed', () => {
      binding.refreshQueue = binding.refreshQueue
        .then(() => refreshConnectorTools(ctx, binding, registeredNames, mutatingTools, employeeToken, binding.journal))
        .catch((error) => logConnectorRefreshFailure(binding.connector, employeeToken, error))
    })
    await closeQuietly(oldClient)
    binding.reconnectAttempt = 0
    debug(`${binding.connector.name}: reconnected, registered=${tools.length}`)
  } catch (error) {
    if (nextClient) await closeQuietly(nextClient)
    logConnectorReconnectFailure(binding.connector, employeeToken, error)
    scheduleReconnect(ctx, binding, employeeToken, registeredNames, mutatingTools)
  }
}

function logConnectorRefreshFailure(
  connector: ManagedConnectorConfig,
  employeeToken: string | undefined,
  error: unknown,
): void {
  const detail = diagnosticError(error, employeeToken, [
    ...Object.values(connector.headers ?? {}),
    ...Object.values(connector.environment ?? {}),
  ])
  process.stderr.write(`${connector.name}：MCP 工具列表刷新失败，保留上一组工具：${detail}\n`)
}

function logConnectorReconnectFailure(
  connector: ManagedConnectorConfig,
  employeeToken: string | undefined,
  error: unknown,
): void {
  const detail = diagnosticError(error, employeeToken, [
    ...Object.values(connector.headers ?? {}),
    ...Object.values(connector.environment ?? {}),
  ])
  process.stderr.write(`${connector.name}：MCP 重连失败：${detail}\n`)
}

async function cleanupBindings(bindings: ConnectorBinding[], mutatingTools: Map<string, string>): Promise<void> {
  for (const binding of bindings.splice(0).reverse()) {
    binding.closed = true
    if (binding.reconnectTimer) clearTimeout(binding.reconnectTimer)
    for (const installed of binding.installed.splice(0).reverse()) {
      installed.dispose()
      mutatingTools.delete(installed.name)
    }
    await closeQuietly(binding.client)
  }
}

async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.close()
  } catch (error) {
    debug(`close failed: ${safeError(error)}`)
  }
}

function debug(message: string): void {
  if (process.env.XIAOYIN_HARNESS_DEBUG === '1') process.stderr.write(`Managed MCP: ${message}\n`)
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

export function diagnosticError(error: unknown, employeeToken: string | undefined, connectorSecrets: string[] = []): string {
  const message = safeError(error)
  if (/abort|timeout|timed out/i.test(message)) return '连接或 MCP 握手超时'
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden/i.test(message)) return '员工身份未获连接器授权'
  const redacted = [employeeToken, ...connectorSecrets]
    .filter((secret): secret is string => Boolean(secret))
    .reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), message)
  const withoutEndpoints = redacted.replace(/https?:\/\/[^\s"'<>]+/giu, '连接器端点')
  return [...withoutEndpoints].filter((character) => !/\p{Cc}/u.test(character)).join('').slice(0, 500)
    || '连接器诊断失败'
}
