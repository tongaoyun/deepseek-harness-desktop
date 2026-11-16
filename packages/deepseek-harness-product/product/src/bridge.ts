/** Main-process product bridge. It owns credentials and exposes only product methods. */

import { addAbortListener } from 'node:events'
import { DeepSeekHarnessApiClient, DeepSeekHarnessApiError } from './http-client.ts'
import { assertProductMethod, assertProductPayload,
  type LibraryFileMethod, type ProductEvent, type ProductMethod, type ProductRuntimeMethod, type ProductSession } from './protocol.ts'
import { ProductCatalogManager } from './catalog-manager.ts'
import { ConnectorCatalogToolsSchema } from './catalog.ts'
import { invokeLibrary } from './library-bridge.ts'
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
  readonly libraryFiles?: (method: LibraryFileMethod, payload: Readonly<Record<string, unknown>>, api: DeepSeekHarnessApiClient,
    session: ProductSession, signal?: AbortSignal) => Promise<unknown>
  readonly serverUrl?: string | undefined
  readonly refreshToken?: string | undefined
  readonly sessionToken?: string | undefined
  readonly initialSession?: ProductSession | undefined
  /** Testable main-process HTTP transport. Renderer code never supplies this function. */
  readonly fetch?: typeof fetch
  readonly persistSession?: (session: ProductSession, sessionToken: string | undefined, refreshToken?: string) => void | Promise<void>
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
  private refreshToken: string | undefined
  private sessionToken: string | undefined
  private identityLifecycle = new AbortController()
  private session: ProductSession
  private readonly listeners = new Set<(event: ProductEvent) => void>()
  private readonly api?: DeepSeekHarnessApiClient
  private readonly connectorManagement?: ProductBridgeOptions['connectorManagement']
  private readonly connectorRuntime?: ProductBridgeOptions['connectorRuntime']
  private readonly support?: ProductBridgeOptions['support']
  private readonly catalog: ProductCatalogManager
  private readonly libraryFiles: ProductBridgeOptions['libraryFiles']
  private sessionSignOut: Promise<void> | undefined
  private sessionRefresh: Promise<void> | undefined
  private readonly refreshOperations = new Set<Promise<void>>()
  private sessionRefreshTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private authorizationAttempt: { readonly controller: AbortController; readonly signal: AbortSignal; state?: string } | undefined

  constructor(options: ProductBridgeOptions = {}) {
    this.libraryFiles = options.libraryFiles
    this.refreshToken = options.refreshToken
    this.sessionToken = options.sessionToken
    this.session = options.initialSession ?? (options.sessionToken === undefined ? { authenticated: false } : { authenticated: true })
    this.persistSession = options.persistSession
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
    return this.withEmployeeSession(signal, signal => api.request<unknown>('/api/v1/company-content', { signal, headers: { 'X-Harness-Content-Protocol': '2' } }))
  }

  /** Read an immutable resource version through the existing employee session.
   * @param ref - Immutable resource coordinates validated by main.
   * @param signal - Employee lifecycle or sync cancellation.
   * @returns Package files whose digest is checked before local installation.
   */
  async loadCompanyResource(ref: { resourceKey: string; version: string; sha256: string }, signal?: AbortSignal): Promise<unknown> {
    if (this.api === undefined) throw new Error('Product server is unavailable')
    const api = this.api
    const query = new URLSearchParams(ref)
    return this.withEmployeeSession(signal, signal => api.request<unknown>('/api/v1/company-content/resource-versions?' + query.toString(), { signal }))
  }

  /** Replace the current session and persist the opaque token outside the Renderer.
   * @param session - UI-safe employee session.
   * @param token - Short-lived access token retained by the main process.
   * @param refreshToken - Remembered-login credential retained by the main process.
   */
  setSession(session: ProductSession, token?: string, refreshToken?: string): void {
    this.commitSession(session, token, refreshToken, false)
  }

  /** A successful refresh may establish its token's missing employee identity
   * without cancelling the refresh or its concurrent sign-in waiters.
   */
  private commitSession(session: ProductSession, token: string | undefined, refreshToken: string | undefined,
    establishesEmployee: boolean): void {
    if (this.closed) return
    this.authorizationAttempt?.controller.abort(new Error('Product employee session changed'))
    this.authorizationAttempt = undefined
    const identityChanged = !session.authenticated || session.employeeId !== this.session.employeeId
    const credentialChanged = this.refreshToken !== refreshToken
    this.session = { ...session }
    this.sessionToken = token
    this.refreshToken = refreshToken
    if (identityChanged || credentialChanged) {
      if (!establishesEmployee) {
        this.identityLifecycle.abort(new Error('Product employee identity changed'))
        this.identityLifecycle = new AbortController()
        this.sessionRefresh = undefined
        this.sessionSignOut = undefined
      }
      if (identityChanged) this.catalog.reset()
    }
    const persisted = this.persistSession?.(this.session, this.sessionToken, this.refreshToken)
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

  /** Invalidate connector reads synchronously after a commit, before device cleanup.
   * The management completion publishes the change and refreshes the catalog.
   */
  invalidateConnectorCatalog(): void { this.catalog.reset() }

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
   * @param signal - Optional cancellation for Host-owned work or waiting on refresh;
   * an issued token rotation still completes for the current employee.
   * @returns The operation result.
   */
  async invoke(method: unknown, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error('Product bridge has been disposed')
    assertProductMethod(method)
    const input = assertProductPayload(payload)
    if (method === 'auth.getSession') return this.session
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
      const receipt = employeeSessionReceipt(session)
      this.setSession(receipt.session, receipt.token, receipt.refreshToken)
      return { status: typeof result.status === 'string' ? result.status : undefined,
        session: this.session.authenticated ? this.getSession() : null }
    }
    if (method === 'auth.signOut') {
      const cancelled = Promise.withResolvers<never>()
      if (signal?.aborted) signal.throwIfAborted()
      using _listener = signal ? addAbortListener(signal, () => { cancelled.reject(signal.reason) }) : undefined
      await Promise.race([this.signOutEmployee(), cancelled.promise])
      signal?.throwIfAborted()
      return this.session
    }
    if (method === 'auth.refresh') {
      const lifetime = AbortSignal.any([this.identityLifecycle.signal, ...signal ? [signal] : []])
      lifetime.throwIfAborted()
      const cancelled = Promise.withResolvers<never>()
      using _listener = addAbortListener(lifetime, () => { cancelled.reject(lifetime.reason) })
      try { await Promise.race([this.refreshEmployeeSession(), cancelled.promise]) }
      catch (error) {
        signal?.throwIfAborted()
        if (!this.getSession().authenticated) {
          throw new DeepSeekHarnessApiError(401, 'EMPLOYEE_UNAUTHORIZED', 'Employee login has expired')
        }
        throw error
      }
      lifetime.throwIfAborted()
      return this.session
    }
    if (method === 'catalog.refresh') {
      await this.refreshCatalog(signal)
      return { refreshed: true }
    }
    return this.withEmployeeSession(signal, lifetime => this.invokeAuthenticated(method, input, lifetime))
  }

  /** Dispatch one Host-owned product request. Connector results receive private
   * runtime headers here and never enter the Renderer catalog snapshot.
   * @param method - Allowlisted Host product method.
   * @param payload - Optional method payload.
   * @param signal - Request cancellation.
   * @returns Host-safe product data.
   */
  async invokeRuntime(method: ProductRuntimeMethod, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (method.startsWith('runtime.library.preview.')) {
      if (this.closed) throw new Error('Product bridge has been disposed')
      return this.withEmployeeSession(signal, async (lifetime) => {
        if (this.api === undefined || this.libraryFiles === undefined) throw new ProductError('LIBRARY_PREVIEW_UNAVAILABLE', 'File transport is unavailable', true)
        return await this.libraryFiles(method as LibraryFileMethod, assertProductPayload(payload), this.api, this.session, lifetime)
      })
    }
    if (method !== 'connectors.list') return this.invoke(method, payload, signal)
    return this.readRuntimeConnectors(payload, signal, true)
  }

  private readRuntimeConnectors(payload: unknown, signal: AbortSignal | undefined, discoverTools: boolean): Promise<unknown> {
    return this.withEmployeeSession(signal, lifetime => this.catalog.withCurrentCatalog(lifetime, async (lifetime) => {
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
    }))
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
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.api === undefined) throw new Error('deepseek-harness product: server URL is not configured')
    if (method.startsWith('support.')) {
      if (!this.session.authenticated || !this.session.employeeId) throw new ProductError('EMPLOYEE_UNAUTHORIZED', 'Employee sign-in is required')
      if (!this.support) throw new ProductError('FEATURE_UNAVAILABLE', 'Desktop support is unavailable')
      return this.support(method, input, this.api, this.session, signal)
    }
    if (method.startsWith('content.submissions.')) {
      if (!this.session.authenticated || !this.session.employeeId) throw new ProductError('EMPLOYEE_UNAUTHORIZED', 'Employee sign-in is required')
      return invokeContentSubmission(method, input, this.api, signal)
    }
    if (method.startsWith('extensions.')) {
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
    if (method === 'connectors.authorization.status') {
      const result = await this.api.request(
        `/api/v1/connectors/${encodeURIComponent(requiredId(input))}/authorization`, { signal },
      )
      if (parseConnectorAuthorization(result, requiredId(input)).status === 'AUTHORIZED') this.catalogChanged()
      return result
    }
    if (method === 'connectors.authorization.begin') {
      const result = await this.api.request(`/api/v1/connectors/${encodeURIComponent(requiredId(input))}/authorization-requests`, {
        method: 'POST', signal,
      })
      parseConnectorAuthorizationLaunch(result, requiredId(input))
      return result
    }
    if (method === 'connectors.authorization.revoke') {
      const result = await this.api.request(`/api/v1/connectors/${encodeURIComponent(requiredId(input))}/authorization`, {
        method: 'DELETE', signal,
      })
      if (parseConnectorAuthorization(result, requiredId(input)).status !== 'REQUIRED') throw new Error('Connector revocation was not confirmed')
      this.catalogChanged()
      return result
    }
    if (method.startsWith('library.files.') && !['library.files.policy', 'library.files.list'].includes(method)) {
      if (this.libraryFiles === undefined) throw new ProductError('LIBRARY_PREVIEW_UNAVAILABLE', 'File transport is unavailable', true)
      return this.libraryFiles(method as LibraryFileMethod, input, this.api, this.session, signal)
    }
    if (method.startsWith('library.')) return invokeLibrary(this.api, method, input, signal)
    const value = method === 'connectors.list' && this.connectorRuntime
      ? await this.readRuntimeConnectors(input, signal, false) : await this.catalog.read(method, signal)
    return method === 'connectors.list' && Array.isArray(value) ? value.map(rendererConnector) : value
  }

  private signOutEmployee(): Promise<void> {
    if (this.sessionSignOut) return this.sessionSignOut
    const token = this.refreshToken
    const lifetime = this.identityLifecycle.signal
    const operation = (async () => {
      if (token && this.api) {
        await this.api.request('/api/v1/employee-auth/session', { method: 'DELETE',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: token }), signal: lifetime })
        lifetime.throwIfAborted()
        if (this.refreshToken !== token) return
      }
      this.clearSession()
    })().finally(() => {
      if (this.sessionSignOut === operation) this.sessionSignOut = undefined
      this.refreshOperations.delete(operation)
    })
    this.sessionSignOut = operation
    this.refreshOperations.add(operation)
    return operation
  }

  private async ensureFreshSession(): Promise<void> {
    if (!this.session.authenticated || this.sessionToken === undefined) {
      throw new DeepSeekHarnessApiError(401, 'EMPLOYEE_UNAUTHORIZED', 'Employee authentication is required')
    }
    const expiresAt = Number(this.session.expiresAt)
    if (!Number.isFinite(expiresAt)) return
    const remaining = expiresAt - Date.now() / 1_000
    if (remaining <= SESSION_REFRESH_LEAD_SECONDS) await this.refreshEmployeeSession()
  }

  private refreshEmployeeSession(): Promise<void> {
    if (this.sessionRefresh !== undefined) return this.sessionRefresh
    if (this.api === undefined || !this.session.authenticated || this.refreshToken === undefined) {
      this.clearSession()
      return Promise.reject(new DeepSeekHarnessApiError(401, 'EMPLOYEE_UNAUTHORIZED', 'Employee authentication is required'))
    }
    const refreshLifetime = this.identityLifecycle.signal
    const tokenBeforeRefresh = this.sessionToken
    const refreshToken = this.refreshToken
    const refresh = this.api.refreshSession<unknown>(refreshToken, refreshLifetime).then((result) => {
      refreshLifetime.throwIfAborted()
      if (this.refreshToken !== refreshToken || this.sessionToken !== tokenBeforeRefresh) throw new Error('Product employee session changed')
      const receipt = employeeSessionReceipt(result)
      if (receipt.refreshToken !== refreshToken || this.session.employeeId !== undefined
        && receipt.session.employeeId !== this.session.employeeId) throw new Error('Product employee session changed')
      this.commitSession(receipt.session, receipt.token, receipt.refreshToken, this.session.employeeId === undefined)
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
    this.sessionRefresh = refresh
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
    const delay = SESSION_REFRESH_RETRY_SECONDS * 1_000
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
    {
      const cancelled = Promise.withResolvers<never>()
      using _listener = addAbortListener(lifetime, () => { cancelled.reject(lifetime.reason) })
      await Promise.race([this.ensureFreshSession(), cancelled.promise])
    }
    lifetime.throwIfAborted()
    const token = this.sessionToken
    try {
      const result = await operation(lifetime)
      lifetime.throwIfAborted()
      return result
    } catch (error) {
      lifetime.throwIfAborted()
      if (this.sessionToken === token && error instanceof DeepSeekHarnessApiError && error.status === 401
        && error.code === 'EMPLOYEE_UNAUTHORIZED') {
        await this.refreshEmployeeSession()
      }
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
  if (!/^[\x21-\x7e]+$/.test(sessionToken)) {
    throw new Error('deepseek-harness product: invalid employee session token')
  }
  if (typeof record.url !== 'string' || record.url === '') {
    throw new Error('deepseek-harness product: authenticated connector URL is missing')
  }
  const endpoint = new URL(api.absoluteUrl(record.url))
  const expected = new URL(api.absoluteUrl(`/api/v1/connectors/${encodeURIComponent(String(record.id))}/mcp`))
  if (endpoint.href !== expected.href || endpoint.username || endpoint.password) {
    throw new Error('deepseek-harness product: authenticated connector must use the product server proxy')
  }
  const headers = new Headers(connectorHeaders(record.headers))
  const version = z.string().min(1).max(128).parse(record.version)
  headers.set('Authorization', `Bearer ${sessionToken}`)
  headers.set('X-Harness-Connector-Version', version)
  return { ...record, url: endpoint.href, headers: Object.fromEntries(headers) }
}

/**
 * Keep server supplied connector headers inside the authenticated main-process
 * boundary. A cast here would allow non-string values or CR/LF injection to
 * reach the MCP transport and turn a malformed catalog into a late request
 * failure.
 */
function connectorHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('deepseek-harness product: invalid connector headers')
  }
  const headers: Record<string, string> = {}
  for (const [name, headerValue] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
      || typeof headerValue !== 'string' || /[\r\n]/.test(headerValue)) {
      throw new Error('deepseek-harness product: invalid connector header')
    }
    headers[name] = headerValue
  }
  return headers
}

function rendererConnector(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid connector catalog entry')
  const record = value as Record<string, unknown>
  const metadata = ['id', 'name', 'displayName', 'summary', 'description', 'category', 'icon', 'author', 'version',
    'status', 'ready', 'authMode', 'authorizationStatus', 'transport', 'minimumDesktopVersion',
    'visibility', 'ownerEmployeeId', 'canEdit', 'canSubmit', 'canDelete', 'reviewStatus', 'configurationStatus', 'canConfigure', 'managed']
  const tools = ConnectorCatalogToolsSchema.parse(record.tools)
  return { ...Object.fromEntries(metadata.filter(key => key in record).map(key => [key, record[key]])), tools }
}

function requiredId(input: Readonly<Record<string, unknown>>): string {
  const id = input.id
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(id)) {
    throw new Error('deepseek-harness product: a valid product id is required')
  }
  return id
}

function employeeSessionReceipt(value: unknown): { session: ProductSession; token: string; refreshToken: string } {
  const receipt = z.object({
    sessionToken: z.string().min(1).max(128), refreshToken: z.string().min(1).max(128),
    expiresAt: z.number().int().positive(), refreshExpiresAt: z.number().int().positive(),
    employee: z.object({ employeeId: z.string().min(1), employeeName: z.string(), teamId: z.string() }),
  }).parse(value)
  if (receipt.expiresAt <= Date.now() / 1000 || receipt.refreshExpiresAt < receipt.expiresAt) {
    throw new Error('Product employee session receipt has expired')
  }
  return { token: receipt.sessionToken, refreshToken: receipt.refreshToken, session: { authenticated: true,
    employeeId: receipt.employee.employeeId, displayName: receipt.employee.employeeName,
    expiresAt: String(receipt.expiresAt), loginExpiresAt: String(receipt.refreshExpiresAt) } }
}
