import type { ComponentType, ReactNode } from 'react'
import { IconAgentPresetOutlineRegular, IconCheckOutlineRegular, IconDatabaseOutlineRegular, IconLinkOutlineRegular, IconSkillOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { type DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import type { ProductInstalledExpertKits, ProductInstalledSkills, ProductTaskCapabilities } from '@deepseek-harness/product/protocol'

export type Catalog = keyof typeof METHODS

/** Match installed content against its catalog identity.
 * @param installed Device installation records indexed by resource ID.
 * @param content Catalog identity; omitted version and hash impose no additional constraint.
 * @returns Whether the device holds the catalog content.
 */
export function isInstalled(installed: ReadonlyMap<string, { readonly version?: string; readonly sha256?: string }>,
  content: { readonly id: string; readonly version?: string; readonly sha256?: string }): boolean {
  const identity = installed.get(content.id)
  return identity !== undefined && (content.version === undefined || identity.version === content.version)
    && (content.sha256 === undefined || identity.sha256 === content.sha256)
}

export type ConnectorTool = {
  readonly name: string
  readonly displayName: string
  readonly description?: string
  readonly access: 'READ' | 'WRITE'
}

export type ProductItem = {
  readonly canRead?: boolean
  readonly canManage?: boolean
  readonly visibility?: string
  readonly canEdit?: boolean
  readonly canSubmit?: boolean
  readonly canDelete?: boolean
  readonly reviewStatus?: string
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly author?: string
  readonly category?: string
  readonly version?: string
  readonly sha256?: string
  readonly status?: string
  readonly scope?: string
  readonly companyId?: string
  readonly ownerEmployeeId?: string
  readonly ownerDepartmentId?: string
  readonly ownerName?: string
  readonly referenceKey?: string
  readonly reference?: string
  readonly transport?: string
  readonly authMode?: string
  readonly managed?: boolean
  readonly ready?: boolean
  readonly authorizationStatus?: string
  readonly availabilityStatus?: string
  readonly tools: readonly ConnectorTool[]
  readonly triggers: readonly string[]
  readonly skillCount: number
  readonly connectorCount: number
  readonly createdAt?: string
  readonly updatedAt?: string
}

export interface DeepSeekHarnessCatalogActions {
  /** Create a separate official conversation without submitting its initial draft. */
  startExtensionAuthoring?(kind: 'skill' | 'expert-kit', options: { prompt: string; stageId?: string; edit?: boolean }): Promise<void>
  startExpertKit(id: string, prompt?: string): Promise<void>
  installSkill(skillId: string): Promise<void>
  readInstalledSkills?(this: void): Promise<ProductInstalledSkills>
  /** Install on this device without changing tasks or drafts. */
  installExpertKit?(kitId: string): Promise<void>
  readInstalledExpertKits?(this: void): Promise<ProductInstalledExpertKits>
  readCapabilities?(this: void): Promise<ProductTaskCapabilities>
  /** Subscribe to active task and Preset changes without invoking a model. */
  subscribeTaskSelection?(this: void, listener: () => void): () => void
}

export type ProductDetail = {
  readonly canRead?: boolean
  readonly canManage?: boolean
  readonly visibility?: string
  readonly canEdit?: boolean
  readonly canSubmit?: boolean
  readonly canDelete?: boolean
  readonly reviewStatus?: string
  readonly id: string
  readonly name: string
  readonly author?: string
  readonly version?: string
  readonly summary?: string
  readonly category?: string
  readonly sha256?: string
  readonly commonTasks: readonly CommonTask[]
  readonly readme: string
  readonly sourceAvailable: boolean
  readonly status?: string
  readonly scope?: string
  readonly companyId?: string
  readonly ownerEmployeeId?: string
  readonly ownerDepartmentId?: string
  readonly ownerName?: string
  readonly transport?: string
  readonly authMode?: string
  readonly managed?: boolean
  readonly ready?: boolean
  readonly authorizationStatus?: string
  readonly availabilityStatus?: string
  readonly tools: readonly ConnectorTool[]
  readonly triggers: readonly string[]
  readonly skillDetails: readonly { readonly id: string; readonly name: string; readonly summary?: string }[]
  readonly connectorRefs: readonly string[]
  readonly connectorDetails: readonly ProductReference[]
  readonly requiredTools: readonly string[]
  readonly knowledgeBaseRefs: readonly string[]
  readonly knowledgeBaseDetails: readonly ProductReference[]
  readonly minimumDesktopVersion?: string
  readonly createdAt?: string
  readonly updatedAt?: string
}

export type ProductReference = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly available: boolean
  readonly status?: string
  readonly scope?: string
  readonly ownerName?: string
  readonly kind?: 'skills' | 'connectors' | 'knowledge'
}

export type CommonTask = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly prompt: string
}

export type CategoryFilter = string

export type ConnectorFilter = 'all' | 'connected'

export const METHODS = {
  expertKits: 'expertKits.list',
  skills: 'skills.list',
  connectors: 'connectors.list',
  knowledge: 'knowledge.bases.list',
} as const

export const DESCRIPTION_KEYS: Record<Catalog, DeepSeekHarnessProductKey> = {
  expertKits: 'expertKitsDescription',
  skills: 'skillsDescription',
  connectors: 'connectorsDescription',
  knowledge: 'knowledgeDescription',
}

export const ICONS: Record<Catalog, ComponentType<{ readonly size?: number }>> = {
  expertKits: IconAgentPresetOutlineRegular,
  skills: IconSkillOutlineRegular,
  connectors: IconLinkOutlineRegular,
  knowledge: IconDatabaseOutlineRegular,
}

export const CATEGORY_KEYS: Readonly<Record<string, DeepSeekHarnessProductKey>> = {
  'office-productivity': 'categoryOfficeProductivity',
  'content-creation': 'categoryContentCreation',
  marketing: 'categoryMarketing',
  'ecommerce-retail': 'categoryEcommerceRetail',
  finance: 'categoryFinance',
  legal: 'categoryLegal',
  recruiting: 'categoryRecruiting',
  'code-development': 'categoryCodeDevelopment',
  'code-review': 'categoryCodeReview',
  'security-testing': 'categorySecurityTesting',
  'database-analysis': 'categoryDatabaseAnalysis',
  'operations-deployment': 'categoryOperationsDeployment',
  'developer-tools': 'categoryDeveloperTools',
  design: 'categoryDesign',
  'product-management': 'categoryProductManagement',
  'knowledge-research': 'categoryKnowledgeResearch',
  workflow: 'categoryWorkflow',
  'agent-evolution': 'categoryAgentEvolution',
  communication: 'categoryCommunication',
  'industry-data': 'categoryIndustryData',
  'recommended-system': 'categoryRecommendedSystem',
  'communication-collaboration': 'categoryCommunicationCollaboration',
  'project-management': 'categoryProjectManagement',
  'knowledge-documents': 'categoryKnowledgeDocuments',
  'design-creative': 'categoryDesignCreative',
  'schedule-productivity': 'categoryScheduleProductivity',
  'maps-travel': 'categoryMapsTravel',
  other: 'categoryOther',
}

export let productRequestSequence = 0

export const AUTHORIZATION_TIMEOUT_MS = 60_000

export const AUTHORIZATION_POLL_INTERVAL_MS = 1_000

export function nextProductRequestId(): string {
  productRequestSequence += 1
  return `deepseek-harness-ui-${Date.now().toString(36)}-${productRequestSequence.toString(36)}`
}

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('operation cancelled'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = (): void => {
      clearTimeout(timer)
      reject(new Error('operation cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

export function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

export function stringList(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function connectorTools(value: unknown): readonly ConnectorTool[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    const name = text(record, 'name')
    const displayName = text(record, 'displayName')
    const access = text(record, 'access')
    if (name === undefined || displayName === undefined || (access !== 'READ' && access !== 'WRITE')) return []
    const description = text(record, 'description')
    return [{ name, displayName, access, ...(description === undefined ? {} : { description }) }]
  })
}

export function skillDetails(value: unknown): ProductDetail['skillDetails'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    const id = text(record, 'id')
    const name = text(record, 'name')
    if (id === undefined || name === undefined) return []
    const summary = text(record, 'summary')
    return [{ id, name, ...(summary === undefined ? {} : { summary }) }]
  })
}

export function items(value: unknown): readonly ProductItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    const id = text(record, 'id') ?? `${index}`
    const label = [record.displayName, record.name, record.title]
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '')
    if (label === undefined) return []
    const description = [record.description, record.summary]
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '')
    const authorizationStatus = text(record, 'authorizationStatus')
    const metadata = Object.fromEntries(
      ['author', 'category', 'version', 'sha256', 'status', 'scope', 'companyId', 'ownerEmployeeId', 'ownerDepartmentId', 'ownerName', 'referenceKey', 'reference', 'transport', 'authMode', 'availabilityStatus', 'createdAt', 'updatedAt', 'visibility', 'reviewStatus'].flatMap((key) => {
        const value = text(record, key)
        return value === undefined ? [] : [[key, value]]
      }),
    )
    return [{ id, label, ...(description === undefined ? {} : { description }), ...metadata,
      ...(typeof record.managed === 'boolean' ? { managed: record.managed } : {}),
      ...(typeof record.ready === 'boolean' ? { ready: record.ready } : {}),
      ...(authorizationStatus === undefined ? {} : { authorizationStatus }),
      ...(typeof record.canEdit === 'boolean' ? { canEdit: record.canEdit } : {}),
      ...(typeof record.canSubmit === 'boolean' ? { canSubmit: record.canSubmit } : {}),
      ...(typeof record.canDelete === 'boolean' ? { canDelete: record.canDelete } : {}),
      ...(typeof record.canRead === 'boolean' ? { canRead: record.canRead } : {}),
      ...(typeof record.canManage === 'boolean' ? { canManage: record.canManage } : {}),
      tools: connectorTools(record.tools), triggers: stringList(record, 'triggers'),
      skillCount: skillDetails(record.skillDetails).length,
      connectorCount: stringList(record, 'connectorRefs').length }]
  })
}

export function commonTasks(value: unknown): readonly CommonTask[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    const id = text(record, 'id')
    const name = text(record, 'name')
    const description = text(record, 'description')
    const prompt = text(record, 'prompt')
    return id === undefined || name === undefined || description === undefined || prompt === undefined
      ? [] : [{ id, name, description, prompt }]
  })
}

export function detail(value: unknown, readmeValue: unknown): ProductDetail | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const id = text(record, 'id')
  const name = text(record, 'displayName') ?? text(record, 'name') ?? text(record, 'title')
  if (id === undefined || name === undefined) return undefined
  const sha256 = text(record, 'sha256')
  const author = text(record, 'author')
  const version = text(record, 'version')
  const summary = text(record, 'summary')
  const category = text(record, 'category')
  const status = text(record, 'status')
  const scope = text(record, 'scope')
  const transport = text(record, 'transport')
  const authMode = text(record, 'authMode')
  const authorizationStatus = text(record, 'authorizationStatus')
  const availabilityStatus = text(record, 'availabilityStatus')
  const createdAt = text(record, 'createdAt')
  const updatedAt = text(record, 'updatedAt')
  const minimumDesktopVersion = text(record, 'minimumDesktopVersion')
  const readmeRecord = typeof readmeValue === 'object' && readmeValue !== null && !Array.isArray(readmeValue)
    ? readmeValue as Record<string, unknown> : {}
  const sourceAvailable = typeof readmeRecord.readme === 'string'
  return {
    id, name,
    ...Object.fromEntries(['visibility', 'reviewStatus'].flatMap(key => text(record, key) === undefined ? [] : [[key, text(record, key)]])),
    ...(typeof record.canEdit === 'boolean' ? { canEdit: record.canEdit } : {}),
    ...(typeof record.canSubmit === 'boolean' ? { canSubmit: record.canSubmit } : {}),
    ...(typeof record.canDelete === 'boolean' ? { canDelete: record.canDelete } : {}),
    ...(typeof record.canRead === 'boolean' ? { canRead: record.canRead } : {}),
    ...(typeof record.canManage === 'boolean' ? { canManage: record.canManage } : {}),
    ...(author === undefined ? {} : { author }),
    ...(version === undefined ? {} : { version }),
    ...(summary === undefined ? {} : { summary }),
    ...(category === undefined ? {} : { category }),
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(status === undefined ? {} : { status }),
    ...(scope === undefined ? {} : { scope }),
    ...Object.fromEntries(['companyId', 'ownerEmployeeId', 'ownerDepartmentId', 'ownerName'].flatMap(key => text(record, key) === undefined ? [] : [[key, text(record, key)]])),
    ...(transport === undefined ? {} : { transport }),
    ...(authMode === undefined ? {} : { authMode }),
    ...(typeof record.managed === 'boolean' ? { managed: record.managed } : {}),
    ...(typeof record.ready === 'boolean' ? { ready: record.ready } : {}),
    ...(authorizationStatus === undefined ? {} : { authorizationStatus }),
    ...(availabilityStatus === undefined ? {} : { availabilityStatus }),
    tools: connectorTools(record.tools), triggers: stringList(record, 'triggers'),
    skillDetails: skillDetails(record.skillDetails), connectorRefs: stringList(record, 'connectorRefs'),
    connectorDetails: [],
    requiredTools: stringList(record, 'requiredTools'), knowledgeBaseRefs: stringList(record, 'knowledgeBaseRefs'),
    knowledgeBaseDetails: [],
    ...(minimumDesktopVersion === undefined ? {} : { minimumDesktopVersion }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    commonTasks: commonTasks(record.commonTasks),
    readme: text(readmeRecord, 'readme') ?? '', sourceAvailable,
  }
}

export function localizedMetadata(value: string, t: (key: DeepSeekHarnessProductKey) => string): string {
  const keys: Record<string, DeepSeekHarnessProductKey> = {
    ACTIVE: 'statusActive', READY: 'statusReady', ENABLED: 'statusEnabled', DISABLED: 'statusDisabled',
    PUBLISHED: 'statusPublished', 'NEEDS-CONFIGURATION': 'statusNeedsConfiguration', UNAVAILABLE: 'statusUnavailable',
    AUTHORIZED: 'statusAuthorized', REQUIRED: 'statusRequired', EXPIRED: 'statusExpired',
    AVAILABLE: 'availabilityAvailable', PREPARING: 'availabilityPreparing',
    AUTHORIZATION_REQUIRED: 'availabilityAuthorizationRequired', INCOMPATIBLE: 'availabilityIncompatible',
    PREPARATION_FAILED: 'availabilityPreparationFailed',
    PERSONAL: 'scopePersonal', DEPARTMENT: 'scopeDepartment', COMPANY: 'scopeCompany',
    'STREAMABLE-HTTP': 'transportStreamableHttp', STDIO: 'transportStdio',
    'EMPLOYEE-BEARER': 'authEmployeeBearer', OAUTH: 'authOauth', NONE: 'authNone',
  }
  const key = CATEGORY_KEYS[value.toLocaleLowerCase()] ?? keys[value.toUpperCase()]
  return key === undefined ? value : t(key)
}

export function localizedCategory(value: string, t: (key: DeepSeekHarnessProductKey) => string): string {
  const key = CATEGORY_KEYS[value.toLocaleLowerCase()]
  return key === undefined ? t('categoryOther') : t(key)
}

export function itemMetadata(item: ProductItem, catalog: Catalog, t: (key: DeepSeekHarnessProductKey) => string): readonly string[] {
  if (catalog === 'connectors') {
    const readCount = item.tools.filter(tool => tool.access === 'READ').length
    const writeCount = item.tools.length - readCount
    const values = [
      readCount === 0 ? undefined : t('readCapabilityShort').replace('{count}', String(readCount)),
      writeCount === 0 ? undefined : t('writeCapabilityShort').replace('{count}', String(writeCount))]
    return [...new Set(values.filter((value): value is string => value !== undefined)
      .map(value => localizedMetadata(value, t)))]
  }
  const values = catalog === 'knowledge'
    ? [item.ownerName ?? item.scope, item.updatedAt === undefined ? undefined : `${t('updatedAtPrefix')}${formatDate(item.updatedAt)}`]
    : catalog === 'expertKits'
      ? [t('skillCount').replace('{count}', String(item.skillCount)),
        t('connectorCount').replace('{count}', String(item.connectorCount)),
        item.version === undefined ? undefined : `${t('versionPrefix')}${item.version}`]
      : [item.version === undefined ? undefined : `${t('versionPrefix')}${item.version}`]
  return [...new Set(values.filter((value): value is string => value !== undefined)
    .map(value => localizedMetadata(value, t)))]
}

export function referenceDetails(references: readonly string[], values: unknown, kind: 'connectors' | 'knowledge' = 'connectors', failed = false): readonly ProductReference[] {
  const catalog = items(values)
  return [...new Set(references)].map((reference) => {
    const match = catalog.find(item => item.id === reference || item.reference === reference)
    return match === undefined
      ? { id: reference, name: reference, available: false, kind, status: failed ? 'LOOKUP_FAILED' : 'NOT_FOUND' }
      : { id: match.id, name: match.label, available: match.availabilityStatus !== 'UNAVAILABLE', kind,
        ...(kind === 'connectors' ? { status: match.authorizationStatus
          ?? (isConnectorConnected(match) ? 'AUTHORIZED' : match.availabilityStatus ?? 'UNAVAILABLE') } : {}),
        ...(match.scope ? { scope: match.scope } : {}), ...(match.ownerName ? { ownerName: match.ownerName } : {}),
        ...(match.description === undefined ? {} : { description: match.description }) }
  })
}

/** Decode server reference outcomes without exposing denied resource details. */
export function knowledgeReferenceDetails(references: readonly string[], values: unknown, failed = false): readonly ProductReference[] {
  if (failed || !Array.isArray(values)) return referenceDetails(references, [], 'knowledge', true)
  const rows: readonly unknown[] = values
  const records = rows.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
  return [...new Set(references)].map((reference) => {
    const normalized = reference.replace(/^team:/, 'department:').replace(/^organization:/, 'company:')
    const value = records.find(entry => entry.reference === normalized)
    if (!value || value.status !== 'RESOLVED') return { id: reference, name: reference, kind: 'knowledge', available: false,
      status: typeof value?.status === 'string' ? value.status : 'LOOKUP_FAILED' }
    const base = items([value.base])[0]
    if (!base) return { id: reference, name: reference, kind: 'knowledge', available: false, status: 'LOOKUP_FAILED' }
    return { id: base.id, name: base.label, kind: 'knowledge', available: true,
      ...(base.scope ? { scope: base.scope } : {}), ...(base.ownerName ? { ownerName: base.ownerName } : {}) }
  })
}

export function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

export function normalizedSearch(item: ProductItem): string {
  return [item.label, item.description, item.author, item.category, item.version, item.status, item.scope, item.ownerName,
    item.transport, item.authMode, ...item.tools.flatMap(tool => [tool.name, tool.displayName, tool.description])]
    .filter((value): value is string => value !== undefined).join('\n').toLocaleLowerCase()
}

export function classificationValue(item: ProductItem, catalog: Catalog): string | undefined {
  return catalog === 'knowledge' ? item.scope : item.category
}

export function groupLabel(item: ProductItem, catalog: Catalog, t: (key: DeepSeekHarnessProductKey) => string): string {
  if (catalog === 'connectors') {
    return item.category === undefined ? t('otherConnectors') : localizedCategory(item.category, t)
  }
  if (catalog === 'knowledge' && item.scope === 'DEPARTMENT' && item.ownerName !== undefined) return `${t('scopeDepartment')} · ${item.ownerName} (${item.ownerDepartmentId ?? ''})`
  if (catalog === 'knowledge') return item.scope === undefined ? t('otherKnowledge') : localizedMetadata(item.scope, t)
  return item.category === undefined ? t('categoryOther') : localizedCategory(item.category, t)
}

export function localDetail(item: ProductItem): ProductDetail {
  return {
    id: item.id, name: item.label,
    ...(item.visibility ? { visibility: item.visibility } : {}),
    ...(item.canEdit === undefined ? {} : { canEdit: item.canEdit }),
    ...(item.canSubmit === undefined ? {} : { canSubmit: item.canSubmit }),
    ...(item.canDelete === undefined ? {} : { canDelete: item.canDelete }),
    ...(item.canRead === undefined ? {} : { canRead: item.canRead }),
    ...(item.canManage === undefined ? {} : { canManage: item.canManage }),
    ...(item.reviewStatus ? { reviewStatus: item.reviewStatus } : {}),
    ...(item.description === undefined ? {} : { summary: item.description }),
    ...(item.author === undefined ? {} : { author: item.author }),
    ...(item.category === undefined ? {} : { category: item.category }),
    ...(item.version === undefined ? {} : { version: item.version }),
    ...(item.status === undefined ? {} : { status: item.status }),
    ...(item.scope === undefined ? {} : { scope: item.scope }),
    ...Object.fromEntries(['companyId', 'ownerEmployeeId', 'ownerDepartmentId', 'ownerName'].flatMap(key => item[key as keyof ProductItem] === undefined ? [] : [[key, item[key as keyof ProductItem]]])),
    ...(item.transport === undefined ? {} : { transport: item.transport }),
    ...(item.authMode === undefined ? {} : { authMode: item.authMode }),
    ...(item.managed === undefined ? {} : { managed: item.managed }),
    ...(item.ready === undefined ? {} : { ready: item.ready }),
    ...(item.authorizationStatus === undefined ? {} : { authorizationStatus: item.authorizationStatus }),
    ...(item.availabilityStatus === undefined ? {} : { availabilityStatus: item.availabilityStatus }),
    tools: item.tools, triggers: item.triggers, skillDetails: [], connectorRefs: [], connectorDetails: [],
    requiredTools: [], knowledgeBaseRefs: [], knowledgeBaseDetails: [],
    ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
    ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
    commonTasks: [], readme: '', sourceAvailable: false,
  }
}

export function AvailabilityStatus({ status, t }: {
  readonly status: string | undefined
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  if (status === undefined) return null
  return <span className={css.availabilityStatus} data-status={status}>
    {status === 'AVAILABLE' && <IconCheckOutlineRegular size={12} />}
    {localizedMetadata(status, t)}
  </span>
}

/** Account connection state is independent of task selection and current server availability.
 * @param connector - Connector catalog metadata returned by the product server.
 * @returns Whether the device is configured and authorization or a managed connection is present.
 */
export function isConnectorConnected(connector: Pick<ProductItem, 'authMode' | 'authorizationStatus' | 'availabilityStatus' | 'status'>): boolean {
  if (connector.status === 'needs-configuration') return false
  if (connector.authorizationStatus !== undefined) return connector.authorizationStatus === 'AUTHORIZED'
  return connector.authMode !== 'oauth' && connector.availabilityStatus === 'AVAILABLE'
}

/** Show connector authorization and availability without implying task selection. */
export function ConnectorStatus({ connector, t }: {
  readonly connector: Pick<ProductItem, 'authorizationStatus' | 'availabilityStatus' | 'status'>
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const status = connector.status === 'needs-configuration' ? 'NEEDS-CONFIGURATION'
    : connector.authorizationStatus === 'EXPIRED' ? 'EXPIRED'
      : connector.authorizationStatus === 'REQUIRED' ? 'AUTHORIZATION_REQUIRED'
        : connector.availabilityStatus ?? (connector.authorizationStatus === 'AUTHORIZED' ? 'AVAILABLE' : undefined)
  if (status === undefined) return null
  return <span className={css.availabilityStatus} data-status={status}>
    {status === 'AVAILABLE' && <IconCheckOutlineRegular size={12} />}
    {status === 'AVAILABLE' ? t('connectorConnected')
      : status === 'AUTHORIZATION_REQUIRED' ? t('connectorAuthorizationRequired') : localizedMetadata(status, t)}
  </span>
}

export function unavailableForUse(status: string | undefined): boolean {
  return status === 'PREPARING' || status === 'INCOMPATIBLE' || status === 'UNAVAILABLE'
    || status === 'AUTHORIZATION_REQUIRED'
}

export function markdownLabels(t: (key: DeepSeekHarnessProductKey) => string) {
  return {
    code: { copyLabel: t('copy'), copiedLabel: t('copied'), toolbarLabels: {
      codeLabel: t('code'), wrapLabel: t('wrap'), unwrapLabel: t('unwrap'),
    } }, footnotes: t('footnotes'),
  }
}

export function DetailIdentity({ detail: product, icon: Icon, showVisibility = true, t }: {
  readonly detail: ProductDetail
  readonly icon: ComponentType<{ readonly size?: number }>
  readonly showVisibility?: boolean
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  return <header className={css.detailHeader}>
    <div className={css.detailLead}>
      <div className={css.detailArtwork}><Icon size={28} /></div>
      <div className={css.detailIdentity}>
        <div className={css.detailTitleLine}><h1>{product.name}</h1></div>
        <div className={css.detailMeta}>
          {product.version !== undefined && <span>{t('versionPrefix')}{product.version}</span>}
          {product.category !== undefined && <span>{localizedCategory(product.category, t)}</span>}
        </div>
        <div className={css.detailMeta}>
          {product.author !== undefined && <span>{product.author}</span>}
          {showVisibility && <span>{product.visibility === 'PERSONAL' ? t('personalExtension') : t('sharedExtension')}</span>}
        </div>
      </div>
    </div>
  </header>
}

export function ReferenceList({ values, t, showStatus = true, onOpen }: {
  readonly values: readonly ProductReference[]
  readonly showStatus?: boolean
  readonly onOpen?: (value: ProductReference) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  if (values.length === 0) return <p className={css.catalogStatus}>{t('none')}</p>
  return <ul className={css.referenceList}>{values.map(value => <li key={value.id}>
    <button type="button" className={css.referenceCopy} disabled={!onOpen || !value.available} onClick={() => { onOpen?.(value) }}>
      <strong>{value.name}</strong>{value.description !== undefined && <span>{value.description}</span>}
      {value.scope && <span>{localizedMetadata(value.scope, t)}{value.ownerName ? ` · ${value.ownerName}` : ''}</span>}
    </button>
    {showStatus && (value.status || !value.available) && <span className={css.referenceStatus} data-available={String(value.available)}>
      {value.status === 'LOOKUP_FAILED' ? t('referenceLookupFailed') : value.status === 'NOT_FOUND' ? t('referenceNotFound')
        : value.status === 'UNAUTHORIZED' ? t('referenceUnauthorized') : value.status === 'AMBIGUOUS' ? t('referenceAmbiguous')
          : value.status ? localizedMetadata(value.status, t) : t('statusUnavailable')}
    </span>}
  </li>)}</ul>
}

export function withoutFrontmatter(value: string, title?: string): string {
  const normalized = value.replaceAll('\r\n', '\n')
  const end = normalized.indexOf('\n---\n', 4)
  const body = normalized.startsWith('---\n') && end >= 0 ? normalized.slice(end + 5).trim() : normalized.trim()
  return title === undefined ? body : withoutDuplicateTitle(body, title)
}

export function withoutDuplicateTitle(value: string, title: string): string {
  const lines = value.split('\n')
  return lines[0]?.replace(/^#+\s+/u, '').trim() === title.trim() ? lines.slice(1).join('\n').trim() : value
}

export function Fact({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return <><dt>{label}</dt><dd>{value}</dd></>
}
