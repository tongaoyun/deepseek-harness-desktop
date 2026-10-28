/** Device reporting and employee-initiated feedback owned by Electron main. */
import { createHash } from 'node:crypto'
import type { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import type { ProductSession } from '@deepseek-harness/product/protocol'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'

/** Validated deployment intervals; full reports are refreshed independently of presence. */
export interface DesktopSupportPolicy {
  readonly heartbeatIntervalMs: number
  readonly reportIntervalMs: number
}
interface DeviceMetadata {
  readonly desktopVersion: string
  readonly platform: string
  readonly architecture: string
  readonly displayScalePercents: readonly number[]
  readonly encryptedStorage: boolean
}
interface SupportState {
  readonly status: 'PENDING' | 'READY' | 'DEGRADED'
  readonly lastSeenAt?: string
  readonly capabilitiesReportedAt?: string
  readonly failureCode?: string
}

/** Main-owned reports contain metadata only; feedback images are selected explicitly by the employee. */
export class DesktopSupport {
  private readonly lifecycle = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private employeeId: string | undefined
  private pendingReport: Promise<unknown> | undefined
  private reportSignature: string | undefined
  private lastFullReport = 0
  private state: SupportState = { status: 'PENDING' }

  constructor(private readonly options: {
    readonly policy: DesktopSupportPolicy
    readonly metadata: () => DeviceMetadata
    readonly native: (method: string, payload: unknown, signal: AbortSignal) => Promise<unknown>
  }) {}

  /** Dispatch support methods after authentication; supplied metadata and identity are ignored.
   * @param method - Allowlisted support operation.
   * @param input - Renderer feedback text and optional explicitly selected images.
   * @param api - Authenticated main-owned server client.
   * @param session - Current employee identity.
   * @param signal - Identity and caller lifetime.
   * @returns Credential-free feedback receipt or device-report state.
   */
  invoke(method: string, input: Readonly<Record<string, unknown>>, api: DeepSeekHarnessApiClient,
    session: ProductSession, signal: AbortSignal): Promise<unknown> {
    const lifetime = AbortSignal.any([this.lifecycle.signal, signal])
    const operation = this.dispatch(method, input, api, session, lifetime)
    this.operations.add(operation)
    void operation.finally(() => this.operations.delete(operation)).catch(() => undefined)
    return operation
  }

  private async dispatch(method: string, input: Readonly<Record<string, unknown>>, api: DeepSeekHarnessApiClient,
    session: ProductSession, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (session.employeeId !== this.employeeId) {
      await this.pendingReport?.catch(() => undefined)
      signal.throwIfAborted()
      this.employeeId = session.employeeId
      this.state = { status: 'PENDING' }; this.reportSignature = undefined; this.lastFullReport = 0
    }
    if (method === 'support.device.report') {
      this.pendingReport ??= this.report(api, signal).finally(() => { this.pendingReport = undefined })
      await this.pendingReport
      signal.throwIfAborted()
      return this.state
    }
    if (method !== 'support.feedback.submit') throw new ProductError('FEATURE_UNAVAILABLE', 'Unsupported support operation')
    const { message, category, operationId, images = [] } = input
    if (typeof message !== 'string' || !message.trim() || message.trim().length > 2000
      || typeof category !== 'string' || !['BUG', 'SUGGESTION', 'QUESTION', 'OTHER'].includes(category)
      || typeof operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)
      || !Array.isArray(images) || images.length > 4) throw new ProductError('FEEDBACK_INVALID', 'Feedback fields are invalid')
    const form = new FormData()
    for (const image of images as readonly unknown[]) {
      if (typeof image !== 'object' || image === null || !('data' in image) || !(image.data instanceof Uint8Array)
        || image.data.byteLength < 1 || image.data.byteLength > 5 * 1024 * 1024
        || !('name' in image) || typeof image.name !== 'string' || image.name.length < 1 || image.name.length > 255
        || /[\x00-\x1f\x7f/\\]/.test(image.name)
        || !('mediaType' in image) || typeof image.mediaType !== 'string'
        || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mediaType)) {
        throw new ProductError('FEEDBACK_IMAGES_INVALID', 'Select up to four PNG, JPEG or WebP images of at most 5 MB each')
      }
      form.append('images', new Blob([Uint8Array.from(image.data)], { type: image.mediaType }), image.name)
    }
    const metadata = this.options.metadata()
    const deviceId = await this.deviceId(signal)
    form.append('feedback', new Blob([JSON.stringify({ message: message.trim(), category,
      desktopVersion: metadata.desktopVersion, deviceId, taskId: '' })], { type: 'application/json' }))
    const result: unknown = await api.request('/api/v1/feedback', { method: 'POST', body: form,
      headers: { 'Idempotency-Key': operationId }, signal })
    if (typeof result !== 'object' || result === null || !('id' in result) || typeof result.id !== 'string' || !result.id.trim()) {
      throw new ProductError('INVALID_SERVER_RESPONSE', 'Feedback receipt is missing', true)
    }
    return { id: result.id }
  }

  private async deviceId(signal: AbortSignal): Promise<string> {
    const identity = await this.options.native('device-identity.get', {}, signal)
    if (typeof identity !== 'object' || identity === null || !('deviceId' in identity)
      || typeof identity.deviceId !== 'string' || !identity.deviceId || identity.deviceId.length > 256) {
      throw new ProductError('DEVICE_IDENTITY_INVALID', 'Native device identity is unavailable', true)
    }
    // A deterministic UUIDv8 projection avoids exposing the native installation identifier.
    const digest = createHash('sha256').update(identity.deviceId).digest('hex')
    const variant = ((parseInt(digest.charAt(16), 16) & 3) | 8).toString(16)
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  }

  private async report(api: DeepSeekHarnessApiClient, signal: AbortSignal): Promise<void> {
    try {
      const deviceId = await this.deviceId(signal)
      const metadata = this.options.metadata()
      const health = await this.options.native('health', {}, signal)
      if (typeof health !== 'object' || health === null || !('ready' in health) || health.ready !== true
        || !('capabilities' in health) || !Array.isArray(health.capabilities)
        || health.capabilities.length > 32 || health.capabilities.some((value: unknown) => typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(value))) {
        throw new ProductError('DEVICE_HEALTH_INVALID', 'Native capability report is unavailable', true)
      }
      const payload = { deviceId, desktopVersion: metadata.desktopVersion, platform: metadata.platform,
        architecture: metadata.architecture, displayCount: metadata.displayScalePercents.length,
        displayScalePercents: metadata.displayScalePercents }
      const capabilities = [
        ...(health.capabilities as readonly string[]).map(key => ({ key: `native.${key}`, status: 'READY', detail: `Native capability: ${key}` })),
        { key: 'credentials.encryption', status: metadata.encryptedStorage ? 'READY' : 'DEGRADED',
          detail: metadata.encryptedStorage ? 'OS credential encryption available' : 'OS credential encryption unavailable' },
      ]
      const signature = JSON.stringify({ payload, capabilities })
      const now = Date.now()
      const elapsed = performance.now()
      if (signature !== this.reportSignature || elapsed - this.lastFullReport >= this.options.policy.reportIntervalMs) {
        const result: unknown = await api.request('/api/v1/device-capabilities', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, capabilities }), signal })
        signal.throwIfAborted()
        if (typeof result !== 'object' || result === null || !('createdAt' in result)
          || typeof result.createdAt !== 'string' || !Number.isFinite(Date.parse(result.createdAt))) {
          throw new ProductError('INVALID_SERVER_RESPONSE', 'Device report receipt is missing', true)
        }
        this.reportSignature = signature; this.lastFullReport = elapsed
        this.state = { status: 'READY', lastSeenAt: result.createdAt, capabilitiesReportedAt: result.createdAt }
      } else {
        await api.requestNoContent('/api/v1/device-capabilities/presence', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal })
        signal.throwIfAborted()
        this.state = { ...this.state, status: 'READY', lastSeenAt: new Date(now).toISOString() }
      }
    } catch (error) {
      if (!signal.aborted) {
        this.state = { ...this.state, status: 'DEGRADED', failureCode: productFailure(error).code }
        console.warn('Desktop device report failed; support status is degraded; next heartbeat retries', { code: this.state.failureCode })
      }
      throw error
    }
  }

  /** Cancel and await reports and feedback before the native sidecar is stopped. */
  async close(): Promise<void> {
    this.lifecycle.abort(new Error('Desktop support closed'))
    await Promise.allSettled([...this.operations])
  }
}
