/** Public product bridge contract. Harness execution never crosses this boundary. */
import { z } from 'zod'
import { isProductFailure, ProductError, type ProductFailure } from './errors.ts'


/** Protocol identifier for the product sidecar bridge. */
export const PRODUCT_PROTOCOL = 'deepseek-harness.native.v1' as const

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
}

/** PDF upload parsing: standard document processing or embedded text without OCR. */
export type KnowledgePdfParseMode = 'STANDARD' | 'TEXT'

/** Opaque identity for a main-owned, employee-bound temporary file. */
export type KnowledgeTransferId = string & { readonly __knowledgeTransferId: unique symbol }

/** Public descriptor excludes local paths and remote credentials. */
export interface KnowledgeFileTransfer {
  readonly transferId: KnowledgeTransferId
  readonly fileName: string
  readonly mediaType: string
  readonly byteLength: number
  readonly maxBytes: number
  readonly chunkSize: number
  readonly missingFonts?: readonly string[]
}

/** Renderer chunks use structured clone rather than JSON or whole-file Base64. */
export interface KnowledgeFileChunk {
  readonly data: Uint8Array
  readonly offset: number
  readonly eof: boolean
}

/** Common metadata returned before an employee-owned document is opened. */
export interface KnowledgeDocumentPreviewMetadata {
  readonly id: string
  readonly knowledgeBaseId: string
  readonly filename: string
  readonly contentVersion: string
  readonly sizeBytes: number
  readonly sourceType?: string
  readonly previewMaxBytes?: number
  readonly downloadMaxBytes?: number
}

/** Resource identifiers accepted by all knowledge IPC and HTTP boundaries.
 * @param value - Candidate resource identifier.
 * @returns Whether the value matches the public resource identifier format.
 */
export function isKnowledgeResourceId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)
}

/**
 * Validate the server metadata used by both the Host preview and Electron's
 * private file transport. Keeping this at the product boundary prevents the
 * two processes from silently accepting different document identities or
 * size limits.
 * @param value - Untrusted server metadata.
 * @param identity - Expected document identity.
 * @param options - Optional validation policy.
 * @returns Validated preview metadata.
 */
export function parseKnowledgeDocumentPreviewMetadata(value: unknown,
  identity: Pick<KnowledgeDocumentPreviewMetadata, 'id' | 'knowledgeBaseId'>,
  options: { readonly requireLimits?: boolean } = {}): KnowledgeDocumentPreviewMetadata {
  if (typeof value !== 'object' || value === null
    || !('id' in value) || value.id !== identity.id
    || !('knowledgeBaseId' in value) || value.knowledgeBaseId !== identity.knowledgeBaseId
    || !('filename' in value) || typeof value.filename !== 'string' || value.filename === '' || value.filename.length > 1024
    || !('contentVersion' in value) || typeof value.contentVersion !== 'string' || value.contentVersion === '' || value.contentVersion.length > 256
    || !('sizeBytes' in value) || typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0
    || 'sourceType' in value && value.sourceType !== undefined && typeof value.sourceType !== 'string'
    || options.requireLimits === true && (!('previewMaxBytes' in value) || typeof value.previewMaxBytes !== 'number'
      || !('downloadMaxBytes' in value) || typeof value.downloadMaxBytes !== 'number')
    || 'previewMaxBytes' in value && value.previewMaxBytes !== undefined
      && (typeof value.previewMaxBytes !== 'number' || !Number.isSafeInteger(value.previewMaxBytes) || value.previewMaxBytes < 1)
    || 'downloadMaxBytes' in value && value.downloadMaxBytes !== undefined
      && (typeof value.downloadMaxBytes !== 'number' || !Number.isSafeInteger(value.downloadMaxBytes) || value.downloadMaxBytes < 1)) {
    throw new ProductError('INVALID_SERVER_RESPONSE', 'Invalid original file metadata', false)
  }
  const record = value as Record<string, unknown>
  return {
    id: record.id as string,
    knowledgeBaseId: record.knowledgeBaseId as string,
    filename: record.filename as string,
    contentVersion: record.contentVersion as string,
    sizeBytes: record.sizeBytes as number,
    ...record.sourceType === undefined ? {} : { sourceType: record.sourceType as string },
    ...record.previewMaxBytes === undefined ? {} : { previewMaxBytes: record.previewMaxBytes as number },
    ...record.downloadMaxBytes === undefined ? {} : { downloadMaxBytes: record.downloadMaxBytes as number },
  }
}

/** File operations owned by Electron main, including private Host conversion transport. */
export type KnowledgeFileMethod =
  | 'knowledge.documents.preview.open'
  | 'knowledge.documents.preview.read'
  | 'knowledge.documents.preview.close'
  | 'knowledge.documents.download'
  | 'knowledge.documents.openExternal'
  | 'runtime.knowledge.preview.readChunk'
  | 'runtime.knowledge.preview.policy'
  | 'runtime.knowledge.preview.write.open'
  | 'runtime.knowledge.preview.write.append'
  | 'runtime.knowledge.preview.write.commit'
  | 'runtime.knowledge.preview.write.close'

/** Allowlisted product and native sidecar operations. */
export type ProductMethod =
  | 'support.device.report'
  | 'support.feedback.submit'
  | 'extensions.save'
  | 'extensions.submit'
  | 'content.submissions.inspect'
  | 'content.submissions.submit'
  | 'extensions.connector.read'
  | 'extensions.connector.update'
  | 'extensions.connector.delete'
  | 'extensions.connector.configuration.read'
  | 'extensions.connector.configuration.save'
  | 'knowledge.references.resolve'
  | 'tasks.capabilities.read'
  | 'tasks.capabilities.prepare'
  | 'auth.getSession'
  | 'auth.ensureDingTalk'
  | 'auth.beginDingTalk'
  | 'auth.pollDingTalk'
  | 'auth.refresh'
  | 'catalog.refresh'
  | 'connectors.refresh'
  | 'connectors.list'
  | 'connectors.authorization.status'
  | 'connectors.authorization.begin'
  | 'connectors.authorization.revoke'
  | 'knowledge.bases.list'
  | 'knowledge.bases.create'
  | 'knowledge.bases.delete'
  | 'knowledge.files.limits'
  | 'knowledge.search'
  | 'knowledge.sources.read'
  | 'knowledge.documents.list'
  | 'knowledge.documents.get'
  | 'knowledge.documents.previewMetadata'
  | Extract<KnowledgeFileMethod, `knowledge.${string}`>
  | 'knowledge.documents.read'
  | 'knowledge.documents.upload.select'
  | 'knowledge.documents.upload'
  | 'knowledge.documents.upload.discard'
  | 'knowledge.documents.upload.pending'
  | 'knowledge.documents.save'
  | 'knowledge.documents.importUrl'
  | 'knowledge.documents.delete'
  | 'knowledge.documents.reindex'
  | 'knowledge.documents.cancel'
  | 'knowledge.documents.move'
  | 'knowledge.folders.list'
  | 'knowledge.folders.get'
  | 'knowledge.folders.create'
  | 'knowledge.folders.rename'
  | 'knowledge.folders.delete'

/** Product operations the trusted Harness Host may request from Electron main. */
export type ProductRuntimeMethod = Extract<ProductMethod,
  | 'auth.getSession'
  | 'connectors.list'
  | 'knowledge.bases.list'
  | 'knowledge.search'
  | 'knowledge.sources.read'
  | 'knowledge.documents.get'
  | 'knowledge.documents.previewMetadata'
  | 'knowledge.documents.preview.open'
  | 'knowledge.documents.preview.close'
  | 'knowledge.documents.save'
> | Extract<KnowledgeFileMethod, `runtime.${string}`>
  | 'runtime.companyContent.read'
  | 'runtime.companyContent.refresh'
  | 'runtime.companyContent.pin'


const PRODUCT_RUNTIME_METHODS: readonly ProductRuntimeMethod[] = [
  'runtime.companyContent.read', 'runtime.companyContent.refresh', 'runtime.companyContent.pin',
  'auth.getSession',
  'connectors.list', 'knowledge.bases.list', 'knowledge.search', 'knowledge.sources.read', 'knowledge.documents.save',
  'knowledge.documents.get', 'knowledge.documents.previewMetadata', 'knowledge.documents.preview.open', 'knowledge.documents.preview.close',
  'runtime.knowledge.preview.policy', 'runtime.knowledge.preview.readChunk', 'runtime.knowledge.preview.write.open', 'runtime.knowledge.preview.write.append',
  'runtime.knowledge.preview.write.commit', 'runtime.knowledge.preview.write.close',
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

const taskIdentity = z.string().min(1).max(256).refine(value => value.trim() !== '')
const knowledgeSelection = z.array(taskIdentity).max(32).readonly()

/** Validate a task request without accepting obsolete selections or undeclared fields. */
export const ProductTaskCapabilityRequestSchema = z.object({
  basePresetId: taskIdentity.optional(), sessionId: taskIdentity.optional(),
  knowledgeBaseIds: knowledgeSelection.optional(), recoverCapabilities: z.boolean().optional(),
}).strict()
/** Omitted selections retain the current task's knowledge scope. */
export type ProductTaskCapabilityRequest = Readonly<z.output<typeof ProductTaskCapabilityRequestSchema>>

/** Validate a complete selected scope and its optional restoration diagnostic. */
export const ProductTaskCapabilitiesSchema = z.object({
  basePresetId: taskIdentity.optional(),
  knowledgeBaseIds: knowledgeSelection.refine(ids => new Set(ids).size === ids.length),
  unavailable: z.custom<ProductFailure>(isProductFailure).optional(),
}).strict()
/** Knowledge selection pinned to an immutable task composition. */
export type ProductTaskCapabilities = Readonly<z.output<typeof ProductTaskCapabilitiesSchema>>

/** Validate one verified knowledge dependency. */
export const ProductDependencyCheckSchema = z.object({
  kind: z.literal('KNOWLEDGE_BASE'), reference: taskIdentity,
  status: z.enum(['READY', 'MISSING', 'UNAUTHORIZED', 'INCOMPATIBLE', 'NOT_CHECKED']),
}).strict()
/** One dependency verified before preparing a product capability. */
export type ProductDependencyCheck = Readonly<z.output<typeof ProductDependencyCheckSchema>>

/** Require a successful check for every selected knowledge base before Session selection. */
export const ProductTaskCapabilityResultSchema = z.object({
  kind: z.enum(['CURRENT_SESSION', 'NEW_SESSION']), presetId: taskIdentity,
  capabilities: ProductTaskCapabilitiesSchema,
  dependencyChecks: z.array(ProductDependencyCheckSchema).max(32).readonly(),
}).strict().refine(value => value.capabilities.basePresetId !== undefined && value.capabilities.unavailable === undefined
  && value.dependencyChecks.length === value.capabilities.knowledgeBaseIds.length
  && new Set(value.dependencyChecks.map(check => check.reference)).size === value.dependencyChecks.length
  && value.dependencyChecks.every(check => check.status === 'READY'
    && value.capabilities.knowledgeBaseIds.includes(check.reference)))
/** Preparation does not modify a Session; the official selection API commits the result. */
export type ProductTaskCapabilityResult = Readonly<z.output<typeof ProductTaskCapabilityResultSchema>>

/** Validate the renderer's task request at a process interface.
 * @param value - Untrusted request fields.
 * @returns Explicit task selections; omitted fields remain omitted.
 */
export function parseTaskCapabilityRequest(value: unknown): ProductTaskCapabilityRequest {
  const parsed = ProductTaskCapabilityRequestSchema.safeParse(value)
  if (!parsed.success) throw new ProductError('CAPABILITY_REQUEST_INVALID', 'Invalid task capability request', false, [], { cause: parsed.error })
  return parsed.data
}

/** Validate a task read before exposing its selected scope.
 * @param value - Untrusted Host response.
 * @returns Complete task selections or a structured response failure.
 */
export function parseTaskCapabilities(value: unknown): ProductTaskCapabilities {
  const parsed = ProductTaskCapabilitiesSchema.safeParse(value)
  if (!parsed.success) throw new ProductError('CAPABILITY_RESPONSE_INVALID', 'Task selection is invalid; reload the task', true, [], { cause: parsed.error })
  return parsed.data
}

/** Validate a preparation receipt before changing a native Session or draft.
 * @param value - Untrusted Host response, including all dependency checks.
 * @param request - Requested selection; recovery may discard knowledge that is no longer available.
 * @returns A complete receipt matching the request, with one successful check per selected knowledge base.
 */
export function parseTaskCapabilityResult(value: unknown, request?: ProductTaskCapabilityRequest): ProductTaskCapabilityResult {
  const parsed = ProductTaskCapabilityResultSchema.safeParse(value)
  if (!parsed.success) throw new ProductError('CAPABILITY_RESPONSE_INVALID', 'Task preparation is incomplete or inconsistent; reload the task', true, [], { cause: parsed.error })
  const capabilities = parsed.data.capabilities
  const selected = request?.knowledgeBaseIds
  if (request !== undefined && (request.basePresetId !== undefined && request.basePresetId !== capabilities.basePresetId
    || selected !== undefined && (capabilities.knowledgeBaseIds.some(id => !selected.includes(id))
      || request.recoverCapabilities !== true && new Set(selected).size !== capabilities.knowledgeBaseIds.length))) {
    throw new ProductError('CAPABILITY_RESPONSE_INVALID', 'Task preparation does not match the requested selection; reload the task', true)
  }
  return parsed.data
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
    'support.device.report', 'support.feedback.submit',
    'tasks.capabilities.read', 'tasks.capabilities.prepare',
    'extensions.save', 'extensions.submit', 'content.submissions.inspect', 'content.submissions.submit',
    'extensions.connector.read', 'extensions.connector.update', 'extensions.connector.delete',
    'extensions.connector.configuration.read', 'extensions.connector.configuration.save', 'knowledge.references.resolve',
    'auth.getSession', 'auth.ensureDingTalk', 'auth.beginDingTalk', 'auth.pollDingTalk', 'auth.refresh', 'catalog.refresh', 'connectors.refresh',

    'connectors.list',
    'connectors.authorization.status', 'connectors.authorization.begin', 'connectors.authorization.revoke',
    'knowledge.bases.list', 'knowledge.bases.create', 'knowledge.bases.delete', 'knowledge.files.limits', 'knowledge.search', 'knowledge.sources.read',
    'knowledge.documents.list', 'knowledge.documents.get', 'knowledge.documents.previewMetadata', 'knowledge.documents.read', 'knowledge.documents.upload', 'knowledge.documents.upload.select', 'knowledge.documents.upload.discard', 'knowledge.documents.upload.pending',
    'knowledge.documents.preview.open', 'knowledge.documents.preview.read', 'knowledge.documents.preview.close',
    'knowledge.documents.download', 'knowledge.documents.openExternal',
    'knowledge.documents.save', 'knowledge.documents.importUrl', 'knowledge.documents.delete', 'knowledge.documents.reindex', 'knowledge.documents.cancel',
    'knowledge.documents.move', 'knowledge.folders.list', 'knowledge.folders.get', 'knowledge.folders.create', 'knowledge.folders.rename', 'knowledge.folders.delete',
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
