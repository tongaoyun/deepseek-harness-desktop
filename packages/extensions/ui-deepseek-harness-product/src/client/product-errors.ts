/** Localized public diagnostics for organization and knowledge failures. */
import { productFailure } from '@deepseek-harness/product/errors'
import type { DeepSeekHarnessProductKey } from '../locales.ts'

const messageKeys: Readonly<Record<string, DeepSeekHarnessProductKey>> = {
  FEEDBACK_INVALID: 'feedbackSendFailed',
  FEEDBACK_IMAGES_INVALID: 'feedbackImagesInvalid',
  EXTENSION_DRAFT_CHANGED: 'draftChanged',
  EXTENSION_VERSION_CONFLICT: 'resourceConflict',
  EXTENSION_REQUEST_TIMEOUT: 'extensionRequestTimeout',
  EXTENSION_PRIVATE_CONFIGURATION_INVALID: 'invalidPrivateConfiguration',
  CONNECTOR_DISCOVERY_FAILED: 'connectorDiscoveryFailed',
  CONNECTOR_AUTHORIZATION_REQUIRED: 'connectorProviderAuthorizationRequired',
  CONNECTOR_CONFIGURATION_REQUIRED: 'privateValuesRequired',
  EXTENSION_OWNER_REQUIRED: 'ownerRequired',
  EXTENSION_IMPORT_INVALID: 'importInvalid',
  EXPERT_KIT_PACKAGE_INVALID: 'importInvalid',
  EXPERT_KIT_PACKAGE_NOT_FOUND: 'importInvalid',
  EXPERT_KIT_RELEASE_CONFLICT: 'resourceConflict',
  KIT_NOT_INSTALLED: 'expertKitNotInstalled',
  KIT_TASK_INVALID: 'expertKitTaskInvalid',
  KIT_SKILL_MISSING: 'expertKitSkillMissing',
  KIT_INSTALLED_VERSION_CHANGED: 'expertKitInstalledVersionChanged',
  TASK_SNAPSHOT_INVALID: 'taskSnapshotUnavailable',
  TASK_SNAPSHOT_MISSING: 'taskSnapshotUnavailable',
  TASK_SNAPSHOT_UNAVAILABLE: 'taskSnapshotUnavailable',
  EXTENSION_REVIEW_CONFLICT: 'resourceConflict',
  ORGANIZATION_EMPLOYEE_UNMAPPED: 'organizationEmployeeUnmapped',
  ORGANIZATION_EMPLOYEE_INACTIVE: 'organizationEmployeeInactive',
  ORGANIZATION_SOURCE_INVALID: 'organizationSourceInvalid',
  ORGANIZATION_SYNC_EXPIRED: 'organizationSyncExpired',
  ORGANIZATION_SERVICE_UNAVAILABLE: 'organizationServiceUnavailable',
  KNOWLEDGE_ACCESS_REVOKED: 'knowledgeAccessRevoked',
  KNOWLEDGE_ACCESS_DENIED: 'knowledgeAccessDenied',
  KNOWLEDGE_MANAGEMENT_FORBIDDEN: 'knowledgeManageForbidden',
  KNOWLEDGE_DOCUMENT_CONFLICT: 'knowledgeDocumentChanged',
  KNOWLEDGE_DOCUMENT_CHANGED: 'knowledgePreviewSourceChanged',
  KNOWLEDGE_DOCUMENT_DUPLICATE: 'knowledgeDocumentDuplicate',
  KNOWLEDGE_PREVIEW_UNAVAILABLE: 'knowledgePreviewUnavailable',
  KNOWLEDGE_PREVIEW_TOO_LARGE: 'knowledgePreviewTooLarge',
  KNOWLEDGE_FILE_TOO_LARGE: 'knowledgeFileTooLarge',
  KNOWLEDGE_SERVICE_UNAVAILABLE: 'knowledgeServiceUnavailable',
  KNOWLEDGE_OFFICE_PREVIEW_UNAVAILABLE: 'knowledgeOfficePreviewUnavailable',
  KNOWLEDGE_PREVIEW_SOURCE_CHANGED: 'knowledgePreviewSourceChanged',
  KNOWLEDGE_PREVIEW_INVALID: 'knowledgePreviewInvalid',
  KNOWLEDGE_PREVIEW_TIMEOUT: 'knowledgePreviewTimeout',
  KNOWLEDGE_PREVIEW_BUSY: 'knowledgePreviewBusy',
  KNOWLEDGE_TRANSFER_BUSY: 'knowledgePreviewBusy',
  KNOWLEDGE_PREVIEW_FAILED: 'knowledgePreviewFailed',
  KNOWLEDGE_PARSE_MODE_INVALID: 'knowledgeParseModeInvalid',
  KNOWLEDGE_FOLDER_CONFLICT: 'knowledgeFolderConflict',
  KNOWLEDGE_FOLDER_NOT_EMPTY: 'knowledgeFolderNotEmpty',
}

/** Format recognized public failures without displaying remote exception text.
 * @param error - Failure returned by product transport.
 * @param t - Current locale dictionary.
 * @param fallback - Message for unrecognized failures.
 * @returns Localized cause and diagnostic code, or the generic fallback.
 */
export function productErrorMessage(error: unknown, t: (key: DeepSeekHarnessProductKey) => string,
  fallback: DeepSeekHarnessProductKey): string {
  const failure = productFailure(error)
  const key = Object.hasOwn(messageKeys, failure.code) ? messageKeys[failure.code] : undefined
  const checks = failure.dependencyChecks?.filter(value => value.status !== 'READY').map(value => `${value.reference}: ${value.status}`)
  return `${key === undefined ? t(fallback) : `${t(key)} (${failure.code})`}${checks?.length ? ` ${checks.join('; ')}` : ''}`
}
