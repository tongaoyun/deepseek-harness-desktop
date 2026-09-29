/** Main-process product bridge. It owns credentials and exposes only product methods. */

import { XiaoyinApiClient } from './http-client.ts'
import { assertProductMethod, assertProductPayload, type ProductEvent, type ProductMethod, type ProductSession } from './protocol.ts'

/** Main-process-only inference bootstrap. Secrets in this object never cross the preload bridge. */
export interface ProductRuntimeBootstrap {
  readonly modelApiKey: string
  readonly endpoints: { readonly litellm: string }
  readonly models: readonly string[]
}

function runtimeBootstrap(value: unknown): ProductRuntimeBootstrap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('xiaoyin product: invalid runtime bootstrap')
  }
  const record = value as Record<string, unknown>
  const endpoints = record.endpoints
  const rawModels: unknown = record.models
  if (typeof record.modelApiKey !== 'string' || !/^[\x21-\x7e]+$/.test(record.modelApiKey)
    || !Array.isArray(rawModels) || (rawModels as unknown[]).some(model => typeof model !== 'string')
    || typeof endpoints !== 'object' || endpoints === null || Array.isArray(endpoints)
    || typeof (endpoints as Record<string, unknown>).litellm !== 'string') {
    throw new Error('xiaoyin product: invalid runtime bootstrap')
  }
  const endpoint = new URL((endpoints as Record<string, unknown>).litellm as string)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username !== '' || endpoint.password !== ''
    || endpoint.search !== '' || endpoint.hash !== '') {
    throw new Error('xiaoyin product: invalid inference endpoint')
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
}

/** Main-process product API boundary exposed to the Renderer through preload. */
export class XiaoyinProductBridge {
  private sessionToken: string | undefined
  private session: ProductSession
  private readonly listeners = new Set<(event: ProductEvent) => void>()
  private readonly api?: XiaoyinApiClient
  private readonly nativeInvoke?: ProductBridgeOptions['nativeInvoke']

  constructor(options: ProductBridgeOptions = {}) {
    this.sessionToken = options.sessionToken
    this.session = options.initialSession ?? (options.sessionToken === undefined ? { authenticated: false } : { authenticated: true })
    this.persistSession = options.persistSession
    this.nativeInvoke = options.nativeInvoke
    if (options.serverUrl !== undefined && options.serverUrl !== '') {
      this.api = new XiaoyinApiClient({ baseUrl: options.serverUrl, getSessionToken: () => this.sessionToken,
        getEmployeeId: () => this.session.employeeId,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }) })
    }
  }

  /** Return the current UI-safe employee session snapshot.
   * @returns Current product session.
   */
  getSession(): ProductSession { return this.session }

  /** Read inference configuration for the Electron main process only. */
  async loadRuntimeBootstrap(): Promise<ProductRuntimeBootstrap> {
    if (this.api === undefined) throw new Error('xiaoyin product: server URL is not configured')
    return runtimeBootstrap(await this.api.bootstrap<unknown>())
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
        console.error('xiaoyin product: failed to persist session', error)
      })
    }
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
   * @returns The operation result.
   */
  async invoke(method: unknown, payload?: unknown): Promise<unknown> {
    assertProductMethod(method)
    const input = assertProductPayload(payload)
    if (method === 'auth.getSession') return this.session
    if (method.startsWith('native.')) {
      if (this.nativeInvoke === undefined) throw new Error('xiaoyin product: native sidecar is unavailable')
      return this.nativeInvoke(method.slice('native.'.length), input)
    }
    if (this.api === undefined) throw new Error('xiaoyin product: server URL is not configured')
    if (method === 'auth.beginDingTalk') return this.api.beginDingTalk<unknown>()
    if (method === 'auth.pollDingTalk') {
      const state = input.state
      if (typeof state !== 'string' || state.length < 8) throw new Error('xiaoyin product: authorization state is required')
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
      let result: unknown
      try {
        result = await this.api.refreshSession<unknown>()
      } catch (error) {
        this.setSession({ authenticated: false })
        throw error
      }
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        this.setSession({ authenticated: false })
        throw new Error('xiaoyin product: invalid refreshed session')
      }
      const refreshed = result as Record<string, unknown>
      const token = refreshed.sessionToken
      if (typeof token === 'string' && token !== '') {
        const identity = refreshed.employee as Record<string, unknown> | undefined
        this.setSession({ authenticated: true,
          ...(typeof identity?.employeeId === 'string' ? { employeeId: identity.employeeId } : {}),
          ...(typeof identity?.employeeName === 'string' ? { displayName: identity.employeeName } : {}),
          ...((typeof refreshed.expiresAt === 'string' || typeof refreshed.expiresAt === 'number')
            ? { expiresAt: String(refreshed.expiresAt) } : {}),
        }, token)
      }
      return refreshed
    }
    const routes: Partial<Record<ProductMethod, string>> = {
      'expertKits.list': '/api/v1/expert-kits',
      'skills.list': '/api/v1/skills',
      'connectors.list': '/api/v1/connectors',
      'knowledge.bases.list': '/api/v1/knowledge-bases',
      'schedules.list': '/api/v1/schedules',
      'im.channels.list': '/api/v1/im/channels',
      'artifacts.list': '/api/v1/artifacts',
    }
    const route = routes[method]
    if (route === undefined) throw new Error(`xiaoyin product: method ${method} is not available`)
    const size = typeof input.size === 'number' ? input.size : 100
    // Product directories are consumed as complete catalogs. The HTTP client
    // validates every page and fails closed if the server omits metadata.
    return this.api.listAll(route, size)
  }

  private emit(event: ProductEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch (error) { console.error('xiaoyin product event listener failed', error) }
    }
  }

  private readonly persistSession: ProductBridgeOptions['persistSession']
}
