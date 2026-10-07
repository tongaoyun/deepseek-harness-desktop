/** Minimal COLA API client. Business rules stay on deepseek-harness-server. */

/** Minimal COLA envelope returned by DeepSeekHarness server APIs. */
export interface ColaResponse<T> {
  readonly success: boolean
  readonly data?: T
  readonly errCode?: string
  readonly errMessage?: string
}

/** The server's top-level COLA PageResponse contract. */
export interface PageResponse<T> {
  readonly success: boolean
  readonly data: readonly T[]
  readonly errCode?: string
  readonly errMessage?: string
  readonly pageIndex: number
  readonly pageSize: number
  readonly totalCount: number
  readonly totalPages: number
}

/** Transport dependencies for the product API client. */
export interface ProductHttpClientOptions {
  readonly baseUrl: string
  readonly getSessionToken: () => string | undefined
  readonly getEmployeeId?: () => string | undefined
  readonly fetch?: typeof globalThis.fetch
}

/** Typed failure returned when a product API request is not successful. */
export class DeepSeekHarnessApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'DeepSeekHarnessApiError'
  }
}

/** Small COLA-aware HTTP client for product APIs. */
export class DeepSeekHarnessApiClient {
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
    const response = await this.requestFetch(`${this.baseUrl}${path}`, { ...init, headers })
    const body = await response.json() as T
    if (!response.ok || !body.success) {
      throw new DeepSeekHarnessApiError(response.status, body.errCode ?? 'SERVER_ERROR', body.errMessage ?? `HTTP ${String(response.status)}`)
    }
    return body
  }

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
   * @returns Unwrapped bootstrap data.
   */
  bootstrap<T>(): Promise<T> { return this.request<T>('/api/v1/bootstrap') }
  /** Start a DingTalk browser authorization request.
   * @returns Authorization request data.
   */
  beginDingTalk<T>(): Promise<T> { return this.request<T>('/api/v1/dingtalk-auth/authorization-requests', { method: 'POST' }) }
  /** Poll one DingTalk authorization request.
   * @param state - Authorization state.
   * @returns Authorization result data.
   */
  pollDingTalk<T>(state: string): Promise<T> { return this.request<T>(`/api/v1/dingtalk-auth/authorization-requests/${encodeURIComponent(state)}`) }
  /** Refresh the current employee session.
   * @returns Refreshed session data.
   */
  refreshSession<T>(): Promise<T> { return this.request<T>('/api/v1/employee-auth/session/refresh', { method: 'POST' }) }
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
