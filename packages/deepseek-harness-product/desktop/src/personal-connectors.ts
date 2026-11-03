/** Personal MCP configuration stays encrypted in main and reaches Host through a loopback relay. */
import { addAbortListener } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Server, isInitializeRequest, type ServerContext } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { ConnectorDraftSchema, type ConnectorDraft } from '@deepseek-harness/product/connector-draft'
import { DeepSeekHarnessApiError, type DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { ProductError } from '@deepseek-harness/product/errors'
import { z } from 'zod'

const CommonConfiguration = z.object({ timeoutSeconds: z.number().int().min(1).max(600).default(60),
  arguments: z.array(z.string()), environment: z.record(z.string(), z.string()), headers: z.record(z.string(), z.string()) })
const Configuration = z.discriminatedUnion('transport', [
  CommonConfiguration.extend({ transport: z.literal('stdio'), command: z.string().min(1), url: z.undefined().optional() }),
  CommonConfiguration.extend({ transport: z.literal('streamable-http'), url: z.string().min(1), command: z.undefined().optional() }),
])
type Configuration = z.infer<typeof Configuration>
interface ConfigurationRead { readonly config: Configuration | undefined; readonly signal: AbortSignal }
interface SecureStorage { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
const PublicConnector = z.looseObject({ id: z.string(), version: z.string(), ownerEmployeeId: z.string().optional(),
  visibility: z.string().optional(), authMode: z.string().optional(), ready: z.boolean().optional(),
  managed: z.boolean().optional(), status: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}), environment: z.record(z.string(), z.string()).default({}),
  transport: z.string(), url: z.string().nullish().transform(value => value || undefined),
  command: z.string().nullish().transform(value => value || undefined), arguments: z.array(z.string()).default([]),
  tools: z.array(z.looseObject({ name: z.string() })).default([]),
})
type PublicConnector = z.infer<typeof PublicConnector>
const PendingConfiguration = z.object({ employee: z.string(), config: Configuration, body: z.string() })
const PendingMetadata = z.object({ id: z.string(), version: z.string(), name: z.string(), summary: z.string(), category: z.string() })

interface CachedConnection {
  readonly key: string
  readonly employee: string
  readonly id: string
  readonly controller: AbortController
  readonly connection: Promise<Client>
  waiters: number
  connected: boolean
  relay?: RelaySession
  closing?: Promise<void>
}

interface RelaySession {
  readonly id: string
  readonly transport: NodeStreamableHTTPServerTransport
  readonly ready: Promise<void>
  readonly requests: Set<Promise<void>>
  close(): Promise<void>
}

/** Owns authenticated personal configuration and SDK connections for the desktop lifetime. */
export class PersonalConnectors {
  private readonly lifetime = new AbortController()
  private readonly clients = new Map<string, CachedConnection>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly connectorOwners = new Map<string, AbortController>()
  private identity: string | undefined
  constructor(private readonly root: string, private readonly secure: SecureStorage, private readonly employee: () => string | undefined,
    private readonly oauthConnector?: (id: string, signal: AbortSignal) => Promise<unknown>,
    private readonly catalogCommitted?: () => void) {}

  /** Serialize management per employee and connector; check current access and version after prior operations settle.
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
    const id = input.id
    return this.serialize(employee, id, signal, lifetime => this.manageConnector(method, id, input, api, employee, lifetime))
  }

  private async manageConnector(method: string, id: string, input: Readonly<Record<string, unknown>>,
    api: DeepSeekHarnessApiClient, employee: string, signal: AbortSignal): Promise<unknown> {
    const deviceConfiguration = method.startsWith('extensions.connector.configuration.')
    const entry = PublicConnector.extend({ id: z.literal(id) }).parse(
      await api.request(`/api/v1/connectors/${encodeURIComponent(id)}${deviceConfiguration ? '/configuration-template' : ''}`, { signal }))
    if (input.version !== entry.version) throw new ProductError('EXTENSION_VERSION_CONFLICT', 'Connector changed; reopen its configuration', true)
    if (deviceConfiguration) {
      if (!this.localConfigurationAllowed(entry) || entry.status !== 'ready') {
        throw new ProductError('FEATURE_UNAVAILABLE', 'This connector does not support device configuration', false)
      }
      if (method === 'extensions.connector.configuration.read') {
        const { config } = await this.configuration(entry, employee, signal, true)
        return { id: entry.id, version: entry.version, transport: entry.transport, url: entry.url,
          command: entry.command, arguments: entry.arguments, configured: config !== undefined,
          headers: Object.keys(entry.headers), environment: Object.keys(entry.environment), timeoutSeconds: config?.timeoutSeconds ?? 60 }
      }
      if (method !== 'extensions.connector.configuration.save') throw new Error('Unsupported connector configuration operation')
      if (!this.secure.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable')
      const values = z.object({ headers: z.record(z.string().min(1).max(200), z.string().max(4000)),
        environment: z.record(z.string().min(1).max(200), z.string().max(4000)),
        timeoutSeconds: z.number().int().min(1).max(600) }).strict().parse(input.configuration)
      const { config: previous } = await this.configuration(entry, employee, signal, true)
      const requiredValues = (provided: Record<string, string>, required: Record<string, string>, saved: Record<string, string>) => {
        if (Object.keys(provided).some(key => !Object.hasOwn(required, key))) throw new Error('Unknown private configuration key')
        return Object.fromEntries(Object.keys(required).map((key) => {
          const value = provided[key] || saved[key]
          if (!value) throw new ProductError('CONNECTOR_CONFIGURATION_REQUIRED', 'Enter the required private values', false)
          return [key, value]
        }))
      }
      const config = Configuration.parse({ transport: entry.transport, url: entry.url, command: entry.command,
        arguments: entry.arguments, timeoutSeconds: values.timeoutSeconds,
        headers: requiredValues(values.headers, entry.headers, previous?.headers ?? {}),
        environment: requiredValues(values.environment, entry.environment, previous?.environment ?? {}) })
      const client = await this.connect(config, signal)
      try {
        const actual = new Set((await this.discover(client, signal, config.timeoutSeconds)).map(tool => tool.name))
        if (!entry.tools.length || entry.tools.some(tool => !actual.has(tool.name))) {
          throw new ProductError('CONNECTOR_DISCOVERY_FAILED', 'Declared MCP tools are missing', false)
        }
      } finally { await client.close() }
      signal.throwIfAborted()
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      await this.finalize(this.filename(employee, entry.id, entry.version), config)
      this.catalogCommitted?.()
      await this.disconnectConnector(employee, entry.id)
      return { id: entry.id, version: entry.version, configured: true }
    }
    if (entry.visibility !== 'PERSONAL' || entry.ownerEmployeeId !== employee || entry.canEdit !== true) {
      throw new ProductError('EXTENSION_OWNER_REQUIRED', 'Only the owner can manage a personal connector', false)
    }
    if (method === 'extensions.connector.delete') {
      await api.request(`/api/v1/connectors/${encodeURIComponent(entry.id)}`, { method: 'DELETE', signal })
      this.catalogCommitted?.()
      await this.disconnectConnector(employee, entry.id)
      await rm(this.filename(employee, entry.id, entry.version), { force: true })
      await rm(`${this.filename(employee, entry.id, entry.version)}.pending`, { force: true })
      return { removed: true, id: entry.id }
    }
    let config = entry.authMode === 'oauth' ? undefined : (await this.configuration(entry, employee, signal, true)).config
    const [major, minor, patch] = entry.version.split('-')[0]?.split('.') ?? []
    if (!major || !minor || !patch || !/^\d+$/.test(patch)) throw new Error('Invalid connector version')
    const nextVersion = `${major}.${minor}.${String(BigInt(patch) + 1n)}`
    const pending = entry.authMode === 'oauth' ? undefined : await this.pending(this.filename(employee, entry.id, nextVersion))
    const pendingDraft = pending === undefined ? undefined : ConnectorDraftSchema.parse({
      ...PendingMetadata.parse(JSON.parse(pending.body)), kind: 'connector', ...pending.config,
      url: pending.config.url, command: pending.config.command,
    })
    if (pending && (pending.employee !== employee || pendingDraft?.id !== entry.id || pendingDraft.version !== nextVersion)) {
      throw new ProductError('EXTENSION_PRIVATE_CONFIGURATION_INVALID', 'Pending connector identity is invalid', false)
    }
    if (pending) config = pending.config
    const draft = ConnectorDraftSchema.parse({ kind: 'connector', id: entry.id, version: nextVersion,
      name: pendingDraft?.name ?? entry.name ?? entry.displayName, summary: pendingDraft?.summary ?? entry.summary,
      category: pendingDraft?.category ?? entry.category,
      transport: config?.transport ?? entry.transport, url: config?.url ?? entry.url, command: config?.command ?? entry.command,
      arguments: config?.arguments ?? entry.arguments,
      ...(entry.authMode === 'oauth' ? { oauthProviderId: entry.oauthProviderId } : {}), timeoutSeconds: config?.timeoutSeconds ?? 60,
      headers: this.template(config?.headers ?? entry.headers),
      environment: this.template(config?.environment ?? entry.environment),
    })
    if (method === 'extensions.connector.read') return { draft, configured: config !== undefined, savePending: pending !== undefined }
    if (method !== 'extensions.connector.update') throw new Error('Unsupported connector operation')
    let edited = ConnectorDraftSchema.parse(input.draft)
    if (edited.id !== entry.id || edited.version !== nextVersion) throw new Error('Connector identity is fixed')
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
    await this.saveConfiguration(edited, api, employee, signal)
    return { kind: 'connector', id: edited.id, version: edited.version, visibility: 'PERSONAL' }
  }

  /** Discover the actual MCP tool list, then persist public configuration and encrypted local secrets.
   * @param draft Validated renderer form without tool access declarations.
   * @param api Authenticated product API.
   * @param employee Authenticated owner.
   * @param signal Cancellation. A dispatched request with an unknown outcome retains encrypted pending settings.
   */
  async save(draft: ConnectorDraft, api: DeepSeekHarnessApiClient, employee: string,
    signal: AbortSignal): Promise<void> {
    await this.serialize(employee, draft.id, signal, lifetime => this.saveConfiguration(draft, api, employee, lifetime))
  }

  private async serialize<T>(employee: string, id: string, signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const key = this.key(employee, id, '')
    const previous = this.operations.get(key)
    const pending = (previous === undefined ? Promise.resolve() : previous.catch(() => undefined))
      .then(() => {
        const lifetime = AbortSignal.any([signal, this.lifetime.signal])
        lifetime.throwIfAborted()
        return operation(lifetime)
      })
    this.operations.set(key, pending)
    try { return await pending }
    finally { if (this.operations.get(key) === pending) this.operations.delete(key) }
  }

  private async saveConfiguration(draft: ConnectorDraft, api: DeepSeekHarnessApiClient, employee: string,
    signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
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
      this.catalogCommitted?.()
      await this.disconnectConnector(employee, draft.id)
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
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const body = JSON.stringify({
      id: draft.id, name: draft.name, summary: draft.summary, category: draft.category, version: draft.version,
      transport: config.transport, url: config.url ?? null, command: config.command ?? null, arguments: config.arguments,
      environment: this.template(config.environment), headers: this.template(config.headers), authMode: 'none', toolNames: tools.map(tool => tool.name),
    })
    const pending = await this.pending(filename)
    if (pending && (pending.employee !== employee || pending.body !== body || JSON.stringify(pending.config) !== JSON.stringify(config))) {
      throw new ProductError('CONNECTOR_SAVE_PENDING', 'Retry the previous save before changing this version', true,
        [{ kind: 'connector', id: draft.id }])
    }
    if (!pending) {
      const staging = `${filename}.${randomUUID()}.tmp`
      try {
        await writeFile(staging, this.secure.encryptString(JSON.stringify({ employee, config, body })), { mode: 0o600, signal, flag: 'wx', flush: true })
        await rename(staging, `${filename}.pending`)
      } finally { await rm(staging, { force: true }) }
    }
    try {
      await api.request('/api/v1/connectors', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body })
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof DeepSeekHarnessApiError && !error.retryable && error.status < 500 && error.status !== 408) {
        await rm(`${filename}.pending`, { force: true })
        throw error
      }
      // An authenticated immutable catalog entry can confirm a lost commit receipt.
      let confirmed = false
      try {
        const entry = PublicConnector.parse(await api.request(`/api/v1/connectors/${encodeURIComponent(draft.id)}`, { signal }))
        confirmed = this.matchesPending(entry, employee, { employee, config, body })
      } catch (_confirmationError) { signal.throwIfAborted() }
      if (!confirmed) throw new ProductError('CONNECTOR_SAVE_PENDING', 'Save outcome is unknown; encrypted settings are retained for retry', true,
        [{ kind: 'connector', id: draft.id }], { cause: error })
    }
    try { await this.finalize(filename, config) }
    catch (error) {
      throw new ProductError('CONNECTOR_SAVE_PENDING', 'Server save succeeded; encrypted device settings await restoration', true,
        [{ kind: 'connector', id: draft.id }], { cause: error })
    }
    this.catalogCommitted?.()
    await this.disconnectConnector(employee, draft.id)
  }

  /** Augment personal runtime data with local configuration and live read-only annotations.
   * @param value Main-process catalog after server authorization.
   * @param signal Optional caller cancellation.
   * @param discoverTools Whether execution requires live annotations; catalog browsing only reads configuration state.
   * @returns Main-only entries, later sanitized by the relay for Host.
   */
  async enrich(value: unknown, signal = this.lifetime.signal, discoverTools = true): Promise<unknown> {
    signal = AbortSignal.any([signal, this.lifetime.signal])
    signal.throwIfAborted()
    if (!Array.isArray(value)) throw new Error('Invalid connector catalog')
    const employee = this.employee()
    await this.resetIdentity(employee)
    const entries: unknown[] = value
    return Promise.all(entries.map(async (raw) => {
      const entry = PublicConnector.parse(raw)
      if (!employee || entry.status !== 'ready') return raw
      const deviceConfiguration = this.localConfigurationAllowed(entry) && (entry.visibility === 'PERSONAL'
        || entry.transport === 'stdio' || Object.keys(entry.headers).length > 0 || Object.keys(entry.environment).length > 0)
      if (!deviceConfiguration && !(entry.authMode === 'oauth' && entry.visibility === 'PERSONAL' && entry.ownerEmployeeId === employee)) return raw
      try {
        if (entry.authMode === 'oauth') {
          if (entry.ready !== true || !discoverTools) return raw
          const lifetime = AbortSignal.any([signal, this.connectorSignal(employee, entry.id)])
          const client = await this.connect(Configuration.parse({ transport: 'streamable-http', url: entry.url,
            headers: entry.headers, arguments: [], environment: {} }), lifetime)
          try {
            const declared = new Set(entry.tools.map(tool => tool.name))
            const tools = (await this.discover(client, lifetime, 60)).filter(tool => declared.has(tool.name))
            return { ...entry, tools: tools.map(tool => ({ name: tool.name, displayName: tool.title ?? tool.name,
              description: tool.description ?? '', access: tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true ? 'READ' : 'WRITE' })) }
          } finally { await client.close() }
        }
        const { config, signal: owner } = await this.configuration(entry, employee, signal)
        const lifetime = AbortSignal.any([signal, owner])
        lifetime.throwIfAborted()
        if (!config) return { ...entry, status: 'needs-configuration', ready: false, configurationStatus: 'REQUIRED', canConfigure: true, headers: {}, environment: {} }
        if (!discoverTools) return { ...entry, ...config, canConfigure: true, configurationStatus: 'CONFIGURED' }
        const client = await this.client(entry, employee, config, lifetime)
        const declared = entry.tools.map(tool => tool.name)
        const tools = (await this.discover(client, lifetime, config.timeoutSeconds)).filter(tool => declared.includes(tool.name))
        return { ...entry, ...config, canConfigure: true, configurationStatus: 'CONFIGURED', tools: tools.map(tool => ({ name: tool.name,
          displayName: tool.title ?? tool.name, description: tool.description ?? '', access: tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true ? 'READ' : 'WRITE' })) }
      } catch (_error) {
        signal.throwIfAborted()
        return { ...entry, status: 'unavailable', ready: false, canConfigure: this.localConfigurationAllowed(entry), configurationStatus: 'FAILED', headers: {}, environment: {}, tools: [] }
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
    if (!employee || entry.status !== 'ready' || !this.localConfigurationAllowed(entry)) throw new Error('Device connector access denied')
    const { config, signal: owner } = await this.configuration(entry, employee, signal)
    signal = AbortSignal.any([signal, owner])
    signal.throwIfAborted()
    if (!config) throw new Error('Private connector configuration is missing')
    const client = await this.client(entry, employee, config, signal)
    const cached = this.clients.get(this.key(employee, entry.id, entry.version))
    if (!cached || cached.controller.signal.aborted) throw new Error('Personal MCP connection is unavailable')
    signal.throwIfAborted()
    using _abort = addAbortListener(signal, () => { response.destroy() })
    let relay = cached.relay
    let body: unknown
    const sessionId = request.headers['mcp-session-id']
    if (sessionId !== undefined) {
      if (typeof sessionId !== 'string' || relay?.id !== sessionId) {
        response.writeHead(404).end('MCP session is unavailable')
        return
      }
    } else {
      if (request.method !== 'POST') { response.writeHead(400).end('MCP initialization is required'); return }
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of request) {
        signal.throwIfAborted()
        const value: unknown = chunk
        if (!(value instanceof Uint8Array)) throw new Error('Invalid MCP request bytes')
        length += value.length
        if (length > 2 * 1024 * 1024) throw new Error('MCP request exceeds size limit')
        chunks.push(Buffer.from(value))
      }
      body = JSON.parse(Buffer.concat(chunks).toString())
      if (!isInitializeRequest(body)) { response.writeHead(400).end('MCP initialization is required'); return }
      signal.throwIfAborted()
      relay = this.createRelay(cached, client, entry, config)
    }
    await relay.ready
    signal.throwIfAborted()
    if (cached.relay !== relay) { response.writeHead(404).end('MCP session is unavailable'); return }
    const operation = relay.transport.handleRequest(request, response, body)
    relay.requests.add(operation)
    try { await operation }
    finally {
      relay.requests.delete(operation)
      if (request.method === 'DELETE' || relay.transport.sessionId === undefined) await relay.close()
    }
  }

  private createRelay(cached: CachedConnection, client: Client, entry: PublicConnector, config: Configuration): RelaySession {
    const previous = cached.relay
    const id = randomUUID()
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => id })
    const resources = client.getServerCapabilities()?.resources !== undefined
    const instructions = client.getInstructions()
    // oxlint-disable-next-line typescript/no-deprecated -- MCP relay needs raw forwarding, not tool registration.
    const server = new Server({ name: 'product-personal-mcp-relay', version: '1.0.0' }, {
      capabilities: { tools: {}, ...resources ? { resources: {} } : {} },
      ...instructions === undefined ? {} : { instructions },
    })
    const requestOptions = (context: ServerContext) => ({
      signal: AbortSignal.any([cached.controller.signal, context.mcpReq.signal, this.lifetime.signal,
        ...context.http?.req === undefined ? [] : [context.http.req.signal]]), timeout: config.timeoutSeconds * 1000,
    })
    const declaredNames = new Set(entry.tools.map(tool => tool.name))
    server.setRequestHandler('tools/list', async (_request, context) => ({
      tools: (await this.discover(client, requestOptions(context).signal, config.timeoutSeconds))
        .filter(tool => declaredNames.has(tool.name)),
    }))
    server.setRequestHandler('tools/call', async (request, context) => {
      const options = requestOptions(context)
      const current = await this.discover(client, options.signal, config.timeoutSeconds)
      const declared = entry.tools.some(tool => tool.name === request.params.name)
      if (!declared || !current.some(tool => tool.name === request.params.name)) throw new Error('Connector tool is not declared')
      return client.callTool(request.params, options)
    })
    if (resources) {
      server.setRequestHandler('resources/list', (request, context) =>
        client.listResources(request.params, requestOptions(context)))
      server.setRequestHandler('resources/templates/list', (request, context) =>
        client.listResourceTemplates(request.params, requestOptions(context)))
      server.setRequestHandler('resources/read', (request, context) =>
        client.readResource(request.params, requestOptions(context)))
    }
    let closing: Promise<void> | undefined
    const relay: RelaySession = { id, transport, requests: new Set(),
      ready: (async () => {
        await previous?.close()
        cached.controller.signal.throwIfAborted()
        await server.connect(transport)
      })(),
      close: () => closing ??= (async () => {
        await relay.ready.catch(() => undefined)
        try { await server.close() }
        finally {
          if (cached.relay === relay) delete cached.relay
          await Promise.allSettled([...relay.requests])
        }
      })(),
    }
    server.onclose = () => { if (cached.relay === relay) delete cached.relay }
    cached.relay = relay
    return relay
  }

  /** Cancel pending connects and close every child process owned by this desktop extension. */
  async close(): Promise<void> {
    this.lifetime.abort(new Error('Personal connector manager closed'))
    for (const owner of this.connectorOwners.values()) owner.abort(this.lifetime.signal.reason)
    this.connectorOwners.clear()
    await Promise.allSettled([...this.operations.values()])
    await Promise.allSettled([...this.clients.values()].map(cached => this.disconnect(cached)))
    this.clients.clear()
  }

  /** Release the previous employee's MCP processes after signing out or switching accounts.
   * @param employee Current authenticated employee, or undefined after sign-out.
   */
  async resetIdentity(employee: string | undefined): Promise<void> {
    if (this.identity === employee) return
    this.identity = employee
    for (const owner of this.connectorOwners.values()) owner.abort(new Error('Employee identity changed'))
    this.connectorOwners.clear()
    const previous = [...this.clients.values()]
    this.clients.clear()
    await Promise.allSettled(previous.map(cached => this.disconnect(cached)))
  }

  private key(employee: string, id: string, version: string): string { return createHash('sha256').update(JSON.stringify([employee, id, version])).digest('hex') }
  private template(values: Record<string, string>): Record<string, string> { return Object.fromEntries(Object.keys(values).map(key => [key, ''])) }
  private localConfigurationAllowed(entry: PublicConnector): boolean { return entry.authMode === 'none' && entry.managed !== true }
  private filename(employee: string, id: string, version: string): string { return join(this.root, `${this.key(employee, id, version)}.bin`) }
  private async pending(filename: string): Promise<z.infer<typeof PendingConfiguration> | undefined> {
    let encrypted: Buffer
    try { encrypted = await readFile(`${filename}.pending`) }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error }
    return PendingConfiguration.parse(JSON.parse(this.secure.decryptString(encrypted)))
  }
  private matchesPending(entry: PublicConnector, employee: string, pending: z.infer<typeof PendingConfiguration>): boolean {
    const publicFields = z.object({ id: z.string(), version: z.string(), name: z.string(), summary: z.string(), category: z.string(),
      toolNames: z.array(z.string()) }).parse(JSON.parse(pending.body))
    return pending.employee === employee && entry.ownerEmployeeId === employee && entry.visibility === 'PERSONAL'
      && entry.authMode === 'none' && entry.id === publicFields.id && entry.version === publicFields.version && entry.name === publicFields.name
      && entry.summary === publicFields.summary && entry.category === publicFields.category
      && entry.transport === pending.config.transport && entry.url === pending.config.url && entry.command === pending.config.command
      && JSON.stringify(entry.arguments) === JSON.stringify(pending.config.arguments)
      && JSON.stringify(Object.keys(entry.headers).sort()) === JSON.stringify(Object.keys(pending.config.headers).sort())
      && JSON.stringify(Object.keys(entry.environment).sort()) === JSON.stringify(Object.keys(pending.config.environment).sort())
      && JSON.stringify(entry.tools.map(tool => tool.name).sort()) === JSON.stringify([...publicFields.toolNames].sort())
  }
  private async finalize(filename: string, config: Configuration): Promise<void> {
    const staging = `${filename}.${randomUUID()}.tmp`
    try {
      await writeFile(staging, this.secure.encryptString(JSON.stringify(config)), { mode: 0o600, flag: 'wx', flush: true })
      await rename(staging, filename)
      await rm(`${filename}.pending`, { force: true })
    } finally { await rm(staging, { force: true }) }
  }
  private connectorSignal(employee: string, id: string): AbortSignal {
    this.lifetime.signal.throwIfAborted()
    const key = this.key(employee, id, '')
    let owner = this.connectorOwners.get(key)
    if (owner === undefined) {
      owner = new AbortController()
      this.connectorOwners.set(key, owner)
    }
    return owner.signal
  }
  private async configuration(entry: PublicConnector, employee: string, signal: AbortSignal,
    serialized = false): Promise<ConfigurationRead> {
    signal.throwIfAborted()
    let owner = this.connectorSignal(employee, entry.id)
    try {
      const filename = this.filename(employee, entry.id, entry.version)
      const pending = await this.pending(filename)
      signal.throwIfAborted()
      owner.throwIfAborted()
      if (pending && this.matchesPending(entry, employee, pending)) {
        if (!serialized) return await this.serialize(employee, entry.id, AbortSignal.any([signal, owner]),
          () => this.configuration(entry, employee, signal, true))
        await this.finalize(filename, pending.config)
        owner.throwIfAborted()
        const cleanup = this.disconnectConnector(employee, entry.id)
        owner = this.connectorSignal(employee, entry.id)
        await cleanup
        owner.throwIfAborted()
      }
      signal.throwIfAborted()
      const encrypted = await readFile(filename)
      signal.throwIfAborted()
      owner.throwIfAborted()
      const config = Configuration.parse(JSON.parse(this.secure.decryptString(encrypted)))
      if (config.transport !== entry.transport || config.url !== entry.url || config.command !== entry.command
        || JSON.stringify(config.arguments) !== JSON.stringify(entry.arguments)) {
        throw new Error('Private settings do not match this connector version')
      }
      return { config, signal: owner }
    } catch (error) {
      signal.throwIfAborted()
      owner.throwIfAborted()
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { config: undefined, signal: owner }
      throw new Error('Private connector settings could not be decrypted')
    }
  }
  private async client(entry: PublicConnector, employee: string, config: Configuration, signal: AbortSignal): Promise<Client> {
    signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    if (this.employee() !== employee) throw new ProductError('CONNECTOR_AUTHORIZATION_REQUIRED', 'Employee identity changed', false)
    const key = this.key(employee, entry.id, entry.version)
    let cached = this.clients.get(key)
    if (cached?.controller.signal.aborted) {
      await this.disconnect(cached)
      return this.client(entry, employee, config, signal)
    }
    if (cached === undefined) {
      const controller = new AbortController()
      const created: CachedConnection = { key, employee, id: entry.id, controller, connection: this.connect(config, controller.signal),
        waiters: 0, connected: false }
      cached = created
      this.clients.set(key, created)
      void created.connection.then((value) => {
        created.connected = true
        value.onclose = () => { void this.disconnect(created).catch((error: unknown) => {
          console.error('Personal MCP connection cleanup failed', error)
        }) }
      }, () => { if (this.clients.get(key) === created) this.clients.delete(key) })
    }
    const shared = cached
    shared.waiters += 1
    try {
      const cancelled = Promise.withResolvers<never>()
      using _listener = addAbortListener(signal, () => {
        cancelled.reject(signal.reason instanceof Error ? signal.reason : new Error('MCP connection reader cancelled'))
      })
      return await Promise.race([cancelled.promise, shared.connection])
    } finally {
      shared.waiters -= 1
      if (shared.waiters === 0 && !shared.connected) {
        shared.controller.abort(new Error('No remaining MCP connection readers'))
        await shared.connection.catch(() => undefined)
      }
    }
  }
  private async disconnectConnector(employee: string, id: string): Promise<void> {
    const key = this.key(employee, id, '')
    const owner = this.connectorOwners.get(key)
    this.connectorOwners.delete(key)
    owner?.abort(new Error('Personal connector configuration changed'))
    const results = await Promise.allSettled([...this.clients.values()]
      .filter(cached => cached.employee === employee && cached.id === id)
      .map(cached => this.disconnect(cached)))
    const errors: unknown[] = []
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
    if (errors.length) throw new AggregateError(errors, 'Personal MCP connection cleanup failed')
  }
  private async disconnect(cached: CachedConnection): Promise<void> {
    cached.controller.abort(new Error('Personal MCP connection released'))
    return cached.closing ??= (async () => {
      const client = await cached.connection.catch(() => undefined)
      try { await cached.relay?.close() }
      finally {
        try { await client?.close() }
        finally { if (this.clients.get(cached.key) === cached) this.clients.delete(cached.key) }
      }
    })()
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
    const { tools } = await client.listTools(undefined, { cacheMode: 'refresh', signal: deadline, timeout: timeoutSeconds * 1000 })
    if (tools.length > 512) throw new Error('MCP tool limit exceeded')
    return tools
  }
}
