/** Serializable product failures across renderer, main, Host, and remote boundaries. */
export interface ProductFailure {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly resources: readonly { readonly kind: string; readonly id: string }[]
  readonly dependencyChecks?: readonly import('./protocol.ts').ProductDependencyCheck[]
}

/** Product diagnostic retaining private causes and a serializable public failure. */
export class ProductError extends Error implements ProductFailure {
  readonly dependencyChecks?: readonly import('./protocol.ts').ProductDependencyCheck[]
  constructor(readonly code: string, message: string, readonly retryable = false,
    readonly resources: ProductFailure['resources'] = [],
    options?: ErrorOptions & { readonly dependencyChecks?: ProductFailure['dependencyChecks'] }) {
    super(message, options)
    this.name = 'ProductError'
    if (options?.dependencyChecks !== undefined) this.dependencyChecks = options.dependencyChecks
  }
  /** Credential-free diagnostic for IPC and HTTP consumers. */
  get publicFailure(): ProductFailure {
    return { code: this.code, message: this.message, retryable: this.retryable, resources: this.resources,
      ...this.dependencyChecks === undefined ? {} : { dependencyChecks: this.dependencyChecks } }
  }
}

/** Publish a known failure, or redact an unknown local exception.
 * @param error - Local or remote operation failure.
 * @returns Public diagnostic without private exception details.
 */
export function productFailure(error: unknown): ProductFailure {
  if (isProductFailure(error)) return { code: error.code, message: error.message, retryable: error.retryable, resources: error.resources,
    ...error.dependencyChecks === undefined ? {} : { dependencyChecks: error.dependencyChecks } }
  return { code: 'PRODUCT_OPERATION_FAILED', message: 'Product operation failed',
    retryable: true, resources: [] }
}

/** Validate published failures at process and HTTP interfaces.
 * @param value - Untrusted response or error.
 * @returns Whether it contains the complete public diagnostic fields.
 */
export function isProductFailure(value: unknown): value is ProductFailure {
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
    && 'message' in value && typeof value.message === 'string' && 'retryable' in value && typeof value.retryable === 'boolean'
    && 'resources' in value && Array.isArray(value.resources) && value.resources.every((resource: unknown) =>
    typeof resource === 'object' && resource !== null && 'kind' in resource && typeof resource.kind === 'string'
      && 'id' in resource && typeof resource.id === 'string')
    && (!('dependencyChecks' in value) || value.dependencyChecks === undefined
      || Array.isArray(value.dependencyChecks) && value.dependencyChecks.every((row: unknown) =>
        typeof row === 'object' && row !== null && 'kind' in row && typeof row.kind === 'string'
      && ['DESKTOP_VERSION', 'SKILL', 'DATA_CONNECTION', 'TOOL', 'KNOWLEDGE_BASE'].includes(row.kind)
      && 'reference' in row && typeof row.reference === 'string' && 'status' in row && typeof row.status === 'string'
      && ['READY', 'MISSING', 'UNAUTHORIZED', 'INCOMPATIBLE', 'NOT_CHECKED'].includes(row.status)))
}
