/** Extensions may explicitly publish a credential-free failure across process boundaries. */
export interface ExtensionFailure {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly resources: readonly { readonly kind: string; readonly id: string }[]
}

/** Structured replies retain diagnostics across Electron's isolated-world bridge. */
export type ExtensionResponse = { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly failure: ExtensionFailure }

export function isExtensionFailure(value: unknown): value is ExtensionFailure {
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
    && 'message' in value && typeof value.message === 'string' && 'retryable' in value && typeof value.retryable === 'boolean'
    && 'resources' in value && Array.isArray(value.resources) && value.resources.every((row: unknown) => typeof row === 'object'
      && row !== null && 'kind' in row && typeof row.kind === 'string' && 'id' in row && typeof row.id === 'string')
}

export function extensionFailure(error: unknown): ExtensionFailure {
  if (typeof error === 'object' && error !== null && 'publicFailure' in error && isExtensionFailure(error.publicFailure)) {
    return error.publicFailure
  }
  return { code: 'EXTENSION_OPERATION_FAILED', message: 'Desktop extension operation failed', retryable: true, resources: [] }
}

export function extensionError(failure: ExtensionFailure): Error {
  return Object.assign(new Error(failure.message), failure, { publicFailure: failure })
}
