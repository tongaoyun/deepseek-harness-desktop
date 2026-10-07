import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComponentType, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, IconAgentPresetOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular,
  IconDatabaseOutlineRegular, IconLinkOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular,
  IconSkillOutlineRegular, MarkdownText, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { NS, type DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'

type ProductSession = { readonly authenticated?: boolean }
type ProductApi = {
  invoke(method: string, payload?: unknown, requestId?: string): Promise<unknown>
  cancel(requestId: string): void
  getSession(): Promise<ProductSession>
  subscribe?(listener: (event: { readonly type: string }) => void): () => void
}
type ProductWindow = { deepseekHarness?: { product?: ProductApi } }
type Catalog = keyof typeof METHODS
type ConnectorTool = {
  readonly name: string
  readonly displayName: string
  readonly description?: string
  readonly access: 'READ' | 'WRITE'
}
type ProductItem = {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly author?: string
  readonly category?: string
  readonly version?: string
  readonly status?: string
  readonly scope?: string
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
  startExpertKit(id: string, prompt?: string): Promise<void>
  useSkill(skillId: string, skillName: string): Promise<void>
}
type ProductDetail = {
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
  readonly requiredTools: readonly string[]
  readonly knowledgeBaseRefs: readonly string[]
  readonly minimumDesktopVersion?: string
  readonly createdAt?: string
  readonly updatedAt?: string
}
type CommonTask = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly prompt: string
}
type CategoryFilter = string

const METHODS = {
  expertKits: 'expertKits.list',
  skills: 'skills.list',
  connectors: 'connectors.list',
  knowledge: 'knowledge.bases.list',
} as const

const DESCRIPTION_KEYS: Record<Catalog, DeepSeekHarnessProductKey> = {
  expertKits: 'expertKitsDescription',
  skills: 'skillsDescription',
  connectors: 'connectorsDescription',
  knowledge: 'knowledgeDescription',
}

const ICONS: Record<Catalog, ComponentType<{ readonly size?: number }>> = {
  expertKits: IconAgentPresetOutlineRegular,
  skills: IconSkillOutlineRegular,
  connectors: IconLinkOutlineRegular,
  knowledge: IconDatabaseOutlineRegular,
}

const CATEGORY_KEYS: Readonly<Record<string, DeepSeekHarnessProductKey>> = {
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

let productRequestSequence = 0
const AUTHORIZATION_TIMEOUT_MS = 60_000
const AUTHORIZATION_POLL_INTERVAL_MS = 1_000

function nextProductRequestId(): string {
  productRequestSequence += 1
  return `deepseek-harness-ui-${Date.now().toString(36)}-${productRequestSequence.toString(36)}`
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
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

function productApi(): ProductApi | undefined {
  return (globalThis as ProductWindow).deepseekHarness?.product
}

function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function stringList(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function connectorTools(value: unknown): readonly ConnectorTool[] {
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

function skillDetails(value: unknown): ProductDetail['skillDetails'] {
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

function items(value: unknown): readonly ProductItem[] {
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
      ['author', 'category', 'version', 'status', 'scope', 'transport', 'authMode', 'availabilityStatus', 'createdAt', 'updatedAt'].flatMap((key) => {
        const value = text(record, key)
        return value === undefined ? [] : [[key, value]]
      }),
    )
    return [{ id, label, ...(description === undefined ? {} : { description }), ...metadata,
      ...(typeof record.managed === 'boolean' ? { managed: record.managed } : {}),
      ...(typeof record.ready === 'boolean' ? { ready: record.ready } : {}),
      ...(authorizationStatus === undefined ? {} : { authorizationStatus }),
      tools: connectorTools(record.tools) }]
  })
}

function commonTasks(value: unknown): readonly CommonTask[] {
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

function detail(value: unknown, readmeValue: unknown): ProductDetail | undefined {
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
    ...(author === undefined ? {} : { author }),
    ...(version === undefined ? {} : { version }),
    ...(summary === undefined ? {} : { summary }),
    ...(category === undefined ? {} : { category }),
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(status === undefined ? {} : { status }),
    ...(scope === undefined ? {} : { scope }),
    ...(transport === undefined ? {} : { transport }),
    ...(authMode === undefined ? {} : { authMode }),
    ...(typeof record.managed === 'boolean' ? { managed: record.managed } : {}),
    ...(typeof record.ready === 'boolean' ? { ready: record.ready } : {}),
    ...(authorizationStatus === undefined ? {} : { authorizationStatus }),
    ...(availabilityStatus === undefined ? {} : { availabilityStatus }),
    tools: connectorTools(record.tools), triggers: stringList(record, 'triggers'),
    skillDetails: skillDetails(record.skillDetails), connectorRefs: stringList(record, 'connectorRefs'),
    requiredTools: stringList(record, 'requiredTools'), knowledgeBaseRefs: stringList(record, 'knowledgeBaseRefs'),
    ...(minimumDesktopVersion === undefined ? {} : { minimumDesktopVersion }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    commonTasks: commonTasks(record.commonTasks),
    readme: text(readmeRecord, 'readme') ?? '', sourceAvailable,
  }
}

function localizedMetadata(value: string, t: (key: DeepSeekHarnessProductKey) => string): string {
  const keys: Record<string, DeepSeekHarnessProductKey> = {
    ACTIVE: 'statusActive', READY: 'statusReady', ENABLED: 'statusEnabled', DISABLED: 'statusDisabled',
    PUBLISHED: 'statusPublished', 'NEEDS-CONFIGURATION': 'statusNeedsConfiguration', UNAVAILABLE: 'statusUnavailable',
    AUTHORIZED: 'statusAuthorized', REQUIRED: 'statusRequired', EXPIRED: 'statusExpired',
    AVAILABLE: 'availabilityAvailable', PREPARING: 'availabilityPreparing',
    AUTHORIZATION_REQUIRED: 'availabilityAuthorizationRequired', INCOMPATIBLE: 'availabilityIncompatible',
    PREPARATION_FAILED: 'availabilityPreparationFailed',
    PERSONAL: 'scopePersonal', TEAM: 'scopeTeam', ORGANIZATION: 'scopeOrganization',
    'STREAMABLE-HTTP': 'transportStreamableHttp', STDIO: 'transportStdio',
    'EMPLOYEE-BEARER': 'authEmployeeBearer', OAUTH: 'authOauth', NONE: 'authNone',
  }
  const key = CATEGORY_KEYS[value.toLocaleLowerCase()] ?? keys[value.toUpperCase()]
  return key === undefined ? value : t(key)
}

function localizedCategory(value: string, t: (key: DeepSeekHarnessProductKey) => string): string {
  const key = CATEGORY_KEYS[value.toLocaleLowerCase()]
  return key === undefined ? t('categoryOther') : t(key)
}

function itemMetadata(item: ProductItem, catalog: Catalog, t: (key: DeepSeekHarnessProductKey) => string): readonly string[] {
  if (catalog === 'connectors') {
    const tools = item.tools.length === 0
      ? t('connectorNoTools')
      : t('connectorToolsCount').replace('{count}', String(item.tools.length))
    const values = [item.availabilityStatus, item.authMode, tools]
    return [...new Set(values.filter((value): value is string => value !== undefined)
      .map(value => localizedMetadata(value, t)))]
  }
  const values = catalog === 'knowledge'
    ? [item.scope, item.updatedAt === undefined ? undefined : `${t('updatedAtPrefix')}${formatDate(item.updatedAt)}`]
    : [item.availabilityStatus, item.version === undefined ? undefined : `${t('versionPrefix')}${item.version}`, item.author]
  return [...new Set(values.filter((value): value is string => value !== undefined)
    .map(value => localizedMetadata(value, t)))]
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

function normalizedSearch(item: ProductItem): string {
  return [item.label, item.description, item.author, item.category, item.version, item.status, item.scope,
    item.transport, item.authMode, ...item.tools.flatMap(tool => [tool.name, tool.displayName, tool.description])]
    .filter((value): value is string => value !== undefined).join('\n').toLocaleLowerCase()
}

function classificationValue(item: ProductItem, catalog: Catalog): string | undefined {
  return catalog === 'knowledge' ? item.scope : item.category
}

function groupLabel(item: ProductItem, catalog: Catalog, t: (key: DeepSeekHarnessProductKey) => string): string {
  if (catalog === 'connectors') {
    return item.category === undefined ? t('otherConnectors') : localizedCategory(item.category, t)
  }
  if (catalog === 'knowledge') return item.scope === undefined ? t('otherKnowledge') : localizedMetadata(item.scope, t)
  return item.category === undefined ? t('categoryOther') : localizedCategory(item.category, t)
}

function localDetail(item: ProductItem): ProductDetail {
  return {
    id: item.id, name: item.label,
    ...(item.description === undefined ? {} : { summary: item.description }),
    ...(item.author === undefined ? {} : { author: item.author }),
    ...(item.category === undefined ? {} : { category: item.category }),
    ...(item.version === undefined ? {} : { version: item.version }),
    ...(item.status === undefined ? {} : { status: item.status }),
    ...(item.scope === undefined ? {} : { scope: item.scope }),
    ...(item.transport === undefined ? {} : { transport: item.transport }),
    ...(item.authMode === undefined ? {} : { authMode: item.authMode }),
    ...(item.managed === undefined ? {} : { managed: item.managed }),
    ...(item.ready === undefined ? {} : { ready: item.ready }),
    ...(item.authorizationStatus === undefined ? {} : { authorizationStatus: item.authorizationStatus }),
    ...(item.availabilityStatus === undefined ? {} : { availabilityStatus: item.availabilityStatus }),
    tools: item.tools, triggers: [], skillDetails: [], connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [],
    ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
    ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
    commonTasks: [], readme: '', sourceAvailable: false,
  }
}

type CatalogSectionProps = PropsRuntime<'main'> & PropsLocale<typeof NS> & DeepSeekHarnessCatalogActions & {
  readonly catalog: Catalog
  readonly labelKey: DeepSeekHarnessProductKey
}

/** Main-panel content for one DeepSeekHarness product directory. */
export function DeepSeekHarnessCatalogSection(props: CatalogSectionProps): ReactNode {
  const { catalog, labelKey } = props
  const t = (key: DeepSeekHarnessProductKey): string => props.t(key)
  const [entries, setEntries] = useState<readonly ProductItem[]>([])
  const [loading, setLoading] = useState(true)
  const [authRequired, setAuthRequired] = useState(false)
  const [authPending, setAuthPending] = useState(false)
  const [authError, setAuthError] = useState(false)
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string>()
  const [selected, setSelected] = useState<ProductDetail>()
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  const [actionError, setActionError] = useState(false)
  const generation = useRef(0)
  const activeRequests = useRef(new Map<string, ProductApi>())

  const cancelReads = (): number => {
    generation.current += 1
    for (const [requestId, api] of activeRequests.current) api.cancel(requestId)
    activeRequests.current.clear()
    return generation.current
  }

  const read = async (api: ProductApi, method: string, payload?: unknown, timeoutMs?: number): Promise<unknown> => {
    const requestId = nextProductRequestId()
    activeRequests.current.set(requestId, api)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const request = api.invoke(method, payload, requestId)
      if (timeoutMs === undefined) return await request
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try { api.cancel(requestId) }
          finally { reject(new Error('authorization request timed out')) }
        }, timeoutMs)
      })
      return await Promise.race([request, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      activeRequests.current.delete(requestId)
    }
  }

  const refresh = async (force = false): Promise<void> => {
    const currentGeneration = cancelReads()
    const api = productApi()
    if (api === undefined) {
      setError(t('unavailable'))
      setLoading(false)
      return
    }
    setLoading(true)
    setError(undefined)
    setAuthError(false)
    try {
      const session = await api.getSession()
      if (session.authenticated !== true) {
        setAuthRequired(true)
        setEntries([])
        return
      }
      setAuthRequired(false)
      if (force) await read(api, 'catalog.refresh')
      const catalogValue = await read(api, METHODS[catalog])
      if (currentGeneration !== generation.current) return
      setEntries(items(catalogValue))
    } catch {
      if (currentGeneration !== generation.current) return
      const session = await api.getSession().catch(() => undefined)
      if (currentGeneration !== generation.current) return
      if (session?.authenticated !== true) {
        setAuthRequired(true)
        setEntries([])
        setError(undefined)
      } else {
        setError(t('loadFailed'))
      }
    } finally {
      if (currentGeneration === generation.current) setLoading(false)
    }
  }

  const signIn = async (): Promise<void> => {
    const api = productApi()
    if (api === undefined || authPending) return
    setAuthPending(true)
    setAuthError(false)
    try {
      await read(api, 'auth.ensureDingTalk', undefined, AUTHORIZATION_TIMEOUT_MS)
      await refresh()
    } catch {
      setAuthError(true)
    } finally {
      setAuthPending(false)
    }
  }

  useEffect(() => {
    setQuery('')
    setCategoryFilter('all')
    setCategoryMenuOpen(false)
    setSelectedId(undefined)
    setSelected(undefined)
    void refresh()
    return () => { cancelReads() }
  }, [catalog])

  useEffect(() => {
    const api = productApi()
    if (api?.subscribe === undefined) return
    return api.subscribe((event) => {
      if (event.type === 'catalog.changed' || event.type === 'session.changed') void refresh()
    })
  }, [catalog])

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return entries.filter(entry => (needle === '' || normalizedSearch(entry).includes(needle))
      && (categoryFilter === 'all' || classificationValue(entry, catalog) === categoryFilter))
  }, [catalog, categoryFilter, entries, query])

  const classificationLabel = (value: string): string => catalog === 'knowledge'
    ? localizedMetadata(value, t)
    : localizedCategory(value, t)

  const categories = useMemo(() => {
    return [...new Set(entries.map(entry => classificationValue(entry, catalog))
      .filter((value): value is string => value !== undefined))]
      .sort((left, right) => classificationLabel(left).localeCompare(classificationLabel(right)))
  }, [catalog, entries])

  useEffect(() => {
    if (categoryFilter !== 'all' && !categories.includes(categoryFilter)) setCategoryFilter('all')
  }, [categories, categoryFilter])

  const groupedEntries = useMemo(() => {
    const groups = new Map<string, ProductItem[]>()
    for (const entry of filteredEntries) {
      const label = groupLabel(entry, catalog, t)
      const group = groups.get(label) ?? []
      group.push(entry)
      groups.set(label, group)
    }
    const values = [...groups.entries()]
    return catalog === 'expertKits' || catalog === 'skills'
      ? values.sort(([left], [right]) => left.localeCompare(right))
      : values
  }, [catalog, filteredEntries])

  const closeDetail = (): void => {
    cancelReads()
    setSelectedId(undefined)
    setSelected(undefined)
    setDetailLoading(false)
    setDetailError(false)
    setActionError(false)
  }

  useEffect(() => {
    if (selectedId === undefined) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeDetail()
    }
    globalThis.addEventListener('keydown', closeOnEscape)
    return () => { globalThis.removeEventListener('keydown', closeOnEscape) }
  }, [selectedId])

  const openDetail = async (id: string): Promise<void> => {
    const api = productApi()
    if (api === undefined) return
    cancelReads()
    setSelectedId(id)
    setSelected(undefined)
    setDetailLoading(true)
    setDetailError(false)
    setActionError(false)
    const currentGeneration = generation.current
    if (catalog !== 'expertKits' && catalog !== 'skills') {
      const entry = entries.find(candidate => candidate.id === id)
      if (entry !== undefined) setSelected(localDetail(entry))
      setDetailLoading(false)
      return
    }
    try {
      const prefix = catalog === 'expertKits' ? 'expertKits' : 'skills'
      const [metadata, readme] = await Promise.allSettled([
        read(api, `${prefix}.get`, { id }), read(api, `${prefix}.readme`, { id }),
      ])
      if (currentGeneration !== generation.current) return
      if (metadata.status === 'rejected') throw metadata.reason
      const parsed = detail(metadata.value, readme.status === 'fulfilled' ? readme.value : undefined)
      if (parsed === undefined) throw new Error('invalid product detail')
      const availabilityStatus = entries.find(entry => entry.id === id)?.availabilityStatus
      setSelected(availabilityStatus === undefined ? parsed : { ...parsed, availabilityStatus })
    } catch {
      if (currentGeneration !== generation.current) return
      setDetailError(true)
    } finally {
      if (currentGeneration === generation.current) setDetailLoading(false)
    }
  }

  const useProduct = async (product: ProductDetail, task?: CommonTask): Promise<void> => {
    setActionPending(true)
    setActionError(false)
    try {
      if (catalog === 'skills') await props.useSkill(product.id, product.name)
      else if (catalog === 'expertKits') await props.startExpertKit(product.id, task?.prompt)
    } catch {
      setActionError(true)
    } finally {
      setActionPending(false)
    }
  }

  const Icon = ICONS[catalog]
  const showCatalogControls = loading || (!authRequired && error === undefined)
  const categoryItems = [
    { id: 'all', label: t('allCategories') },
    ...categories.map(category => ({ id: category, label: classificationLabel(category) })),
  ]
  const selectedCategoryLabel = categoryFilter === 'all'
    ? t('allCategories')
    : classificationLabel(categoryFilter)

  return <section className={css.catalogPage} aria-label={t(labelKey)}>
    <div className={css.catalogScroll}>
      <div className={css.catalogContent}>
        <header className={css.catalogHeader}>
          <div><h1 className={css.catalogTitle}>{t(labelKey)}</h1>
            <p className={css.catalogDescription}>{t(DESCRIPTION_KEYS[catalog])}</p></div>
        </header>
        {showCatalogControls && <div className={css.catalogToolbar}>
          <label className={css.searchField}>
            <IconSearchOutlineRegular size={16} />
            <span className={css.visuallyHidden}>{t('search')}</span>
            <input value={query} onChange={(event) => { setQuery(event.currentTarget.value) }}
              placeholder={t('searchPlaceholder')} type="search" />
          </label>
          {categories.length > 0 && <Menu open={categoryMenuOpen} items={categoryItems}
            selectedId={categoryFilter} portal align="end" compact className={css.categoryMenu}
            listClassName={css.categoryMenuList}
            onSelect={(id) => { setCategoryFilter(id); setCategoryMenuOpen(false) }}
            onClose={() => { setCategoryMenuOpen(false) }}
            anchor={<button className={css.categoryButton} type="button" aria-label={t('categoryFilter')}
              aria-expanded={categoryMenuOpen} onClick={() => { setCategoryMenuOpen(value => !value) }}>
              <span>{selectedCategoryLabel}</span><IconChevronDownOutlineRegular size={14} />
            </button>} />}
          <Tooltip portal label={t('refresh')} side="bottom" delayMs={500}>
            <button className={css.iconButton} type="button" disabled={loading} aria-label={t('refresh')}
              onClick={() => { void refresh(true) }}><IconRefreshOutlineRegular size={16} /></button>
          </Tooltip>
        </div>}
        {!loading && error === undefined && !authRequired && <div className={css.resultSummary}>
          {t('itemCount').replace('{count}', String(filteredEntries.length))}
        </div>}
        <div id="deepseek-harness-catalog-results">
          {loading && <p className={css.catalogStatus} role="status">{t('loading')}</p>}
          {!loading && authRequired && <div className={css.authEmptyState} role="status" aria-live="polite">
            <span className={css.authEmptyIcon} aria-hidden="true"><Icon size={22} /></span>
            <div className={css.authEmptyCopy}>
              <strong>{authPending ? t('authWaiting') : authError ? t('authFailedTitle') : t('authTitle')}</strong>
              <span>{t('authRequired')}</span>
              {authError && <span className={css.catalogError} role="alert">{t('signInFailed')}</span>}
            </div>
            <Button className={css.authAction} variant="primary" size="sm" disabled={authPending}
              aria-busy={authPending} onClick={() => { void signIn() }}>
              {authPending ? t('signingIn') : t('signIn')}
            </Button>
          </div>}
          {!loading && error !== undefined && <p className={css.catalogError} role="alert">{error}</p>}
          {!loading && error === undefined && !authRequired && (filteredEntries.length === 0
            ? <p className={css.catalogStatus}>{query === '' ? t('empty') : t('noSearchResults')}</p>
            : groupedEntries.map(([group, groupItems]) => <section className={css.catalogGroup}
              aria-label={group === '' ? undefined : group} key={group || 'all'}>
              {group !== '' && <h2 className={css.groupTitle}>{group}<span>{groupItems.length}</span></h2>}
              <ul className={css.catalogList}>{groupItems.map(entry => <li className={css.catalogRow} key={entry.id}>
                <span className={css.catalogArtwork} aria-hidden="true"><Icon size={20} /></span>
                <button className={css.catalogItem} type="button" disabled={detailLoading}
                  onClick={() => { void openDetail(entry.id) }}>
                  <CatalogItemCopy entry={entry} catalog={catalog} t={t} />
                  <IconChevronRightOutlineRegular size={16} />
                </button>
              </li>)}</ul>
            </section>))}
        </div>
      </div>
    </div>
    {selectedId !== undefined && <div className={css.drawerBackdrop} onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeDetail()
    }}>
      <aside className={css.detailDrawer} role="dialog" aria-modal="true"
        aria-label={selected?.name ?? t('details')}>
        <div className={css.drawerBar}><span>{t('details')}</span>
          <Tooltip portal label={t('close')} side="bottom" delayMs={500}>
            <button className={css.iconButton} type="button" onClick={closeDetail} aria-label={t('close')}>
              <IconCloseOutlineRegular size={16} />
            </button>
          </Tooltip>
        </div>
        {detailLoading && <p className={css.drawerStatus} role="status">{t('loading')}</p>}
        {!detailLoading && detailError && <p className={css.drawerStatusError} role="alert">{t('detailFailed')}</p>}
        {selected !== undefined && <CatalogDetail catalog={catalog} detail={selected}
          actionPending={actionPending} actionError={actionError}
          onUse={(task) => { void useProduct(selected, task) }}
          onCatalogChanged={async () => { closeDetail() }} t={t} />}
      </aside>
    </div>}
  </section>
}

function CatalogItemCopy({ catalog, entry, t }: {
  readonly catalog: Catalog
  readonly entry: ProductItem
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const metadata = itemMetadata(entry, catalog, t)
  return <span className={css.catalogItemCopy}>
    <span className={css.itemTitle}>{entry.label}</span>
    {entry.description !== undefined && <span className={css.itemDescription}>{entry.description}</span>}
    {metadata.length > 0 && <span className={css.itemMetadata}>{metadata.map(value =>
      <span key={value}>{value}</span>)}</span>}
  </span>
}

function CatalogDetail({ actionError, actionPending, catalog, detail: product, onUse, onCatalogChanged, t }: {
  readonly catalog: Catalog
  readonly detail: ProductDetail
  readonly onUse: (task?: CommonTask) => void
  readonly actionPending: boolean
  readonly actionError: boolean
  readonly onCatalogChanged: () => Promise<void>
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const skill = catalog === 'skills'
  const expertKit = catalog === 'expertKits'
  const connector = catalog === 'connectors'
  const Icon = skill ? IconSkillOutlineRegular
    : catalog === 'expertKits' ? IconAgentPresetOutlineRegular
      : catalog === 'connectors' ? IconLinkOutlineRegular : IconDatabaseOutlineRegular
  const markdownLabels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied'), toolbarLabels: {
      codeLabel: t('code'), wrapLabel: t('wrap'), unwrapLabel: t('unwrap'),
    } }, footnotes: t('footnotes'),
  }), [t])
  const skillGuide = withoutFrontmatter(product.readme, product.name)
  const actionDisabled = actionPending || product.availabilityStatus === 'PREPARING'
    || product.availabilityStatus === 'INCOMPATIBLE' || product.availabilityStatus === 'UNAVAILABLE'
    || product.availabilityStatus === 'AUTHORIZATION_REQUIRED'
  return <article className={css.detailContent}>
    <header className={css.detailHeader}>
      <div className={css.detailLead}>
        <div className={css.detailArtwork}><Icon size={28} /></div>
        <div className={css.detailIdentity}>
          <div className={css.detailTitleLine}><h1>{product.name}</h1></div>
          <div className={css.detailMeta}>
            {product.version !== undefined && <span>{t('versionPrefix')}{product.version}</span>}
            {product.category !== undefined && <span>{localizedCategory(product.category, t)}</span>}
            {product.author !== undefined && <span>{product.author}</span>}
          </div>
        </div>
      </div>
      {skill
        ? <Button variant="primary" size="sm" disabled={actionDisabled} onClick={() => { onUse() }}>
          {actionPending ? t('starting') : product.availabilityStatus === 'PREPARATION_FAILED' ? t('retry') : t('useSkill')}
        </Button>
        : expertKit
          ? <Button variant="primary" size="sm" disabled={actionDisabled} onClick={() => { onUse() }}>
            {actionPending ? t('starting') : product.availabilityStatus === 'PREPARATION_FAILED' ? t('retry') : t('startUsing')}
          </Button>
          : <span className={css.detailState}>{connector ? t('connectorDetails') : t('knowledgeDetails')}</span>}
    </header>
    {actionError && <p className={css.catalogError} role="alert">{t('useFailed')}</p>}
    {product.summary !== undefined && <p className={css.detailSummary}>{product.summary}</p>}
    {skill
      ? <>
        {product.triggers.length > 0 && <section className={css.detailSection}>
          <h2>{t('applicableScenarios')}</h2>
          <ul className={css.detailToolList}>{product.triggers.map(trigger => <li key={trigger}><span>{trigger}</span></li>)}</ul>
        </section>}
        <section className={css.detailSection}>
          <h2>{t('usageGuide')}</h2>
          {!product.sourceAvailable ? <p className={css.catalogStatus}>{t('sourceUnavailable')}</p>
            : skillGuide === '' ? <p className={css.catalogStatus}>{t('noGuide')}</p>
              : <div className={css.markdown}><MarkdownText text={skillGuide} labels={markdownLabels} /></div>}
        </section>
        {product.sourceAvailable && <details className={css.sourcePanel}>
          <summary>{t('viewSource')}</summary><div className={css.sourceRule} /><pre>{product.readme}</pre>
        </details>}
      </>
      : expertKit
        ? <>
          <section className={css.detailSection}>
            <h2>{t('kitContents')}</h2>
            <dl className={css.detailFacts}>
              {product.minimumDesktopVersion !== undefined
                && <Fact label={t('minimumDesktopVersion')} value={product.minimumDesktopVersion} />}
              <Fact label={t('includedSkills')} value={product.skillDetails.length === 0
                ? t('none') : product.skillDetails.map(skill => skill.name).join('、')} />
              <Fact label={t('dataConnections')} value={product.connectorRefs.length === 0
                ? t('none') : product.connectorRefs.join('、')} />
              <Fact label={t('knowledgeScope')} value={product.knowledgeBaseRefs.length === 0
                ? t('none') : product.knowledgeBaseRefs.join('、')} />
              <Fact label={t('toolPermissions')} value={product.requiredTools.length === 0
                ? t('readOnlyCapability') : t('containsWriteCapability')} />
            </dl>
          </section>
          <section className={css.detailSection}>
            <h2>{t('commonTasks')} <span>{product.commonTasks.length}</span></h2>
            {product.commonTasks.length === 0 ? <p className={css.catalogStatus}>{t('empty')}</p>
              : <div className={css.commandList}>{product.commonTasks.map(task =>
                <button className={css.commandRow} disabled={actionPending} key={task.id}
                  type="button" onClick={() => { onUse(task) }}>
                  <span className={css.commandCopy}><strong>{task.name}</strong><span>{task.description}</span></span>
                  <IconChevronRightOutlineRegular size={16} />
                </button>)}</div>}
          </section>
          <section className={css.detailSection}>
            <h2>{t('kitGuide')}</h2>
            {!product.sourceAvailable ? <p className={css.catalogStatus}>{t('sourceUnavailable')}</p>
              : product.readme === '' ? <p className={css.catalogStatus}>{t('noGuide')}</p>
                : <div className={css.markdown}><MarkdownText text={product.readme} labels={markdownLabels} /></div>}
          </section>
        </>
        : connector
          ? <ConnectorDetail product={product} onCatalogChanged={onCatalogChanged} t={t} />
          : <KnowledgeDetail product={product} t={t} />}
  </article>
}

function ConnectorDetail({ product, onCatalogChanged, t }: {
  readonly product: ProductDetail
  readonly onCatalogChanged: () => Promise<void>
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [authorizationPending, setAuthorizationPending] = useState(false)
  const [authorizationError, setAuthorizationError] = useState(false)
  const mounted = useRef(true)
  const authorizationAbort = useRef<AbortController>()
  const activeRequests = useRef(new Map<string, ProductApi>())
  const managedAuthorization = product.authMode === 'oauth'
  useEffect(() => () => {
    mounted.current = false
    authorizationAbort.current?.abort()
    for (const [requestId, api] of activeRequests.current) api.cancel(requestId)
    activeRequests.current.clear()
  }, [])
  const invoke = async (api: ProductApi, method: string): Promise<unknown> => {
    const requestId = nextProductRequestId()
    activeRequests.current.set(requestId, api)
    try {
      return await api.invoke(method, { id: product.id }, requestId)
    } finally {
      activeRequests.current.delete(requestId)
    }
  }
  const authorize = async (): Promise<void> => {
    const api = productApi()
    if (api === undefined || authorizationPending) return
    const controller = new AbortController()
    authorizationAbort.current = controller
    setAuthorizationPending(true)
    setAuthorizationError(false)
    try {
      await invoke(api, 'connectors.authorization.begin')
      const expiresAt = Date.now() + AUTHORIZATION_TIMEOUT_MS
      while (Date.now() < expiresAt) {
        await abortableDelay(AUTHORIZATION_POLL_INTERVAL_MS, controller.signal)
        const value = await invoke(api, 'connectors.authorization.status')
        const status = typeof value === 'object' && value !== null && !Array.isArray(value)
          ? text(value as Record<string, unknown>, 'status') : undefined
        if (status === 'AUTHORIZED') { await onCatalogChanged(); return }
        if (status === 'EXPIRED' || status === 'REQUIRED') break
      }
      throw new Error('data connection authorization did not complete')
    } catch {
      if (!controller.signal.aborted && mounted.current) setAuthorizationError(true)
    } finally {
      if (authorizationAbort.current === controller) authorizationAbort.current = undefined
      if (mounted.current) setAuthorizationPending(false)
    }
  }
  const revoke = async (): Promise<void> => {
    const api = productApi()
    if (api === undefined || authorizationPending) return
    setAuthorizationPending(true)
    setAuthorizationError(false)
    try {
      await invoke(api, 'connectors.authorization.revoke')
      await onCatalogChanged()
    } catch {
      if (mounted.current) setAuthorizationError(true)
    } finally {
      if (mounted.current) setAuthorizationPending(false)
    }
  }
  return <>
    <section className={css.detailSection}>
      <h2>{t('connectorConfiguration')}</h2>
      <dl className={css.detailFacts}>
        {product.status !== undefined && <Fact label={t('status')} value={localizedMetadata(product.status, t)} />}
        {product.transport !== undefined && <Fact label={t('transport')} value={localizedMetadata(product.transport, t)} />}
        {product.authMode !== undefined && <Fact label={t('authMode')} value={localizedMetadata(product.authMode, t)} />}
        {product.authorizationStatus !== undefined
          && <Fact label={t('authorizationStatus')} value={localizedMetadata(product.authorizationStatus, t)} />}
        {product.scope !== undefined && <Fact label={t('scope')} value={localizedMetadata(product.scope, t)} />}
      </dl>
      {managedAuthorization && <div className={css.detailActions}>
        {product.authorizationStatus === 'AUTHORIZED'
          ? <Button variant="outline" size="sm" disabled={authorizationPending} onClick={() => { void revoke() }}>
            {authorizationPending ? t('authorizationWorking') : t('revokeAuthorization')}
          </Button>
          : <Button variant="primary" size="sm" disabled={authorizationPending} onClick={() => { void authorize() }}>
            {authorizationPending ? t('authorizationWaiting')
              : product.authorizationStatus === 'EXPIRED' ? t('reauthorize') : t('authorize')}
          </Button>}
        {authorizationError && <span className={css.catalogError} role="alert">{t('authorizationFailed')}</span>}
      </div>}
    </section>
    <section className={css.detailSection}>
      <h2>{t('connectorTools')} <span>{product.tools.length}</span></h2>
      {product.tools.length === 0 ? <p className={css.catalogStatus}>{t('empty')}</p>
        : <ul className={css.detailToolList}>{product.tools.map(tool =>
          <li key={tool.name}><span><strong>{tool.displayName}</strong>
            {tool.description !== undefined && <small>{tool.description}</small>}</span><span className={css.toolPermission}>
            {tool.access === 'READ' ? t('readOnlyNoApproval') : t('writeApprovalRequired')}
          </span></li>)}</ul>}
    </section>
    {product.tools.length > 0 && <details className={css.sourcePanel}>
      <summary>{t('advancedInformation')}</summary><div className={css.sourceRule} />
      <dl className={css.detailFacts}>{product.tools.map(tool =>
        <Fact key={tool.name} label={tool.displayName} value={tool.name} />)}</dl>
    </details>}
  </>
}

function withoutFrontmatter(value: string, title: string): string {
  if (!value.startsWith('---\n') && !value.startsWith('---\r\n')) return withoutDuplicateTitle(value.trim(), title)
  const normalized = value.replaceAll('\r\n', '\n')
  const end = normalized.indexOf('\n---\n', 4)
  return withoutDuplicateTitle(end < 0 ? normalized.trim() : normalized.slice(end + 5).trim(), title)
}

function withoutDuplicateTitle(value: string, title: string): string {
  const lines = value.split('\n')
  return lines[0]?.replace(/^#+\s+/u, '').trim() === title.trim() ? lines.slice(1).join('\n').trim() : value
}

function KnowledgeDetail({ product, t }: {
  readonly product: ProductDetail
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<readonly KnowledgeSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const search = async (): Promise<void> => {
    const value = query.trim()
    const api = productApi()
    if (value === '' || api === undefined || searching) return
    setSearching(true)
    setSearchError(false)
    try {
      const response = await api.invoke('knowledge.search', {
        query: value, knowledgeBaseIds: [product.id], knowledgeBaseRefs: [], limit: 8,
      })
      setResults(searchResults(response))
    } catch {
      setResults([])
      setSearchError(true)
    } finally {
      setSearching(false)
    }
  }
  return <section className={css.detailSection}>
    <h2>{t('knowledgeAccess')}</h2>
    <dl className={css.detailFacts}>
      {product.scope !== undefined && <Fact label={t('scope')} value={localizedMetadata(product.scope, t)} />}
      {product.updatedAt !== undefined && <Fact label={t('updatedAt')} value={formatDate(product.updatedAt)} />}
      {product.createdAt !== undefined && <Fact label={t('createdAt')} value={formatDate(product.createdAt)} />}
    </dl>
    <p className={css.detailHint}>{t('knowledgeSearchHint')}</p>
    <div className={css.knowledgeSearch}>
      <label className={css.searchField}>
        <IconSearchOutlineRegular size={16} />
        <span className={css.visuallyHidden}>{t('knowledgeSearch')}</span>
        <input value={query} onChange={(event) => { setQuery(event.currentTarget.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') void search() }}
          placeholder={t('knowledgeSearchPlaceholder')} type="search" />
      </label>
      <Button variant="outline" size="sm" disabled={searching || query.trim() === ''} onClick={() => { void search() }}>
        {searching ? t('searching') : t('search')}
      </Button>
    </div>
    {searchError && <p className={css.catalogError} role="alert">{t('searchFailed')}</p>}
    {results.length > 0 && <div className={css.knowledgeResults} aria-label={t('searchResults')}>
      {results.map((result, index) => <article className={css.knowledgeResult} key={`${result.sourceId}-${String(index)}`}>
        <strong>{result.filename ?? result.knowledgeBaseName ?? t('knowledge')}</strong>
        {result.locator !== undefined && <span>{result.locator}</span>}
        <p>{result.content}</p>
      </article>)}
    </div>}
    {!searching && !searchError && query.trim() !== '' && results.length === 0
      && <p className={css.catalogStatus}>{t('noSearchResults')}</p>}
  </section>
}

type KnowledgeSearchResult = {
  readonly sourceId?: string
  readonly knowledgeBaseName?: string
  readonly filename?: string
  readonly locator?: string
  readonly content?: string
}

function searchResults(value: unknown): readonly KnowledgeSearchResult[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    const content = text(record, 'content')
    if (content === undefined) return []
    const sourceId = text(record, 'sourceId')
    const knowledgeBaseName = text(record, 'knowledgeBaseName')
    const filename = text(record, 'filename')
    const locator = text(record, 'locator')
    return [{
      ...(sourceId === undefined ? {} : { sourceId }),
      ...(knowledgeBaseName === undefined ? {} : { knowledgeBaseName }),
      ...(filename === undefined ? {} : { filename }),
      ...(locator === undefined ? {} : { locator }), content,
    }]
  })
}

function Fact({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return <><dt>{label}</dt><dd>{value}</dd></>
}

/** Official main-slot panel for the Expert Kits directory. */
export function ExpertKitsPanel(props: Omit<CatalogSectionProps, 'catalog' | 'labelKey'>): ReactNode {
  return <DeepSeekHarnessCatalogSection {...props} catalog="expertKits" labelKey="expertKits" />
}
/** Official main-slot panel for the Skills directory. */
export function SkillsPanel(props: Omit<CatalogSectionProps, 'catalog' | 'labelKey'>): ReactNode {
  return <DeepSeekHarnessCatalogSection {...props} catalog="skills" labelKey="skills" />
}
/** Official main-slot panel for the Connectors directory. */
export function ConnectorsPanel(props: Omit<CatalogSectionProps, 'catalog' | 'labelKey'>): ReactNode {
  return <DeepSeekHarnessCatalogSection {...props} catalog="connectors" labelKey="connectors" />
}
/** Official main-slot panel for the Knowledge directory. */
export function KnowledgePanel(props: Omit<CatalogSectionProps, 'catalog' | 'labelKey'>): ReactNode {
  return <DeepSeekHarnessCatalogSection {...props} catalog="knowledge" labelKey="knowledge" />
}
