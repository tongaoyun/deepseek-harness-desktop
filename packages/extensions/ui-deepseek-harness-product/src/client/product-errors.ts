/** Localized public diagnostics for product operations. */
import { productFailure } from '@deepseek-harness/product/errors'
import type { DeepSeekHarnessProductKey } from '../locales.ts'

/** Retained failure data formatted in the active locale when rendered. */
export interface ProductFailureReport {
  /** Failure returned by the operation. */
  readonly failure: unknown
  /** Localized fallback for unrecognized failures. */
  readonly fallback: DeepSeekHarnessProductKey
}

const messageKeys: Readonly<Record<string, DeepSeekHarnessProductKey>> = {
  EMPLOYEE_UNAUTHORIZED: 'employeeSignInRequired',
  PRODUCT_HOST_IDENTITY_CHANGED: 'employeeHostRestartRequired',
  METHOD_NOT_ALLOWED: 'serverFeatureUnavailable',
  NOT_FOUND: 'serverFeatureUnavailable',
  FEEDBACK_INVALID: 'feedbackSendFailed',
  FEEDBACK_IMAGES_INVALID: 'feedbackImagesInvalid',
  EXTENSION_DRAFT_CHANGED: 'draftChanged',
  EXTENSION_SAVE_PENDING: 'extensionSavePending',
  EXTENSION_DEPENDENCY_BLOCKED: 'extensionDependenciesBlocked',
  EXTENSION_VERSION_CONFLICT: 'resourceConflict',
  EXTENSION_REQUEST_TIMEOUT: 'extensionRequestTimeout',
  EXTENSION_PRIVATE_CONFIGURATION_INVALID: 'invalidPrivateConfiguration',
  CONNECTOR_DISCOVERY_FAILED: 'connectorDiscoveryFailed',
  CONNECTOR_STARTUP_FAILED: 'connectorRuntimeUnavailable',
  CONNECTOR_AUTHORIZATION_REQUIRED: 'connectorProviderAuthorizationRequired',
  CONNECTOR_CONFIGURATION_REQUIRED: 'privateValuesRequired',
  CONNECTOR_SAVE_PENDING: 'connectorSavePending',
  CONNECTOR_OPERATION_UNCONFIRMED: 'connectorOperationUnconfirmed',
  CONNECTOR_DELETE_CLEANUP_FAILED: 'connectorDeleteCleanupFailed',
  EXTENSION_OWNER_REQUIRED: 'ownerRequired',
  EXTENSION_IMPORT_INVALID: 'importInvalid',
  EXTENSION_REVIEW_CONFLICT: 'resourceConflict',
  ORGANIZATION_EMPLOYEE_UNMAPPED: 'organizationEmployeeUnmapped',
  ORGANIZATION_EMPLOYEE_INACTIVE: 'organizationEmployeeInactive',
  ORGANIZATION_SOURCE_INVALID: 'organizationSourceInvalid',
  ORGANIZATION_SYNC_EXPIRED: 'organizationSyncExpired',
  ORGANIZATION_SERVICE_UNAVAILABLE: 'organizationServiceUnavailable',
  IDEMPOTENCY_OPERATION_UNKNOWN: 'libraryOutcomeUnknown',
  LIBRARY_ACCESS_DENIED: 'libraryAccessDenied',
  LIBRARY_ACCESS_REVOKED: 'libraryAccessDenied',
  LIBRARY_MANAGEMENT_FORBIDDEN: 'libraryManageDenied',
  LIBRARY_CONFLICT: 'libraryConflict',
  LIBRARY_PREVIEW_SOURCE_CHANGED: 'libraryConflict',
  LIBRARY_NOT_EMPTY: 'libraryNotEmpty',
  LIBRARY_FILE_INVALID: 'libraryFileInvalid',
}

/** Format recognized public failures without displaying remote exception text.
 * @param error - Failure returned by product transport.
 * @param t - Current locale dictionary.
 * @param fallback - Message for unrecognized failures.
 * @returns Localized cause, with diagnostic codes only for failures requiring investigation.
 */
export function productErrorMessage(error: unknown, t: (key: DeepSeekHarnessProductKey) => string,
  fallback: DeepSeekHarnessProductKey): string {
  const failure = productFailure(error)
  const key = Object.hasOwn(messageKeys, failure.code) ? messageKeys[failure.code] : undefined
  const message = key === undefined ? t(fallback) : t(key)
  if (failure.code === 'EMPLOYEE_UNAUTHORIZED' || failure.code === 'PRODUCT_HOST_IDENTITY_CHANGED') return message
  return `${message}${key === undefined ? '' : ` (${failure.code})`}`
}
