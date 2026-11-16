/** Public product bridge contract. Harness execution never crosses this boundary. */

/** Protocol identifier for the product desktop bridge. */
export const PRODUCT_PROTOCOL = 'deepseek-harness.native.v1' as const

/** Maximum employee browser-authorization duration, shared by main and its callers. */
export const DINGTALK_AUTHORIZATION_TIMEOUT_MS = 5 * 60_000

/** Immutable company documents, owned by main and shared with native Host plugins. */
export interface CompanyContentRoots {
  readonly version: string
  readonly sha256: string
  readonly skillsRoot: string
  readonly expertsRoot: string
}

/** Optional company source supplied by the product Host to preinstalled plugins. */
export interface CompanyContentSource {
  /** Latest installed catalog without remote access; an optional signal cancels this reader. */
  read(signal?: AbortSignal): Promise<CompanyContentRoots>
  /** Coalesced server check; an optional signal releases this caller without stopping shared work. */
  refresh(signal?: AbortSignal): Promise<void>
  /** Durable Session version; cancellation releases this reader and aborts verification when none remain. */
  forSession(sessionId: string, signal?: AbortSignal): Promise<CompanyContentRoots>
  /** Exact expert package for a personal team's pinned member; never changes the active catalog or Session binding.
   * @param slug - Company expert identifier.
   * @param sha256 - Full immutable package digest saved with the team.
   * @param signal - Optional reader cancellation; omission uses the source lifetime.
   * @returns Verified package root; missing versions or damaged caches fail without using the latest expert.
   */
  expertVersion(slug: string, sha256: string, signal?: AbortSignal): Promise<string>
}

/** Opaque identity for a main-owned, employee-bound temporary file. */
export type LibraryTransferId = string & { readonly __libraryTransferId: unique symbol }

/** Public descriptor excludes local paths and remote credentials. */
export interface LibraryFileTransfer {
  readonly transferId: LibraryTransferId
  readonly fileName: string
  readonly mediaType: string
  readonly byteLength: number
  readonly maxBytes: number
  readonly chunkSize: number
  readonly missingFonts?: readonly string[]
}

/** Renderer chunks use structured clone rather than JSON or whole-file Base64. */
export interface LibraryFileChunk {
  readonly data: Uint8Array
  readonly offset: number
  readonly eof: boolean
}

/** Resource identifiers accepted by all library IPC and HTTP boundaries.
 * @param value - Candidate resource identifier.
 * @returns Whether the value matches the public resource identifier format.
 */
export function isLibraryResourceId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)
}

/** File operations owned by Electron main, including private Host conversion transport. */
export type LibraryFileMethod =
  | 'library.files.preview.open'
  | 'library.files.preview.read'
  | 'library.files.preview.close'
  | 'library.files.download'
  | 'library.files.openExternal'
  | 'runtime.library.preview.readChunk'
  | 'runtime.library.preview.policy'
  | 'runtime.library.preview.write.open'
  | 'runtime.library.preview.write.append'
  | 'runtime.library.preview.write.commit'
  | 'runtime.library.preview.write.close'
  | 'library.files.archive.select'
  | 'library.files.upload.select'
  | 'library.files.upload'
  | 'library.files.upload.discard'

/** Allowlisted product desktop operations. */
export type ProductMethod = typeof PRODUCT_METHODS[number]
const PRODUCT_METHODS = ['support.device.report', 'support.feedback.submit', 'extensions.save', 'extensions.submit', 'content.submissions.inspect', 'content.submissions.submit', 'extensions.connector.read', 'extensions.connector.update', 'extensions.connector.delete', 'extensions.connector.configuration.read', 'extensions.connector.configuration.save', 'auth.getSession', 'auth.signOut', 'auth.ensureDingTalk', 'auth.beginDingTalk', 'auth.pollDingTalk', 'auth.refresh', 'catalog.refresh', 'connectors.refresh', 'connectors.list', 'connectors.authorization.status', 'connectors.authorization.begin', 'connectors.authorization.revoke', 'library.files.list', 'library.entries.access', 'library.personal.ensure', 'library.list', 'library.create', 'library.members.list', 'library.members.save', 'library.members.remove', 'library.owner.transfer', 'library.memberOptions.employees', 'library.memberOptions.departments', 'library.get', 'library.update', 'library.delete', 'library.entries.list', 'library.entries.get', 'library.entries.update', 'library.entries.delete', 'library.folders.create', 'library.files.policy', 'library.files.archive.select', 'library.files.upload.select', 'library.files.upload', 'library.files.upload.discard', 'library.files.preview.open', 'library.files.preview.read', 'library.files.preview.close', 'library.files.download', 'library.files.openExternal'] as const

/** Operations available only to the trusted Host. */
export type ProductRuntimeMethod = typeof PRODUCT_RUNTIME_METHODS[number]
const PRODUCT_RUNTIME_METHODS = ['auth.getSession', 'connectors.list', 'library.entries.get', 'library.files.preview.open', 'library.files.preview.close', 'runtime.library.preview.readChunk', 'runtime.library.preview.policy', 'runtime.library.preview.write.open', 'runtime.library.preview.write.append', 'runtime.library.preview.write.commit', 'runtime.library.preview.write.close', 'runtime.companyContent.read', 'runtime.companyContent.refresh', 'runtime.companyContent.pin', 'runtime.companyContent.expertVersion'] as const

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
  readonly loginExpiresAt?: string
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
  return typeof value === 'string' && PRODUCT_METHODS.some(method => method === value)
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
