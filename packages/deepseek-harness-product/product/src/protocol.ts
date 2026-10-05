/** Public product bridge contract. Harness execution never crosses this boundary. */

/** Protocol identifier for the product sidecar bridge. */
export const PRODUCT_PROTOCOL = 'deepseek-harness.native.v1' as const

/** Allowlisted product and native sidecar operations. */
export type ProductMethod =
  | 'auth.getSession'
  | 'auth.ensureDingTalk'
  | 'auth.beginDingTalk'
  | 'auth.pollDingTalk'
  | 'auth.refresh'
  | 'expertKits.list'
  | 'expertKits.get'
  | 'expertKits.readme'
  | 'expertKits.artifact'
  | 'expertKits.preset.prepare'
  | 'skills.list'
  | 'skills.get'
  | 'skills.readme'
  | 'skills.artifact'
  | 'connectors.list'
  | 'knowledge.bases.list'
  | 'knowledge.search'
  | 'native.filesystem.list'
  | 'native.filesystem.read'
  | 'native.filesystem.write'
  | 'native.secure-storage.get'
  | 'native.secure-storage.set'
  | 'native.secure-storage.delete'
  | 'native.sqlite.query'
  | 'native.sqlite.execute'
  | 'native.dingtalk-auth.state'
  | 'native.attachments.put'
  | 'native.attachments.get'
  | 'native.attachments.list'
  | 'native.file-undo.record'
  | 'native.file-undo.undo'
  | 'native.device-identity.get'
  | 'native.image-preview.inspect'

/** Product operations the trusted Harness Host may request from Electron main. */
export type ProductRuntimeMethod = Extract<ProductMethod,
  | 'expertKits.list'
  | 'expertKits.get'
  | 'expertKits.readme'
  | 'expertKits.artifact'
  | 'skills.list'
  | 'skills.get'
  | 'skills.readme'
  | 'skills.artifact'
  | 'connectors.list'
  | 'knowledge.bases.list'
  | 'knowledge.search'
>

const PRODUCT_RUNTIME_METHODS: readonly ProductRuntimeMethod[] = [
  'expertKits.list', 'expertKits.get', 'expertKits.readme', 'expertKits.artifact',
  'skills.list', 'skills.get', 'skills.readme', 'skills.artifact',
  'connectors.list', 'knowledge.bases.list', 'knowledge.search',
]

/** Return whether a method is available to the Harness Host product adapter.
 * @param value - Candidate operation name received over private IPC.
 * @returns Whether the Host may request the operation.
 */
export function isProductRuntimeMethod(value: unknown): value is ProductRuntimeMethod {
  return typeof value === 'string' && PRODUCT_RUNTIME_METHODS.includes(value as ProductRuntimeMethod)
}

/** Opaque employee session token kept outside the Renderer. */
export interface SessionToken {
  readonly value: string
  readonly expiresAt?: string
}

/** UI-safe employee session snapshot. */
export interface ProductSession {
  readonly authenticated: boolean
  readonly employeeId?: string
  readonly displayName?: string
  readonly expiresAt?: string
}

/** Versioned request sent across the product bridge. */
export interface ProductInvokeRequest {
  readonly protocol: typeof PRODUCT_PROTOCOL
  readonly method: ProductMethod
  readonly payload?: unknown
  readonly requestId: string
}

/** Versioned response sent across the product bridge. */
export interface ProductInvokeResponse {
  readonly protocol: typeof PRODUCT_PROTOCOL
  readonly requestId: string
  readonly result: unknown
}

/** Product event delivered to subscribed Renderer listeners. */
export interface ProductEvent {
  readonly type: 'session.changed' | 'catalog.changed' | 'auth.required'
  readonly payload?: unknown
}

/** Return whether an unknown value is an allowlisted product method.
 * @param value - Candidate method value.
 * @returns Whether the value is a product method.
 */
export function isProductMethod(value: unknown): value is ProductMethod {
  return typeof value === 'string' && [
    'auth.getSession', 'auth.ensureDingTalk', 'auth.beginDingTalk', 'auth.pollDingTalk', 'auth.refresh', 'expertKits.list',
    'expertKits.get', 'expertKits.readme', 'expertKits.artifact', 'expertKits.preset.prepare',
    'skills.list', 'skills.get', 'skills.readme',
    'skills.artifact', 'connectors.list',
    'knowledge.bases.list', 'knowledge.search',
    'native.filesystem.list', 'native.filesystem.read',
    'native.filesystem.write', 'native.secure-storage.get', 'native.secure-storage.set', 'native.secure-storage.delete',
    'native.sqlite.query', 'native.sqlite.execute', 'native.dingtalk-auth.state',
    'native.attachments.put', 'native.attachments.get', 'native.attachments.list',
    'native.file-undo.record', 'native.file-undo.undo', 'native.device-identity.get',
    'native.image-preview.inspect',
  ].includes(value)
}

/** Assert that a bridge method is allowlisted.
 * @param value - Candidate method value.
 * @returns Nothing when the value is valid.
 */
export function assertProductMethod(value: unknown): asserts value is ProductMethod {
  if (!isProductMethod(value)) throw new Error('deepseek-harness product: unsupported method')
}

/** Validate and normalize an optional bridge payload object.
 * @param value - Candidate payload value.
 * @returns A normalized payload object.
 */
export function assertProductPayload(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('deepseek-harness product: payload must be an object')
  }
  return value as Record<string, unknown>
}
