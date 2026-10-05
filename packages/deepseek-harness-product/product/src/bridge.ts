/** Main-process product bridge. It owns credentials and exposes only product methods. */

import { DeepSeekHarnessApiClient, DeepSeekHarnessApiError } from './http-client.ts'
import { assertProductMethod, assertProductPayload, type ProductEvent, type ProductMethod, type ProductSession } from './protocol.ts'

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
    || !Array.isArray(rawModels) || (rawModels as unknown[]).some(model => typeof model !== 'string')
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
  readonly serverUrl?: string | undefined
  readonly sessionToken?: string | undefined
  readonly initialSession?: ProductSession | undefined
  /** Testable main-process HTTP transport. Renderer code never supplies this function. */
  readonly fetch?: typeof fetch
  readonly persistSession?: (session: ProductSession, sessionToken: string | undefined) => void | Promise<void>
  /** Main-process native capability dispatcher. Renderer code never receives this function. */
  readonly nativeInvoke?: (method: string, payload: unknown) => Promise<unknown>
  /** Prepare the immutable Host Preset snapshot for one Expert Kit. */
  readonly prepareExpertKit?: (id: string) => Promise<string>
}

const SESSION_REFRESH_LEAD_SECONDS = 5 * 60
const SESSION_REFRESH_RETRY_SECONDS = 30

/** Main-process product API boundary exposed to the Renderer through preload. */
export class DeepSeekHarnessProductBridge {
  private sessionToken: string | undefined
  private session: ProductSession
  private readonly listeners = new Set<(event: ProductEvent) => void>()
  private readonly api?: DeepSeekHarnessApiClient
  private readonly nativeInvoke?: ProductBridgeOptions['nativeInvoke']
  private readonly prepareExpertKit?: ProductBridgeOptions['prepareExpertKit']
  private sessionRefresh: Promise<void> | undefined
  private sessionRefreshTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: ProductBridgeOptions = {}) {
    this.sessionToken = options.sessionToken
    this.session = options.initialSession ?? (options.sessionToken === undefined ? { authenticated: false } : { authenticated: true })
    this.persistSession = options.persistSession
    this.nativeInvoke = options.nativeInvoke
    this.prepareExpertKit = options.prepareExpertKit
    if (options.serverUrl !== undefined && options.serverUrl !== '') {
      this.api = new DeepSeekHarnessApiClient({ baseUrl: options.serverUrl, getSessionToken: () => this.sessionToken,
        getEmployeeId: () => this.session.employeeId,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }) })
    }
    this.scheduleSessionRefresh()
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
    await this.ensureFreshSession()
    try {
      return runtimeBootstrap(await this.api.bootstrap<unknown>())
    } catch (error) {
      this.handleAuthenticationFailure(error)
      throw error
    }
  }

  /** Replace the current session and persist the opaque token outside the Renderer.
   * @param session - UI-safe employee session.
   * @param token - Opaque token retained by the main process.
   */
  setSession(session: ProductSession, token?: string): void {
    this.session = { ...session }
    this.sessionToken = token
    const persisted = this.persistSession?.(this.session, this.sessionToken)
    if (persisted instanceof Promise) {
      void persisted.catch((error: unknown) => {
        console.error('deepseek-harness product: failed to persist session', error)
      })
    }
    this.scheduleSessionRefresh()
    this.emit({ type: 'session.changed', payload: this.session })
  }

  /** Subscribe to product session and catalog events.
   * @param listener - Callback invoked for each product event.
   * @returns An unsubscribe function.
   */
  subscribe(listener: (event: ProductEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Validate and dispatch one allowlisted product operation.
   * @param method - Candidate operation name.
   * @param payload - Candidate operation payload.
   * @param signal - Optional cancellation for Host-owned remote work.
   * @returns The operation result.
   */
  async invoke(method: unknown, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    assertProductMethod(method)
    const input = assertProductPayload(payload)
    if (method === 'auth.getSession') return this.session
    if (method.startsWith('native.')) {
      if (this.nativeInvoke === undefined) throw new Error('deepseek-harness product: native sidecar is unavailable')
      return this.nativeInvoke(method.slice('native.'.length), input)
    }
    if (this.api === undefined) throw new Error('deepseek-harness product: server URL is not configured')
    if (method === 'auth.beginDingTalk') return this.api.beginDingTalk<unknown>()
    if (method === 'auth.pollDingTalk') {
      const state = input.state
      if (typeof state !== 'string' || state.length < 8) throw new Error('deepseek-harness product: authorization state is required')
      const result = await this.api.pollDingTalk<Record<string, unknown>>(state)
      const session = result.session
      if (typeof session !== 'object' || session === null || Array.isArray(session)) return result
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
      return result
    }
    if (method === 'auth.refresh') {
      await this.refreshEmployeeSession()
      return this.session
    }
    await this.ensureFreshSession()
    try {
      return await this.invokeAuthenticated(method, input, signal)
    } catch (error) {
      this.handleAuthenticationFailure(error)
      throw error
    }
  }

  private async invokeAuthenticated(
    method: ProductMethod,
    input: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.api === undefined) throw new Error('deepseek-harness product: server URL is not configured')
    if (method === 'expertKits.preset.prepare') {
      if (!this.session.authenticated) throw new Error('deepseek-harness product: authenticated employee is required')
      if (this.prepareExpertKit === undefined) throw new Error('deepseek-harness product: expert kit runtime is unavailable')
      return { presetId: await this.prepareExpertKit(requiredId(input)) }
    }
    if (method === 'expertKits.get') {
      return this.api.request(`/api/v1/expert-kits/${encodeURIComponent(requiredId(input))}`)
    }
    if (method === 'expertKits.readme') {
      return this.api.request(`/api/v1/expert-kits/${encodeURIComponent(requiredId(input))}/readme`)
    }
    if (method === 'expertKits.artifact') {
      return this.api.request(`/api/v1/expert-kits/${encodeURIComponent(requiredId(input))}/artifacts`)
    }
    if (method === 'skills.get') {
      return this.api.request(`/api/v1/skills/${encodeURIComponent(requiredId(input))}`)
    }
    if (method === 'skills.readme') {
      return this.api.request(`/api/v1/skills/${encodeURIComponent(requiredId(input))}/readme`)
    }
    if (method === 'skills.artifact') {
      return this.api.request(`/api/v1/skills/${encodeURIComponent(requiredId(input))}/artifacts`)
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
      return this.api.request('/api/v1/knowledge-searches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(signal === undefined ? {} : { signal }),
        body: JSON.stringify({
          query: query.trim(), knowledgeBaseRefs, knowledgeBaseIds,
          restrictToKnowledgeBaseRefs: knowledgeBaseRefs.length > 0, limit,
        }),
      })
    }
    const routes: Partial<Record<ProductMethod, string>> = {
      'expertKits.list': '/api/v1/expert-kits',
      'skills.list': '/api/v1/skills',
      'connectors.list': '/api/v1/connectors',
      'knowledge.bases.list': '/api/v1/knowledge-bases',
    }
    const route = routes[method]
    if (route === undefined) throw new Error(`deepseek-harness product: method ${method} is not available`)
    const size = typeof input.size === 'number' ? input.size : 100
    // Product directories are consumed as complete catalogs. The HTTP client
    // validates every page and fails closed if the server omits metadata.
    return this.api.listAll(route, size, signal)
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

  private refreshEmployeeSession(): Promise<void> {
    if (this.sessionRefresh !== undefined) return this.sessionRefresh
    if (this.api === undefined || !this.session.authenticated || this.sessionToken === undefined) {
      this.clearSession()
      return Promise.reject(new DeepSeekHarnessApiError(401, 'EMPLOYEE_UNAUTHORIZED', 'Employee authentication is required'))
    }
    const refresh = this.api.refreshSession<unknown>().then((result) => {
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
      this.handleAuthenticationFailure(error)
      if (this.session.authenticated) this.scheduleSessionRefreshRetry()
      throw error
    }).finally(() => {
      if (this.sessionRefresh === refresh) this.sessionRefresh = undefined
    })
    this.sessionRefresh = refresh
    return refresh
  }

  private scheduleSessionRefresh(): void {
    if (this.sessionRefreshTimer !== undefined) clearTimeout(this.sessionRefreshTimer)
    this.sessionRefreshTimer = undefined
    if (!this.session.authenticated || this.sessionToken === undefined) return
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

  private emit(event: ProductEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch (error) { console.error('deepseek-harness product event listener failed', error) }
    }
  }

  private readonly persistSession: ProductBridgeOptions['persistSession']
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
