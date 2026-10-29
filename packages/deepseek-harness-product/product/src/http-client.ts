/** Minimal COLA API client. Business rules stay on deepseek-harness-server. */
import { ProductError, isProductFailure, type ProductFailure } from './errors.ts'

/** Minimal COLA envelope returned by DeepSeekHarness server APIs. */
export interface ColaResponse<T> {
  readonly success: boolean
  readonly data?: T
  readonly errCode?: string | null
  readonly errMessage?: string | null
}

/** The server's top-level COLA PageResponse contract. */
export interface PageResponse<T> {
  readonly success: boolean
  readonly data: readonly T[]
  readonly errCode?: string | null
  readonly errMessage?: string | null
  readonly pageIndex: number
  readonly pageSize: number
  readonly totalCount: number
  readonly totalPages: number
}

/** Transport dependencies for the product API client. */
export interface ProductHttpClientOptions {
  readonly requestTimeoutMs?: number
  readonly baseUrl: string
  readonly getSessionToken: () => string | undefined
  readonly getEmployeeId?: () => string | undefined
  readonly fetch?: typeof globalThis.fetch
}

/** Complete bounded original file; authorization headers remain in the client. */
export interface ProductFileBytes {
  readonly mediaType: string
  readonly data: Uint8Array
}

/** Metadata for an authenticated original streamed into an owned sink. */
export interface ProductFileStream {
  readonly mediaType: string
  readonly byteLength: number
}

/** Typed failure returned when a product API request is not successful. */
export class DeepSeekHarnessApiError extends ProductError {
  constructor(readonly status: number, code: string, message: string, resources: ProductError['resources'] = [],
    diagnostic?: Pick<ProductFailure, 'retryable' | 'dependencyChecks'>) {
    super(code, message, diagnostic?.retryable ?? (status >= 500 || status === 429 || code === 'ORGANIZATION_SYNC_EXPIRED'),
      resources, diagnostic)
    this.name = 'DeepSeekHarnessApiError'
  }
}

/** Small COLA-aware HTTP client for product APIs. */
export class DeepSeekHarnessApiClient {
  private readonly lifecycle = new AbortController()
  private readonly requestFetch: typeof globalThis.fetch
  private readonly baseUrl: string

  constructor(private readonly options: ProductHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.requestFetch = options.fetch ?? globalThis.fetch
  }

  /** Resolve one server-relative product URL without exposing credentials.
   * @param path - Absolute URL or server-relative path.
   * @returns Validated absolute HTTP URL.
   */
  absoluteUrl(path: string): string {
    const value = new URL(/^https?:\/\//u.test(path)
      ? path
      : `${this.baseUrl}/${path.replace(/^\/+/, '')}`)
    if (!['http:', 'https:'].includes(value.protocol) || value.username !== '' || value.password !== '') {
      throw new Error('deepseek-harness product: invalid server URL')
    }
    return value.href
  }

  private async send<T extends ColaResponse<unknown>>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    const token = this.options.getSessionToken()
    if (token !== undefined) {
      headers.set('authorization', `Bearer ${token}`)
      const employeeId = this.options.getEmployeeId?.()
      if (employeeId !== undefined && employeeId !== '') headers.set('x-deepseek-harness-employee-id', employeeId)
      if ((init.method ?? 'GET').toUpperCase() !== 'GET' && (init.method ?? 'GET').toUpperCase() !== 'HEAD') {
        headers.set('x-requested-with', 'XMLHttpRequest')
      }
    }
    const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(this.options.requestTimeoutMs ?? 60_000),
      ...init.signal === undefined || init.signal === null ? [] : [init.signal]])
    signal.throwIfAborted()
    let response: Response
    try {
      response = await this.requestFetch(`${this.baseUrl}${path}`, { ...init, headers, signal, redirect: 'error' })
    } catch (cause) {
      this.lifecycle.signal.throwIfAborted()
      init.signal?.throwIfAborted()
      if (!(cause instanceof TypeError) && !signal.aborted) throw cause
      throw new ProductError('PRODUCT_NETWORK_UNAVAILABLE',
        'Unable to reach the product service. The request outcome is unknown.', true, [], { cause })
    }
    // DELETE endpoints may intentionally return 204 with no COLA envelope.
    // Treat that status as a successful empty response while preserving the
    // normal envelope validation for every response carrying a body.
    let body: unknown
    try {
      body = response.status === 204 ? { success: true } : await response.json()
    } catch (cause) {
      this.lifecycle.signal.throwIfAborted()
      init.signal?.throwIfAborted()
      if (cause instanceof SyntaxError) throw invalidResponse()
      if (!(cause instanceof TypeError) && !signal.aborted) throw cause
      throw new ProductError('PRODUCT_NETWORK_UNAVAILABLE',
        'Unable to read the product service response. The request outcome is unknown.', true, [], { cause })
    }
    signal.throwIfAborted()
    if (!isEnvelope(body)) throw invalidResponse()
    if (!response.ok || !body.success) throw serverError(response.status, body)
    return body as T
  }

  /** Cancel remote work owned by the product bridge and reject later requests. */
  close(): void { this.lifecycle.abort(new Error('Product client is closed')) }

  /** Send one authenticated JSON request and unwrap its COLA data value.
   * @param path - Relative API path.
   * @param init - Fetch request options.
   * @returns Unwrapped response data.
   */
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const body = await this.send<ColaResponse<T>>(path, init)
    if (body.data === undefined) throw new DeepSeekHarnessApiError(502, 'INVALID_SERVER_RESPONSE', 'server response data is missing')
    return body.data
  }

  /** Send an authenticated request whose successful response has no body.
   * @param path - Relative API path.
   * @param init - Fetch request options.
   */
  async requestNoContent(path: string, init: RequestInit = {}): Promise<void> {
    await this.send<ColaResponse<unknown>>(path, init)
  }

  /** Read an authenticated original file without following upstream redirects.
   * @param path - Server-relative API path.
   * @param maxBytes - Maximum complete file bytes.
   * @param signal - Caller cancellation.
   * @returns Media type and owned bytes, without URLs or credentials.
   */
  async requestBytes(path: string, maxBytes: number, signal?: AbortSignal): Promise<ProductFileBytes> {
    const chunks: Uint8Array[] = []
    const result = await this.streamBytes(path, maxBytes, (chunk) => { chunks.push(chunk.slice()); return Promise.resolve() }, signal)
    const data = new Uint8Array(result.byteLength)
    let offset = 0
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
    return { mediaType: result.mediaType, data }
  }

  /** Stream an authenticated file to an owned sink with bounded memory.
   * @param path - Server-relative API path.
   * @param maxBytes - Maximum total file bytes.
   * @param write - Sink called sequentially for each received chunk.
   * @param signal - Caller cancellation.
   * @param timeoutMs - Optional main-owned file timeout override.
   * @returns Media type and complete byte count; credentials remain in this client.
   */
  async streamBytes(path: string, maxBytes: number, write: (chunk: Uint8Array) => Promise<void>,
    signal?: AbortSignal, timeoutMs?: number): Promise<ProductFileStream> {
    if (!path.startsWith('/api/') || path.startsWith('//') || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new ProductError('KNOWLEDGE_REQUEST_INVALID', 'Invalid original file request', false)
    }
    const headers = new Headers({ accept: '*/*' })
    const token = this.options.getSessionToken()
    if (token !== undefined) {
      headers.set('authorization', `Bearer ${token}`)
      const employeeId = this.options.getEmployeeId?.()
      if (employeeId) headers.set('x-deepseek-harness-employee-id', employeeId)
    }
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1)) {
      throw new ProductError('KNOWLEDGE_REQUEST_INVALID', 'Invalid original file timeout', false)
    }
    const lifetime = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(timeoutMs ?? this.options.requestTimeoutMs ?? 60_000),
      ...signal ? [signal] : []])
    lifetime.throwIfAborted()
    let response: Response
    try {
      response = await this.requestFetch(`${this.baseUrl}${path}`, { headers, signal: lifetime, redirect: 'error' })
    } catch (cause) {
      this.lifecycle.signal.throwIfAborted()
      signal?.throwIfAborted()
      if (!(cause instanceof TypeError) && !lifetime.aborted) throw cause
      throw new ProductError('PRODUCT_NETWORK_UNAVAILABLE',
        'Unable to reach the product service. The request outcome is unknown.', true, [], { cause })
    }
    if (!response.ok) {
      const data = await readBoundedBody(response, 64 * 1024, lifetime)
      let body: unknown
      try { body = JSON.parse(new TextDecoder().decode(data)) }
      catch { throw invalidResponse() }
      if (!isEnvelope(body)) throw invalidResponse()
      throw serverError(response.status, body)
    }
    const reader = response.body?.getReader()
    if (reader === undefined) throw new DeepSeekHarnessApiError(502, 'INVALID_SERVER_RESPONSE', 'Original file body is missing')
    const abort = (): void => { void reader.cancel(lifetime.reason).catch(() => undefined) }
    lifetime.addEventListener('abort', abort, { once: true })
    let byteLength = 0
    try {
      lifetime.throwIfAborted()
      const declared = response.headers.get('content-length')
      if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
        throw new ProductError('KNOWLEDGE_PREVIEW_TOO_LARGE', 'Original file exceeds the file size limit', false)
      }
      for (;;) {
        const { done, value } = await reader.read()
        lifetime.throwIfAborted()
        if (done) break
        byteLength += value.byteLength
        if (byteLength > maxBytes) throw new ProductError('KNOWLEDGE_PREVIEW_TOO_LARGE', 'Original file exceeds the file size limit', false)
        await write(value)
      }
      lifetime.throwIfAborted()
      return { mediaType: response.headers.get('content-type') ?? 'application/octet-stream', byteLength }
    } finally {
      lifetime.removeEventListener('abort', abort)
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  private async requestPage<T>(path: string, signal?: AbortSignal): Promise<PageResponse<T>> {
    const body = await this.send<PageResponse<T>>(path, signal === undefined ? {} : { signal })
    if (!Array.isArray(body.data)
      || !Number.isSafeInteger(body.pageIndex) || body.pageIndex < 1
      || !Number.isSafeInteger(body.pageSize) || body.pageSize < 1 || body.pageSize > 100
      || !Number.isSafeInteger(body.totalCount) || body.totalCount < 0
      || !Number.isSafeInteger(body.totalPages) || body.totalPages < 0
      || body.totalPages !== Math.ceil(body.totalCount / body.pageSize)
      || body.data.length > body.pageSize) {
      throw new DeepSeekHarnessApiError(502, 'INVALID_PAGE_RESPONSE', 'server page metadata is invalid')
    }
    return body
  }

  /** Read the employee bootstrap document.
   * @param signal - Employee request lifetime.
   * @returns Unwrapped bootstrap data.
   */
  bootstrap<T>(signal?: AbortSignal): Promise<T> { return this.request<T>('/api/v1/bootstrap', signal === undefined ? {} : { signal }) }
  /** Start a DingTalk browser authorization request.
   * @param signal - Optional caller cancellation.
   * @returns Authorization request data.
   */
  beginDingTalk<T>(signal?: AbortSignal): Promise<T> {
    return this.request<T>('/api/v1/dingtalk-auth/authorization-requests', { method: 'POST', ...(signal === undefined ? {} : { signal }) })
  }
  /** Poll one DingTalk authorization request.
   * @param state - Authorization state.
   * @param signal - Optional caller cancellation.
   * @returns Authorization result data.
   */
  pollDingTalk<T>(state: string, signal?: AbortSignal): Promise<T> { return this.request<T>(`/api/v1/dingtalk-auth/authorization-requests/${encodeURIComponent(state)}`, signal === undefined ? {} : { signal }) }
  /** Refresh the current employee session.
   * @param signal - Employee request lifetime.
   * @returns Refreshed session data.
   */
  refreshSession<T>(signal?: AbortSignal): Promise<T> { return this.request<T>('/api/v1/employee-auth/session/refresh', { method: 'POST', ...(signal === undefined ? {} : { signal }) }) }
  /** Read one validated page from a product directory.
   * @param path - Directory endpoint path.
   * @param page - One-based page number.
   * @param size - Number of records requested.
   * @param signal - Optional cancellation for the directory request.
   * @returns Unwrapped page response.
   */
  list<T>(path: string, page = 1, size = 100, signal?: AbortSignal): Promise<PageResponse<T>> {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(size) || size < 1 || size > 100) {
      return Promise.reject(new RangeError('deepseek-harness product: page must be >= 1 and size must be between 1 and 100'))
    }
    const separator = path.includes('?') ? '&' : '?'
    return this.requestPage<T>(`${path}${separator}page=${String(page)}&size=${String(size)}`, signal)
  }

  /**
   * Read a complete server directory using its paging metadata. A malformed
   * page fails closed instead of returning a misleading first-page snapshot.
   * @param path - Directory endpoint path.
   * @param size - Number of records requested per page.
   * @param signal - Optional cancellation shared by every page request.
   * @returns Every record across the server's declared pages.
   */
  async listAll<T>(path: string, size = 100, signal?: AbortSignal): Promise<readonly T[]> {
    if (!Number.isSafeInteger(size) || size < 1 || size > 100) {
      throw new RangeError('deepseek-harness product: size must be between 1 and 100')
    }
    const first = await this.list<T>(path, 1, size, signal)
    if (first.pageIndex !== 1 || first.pageSize !== size) {
      throw new DeepSeekHarnessApiError(502, 'INVALID_PAGE_RESPONSE', 'server page metadata is invalid')
    }
    const all: T[] = [...first.data]
    for (let page = 2; page <= first.totalPages; page += 1) {
      const next = await this.list<T>(path, page, size, signal)
      if (next.pageIndex !== page || next.pageSize !== first.pageSize
        || next.totalPages !== first.totalPages || next.totalCount !== first.totalCount) {
        throw new DeepSeekHarnessApiError(502, 'INVALID_PAGE_RESPONSE', 'server page metadata changed during read')
      }
      all.push(...next.data)
    }
    if (all.length !== first.totalCount) {
      throw new DeepSeekHarnessApiError(502, 'INVALID_PAGE_RESPONSE', 'server page record count is inconsistent')
    }
    return all
  }
}

function isEnvelope(value: unknown): value is ColaResponse<unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'success' in value && typeof value.success === 'boolean'
    && (!('errCode' in value) || value.errCode === null || typeof value.errCode === 'string')
    && (!('errMessage' in value) || value.errMessage === null || typeof value.errMessage === 'string')
}

function invalidResponse(): DeepSeekHarnessApiError {
  return new DeepSeekHarnessApiError(502, 'INVALID_SERVER_RESPONSE', 'Invalid product service response')
}

function serverError(status: number, body: ColaResponse<unknown>): DeepSeekHarnessApiError {
  const code = body.errCode ?? 'SERVER_ERROR'
  const message = body.errMessage ?? `HTTP ${String(status)}`
  const failure = { ...typeof body.data === 'object' && body.data !== null ? body.data : {}, code, message }
  return isProductFailure(failure)
    ? new DeepSeekHarnessApiError(status, code, message, failure.resources, failure)
    : new DeepSeekHarnessApiError(status, code, message)
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new DeepSeekHarnessApiError(502, 'INVALID_SERVER_RESPONSE', 'Original file body is missing')
  const abort = (): void => { void reader.cancel(signal.reason).catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    const declared = response.headers.get('content-length')
    if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
      throw new ProductError('KNOWLEDGE_PREVIEW_TOO_LARGE', 'Original file exceeds the preview size limit', false)
    }
    const chunks: Uint8Array[] = []
    let length = 0
    for (;;) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) throw new ProductError('KNOWLEDGE_PREVIEW_TOO_LARGE', 'Original file exceeds the preview size limit', false)
      chunks.push(value)
    }
    const data = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
    return data
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
