/** Minimal COLA API client. Business rules stay on xiaoyin-server. */

/** Minimal COLA envelope returned by Xiaoyin server APIs. */
export interface ColaResponse<T> {
  readonly success: boolean
  readonly data?: T
  readonly errCode?: string
  readonly errMessage?: string
}

/** The server's 1-based page contract. Product callers never silently drop later pages. */
/** Server-side 1-based page metadata and records. */
export interface PageResponse<T> {
  readonly records?: readonly T[]
  readonly items?: readonly T[]
  readonly page: number
  readonly size: number
  readonly total: number
  readonly totalPages: number
}

/** Transport dependencies for the product API client. */
export interface ProductHttpClientOptions {
  readonly baseUrl: string
  readonly getSessionToken: () => string | undefined
  readonly fetch?: typeof globalThis.fetch
}

/** Typed failure returned when a product API request is not successful. */
export class XiaoyinApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'XiaoyinApiError'
  }
}

/** Small COLA-aware HTTP client for product APIs. */
export class XiaoyinApiClient {
  private readonly requestFetch: typeof globalThis.fetch
  private readonly baseUrl: string

  constructor(private readonly options: ProductHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.requestFetch = options.fetch ?? globalThis.fetch
  }

  /** Send one authenticated JSON request and unwrap its COLA data value.
   * @param path - Relative API path.
   * @param init - Fetch request options.
   * @returns Unwrapped response data.
   */
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    const token = this.options.getSessionToken()
    if (token !== undefined) headers.set('authorization', `Bearer ${token}`)
    const response = await this.requestFetch(`${this.baseUrl}${path}`, { ...init, headers })
    const body = await response.json() as ColaResponse<T>
    if (!response.ok || !body.success || body.data === undefined) {
      throw new XiaoyinApiError(response.status, body.errCode ?? 'SERVER_ERROR', body.errMessage ?? `HTTP ${String(response.status)}`)
    }
    return body.data
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
   * @returns Unwrapped page response.
   */
  list<T>(path: string, page = 1, size = 100): Promise<T> {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(size) || size < 1 || size > 100) {
      return Promise.reject(new RangeError('xiaoyin product: page must be >= 1 and size must be between 1 and 100'))
    }
    const separator = path.includes('?') ? '&' : '?'
    return this.request<T>(`${path}${separator}page=${String(page)}&size=${String(size)}`)
  }

  /**
   * Read a complete server directory using its paging metadata. A malformed
   * page fails closed instead of returning a misleading first-page snapshot.
   * @param path - Directory endpoint path.
   * @param size - Number of records requested per page.
   * @returns Every record across the server's declared pages.
   */
  async listAll<T>(path: string, size = 100): Promise<readonly T[]> {
    if (!Number.isSafeInteger(size) || size < 1 || size > 100) {
      throw new RangeError('xiaoyin product: size must be between 1 and 100')
    }
    const first = await this.list<PageResponse<T>>(path, 1, size)
    const isRecords = (value: unknown): value is readonly T[] => Array.isArray(value)
    const records = (page: PageResponse<T>): readonly T[] => {
      if (isRecords(page.records)) return page.records
      if (isRecords(page.items)) return page.items
      throw new XiaoyinApiError(502, 'INVALID_PAGE_RESPONSE', 'server page records are missing')
    }
    if (!Number.isSafeInteger(first.page) || first.page !== 1
      || !Number.isSafeInteger(first.totalPages) || first.totalPages < 1
      || !Number.isSafeInteger(first.total) || first.total < 0) {
      throw new XiaoyinApiError(502, 'INVALID_PAGE_RESPONSE', 'server page metadata is invalid')
    }
    const all: T[] = [...records(first)]
    for (let page = 2; page <= first.totalPages; page += 1) {
      const next = await this.list<PageResponse<T>>(path, page, size)
      if (next.page !== page || next.totalPages !== first.totalPages || next.total !== first.total) {
        throw new XiaoyinApiError(502, 'INVALID_PAGE_RESPONSE', 'server page metadata changed during read')
      }
      all.push(...records(next))
    }
    if (all.length > first.total) throw new XiaoyinApiError(502, 'INVALID_PAGE_RESPONSE', 'server page contains too many records')
    return all
  }
}
