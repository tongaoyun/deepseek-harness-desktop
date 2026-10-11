/** Personal MCP configuration stays encrypted in main and reaches Host through a loopback relay. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Server } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { ExtensionDraftSchema, type ExtensionDraft } from '@deepseek-harness/product/authoring'
import type { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { ProductError } from '@deepseek-harness/product/errors'
import { z } from 'zod'

const CommonConfiguration = z.object({ timeoutSeconds: z.number().int().min(1).max(600).default(60),
  arguments: z.array(z.string()), environment: z.record(z.string(), z.string()), headers: z.record(z.string(), z.string()) })
const Configuration = z.discriminatedUnion('transport', [
  CommonConfiguration.extend({ transport: z.literal('stdio'), command: z.string().min(1), url: z.undefined().optional() }),
  CommonConfiguration.extend({ transport: z.literal('streamable-http'), url: z.string().min(1), command: z.undefined().optional() }),
])
type Configuration = z.infer<typeof Configuration>
interface SecureStorage { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
const PublicConnector = z.looseObject({ id: z.string(), version: z.string(), ownerEmployeeId: z.string().optional(),
  visibility: z.string().optional(), authMode: z.string().optional(), ready: z.boolean().optional(),
  transport: z.string(), url: z.string().nullish().transform(value => value || undefined),
  command: z.string().nullish().transform(value => value || undefined), arguments: z.array(z.string()).default([]),
  tools: z.array(z.looseObject({ name: z.string() })).default([]),
})
type PublicConnector = z.infer<typeof PublicConnector>

/** Owns authenticated personal configuration and SDK connections for the desktop lifetime. */
export class PersonalConnectors {
  private readonly lifetime = new AbortController()
  private readonly clients = new Map<string, Promise<Client>>()
  private identity: string | undefined
  constructor(private readonly root: string, private readonly secure: SecureStorage, private readonly employee: () => string | undefined,
    private readonly oauthConnector?: (id: string, signal: AbortSignal) => Promise<unknown>) {}

  /** Read public editing fields, save a new version, or remove an owned connector.
   * @param method Product connector management operation.
   * @param input Untrusted resource identity and optional editing form.
   * @param api Authenticated server transport.
   * @param employee Authenticated employee ID.
   * @param signal Operation cancellation.
   * @returns Public editing fields or the committed business result, without private values.
   */
  async manage(method: string, input: Readonly<Record<string, unknown>>, api: DeepSeekHarnessApiClient,
    employee: string, signal: AbortSignal): Promise<unknown> {
    if (typeof input.id !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(input.id)) throw new Error('Invalid connector ID')
    const entry = PublicConnector.parse(await api.request(`/api/v1/connectors/${encodeURIComponent(input.id)}`, { signal }))
    if (entry.visibility !== 'PERSONAL' || entry.ownerEmployeeId !== employee || entry.canEdit !== true) {
      throw new ProductError('EXTENSION_OWNER_REQUIRED', 'Only the owner can manage a personal connector', false)
    }
    if (input.version !== entry.version) throw new ProductError('EXTENSION_VERSION_CONFLICT', 'Connector changed; reopen its configuration', true)
    if (method === 'extensions.connector.delete') {
      await api.request(`/api/v1/connectors/${encodeURIComponent(entry.id)}`, { method: 'DELETE', signal })
      await this.resetIdentity(undefined)
      await rm(this.filename(employee, entry.id, entry.version), { force: true })
      return { removed: true, id: entry.id }
    }
    const config = entry.authMode === 'oauth' ? undefined : await this.configuration(entry, employee)
    const [major, minor, patch] = entry.version.split('-')[0]?.split('.') ?? []
    if (!major || !minor || !patch || !/^\d+$/.test(patch)) throw new Error('Invalid connector version')
    const nextVersion = `${major}.${minor}.${String(BigInt(patch) + 1n)}`
    const draft = ExtensionDraftSchema.parse({ kind: 'connector', id: entry.id, version: nextVersion,
      name: entry.name ?? entry.displayName, summary: entry.summary, category: entry.category,
      transport: entry.transport, url: entry.url, command: entry.command, arguments: entry.arguments,
      ...(entry.authMode === 'oauth' ? { oauthProviderId: entry.oauthProviderId } : {}), timeoutSeconds: config?.timeoutSeconds ?? 60,
      headers: Object.fromEntries(Object.keys(config?.headers ?? {}).map(key => [key, ''])),
      environment: Object.fromEntries(Object.keys(config?.environment ?? {}).map(key => [key, ''])),
    })
    if (method === 'extensions.connector.read') return { draft, configured: config !== undefined }
    if (method !== 'extensions.connector.update') throw new Error('Unsupported connector operation')
    let edited = ExtensionDraftSchema.parse(input.draft)
    if (edited.kind !== 'connector' || edited.id !== entry.id || edited.version !== nextVersion) throw new Error('Connector identity is fixed')
    const sameTarget = config && edited.transport === config.transport && (edited.url || undefined) === config.url
      && (edited.command || undefined) === config.command && JSON.stringify(edited.arguments) === JSON.stringify(config.arguments)
    const retained = (values: Record<string, string>, previous: Record<string, string>): Record<string, string> =>
      Object.fromEntries(Object.entries(values).map(([key, value]) => {
        if (value !== '') return [key, value]
        if (sameTarget && previous[key] !== undefined) return [key, previous[key]]
        throw new ProductError('CONNECTOR_CONFIGURATION_REQUIRED', 'Enter private values for the new connection target', false)
      }))
    edited = { ...edited, headers: retained(edited.headers, config?.headers ?? {}),
      environment: retained(edited.environment, config?.environment ?? {}) }
    await this.save(edited, api, employee, signal)
    return { kind: 'connector', id: edited.id, version: edited.version, visibility: 'PERSONAL', installed: false }
  }

  /** Discover the actual MCP tool list, then persist public configuration and encrypted local secrets.
   * @param draft Validated renderer form without tool access declarations.
   * @param api Authenticated product API.
   * @param employee Authenticated owner.
   * @param signal Cancellation.
   */
  async save(draft: ExtensionDraft, api: DeepSeekHarnessApiClient, employee: string, signal: AbortSignal): Promise<void> {
    await this.resetIdentity(employee)
    if (draft.oauthProviderId) {
      const provider = PublicConnector.parse(await this.oauthConnector?.(draft.oauthProviderId, signal))
      if (provider.authMode !== 'oauth' || provider.ready !== true || provider.visibility === 'PERSONAL') {
        throw new ProductError('CONNECTOR_AUTHORIZATION_REQUIRED', 'Authorize the configured provider before discovery', false)
      }
      const config = Configuration.parse({ transport: 'streamable-http', url: provider.url,
        headers: provider.headers, arguments: [], environment: {} })
      const client = await this.connect(config, signal)
      let tools: Tool[]
      try { tools = await this.discover(client, signal, config.timeoutSeconds) } finally { await client.close() }
      if (!tools.length) throw new ProductError('CONNECTOR_DISCOVERY_FAILED', 'MCP server exposes no usable tools', false)
      await api.request('/api/v1/connectors', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        id: draft.id, name: draft.name, summary: draft.summary, category: draft.category, version: draft.version,
        transport: 'streamable-http', url: provider.url, command: '', arguments: [], environment: {}, headers: {},
        authMode: 'oauth', oauthProviderId: draft.oauthProviderId, toolNames: tools.map(tool => tool.name),
      }) })
      return
    }
    if (!this.secure.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable')
    const config = Configuration.parse({ transport: draft.transport, arguments: draft.arguments,
      headers: draft.headers, environment: draft.environment, timeoutSeconds: draft.timeoutSeconds,
      ...(draft.transport === 'stdio' ? { command: draft.command } : { url: draft.url }) })
    const client = await this.connect(config, signal)
    let tools: Tool[]
    try { tools = await this.discover(client, signal, config.timeoutSeconds) } finally { await client.close() }
    if (!tools.length) throw new Error('MCP server exposes no usable tools')
    const filename = this.filename(employee, draft.id, draft.version)
    let previous: Buffer | undefined
    try { previous = await readFile(filename) } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const encrypted = this.secure.encryptString(JSON.stringify(config))
    const staging = `${filename}.${randomUUID()}.pending`
    try {
      await writeFile(staging, encrypted, { mode: 0o600, signal, flag: 'wx' })
      await api.request('/api/v1/connectors', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        id: draft.id, name: draft.name, summary: draft.summary, category: draft.category, version: draft.version,
        transport: config.transport, url: config.url ?? null, command: config.command ?? null, arguments: config.arguments,
        environment: {}, headers: {}, authMode: 'none', toolNames: tools.map(tool => tool.name),
      }) })
      await rename(staging, filename)
      const key = this.key(employee, draft.id, draft.version)
      const old = this.clients.get(key)
      this.clients.delete(key)
      if (old) await (await old).close()
    } catch (error) {
      await rm(staging, { force: true })
      if (previous) await writeFile(filename, previous, { mode: 0o600 })
      throw error
    }
  }

  /** Augment personal runtime data with local configuration and live read-only annotations.
   * @param value Main-process catalog after server authorization.
   * @param signal Optional caller cancellation.
   * @returns Main-only entries, later sanitized by the relay for Host.
   */
  async enrich(value: unknown, signal = this.lifetime.signal): Promise<unknown> {
    if (!Array.isArray(value)) throw new Error('Invalid connector catalog')
    const employee = this.employee()
    await this.resetIdentity(employee)
    const entries: unknown[] = value
    return Promise.all(entries.map(async (raw) => {
      const entry = PublicConnector.parse(raw)
      if (entry.visibility !== 'PERSONAL' || entry.ownerEmployeeId !== employee || !employee) return raw
      try {
        if (entry.authMode === 'oauth') {
          if (entry.ready !== true) return raw
          const client = await this.connect(Configuration.parse({ transport: 'streamable-http', url: entry.url,
            headers: entry.headers, arguments: [], environment: {} }), signal)
          try {
            const declared = new Set(entry.tools.map(tool => tool.name))
            const tools = (await this.discover(client, signal, 60)).filter(tool => declared.has(tool.name))
            return { ...entry, tools: tools.map(tool => ({ name: tool.name, displayName: tool.title ?? tool.name,
              description: tool.description ?? '', access: tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true ? 'READ' : 'WRITE' })) }
          } finally { await client.close() }
        }
        const config = await this.configuration(entry, employee)
        if (!config) return { ...entry, status: 'needs-configuration', ready: false, configurationStatus: 'REQUIRED', headers: {}, environment: {} }
        const client = await this.client(entry, employee, config, signal)
        const declared = entry.tools.map(tool => tool.name)
        const tools = (await this.discover(client, signal, config.timeoutSeconds)).filter(tool => declared.includes(tool.name))
        return { ...entry, ...config, configurationStatus: 'CONFIGURED', tools: tools.map(tool => ({ name: tool.name,
          displayName: tool.title ?? tool.name, description: tool.description ?? '', access: tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true ? 'READ' : 'WRITE' })) }
      } catch (_error) {
        signal.throwIfAborted()
        return { ...entry, status: 'unavailable', ready: false, configurationStatus: 'FAILED', headers: {}, environment: {}, tools: [] }
      }
    }))
  }

  /** Serve a personal stdio MCP server through an SDK HTTP transport without exposing environment variables.
   * @param request Authenticated loopback request.
   * @param response Loopback response.
   * @param value Server-authorized connector.
   * @param signal Caller cancellation.
   */
  async serveStdio(request: IncomingMessage, response: ServerResponse, value: unknown, signal: AbortSignal): Promise<void> {
    const entry = PublicConnector.parse(value)
    const employee = this.employee()
    if (!employee || entry.visibility !== 'PERSONAL' || entry.ownerEmployeeId !== employee) throw new Error('Personal connector access denied')
    const config = await this.configuration(entry, employee)
    if (!config) throw new Error('Private connector configuration is missing')
    const client = await this.client(entry, employee, config, signal)
    // The relay forwards validated protocol requests without registering duplicate tool handlers.
    // oxlint-disable-next-line typescript/no-deprecated
    const server = new Server({ name: 'product-personal-mcp-relay', version: '1.0.0' }, { capabilities: { tools: {} } })
    const declaredNames = new Set(entry.tools.map(tool => tool.name))
    server.setRequestHandler('tools/list', async () => ({ tools: (await this.discover(client, signal, config.timeoutSeconds)).filter(tool => declaredNames.has(tool.name)) }))
    server.setRequestHandler('tools/call', async (request, context) => {
      const callSignal = AbortSignal.any([signal, context.mcpReq.signal, this.lifetime.signal])
      const current = await this.discover(client, callSignal, config.timeoutSeconds)
      const declared = entry.tools.some(tool => tool.name === request.params.name)
      if (!declared || !current.some(tool => tool.name === request.params.name)) throw new Error('Connector tool is not declared')
      return client.callTool(request.params, { signal: callSignal, timeout: config.timeoutSeconds * 1000 })
    })
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(transport)
    try { await transport.handleRequest(request, response) } finally { await server.close() }
  }

  /** Cancel pending connects and close every child process owned by this desktop extension. */
  async close(): Promise<void> {
    this.lifetime.abort(new Error('Personal connector manager closed'))
    await Promise.allSettled([...this.clients.values()].map(async client => (await client).close()))
    this.clients.clear()
  }

  /** Release the previous employee's MCP processes after signing out or switching accounts.
   * @param employee Current authenticated employee, or undefined after sign-out.
   */
  async resetIdentity(employee: string | undefined): Promise<void> {
    if (this.identity === employee) return
    this.identity = employee
    const previous = [...this.clients.values()]
    this.clients.clear()
    await Promise.allSettled(previous.map(async client => (await client).close()))
  }

  private key(employee: string, id: string, version: string): string { return createHash('sha256').update(JSON.stringify([employee, id, version])).digest('hex') }
  private filename(employee: string, id: string, version: string): string { return join(this.root, `${this.key(employee, id, version)}.bin`) }
  private async configuration(entry: PublicConnector, employee: string): Promise<Configuration | undefined> {
    try {
      const encrypted = await readFile(this.filename(employee, entry.id, entry.version))
      const config = Configuration.parse(JSON.parse(this.secure.decryptString(encrypted)))
      if (config.transport !== entry.transport || config.url !== entry.url || config.command !== entry.command
        || JSON.stringify(config.arguments) !== JSON.stringify(entry.arguments)) {
        throw new Error('Private settings do not match this connector version')
      }
      return config
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw new Error('Private connector settings could not be decrypted')
    }
  }
  private client(entry: PublicConnector, employee: string, config: Configuration, signal: AbortSignal): Promise<Client> {
    const key = this.key(employee, entry.id, entry.version)
    let client = this.clients.get(key)
    if (!client) {
      client = this.connect(config, signal)
      this.clients.set(key, client)
      void client.catch(() => { if (this.clients.get(key) === client) this.clients.delete(key) })
      void client.then((value) => {
        value.onclose = () => { if (this.clients.get(key) === client) this.clients.delete(key) }
      }, () => undefined)
    }
    return client
  }
  private async connect(config: Configuration, signal: AbortSignal): Promise<Client> {
    const combined = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(config.timeoutSeconds * 1000)])
    combined.throwIfAborted()
    const client = new Client({ name: 'product-extension-editor', version: '1.0.0' })
    const transport = config.transport === 'stdio'
      ? new StdioClientTransport({ command: config.command, args: config.arguments,
        env: { ...scrubbedParentEnv(), ...config.environment }, stderr: 'ignore' })
      : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers, redirect: 'error' } })
    const abort = (): void => { void client.close() }
    combined.addEventListener('abort', abort, { once: true })
    try {
      await client.connect(transport, { timeout: config.timeoutSeconds * 1000, signal: combined }); combined.throwIfAborted(); return client
    } catch (_error) {
      await client.close(); combined.throwIfAborted()
      throw new ProductError('CONNECTOR_DISCOVERY_FAILED', 'MCP connection or tool discovery failed', true)
    }
    finally { combined.removeEventListener('abort', abort) }
  }
  private async discover(client: Client, signal: AbortSignal, timeoutSeconds: number): Promise<Tool[]> {
    const deadline = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(timeoutSeconds * 1000)])
    const tools: Tool[] = []
    let cursor: string | undefined
    const cursors = new Set<string>()
    do {
      const result = await client.listTools(cursor ? { cursor } : {}, { signal: deadline, timeout: timeoutSeconds * 1000 })
      tools.push(...result.tools)
      if (tools.length > 512 || (result.nextCursor && cursors.has(result.nextCursor))) throw new Error('Invalid MCP tool pagination')
      cursor = result.nextCursor
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return tools
  }
}
