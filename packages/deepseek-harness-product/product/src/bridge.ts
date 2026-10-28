/** Main-process product bridge. It owns credentials and exposes only product methods. */

import { DeepSeekHarnessApiClient, DeepSeekHarnessApiError } from './http-client.ts'
import { assertProductMethod, assertProductPayload, type KnowledgeFileMethod, type ProductEvent, type ProductMethod, type ProductRuntimeMethod, type ProductSession } from './protocol.ts'
import { ProductCatalogManager } from './catalog-manager.ts'
import { invokeKnowledge, type KnowledgeUpload } from './knowledge-bridge.ts'
export type { KnowledgeUpload, KnowledgeUploadPending } from './knowledge-bridge.ts'
import { ProductError } from './errors.ts'
import { z } from 'zod'
import { invokeContentSubmission } from './content-submission-bridge.ts'
import { parseConnectorAuthorization, parseConnectorAuthorizationLaunch } from './connector-authorization.ts'

/** Main-process-only inference bootstrap. Secrets in this object never cross the preload bridge. */
export interface ProductRuntimeBootstrap {
  readonly modelApiKey: string
  readonly endpoints: { readonly litellm: string }
  readonly models: readonly string[]
}

function runtimeBootstrap(value: unknown): ProductRuntimeBootstrap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('deepseek-harness product: invalid runtime bootstrap')
  }
  const record = value as Record<string, unknown>
  const endpoints = record.endpoints
  const rawModels: unknown = record.models
  if (typeof record.modelApiKey !== 'string' || !/^[\x21-\x7e]+$/.test(record.modelApiKey)
    || !Array.isArray(rawModels) || rawModels.length === 0
    || (rawModels as unknown[]).some(model => typeof model !== 'string' || model.trim() !== model || model === '' || /[\x00-\x20\x7f]/.test(model))
    || new Set(rawModels).size !== rawModels.length
    || typeof endpoints !== 'object' || endpoints === null || Array.isArray(endpoints)
    || typeof (endpoints as Record<string, unknown>).litellm !== 'string') {
    throw new Error('deepseek-harness product: invalid runtime bootstrap')
  }
  const endpoint = new URL((endpoints as Record<string, unknown>).litellm as string)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username !== '' || endpoint.password !== ''
    || endpoint.search !== '' || endpoint.hash !== '') {
    throw new Error('deepseek-harness product: invalid inference endpoint')
  }
  return { modelApiKey: record.modelApiKey, endpoints: { litellm: endpoint.href },
    models: (rawModels as unknown[]).map(model => String(model)) }
}

/** Main-process dependencies used to construct the product bridge. */
export interface ProductBridgeOptions {
  /** Main-owned original streaming, file handles, native download and system opening. */
  readonly knowledgeFiles?: (method: KnowledgeFileMethod, payload: Readonly<Record<string, unknown>>, api: DeepSeekHarnessApiClient,
    session: ProductSession, signal?: AbortSignal) => Promise<unknown>
  /** Native knowledge-file picker and upload; renderer code cannot choose filesystem paths. */
  readonly knowledgeUpload?: KnowledgeUpload
  readonly serverUrl?: string | undefined
  readonly sessionToken?: string | undefined
  readonly desktopVersion?: string | undefined
  readonly initialSession?: ProductSession | undefined
  /** Testable main-process HTTP transport. Renderer code never supplies this function. */
  readonly fetch?: typeof fetch
  readonly persistSession?: (session: ProductSession, sessionToken: string | undefined) => void | Promise<void>
  /** Main-process native capability dispatcher. Renderer code never receives this function. */
  readonly nativeInvoke?: (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>
  /** Dispatch task capability operations to the trusted runtime. */
  readonly taskCapabilities?: (method: 'read' | 'prepare', payload: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<unknown>
  /** Dispatch knowledge selections and document rendering to the Host. */
  /** Main-owned connector management, with authenticated API access and UI-safe employee identity. */
  readonly connectorManagement?: (method: string, payload: Readonly<Record<string, unknown>>, api: DeepSeekHarnessApiClient,
    session: ProductSession, signal?: AbortSignal) => Promise<unknown>
  /** Resolve device-owned MCP configuration in main before projecting a credential-free catalog. */
  readonly connectorRuntime?: (value: unknown, signal: AbortSignal, discoverTools: boolean) => Promise<unknown>
  /** Main-owned device metadata and employee-initiated feedback; no arbitrary transport is exposed. */
  readonly support?: (method: string, payload: Readonly<Record<string, unknown>>, api: DeepSeekHarnessApiClient,
    session: ProductSession, signal: AbortSignal) => Promise<unknown>
}

const SESSION_REFRESH_LEAD_SECONDS = 5 * 60
const SESSION_REFRESH_RETRY_SECONDS = 30
/** Main-process product API boundary exposed to the Renderer through preload. */
export class DeepSeekHarnessProductBridge {
  private sessionToken: string | undefined
  private identityLifecycle = new AbortController()
  private session: ProductSession
  private readonly listeners = new Set<(event: ProductEvent) => void>()
  private readonly api?: DeepSeekHarnessApiClient
  private readonly nativeInvoke?: ProductBridgeOptions['nativeInvoke']
  private readonly optionsTaskCapabilities?: ProductBridgeOptions['taskCapabilities']
  private readonly connectorManagement?: ProductBridgeOptions['connectorManagement']
  private readonly connectorRuntime?: ProductBridgeOptions['connectorRuntime']
  private readonly support?: ProductBridgeOptions['support']
  private readonly catalog: ProductCatalogManager
  private readonly knowledgeUpload: KnowledgeUpload | undefined
  private readonly knowledgeFiles: ProductBridgeOptions['knowledgeFiles']
  private sessionRefresh: Promise<void> | undefined
  private readonly refreshOperations = new Set<Promise<void>>()
  private sessionRefreshTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private authorizationAttempt: { readonly controller: AbortController; readonly signal: AbortSignal; state?: string } | undefined

  constructor(options: ProductBridgeOptions = {}) {
    this.knowledgeUpload = options.knowledgeUpload
    this.knowledgeFiles = options.knowledgeFiles
    this.sessionToken = options.sessionToken
    this.session = options.initialSession ?? (options.sessionToken === undefined ? { authenticated: false } : { authenticated: true })
    this.persistSession = options.persistSession
    this.nativeInvoke = options.nativeInvoke
    this.optionsTaskCapabilities = options.taskCapabilities
    this.connectorManagement = options.connectorManagement
    this.connectorRuntime = options.connectorRuntime
    this.support = options.support
    if (options.serverUrl !== undefined && options.serverUrl !== '') {
      this.api = new DeepSeekHarnessApiClient({ baseUrl: options.serverUrl, getSessionToken: () => this.sessionToken,
        getEmployeeId: () => this.session.employeeId,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }) })
    }
    this.catalog = new ProductCatalogManager({
      api: this.api,
      getSession: () => this.session,
      ensureFreshSession: () => this.ensureFreshSession(),
      getIdentitySignal: () => this.identityLifecycle.signal,
      emit: (event) => { this.emit(event) },
    })
    this.scheduleSessionRefresh()
    this.catalog.schedule()
  }

  /** Return the current UI-safe employee session snapshot.
   * @returns Current product session.
   */
  getSession(): ProductSession { return this.session }

  /** Read inference configuration for the Electron main process only.
   * @returns Employee-scoped model configuration kept outside the Renderer.
   */
  async loadRuntimeBootstrap(): Promise<ProductRuntimeBootstrap> {
    if (this.api === undefined) throw new Error('deepseek-harness product: server URL is not configured')
    const api = this.api
    return this.withEmployeeSession(undefined, async signal => runtimeBootstrap(await api.bootstrap<unknown>(signal)))
  }

  /** Read company-owned native content in main, keeping employee authentication private.
   * @param signal - Lifecycle cancellation for the shared main-process refresh.
   * @returns Current validated release payload, or null when no content is published.
   */
  async loadCompanyContent(signal?: AbortSignal): Promise<unknown> {
    if (this.api === undefined) throw new Error('Product server is unavailable')
    const api = this.api
    return this.withEmployeeSession(signal, signal => api.request<unknown>('/api/v1/company-content', { signal }))
  }

  /** Replace the current session and persist the opaque token outside the Renderer.
   * @param session - UI-safe employee session.
   * @param token - Opaque token retained by the main process.
   */
  setSession(session: ProductSession, token?: string): void {
    if (this.closed) return
    this.authorizationAttempt?.controller.abort(new Error('Product employee session changed'))
    this.authorizationAttempt = undefined
    const previousEmployee = this.session.employeeId
    this.session = { ...session }
    this.sessionToken = token
    if (!session.authenticated || session.employeeId !== previousEmployee) {
      this.identityLifecycle.abort(new Error('Product employee identity changed'))
      this.identityLifecycle = new AbortController()
      this.sessionRefresh = undefined
      this.catalog.reset()
    }
    const persisted = this.persistSession?.(this.session, this.sessionToken)
    if (persisted instanceof Promise) {
      void persisted.catch((error: unknown) => {
        console.error('deepseek-harness product: failed to persist session', error)
      })
    }
    this.scheduleSessionRefresh()
    this.catalog.schedule()
    this.emit({ type: 'session.changed', payload: this.session })
    if (session.authenticated) void this.catalog.refresh().catch(() => undefined)
  }

  /** Subscribe to product session and catalog events.
   * @param listener - Callback invoked for each product event.
   * @returns An unsubscribe function.
   */
  subscribe(listener: (event: ProductEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Refresh employee-visible directories independently, committing each successful result.
   * Background callers share one request; cancellable callers own separate requests.
   * Failed directories retain their last display result and are excluded from dependency estimates.
   * @param signal - Optional caller cancellation.
   * @returns Completion after all directory requests settle.
   */
  async refreshCatalog(signal?: AbortSignal): Promise<void> {
    return this.catalog.refresh(signal)
  }

  private catalogChanged(): void {
    this.catalog.reset()
    this.emit({ type: 'catalog.changed' })
    void this.catalog.refresh().catch((_error: unknown) => {
      // Cached permissions remain invalid; foreground directory reads report refresh failures.
    })
  }

  /** Cancel and await background requests, suppressing later events and timers. */
  async dispose(): Promise<void> {
    this.closed = true
    this.identityLifecycle.abort(new Error('Product bridge closed'))
    this.authorizationAttempt?.controller.abort(new Error('Product bridge closed'))
    this.authorizationAttempt = undefined
    this.listeners.clear()
    this.api?.close()
    if (this.sessionRefreshTimer !== undefined) clearTimeout(this.sessionRefreshTimer)
    this.sessionRefreshTimer = undefined
    await Promise.allSettled([this.catalog.dispose(), ...this.refreshOperations])
  }

  /** Validate and dispatch one allowlisted product operation.
   * @param method - Candidate operation name.
   * @param payload - Candidate operation payload.
   * @param signal - Optional cancellation for Host-owned remote work.
   * @returns The operation result.
   */
  async invoke(method: unknown, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error('Product bridge has been disposed')
    assertProductMethod(method)
    const input = assertProductPayload(payload)
    if (method === 'auth.getSession') return this.session
    if (method === 'native.device-identity.get') {
      if (this.nativeInvoke === undefined) throw new Error('deepseek-harness product: native sidecar is unavailable')
      return this.nativeInvoke('device-identity.get', input, signal)
    }
    if (this.api === undefined) throw new Error('deepseek-harness product: server URL is not configured')
    if (method === 'auth.beginDingTalk') {
      this.authorizationAttempt?.controller.abort(new Error('DingTalk authorization was superseded'))
      const controller = new AbortController()
      const lifetime = AbortSignal.any([controller.signal, this.identityLifecycle.signal, ...signal ? [signal] : []])
      lifetime.throwIfAborted()
      const attempt: NonNullable<typeof this.authorizationAttempt> = { controller, signal: lifetime }
      this.authorizationAttempt = attempt
      const result = await this.api.beginDingTalk<Record<string, unknown>>(lifetime)
      lifetime.throwIfAborted()
      if (typeof result.state !== 'string' || result.state.length < 8) throw new Error('Invalid DingTalk authorization state')
      attempt.state = result.state
      return result
    }
    if (method === 'auth.pollDingTalk') {
      const state = input.state
      if (typeof state !== 'string' || state.length < 8) throw new Error('deepseek-harness product: authorization state is required')
      const attempt = this.authorizationAttempt
      if (attempt?.state !== state) throw new Error('DingTalk authorization is no longer current')
      const lifetime = AbortSignal.any([attempt.signal, ...signal ? [signal] : []])
      lifetime.throwIfAborted()
      const result = await this.api.pollDingTalk<Record<string, unknown>>(state, lifetime)
      lifetime.throwIfAborted()
      const session = result.session
      if (typeof session !== 'object' || session === null || Array.isArray(session)) {
        return { status: typeof result.status === 'string' ? result.status : undefined, session: null }
      }
      const authenticated = session as Record<string, unknown>
      const token = authenticated.sessionToken
      if (typeof token === 'string' && token !== '') {
        const identity = authenticated.employee as Record<string, unknown> | undefined
        this.setSession({ authenticated: true,
          ...(typeof identity?.employeeId === 'string' ? { employeeId: identity.employeeId } : {}),
          ...(typeof identity?.employeeName === 'string' ? { displayName: identity.employeeName } : {}),
          ...((typeof authenticated.expiresAt === 'string' || typeof authenticated.expiresAt === 'number')
            ? { expiresAt: String(authenticated.expiresAt) } : {}),
        }, token)
      }
      return { status: typeof result.status === 'string' ? result.status : undefined,
        session: this.session.authenticated ? this.getSession() : null }
    }
    if (method === 'auth.refresh') {
      await this.refreshEmployeeSession(signal)
      return this.session
    }
    if (method === 'catalog.refresh') {
      await this.refreshCatalog(signal)
      return { refreshed: true }
    }
    const freshCatalog = signal !== undefined
    return this.withEmployeeSession(signal, lifetime => this.invokeAuthenticated(method, input, lifetime, freshCatalog))
  }

  /** Dispatch one Host-owned product request. Connector results receive private
   * runtime headers here and never enter the Renderer catalog snapshot.
   * @param method - Allowlisted Host product method.
   * @param payload - Optional method payload.
   * @param signal - Request cancellation.
   * @returns Host-safe product data.
   */
  async invokeRuntime(method: ProductRuntimeMethod, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (method.startsWith('runtime.knowledge.preview.')) {
      if (this.closed) throw new Error('Product bridge has been disposed')
      return this.withEmployeeSession(signal, async (lifetime) => {
        if (this.api === undefined || this.knowledgeFiles === undefined) throw new ProductError('KNOWLEDGE_PREVIEW_UNAVAILABLE', 'File transport is unavailable', true)
        return await this.knowledgeFiles(method as KnowledgeFileMethod, assertProductPayload(payload), this.api, this.session, lifetime)
      })
    }
    if (method !== 'connectors.list') return this.invoke(method, payload, signal)
    return this.readRuntimeConnectors(payload, signal, true)
  }

  private readRuntimeConnectors(payload: unknown, signal: AbortSignal | undefined, discoverTools: boolean): Promise<unknown> {
    return this.withEmployeeSession(signal, async (lifetime) => {
      const api = this.api
      const sessionToken = this.sessionToken
      if (api === undefined || sessionToken === undefined) {
        throw new Error('deepseek-harness product: connector runtime requires an employee session')
      }
      const input = assertProductPayload(payload)
      const ids = input.ids === undefined ? undefined : z.array(z.string().regex(/^[A-Za-z0-9._-]{1,128}$/)).max(1000).parse(input.ids)
      const selected = ids === undefined ? await this.catalog.read('connectors.list', lifetime)
        : (await Promise.all([...new Set(ids)].map(async (id) => {
          try { return z.looseObject({ id: z.literal(id) }).parse(await api.request(`/api/v1/connectors/${encodeURIComponent(id)}/configuration-template`, { signal: lifetime })) }
          catch (error) {
            if (error instanceof DeepSeekHarnessApiError && error.status === 404
              && ['CONNECTOR_NOT_FOUND', 'CONNECTOR_RELEASE_NOT_FOUND'].includes(error.code)) return undefined
            throw error
          }
        }))).filter(entry => entry !== undefined)
      lifetime.throwIfAborted()
      if (!Array.isArray(selected)) throw new Error('deepseek-harness product: invalid connector catalog')
      const runtime = selected.map(entry => runtimeConnector(entry, api, sessionToken))
      return this.connectorRuntime ? this.connectorRuntime(runtime, lifetime, discoverTools) : runtime
    })
  }

  /** Resolve transport credentials for main's relay without connecting to MCP servers.
   * @param ids Connectors addressed by an authenticated relay request.
   * @param signal Relay request cancellation.
   * @returns Main-only current configuration; the relay must validate its pinned version before forwarding.
   */
  readConnectorTransports(ids: readonly string[], signal: AbortSignal): Promise<unknown> {
    return this.readRuntimeConnectors({ ids }, signal, false)
  }

  private async invokeAuthenticated(
    method: ProductMethod,
    input: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    freshCatalog = true,
  ): Promise<unknown> {
    if (this.api === undefined) throw new Error('deepseek-harness product: server URL is not configured')
    if (method.startsWith('support.')) {
      const lifetime = AbortSignal.any([this.identityLifecycle.signal, ...signal ? [signal] : []])
      if (!this.session.authenticated || !this.session.employeeId) throw new ProductError('EMPLOYEE_UNAUTHORIZED', 'Employee sign-in is required')
      if (!this.support) throw new ProductError('FEATURE_UNAVAILABLE', 'Desktop support is unavailable')
      return this.support(method, input, this.api, this.session, lifetime)
    }
    if (method.startsWith('content.submissions.')) {
      const lifetime = AbortSignal.any([this.identityLifecycle.signal, ...signal ? [signal] : []])
      if (!this.session.authenticated || !this.session.employeeId) throw new ProductError('EMPLOYEE_UNAUTHORIZED', 'Employee sign-in is required')
      return invokeContentSubmission(method, input, this.api, lifetime)
    }
    if (method.startsWith('extensions.')) {
      signal = AbortSignal.any([this.identityLifecycle.signal, ...signal ? [signal] : []])
      if (!this.session.authenticated || !this.session.employeeId) throw new Error('Authenticated employee is required')
      if (this.connectorManagement === undefined) throw new Error('Personal extension editor is unavailable')
      try { return await this.connectorManagement(method, input, this.api, this.session, signal) }
      finally {
        if (!signal.aborted) {
          if (method === 'extensions.save' || method === 'extensions.submit' || method === 'extensions.connector.update'
            || method === 'extensions.connector.delete' || method === 'extensions.connector.configuration.save') {
            this.catalogChanged()
          }
        }
      }
    }
    if (method === 'knowledge.references.resolve') {
      return this.api.request('/api/v1/knowledge-references/resolve', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), ...(signal ? { signal } : {}) })
    }
    if (method === 'tasks.capabilities.read' || method === 'tasks.capabilities.prepare') {
      await this.ensureFreshSession()
      signal?.throwIfAborted()
      if (this.optionsTaskCapabilities === undefined) throw new Error('Product task runtime is unavailable')
      return this.optionsTaskCapabilities(method.endsWith('.read') ? 'read' : 'prepare', input, signal)
    }
    if (method === 'connectors.authorization.status') {
      const result = await this.api.request(
        `/api/v1/connectors/${encodeURIComponent(requiredId(input))}/authorization`, { ...(signal === undefined ? {} : { signal }) },
      )
      if (parseConnectorAuthorization(result, requiredId(input)).status === 'AUTHORIZED') this.catalogChanged()
      return result
    }
    if (method === 'connectors.authorization.begin') {
      const result = await this.api.request(`/api/v1/connectors/${encodeURIComponent(requiredId(input))}/authorization-requests`, {
        method: 'POST', ...(signal === undefined ? {} : { signal }),
      })
      parseConnectorAuthorizationLaunch(result, requiredId(input))
      return result
    }
    if (method === 'connectors.authorization.revoke') {
      const result = await this.api.request(`/api/v1/connectors/${encodeURIComponent(requiredId(input))}/authorization`, {
        method: 'DELETE', ...(signal === undefined ? {} : { signal }),
      })
      if (parseConnectorAuthorization(result, requiredId(input)).status !== 'REQUIRED') throw new Error('Connector revocation was not confirmed')
      this.catalogChanged()
      return result
    }
    if (method === 'knowledge.search') {
      const query = input.query
      const knowledgeBaseRefs = input.knowledgeBaseRefs
      const knowledgeBaseIds = input.knowledgeBaseIds
      const limit = input.limit ?? 8
      if (typeof query !== 'string' || query.trim() === '' || query.length > 2_000
        || !stringArray(knowledgeBaseRefs, 32) || !stringArray(knowledgeBaseIds, 32)
        || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 12) {
        throw new Error('deepseek-harness product: invalid knowledge search request')
      }
      if (input.restrictToKnowledgeBaseRefs === true && knowledgeBaseRefs.length === 0 && knowledgeBaseIds.length === 0) return []
      return this.api.request('/api/v1/knowledge-searches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(signal === undefined ? {} : { signal }),
        body: JSON.stringify({
          query: query.trim(), knowledgeBaseRefs, knowledgeBaseIds,
          restrictToKnowledgeBaseRefs: input.restrictToKnowledgeBaseRefs === true || knowledgeBaseRefs.length > 0, limit,
        }),
      })
    }
    if (method === 'knowledge.bases.list') return this.catalog.read(method, signal)
    if (method.startsWith('knowledge.documents.preview.') || method === 'knowledge.documents.download' || method === 'knowledge.documents.openExternal') {
      if (!this.session.authenticated || !this.session.employeeId) throw new ProductError('KNOWLEDGE_ACCESS_DENIED', 'Authenticated employee is required', false)
      if (this.knowledgeFiles === undefined) throw new ProductError('KNOWLEDGE_PREVIEW_UNAVAILABLE', 'File transport is unavailable', true)
      return this.knowledgeFiles(method as KnowledgeFileMethod, input, this.api, this.session, signal)
    }
    if (method.startsWith('knowledge.documents.') || method.startsWith('knowledge.folders.') || method === 'knowledge.sources.read'
      || method === 'knowledge.bases.create' || method === 'knowledge.files.limits') {
      return invokeKnowledge(this.api, method, input, this.knowledgeUpload, signal)
    }
    if (method === 'knowledge.bases.delete') {
      const result = await invokeKnowledge(this.api, method, input, this.knowledgeUpload, signal)
      this.catalog.reset()
      // Deletion is already committed on the server. A stale catalog should
      // be refreshed opportunistically without turning success into failure.
      await this.catalog.refresh(signal).catch(() => undefined)
      return result
    }
    const value = method === 'connectors.list' && this.connectorRuntime
      ? await this.readRuntimeConnectors(input, signal, false) : await this.catalog.read(method, freshCatalog ? signal : undefined)
    return method === 'connectors.list' && Array.isArray(value) ? value.map(rendererConnector) : value
  }

  private async ensureFreshSession(): Promise<void> {
    if (!this.session.authenticated || this.sessionToken === undefined) {
      throw new DeepSeekHarnessApiError(401, 'EMPLOYEE_UNAUTHORIZED', 'Employee authentication is required')
    }
    const expiresAt = Number(this.session.expiresAt)
    if (!Number.isFinite(expiresAt)) return
    const remaining = expiresAt - Date.now() / 1_000
    if (remaining <= 0) {
      this.clearSession()
      throw new DeepSeekHarnessApiError(401, 'EMPLOYEE_UNAUTHORIZED', 'Employee authentication is required')
    }
    if (remaining <= SESSION_REFRESH_LEAD_SECONDS) await this.refreshEmployeeSession()
  }

  private refreshEmployeeSession(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (signal === undefined && this.sessionRefresh !== undefined) return this.sessionRefresh
    if (this.api === undefined || !this.session.authenticated || this.sessionToken === undefined) {
      this.clearSession()
      return Promise.reject(new DeepSeekHarnessApiError(401, 'EMPLOYEE_UNAUTHORIZED', 'Employee authentication is required'))
    }
    const refreshLifetime = AbortSignal.any([this.identityLifecycle.signal, ...signal ? [signal] : []])
    const tokenBeforeRefresh = this.sessionToken
    const refresh = this.api.refreshSession<unknown>(refreshLifetime).then((result) => {
      refreshLifetime.throwIfAborted()
      if (this.sessionToken !== tokenBeforeRefresh) throw new Error('Product employee session changed')
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw new Error('deepseek-harness product: invalid refreshed session')
      }
      const refreshed = result as Record<string, unknown>
      const token = refreshed.sessionToken
      if (typeof token !== 'string' || token === '') {
        throw new Error('deepseek-harness product: invalid refreshed session')
      }
      const identity = refreshed.employee as Record<string, unknown> | undefined
      this.setSession({ authenticated: true,
        ...(typeof identity?.employeeId === 'string' ? { employeeId: identity.employeeId } : {}),
        ...(typeof identity?.employeeName === 'string' ? { displayName: identity.employeeName } : {}),
        ...((typeof refreshed.expiresAt === 'string' || typeof refreshed.expiresAt === 'number')
          ? { expiresAt: String(refreshed.expiresAt) } : {}),
      }, token)
    }).catch((error: unknown) => {
      if (!refreshLifetime.aborted && this.sessionToken === tokenBeforeRefresh) {
        this.handleAuthenticationFailure(error)
        if (this.session.authenticated) this.scheduleSessionRefreshRetry()
      }
      throw error
    }).finally(() => {
      if (this.sessionRefresh === refresh) this.sessionRefresh = undefined
      this.refreshOperations.delete(refresh)
    })
    if (signal === undefined) this.sessionRefresh = refresh
    this.refreshOperations.add(refresh)
    return refresh
  }

  private scheduleSessionRefresh(): void {
    if (this.sessionRefreshTimer !== undefined) clearTimeout(this.sessionRefreshTimer)
    this.sessionRefreshTimer = undefined
    if (this.closed || !this.session.authenticated || this.sessionToken === undefined) return
    const expiresAt = Number(this.session.expiresAt)
    if (!Number.isFinite(expiresAt)) return
    const delay = Math.max(0, (expiresAt - Date.now() / 1_000 - SESSION_REFRESH_LEAD_SECONDS) * 1_000)
    this.sessionRefreshTimer = setTimeout(() => {
      this.sessionRefreshTimer = undefined
      void this.refreshEmployeeSession().catch(() => undefined)
    }, delay)
    this.sessionRefreshTimer.unref()
  }

  private scheduleSessionRefreshRetry(): void {
    if (this.closed) return
    if (this.sessionRefreshTimer !== undefined) clearTimeout(this.sessionRefreshTimer)
    const expiresAt = Number(this.session.expiresAt)
    const remainingSeconds = Number.isFinite(expiresAt) ? expiresAt - Date.now() / 1_000 : SESSION_REFRESH_RETRY_SECONDS
    if (remainingSeconds <= 0) {
      this.clearSession()
      return
    }
    const delay = Math.min(SESSION_REFRESH_RETRY_SECONDS, remainingSeconds) * 1_000
    this.sessionRefreshTimer = setTimeout(() => {
      this.sessionRefreshTimer = undefined
      void this.refreshEmployeeSession().catch(() => undefined)
    }, delay)
    this.sessionRefreshTimer.unref()
  }

  private handleAuthenticationFailure(error: unknown): void {
    if (error instanceof DeepSeekHarnessApiError && error.status === 401 && error.code === 'EMPLOYEE_UNAUTHORIZED') {
      this.clearSession()
    }
  }

  private clearSession(): void {
    if (!this.session.authenticated && this.sessionToken === undefined) return
    this.setSession({ authenticated: false })
    this.emit({ type: 'auth.required' })
  }

  private async withEmployeeSession<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const lifetime = AbortSignal.any([this.identityLifecycle.signal, ...signal ? [signal] : []])
    lifetime.throwIfAborted()
    await this.ensureFreshSession()
    lifetime.throwIfAborted()
    const token = this.sessionToken
    try {
      const result = await operation(lifetime)
      lifetime.throwIfAborted()
      return result
    } catch (error) {
      lifetime.throwIfAborted()
      if (this.sessionToken === token) this.handleAuthenticationFailure(error)
      throw error
    }
  }

  private emit(event: ProductEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch (error) { console.error('deepseek-harness product event listener failed', error) }
    }
  }

  private readonly persistSession: ProductBridgeOptions['persistSession']
}

function runtimeConnector(value: unknown, api: DeepSeekHarnessApiClient, sessionToken: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('deepseek-harness product: invalid connector runtime entry')
  }
  const record = value as Record<string, unknown>
  const authMode = record.authMode
  if (!['none', 'employee-bearer', 'oauth'].includes(String(authMode))) {
    throw new Error('deepseek-harness product: invalid connector authentication mode')
  }
  if (record.transport !== 'streamable-http' || authMode === 'none') return record
  if (typeof record.url !== 'string' || record.url === '') {
    throw new Error('deepseek-harness product: authenticated connector URL is missing')
  }
  const endpoint = new URL(api.absoluteUrl(record.url))
  const expected = new URL(api.absoluteUrl(`/api/v1/connectors/${encodeURIComponent(String(record.id))}/mcp`))
  if (endpoint.href !== expected.href || endpoint.username || endpoint.password) {
    throw new Error('deepseek-harness product: authenticated connector must use the product server proxy')
  }
  const headers = typeof record.headers === 'object' && record.headers !== null && !Array.isArray(record.headers)
    ? record.headers as Record<string, string> : {}
  const version = z.string().min(1).max(128).parse(record.version)
  return { ...record, url: endpoint.href, headers: { ...headers, Authorization: `Bearer ${sessionToken}`, 'X-Harness-Connector-Version': version } }
}

function rendererConnector(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid connector catalog entry')
  const record = value as Record<string, unknown>
  const metadata = ['id', 'name', 'displayName', 'summary', 'description', 'category', 'icon', 'author', 'version',
    'status', 'ready', 'authMode', 'authorizationStatus', 'transport', 'minimumDesktopVersion',
    'visibility', 'ownerEmployeeId', 'canEdit', 'canSubmit', 'canDelete', 'reviewStatus', 'configurationStatus', 'canConfigure', 'managed']
  const tools = Array.isArray(record.tools) ? record.tools.map((tool: Record<string, unknown>) =>
    Object.fromEntries(['name', 'displayName', 'description', 'access'].filter(key => key in tool).map(key => [key, tool[key]]))) : []
  return { ...Object.fromEntries(metadata.filter(key => key in record).map(key => [key, record[key]])), tools }
}

function requiredId(input: Readonly<Record<string, unknown>>): string {
  const id = input.id
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(id)) {
    throw new Error('deepseek-harness product: a valid product id is required')
  }
  return id
}

function stringArray(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum
    && value.every(item => typeof item === 'string' && item.trim() !== '' && item.length <= 128)
}
