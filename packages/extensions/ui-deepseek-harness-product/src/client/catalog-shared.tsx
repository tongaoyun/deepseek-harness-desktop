import type { ComponentType, ReactNode } from 'react'
import { IconDatabaseOutlineRegular, IconLinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { type DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import type { ProductTaskCapabilities } from '@deepseek-harness/product/protocol'

export type Catalog = keyof typeof METHODS

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
  readonly canConfigure?: boolean
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
  readonly createdAt?: string
  readonly updatedAt?: string
}

export interface DeepSeekHarnessCatalogActions {
  readCapabilities?(this: void): Promise<ProductTaskCapabilities>
  subscribeTaskSelection?(this: void, listener: () => void): () => void
}

export type ProductDetail = {
  readonly canRead?: boolean
  readonly canManage?: boolean
  readonly visibility?: string
  readonly canEdit?: boolean
  readonly canSubmit?: boolean
  readonly canDelete?: boolean
  readonly canConfigure?: boolean
  readonly reviewStatus?: string
  readonly id: string
  readonly name: string
  readonly author?: string
  readonly version?: string
  readonly summary?: string
  readonly category?: string
  readonly sha256?: string
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
  readonly createdAt?: string
  readonly updatedAt?: string
}

export type CategoryFilter = string

export type ConnectorFilter = 'all' | 'connected'

export const METHODS = {
  connectors: 'connectors.list',
  knowledge: 'knowledge.bases.list',
} as const

export const DESCRIPTION_KEYS: Record<Catalog, DeepSeekHarnessProductKey> = {
  connectors: 'connectorsDescription',
  knowledge: 'knowledgeDescription',
}

export const ICONS: Record<Catalog, ComponentType<{ readonly size?: number }>> = {
  connectors: IconLinkOutlineRegular,
  knowledge: IconDatabaseOutlineRegular,
}

export const CATEGORY_KEYS: Readonly<Record<string, DeepSeekHarnessProductKey>> = {
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
      ...(typeof record.canConfigure === 'boolean' ? { canConfigure: record.canConfigure } : {}),
      ...(typeof record.canRead === 'boolean' ? { canRead: record.canRead } : {}),
      ...(typeof record.canManage === 'boolean' ? { canManage: record.canManage } : {}),
      tools: connectorTools(record.tools) }]
  })
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
  if (catalog === 'knowledge') return [item.ownerName ?? localizedMetadata(item.scope ?? '', t)]
  const read = item.tools.filter(tool => tool.access === 'READ').length
  return [t('readCapabilityShort').replace('{count}', String(read)), t('writeCapabilityShort').replace('{count}', String(item.tools.length - read))]
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
    ...(item.canConfigure === undefined ? {} : { canConfigure: item.canConfigure }),
    ...(item.transport === undefined ? {} : { transport: item.transport }),
    ...(item.authMode === undefined ? {} : { authMode: item.authMode }),
    ...(item.managed === undefined ? {} : { managed: item.managed }),
    ...(item.ready === undefined ? {} : { ready: item.ready }),
    ...(item.authorizationStatus === undefined ? {} : { authorizationStatus: item.authorizationStatus }),
    ...(item.availabilityStatus === undefined ? {} : { availabilityStatus: item.availabilityStatus }),
    tools: item.tools,
    ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
    ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
  }
}

/** Whether the connector has the account and device configuration needed to attempt a connection.
 * @param connector - Connector metadata; this does not probe the remote MCP service.
 * @returns Whether the connector is configured and available for connection attempts.
 */
export function isConnectorConfigured(connector: Pick<ProductItem, 'authMode' | 'authorizationStatus' | 'ready' | 'status'>): boolean {
  return connector.status === 'ready' && connector.ready !== false
    && (connector.authMode !== 'oauth' || connector.authorizationStatus === 'AUTHORIZED')
}

/** Display one actionable state without claiming the remote service has connected. */
export function ConnectorStatus({ connector, t }: {
  readonly connector: Pick<ProductItem, 'authMode' | 'authorizationStatus' | 'ready' | 'status'>
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const key: DeepSeekHarnessProductKey = connector.status === 'disabled' ? 'statusDisabled'
    : connector.status === 'unavailable' ? 'statusUnavailable'
      : connector.authMode === 'oauth' && connector.authorizationStatus !== 'AUTHORIZED'
        ? connector.authorizationStatus === 'EXPIRED' ? 'connectorAccountExpired' : 'connectorAccountRequired'
        : connector.status === 'needs-configuration' ? 'statusNeedsConfiguration'
          : isConnectorConfigured(connector) ? 'connectorConfigured' : 'statusUnavailable'
  return <span className={css.availabilityStatus} data-status={key === 'connectorConfigured' ? 'AVAILABLE'
    : key === 'connectorAccountRequired' || key === 'statusNeedsConfiguration' ? 'AUTHORIZATION_REQUIRED'
      : key === 'connectorAccountExpired' ? 'EXPIRED' : key === 'statusDisabled' ? 'DISABLED' : 'UNAVAILABLE'}>
    {t(key)}
  </span>
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

export function Fact({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return <><dt>{label}</dt><dd>{value}</dd></>
}
