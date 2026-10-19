/** Public product bridge contract. Harness execution never crosses this boundary. */

/** Protocol identifier for the product sidecar bridge. */
export const PRODUCT_PROTOCOL = 'deepseek-harness.native.v1' as const

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
  | 'extensions.authoring.begin'
  | 'extensions.authoring.read'
  | 'extensions.authoring.update'
  | 'extensions.authoring.save'
  | 'extensions.authoring.discard'
  | 'extensions.import.inspect'
  | 'extensions.import.release'
  | 'extensions.save'
  | 'extensions.submit'
  | 'extensions.delete'
  | 'extensions.bundledSkill.read'
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
  | 'expertKits.list'
  | 'expertKits.get'
  | 'expertKits.readme'
  | 'expertKits.artifact'
  | 'expertKits.install'
  | 'expertKits.uninstall'
  | 'expertKits.installed.read'
  | 'skills.list'
  | 'skills.get'
  | 'skills.readme'
  | 'skills.artifact'
  | 'skills.install'
  | 'skills.uninstall'
  | 'skills.installed.read'
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
  | 'extensions.authoring.read'
  | 'extensions.authoring.update'
  | 'extensions.authoring.save'
  | 'auth.getSession'
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
  | 'knowledge.sources.read'
  | 'knowledge.documents.get'
  | 'knowledge.documents.previewMetadata'
  | 'knowledge.documents.preview.open'
  | 'knowledge.documents.preview.close'
  | 'knowledge.documents.save'
> | Extract<KnowledgeFileMethod, `runtime.${string}`> | 'runtime.environment'

const PRODUCT_RUNTIME_METHODS: readonly ProductRuntimeMethod[] = [
  'extensions.authoring.read', 'extensions.authoring.update', 'extensions.authoring.save',
  'runtime.environment',
  'auth.getSession',
  'expertKits.list', 'expertKits.get', 'expertKits.readme', 'expertKits.artifact',
  'skills.list', 'skills.get', 'skills.readme', 'skills.artifact',
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

/** Content-addressed catalog identity passed unchanged to the trusted Host. */
export interface ProductContentIdentity {
  /** Display name pinned alongside the content version when available. */
  readonly name?: string
  readonly id: string
  readonly version: string
  readonly sha256: string
}

/** Effective capabilities pinned to a task's immutable execution snapshot. */
export interface ProductTaskCapabilities {
  /** Execution mode underlying the immutable task composition. */
  readonly basePresetId?: string
  readonly expertKit?: ProductContentIdentity
  /** Shortcut and exact bundled skills selected from the pinned kit artifact. */
  readonly expertKitTask?: { readonly id: string; readonly name: string; readonly skillIds: readonly string[] }
  readonly connectorIds: readonly string[]
  /** Connectors required by the pinned Expert Kit and locked against task removal. */
  readonly requiredConnectorIds: readonly string[]
  readonly knowledgeBaseIds: readonly string[]
  /** Required aliases resolved once into immutable IDs during kit preparation. */
  readonly requiredKnowledgeBaseIds: readonly string[]
  readonly knowledgeBaseRefs: readonly string[]
  readonly unavailable?: import('./errors.ts').ProductFailure
}

/** Locally installed skills and the subset available to one task. */
export interface ProductInstalledSkills {
  readonly installed: readonly ProductContentIdentity[]
  readonly available: readonly ProductContentIdentity[]
  readonly frozen: boolean
}

/** Employee-scoped Expert Kit installations on the current device, independent of tasks. */
export interface ProductInstalledExpertKits {
  readonly installed: readonly ProductContentIdentity[]
}

/** Incremental task configuration; omitted selections retain the task's current values. */
export interface ProductTaskCapabilityRequest {
  /** Change execution mode while retaining the task's selected capabilities. */
  readonly basePresetId?: string
  readonly sessionId?: string
  /** Select a kit, or clear its composition with null while retaining selected knowledge. */
  readonly expertKitId?: string | null
  /** Shortcut identity resolved by Host from the selected kit's installed artifact. */
  readonly expertKitTaskId?: string
  readonly connectorIds?: readonly string[]
  readonly knowledgeBaseIds?: readonly string[]
  /** Explicitly exit the kit and remove only resources denied by a successful live query. */
  readonly recoverCapabilities?: boolean
}

/** Preparation does not modify a Session; the official selection API commits the result. */
export interface ProductTaskCapabilityResult {
  readonly kind: 'CURRENT_SESSION' | 'NEW_SESSION'
  readonly presetId: string
  readonly capabilities: ProductTaskCapabilities
  readonly dependencyChecks: readonly ProductDependencyCheck[]
  /** Authoritative shortcut prompt, prefilled without sending it. */
  readonly prompt?: string
}

/** One dependency verified before preparing a product capability. */
export interface ProductDependencyCheck {
  readonly kind: 'DESKTOP_VERSION' | 'SKILL' | 'DATA_CONNECTION' | 'TOOL' | 'KNOWLEDGE_BASE'
  readonly reference: string
  readonly status: 'READY' | 'MISSING' | 'UNAUTHORIZED' | 'INCOMPATIBLE' | 'NOT_CHECKED'
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
  readonly type: 'session.changed' | 'catalog.changed' | 'authoring.changed' | 'auth.required'
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
    'extensions.authoring.begin', 'extensions.authoring.read', 'extensions.authoring.update', 'extensions.authoring.save', 'extensions.authoring.discard',
    'extensions.import.inspect', 'extensions.import.release', 'extensions.save', 'extensions.submit', 'extensions.delete', 'extensions.bundledSkill.read',
    'extensions.connector.read', 'extensions.connector.update', 'extensions.connector.delete',
    'extensions.connector.configuration.read', 'extensions.connector.configuration.save', 'knowledge.references.resolve',
    'auth.getSession', 'auth.ensureDingTalk', 'auth.beginDingTalk', 'auth.pollDingTalk', 'auth.refresh', 'catalog.refresh', 'expertKits.list',
    'expertKits.get', 'expertKits.readme', 'expertKits.artifact', 'expertKits.install', 'expertKits.uninstall', 'expertKits.installed.read',
    'skills.list', 'skills.get', 'skills.readme',
    'skills.artifact', 'skills.install', 'skills.uninstall', 'skills.installed.read', 'connectors.list',
    'connectors.authorization.status', 'connectors.authorization.begin', 'connectors.authorization.revoke',
    'knowledge.bases.list', 'knowledge.bases.create', 'knowledge.bases.delete', 'knowledge.files.limits', 'knowledge.search', 'knowledge.sources.read',
    'knowledge.documents.list', 'knowledge.documents.get', 'knowledge.documents.previewMetadata', 'knowledge.documents.read', 'knowledge.documents.upload', 'knowledge.documents.upload.discard', 'knowledge.documents.upload.pending',
    'knowledge.documents.preview.open', 'knowledge.documents.preview.read', 'knowledge.documents.preview.close',
    'knowledge.documents.download', 'knowledge.documents.openExternal',
    'knowledge.documents.save', 'knowledge.documents.importUrl', 'knowledge.documents.delete', 'knowledge.documents.reindex', 'knowledge.documents.cancel',
    'knowledge.documents.move', 'knowledge.folders.list', 'knowledge.folders.get', 'knowledge.folders.create', 'knowledge.folders.rename', 'knowledge.folders.delete',
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
