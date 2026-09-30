import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComponentType, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, IconAgentPresetOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular,
  IconDatabaseOutlineRegular, IconLinkOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular,
  IconSkillOutlineRegular, MarkdownText, SegmentedTabs, Switch, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { NS, type DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'

type ProductSession = { readonly authenticated?: boolean }
type ProductApi = {
  invoke(method: string, payload?: unknown, requestId?: string): Promise<unknown>
  cancel(requestId: string): void
  getSession(): Promise<ProductSession>
}
type ProductWindow = { deepseekHarness?: { product?: ProductApi } }
type Catalog = keyof typeof METHODS
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
}
export interface DeepSeekHarnessCatalogActions {
  setExpertKitEnabled(id: string, enabled: boolean): Promise<void>
  useExpertKitCommand(skillId: string, description: string): Promise<void>
  useSkill(skillId: string): Promise<void>
}
type ProductDetail = {
  readonly id: string
  readonly name: string
  readonly author?: string
  readonly version?: string
  readonly summary?: string
  readonly category?: string
  readonly sha256: string
  readonly commandDetails: readonly CommandDetail[]
  readonly readme: string
  readonly sourceAvailable: boolean
}
type CommandDetail = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly skillId: string
}
type KitFilter = 'all' | 'enabled'

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

let productRequestSequence = 0

function nextProductRequestId(): string {
  productRequestSequence += 1
  return `deepseek-harness-ui-${Date.now().toString(36)}-${productRequestSequence.toString(36)}`
}

function productApi(): ProductApi | undefined {
  return (globalThis as ProductWindow).deepseekHarness?.product
}

function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function items(value: unknown): readonly ProductItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    const id = text(record, 'id') ?? `${index}`
    const label = [record.name, record.title, record.displayName]
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '')
    if (label === undefined) return []
    const description = [record.description, record.summary]
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '')
    const metadata = Object.fromEntries(
      ['author', 'category', 'version', 'status', 'scope', 'transport'].flatMap((key) => {
        const value = text(record, key)
        return value === undefined ? [] : [[key, value]]
      }),
    )
    return [{ id, label, ...(description === undefined ? {} : { description }), ...metadata }]
  })
}

function commandDetails(value: unknown): readonly CommandDetail[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    const id = text(record, 'id')
    const name = text(record, 'name')
    const description = text(record, 'description')
    const skillId = text(record, 'skillId')
    return id === undefined || name === undefined || description === undefined || skillId === undefined
      ? [] : [{ id, name, description, skillId }]
  })
}

function enabledExpertKitIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) {
    throw new Error('invalid expert kit enablement')
  }
  return value as string[]
}

function detail(value: unknown, readmeValue: unknown): ProductDetail | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const id = text(record, 'id')
  const name = text(record, 'name')
  const sha256 = text(record, 'sha256')
  if (id === undefined || name === undefined || sha256 === undefined) return undefined
  const author = text(record, 'author')
  const version = text(record, 'version')
  const summary = text(record, 'summary')
  const category = text(record, 'category')
  const readmeRecord = typeof readmeValue === 'object' && readmeValue !== null && !Array.isArray(readmeValue)
    ? readmeValue as Record<string, unknown> : {}
  const sourceAvailable = typeof readmeRecord.readme === 'string'
  return {
    id, name,
    ...(author === undefined ? {} : { author }),
    ...(version === undefined ? {} : { version }),
    ...(summary === undefined ? {} : { summary }),
    ...(category === undefined ? {} : { category }),
    sha256, commandDetails: commandDetails(record.commandDetails),
    readme: text(readmeRecord, 'readme') ?? '', sourceAvailable,
  }
}

function localizedMetadata(value: string, t: (key: DeepSeekHarnessProductKey) => string): string {
  const keys: Record<string, DeepSeekHarnessProductKey> = {
    ACTIVE: 'statusActive', ENABLED: 'statusEnabled', DISABLED: 'statusDisabled', PUBLISHED: 'statusPublished',
    PERSONAL: 'scopePersonal', TEAM: 'scopeTeam', ORGANIZATION: 'scopeOrganization',
  }
  const key = keys[value.toUpperCase()]
  return key === undefined ? value : t(key)
}

function itemMetadata(item: ProductItem, catalog: Catalog, t: (key: DeepSeekHarnessProductKey) => string): readonly string[] {
  const values = catalog === 'connectors'
    ? [item.status, item.scope, item.transport, item.version]
    : catalog === 'knowledge'
      ? [item.scope]
      : [item.category, item.version === undefined ? undefined : `${t('versionPrefix')}${item.version}`, item.author]
  return [...new Set(values.filter((value): value is string => value !== undefined)
    .map(value => localizedMetadata(value, t)))]
}

function normalizedSearch(item: ProductItem): string {
  return [item.label, item.description, item.author, item.category, item.version, item.status, item.scope, item.transport]
    .filter((value): value is string => value !== undefined).join('\n').toLocaleLowerCase()
}

function groupLabel(item: ProductItem, catalog: Catalog, t: (key: DeepSeekHarnessProductKey) => string): string {
  if (catalog === 'connectors') return item.category ?? t('otherConnectors')
  if (catalog === 'knowledge') return item.scope === undefined ? t('otherKnowledge') : localizedMetadata(item.scope, t)
  return ''
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
  const [kitFilter, setKitFilter] = useState<KitFilter>('all')
  const [selectedId, setSelectedId] = useState<string>()
  const [selected, setSelected] = useState<ProductDetail>()
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  const [actionError, setActionError] = useState(false)
  const [enabledKitIds, setEnabledKitIds] = useState<ReadonlySet<string>>(new Set())
  const generation = useRef(0)
  const activeRequests = useRef(new Map<string, ProductApi>())

  const cancelReads = (): number => {
    generation.current += 1
    for (const [requestId, api] of activeRequests.current) api.cancel(requestId)
    activeRequests.current.clear()
    return generation.current
  }

  const read = async (api: ProductApi, method: string, payload?: unknown): Promise<unknown> => {
    const requestId = nextProductRequestId()
    activeRequests.current.set(requestId, api)
    try { return await api.invoke(method, payload, requestId) }
    finally { activeRequests.current.delete(requestId) }
  }

  const refresh = async (): Promise<void> => {
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
      const [catalogValue, enabledValue] = await Promise.all([
        read(api, METHODS[catalog]),
        catalog === 'expertKits' ? read(api, 'expertKits.enablement.list') : Promise.resolve([]),
      ])
      if (currentGeneration !== generation.current) return
      setEntries(items(catalogValue))
      setEnabledKitIds(new Set(enabledExpertKitIds(enabledValue)))
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
      await api.invoke('auth.ensureDingTalk')
      await refresh()
    } catch {
      setAuthError(true)
    } finally {
      setAuthPending(false)
    }
  }

  useEffect(() => {
    setQuery('')
    setKitFilter('all')
    setSelectedId(undefined)
    setSelected(undefined)
    void refresh()
    return () => { cancelReads() }
  }, [catalog])

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return entries.filter(entry => (needle === '' || normalizedSearch(entry).includes(needle))
      && (catalog !== 'expertKits' || kitFilter === 'all' || enabledKitIds.has(entry.id)))
  }, [catalog, enabledKitIds, entries, kitFilter, query])

  const groupedEntries = useMemo(() => {
    const groups = new Map<string, ProductItem[]>()
    for (const entry of filteredEntries) {
      const label = groupLabel(entry, catalog, t)
      const group = groups.get(label) ?? []
      group.push(entry)
      groups.set(label, group)
    }
    return [...groups.entries()]
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
    if (catalog !== 'expertKits' && catalog !== 'skills') return
    const api = productApi()
    if (api === undefined) return
    cancelReads()
    setSelectedId(id)
    setSelected(undefined)
    setDetailLoading(true)
    setDetailError(false)
    setActionError(false)
    const currentGeneration = generation.current
    try {
      const prefix = catalog === 'expertKits' ? 'expertKits' : 'skills'
      const [metadata, readme] = await Promise.allSettled([
        read(api, `${prefix}.get`, { id }), read(api, `${prefix}.readme`, { id }),
      ])
      if (currentGeneration !== generation.current) return
      if (metadata.status === 'rejected') throw metadata.reason
      const parsed = detail(metadata.value, readme.status === 'fulfilled' ? readme.value : undefined)
      if (parsed === undefined) throw new Error('invalid product detail')
      setSelected(parsed)
    } catch {
      if (currentGeneration !== generation.current) return
      setDetailError(true)
    } finally {
      if (currentGeneration === generation.current) setDetailLoading(false)
    }
  }

  const useProduct = async (product: ProductDetail, command?: CommandDetail): Promise<void> => {
    setActionPending(true)
    setActionError(false)
    try {
      if (catalog === 'skills') await props.useSkill(product.id)
      else if (command !== undefined) await props.useExpertKitCommand(command.skillId, command.description)
    } catch {
      setActionError(true)
    } finally {
      setActionPending(false)
    }
  }

  const setEnabled = async (id: string, enabled: boolean): Promise<void> => {
    const previous = enabledKitIds
    const next = new Set(previous)
    if (enabled) next.add(id)
    else next.delete(id)
    setEnabledKitIds(next)
    setActionPending(true)
    setActionError(false)
    try {
      await props.setExpertKitEnabled(id, enabled)
    } catch {
      setEnabledKitIds(previous)
      setActionError(true)
    } finally {
      setActionPending(false)
    }
  }

  const Icon = ICONS[catalog]
  const detailsAvailable = catalog === 'expertKits' || catalog === 'skills'
  const filterTabs = [
    { value: 'all' as const, label: t('all'), id: 'deepseek-harness-kits-all', panelId: 'deepseek-harness-catalog-results' },
    { value: 'enabled' as const, label: t('enabled'), id: 'deepseek-harness-kits-enabled', panelId: 'deepseek-harness-catalog-results' },
  ] as const

  return <section className={css.catalogPage} aria-label={t(labelKey)}>
    <div className={css.catalogScroll}>
      <div className={css.catalogContent}>
        <header className={css.catalogHeader}>
          <div><h1 className={css.catalogTitle}>{t(labelKey)}</h1>
            <p className={css.catalogDescription}>{t(DESCRIPTION_KEYS[catalog])}</p></div>
        </header>
        <div className={css.catalogToolbar}>
          <label className={css.searchField}>
            <IconSearchOutlineRegular size={16} />
            <span className={css.visuallyHidden}>{t('search')}</span>
            <input value={query} onChange={(event) => { setQuery(event.currentTarget.value) }}
              placeholder={t('searchPlaceholder')} type="search" />
          </label>
          <Tooltip portal label={t('refresh')} side="bottom" delayMs={500}>
            <button className={css.iconButton} type="button" disabled={loading} aria-label={t('refresh')}
              onClick={() => { void refresh() }}><IconRefreshOutlineRegular size={16} /></button>
          </Tooltip>
        </div>
        {catalog === 'expertKits' && <SegmentedTabs items={filterTabs} value={kitFilter}
          onChange={setKitFilter} label={t('kitFilter')} className={css.catalogTabs} />}
        {!loading && error === undefined && !authRequired && <div className={css.resultSummary}>
          {t('itemCount').replace('{count}', String(filteredEntries.length))}
        </div>}
        <div id="deepseek-harness-catalog-results" role={catalog === 'expertKits' ? 'tabpanel' : undefined}
          aria-labelledby={catalog === 'expertKits'
            ? kitFilter === 'all' ? 'deepseek-harness-kits-all' : 'deepseek-harness-kits-enabled'
            : undefined}>
          {loading && <p className={css.catalogStatus} role="status">{t('loading')}</p>}
          {!loading && authRequired && <div className={css.authRequired} role="status">
            <span>{t('authRequired')}</span>
            <Button variant="primary" size="sm" disabled={authPending} onClick={() => { void signIn() }}>
              {authPending ? t('signingIn') : t('signIn')}
            </Button>
            {authError && <span className={css.catalogError} role="alert">{t('signInFailed')}</span>}
          </div>}
          {!loading && error !== undefined && <p className={css.catalogError} role="alert">{error}</p>}
          {!loading && error === undefined && !authRequired && (filteredEntries.length === 0
            ? <p className={css.catalogStatus}>{query === '' ? t('empty') : t('noSearchResults')}</p>
            : groupedEntries.map(([group, groupItems]) => <section className={css.catalogGroup}
              aria-label={group === '' ? undefined : group} key={group || 'all'}>
              {group !== '' && <h2 className={css.groupTitle}>{group}<span>{groupItems.length}</span></h2>}
              <ul className={css.catalogList}>{groupItems.map(entry => <li className={css.catalogRow} key={entry.id}>
                <span className={css.catalogArtwork} aria-hidden="true"><Icon size={20} /></span>
                {detailsAvailable
                  ? <button className={css.catalogItem} type="button" disabled={detailLoading}
                    onClick={() => { void openDetail(entry.id) }}>
                    <CatalogItemCopy entry={entry} catalog={catalog} t={t} />
                    <IconChevronRightOutlineRegular size={16} />
                  </button>
                  : <div className={css.catalogItemStatic}><CatalogItemCopy entry={entry} catalog={catalog} t={t} /></div>}
                {catalog === 'expertKits' && <div className={css.rowAction}>
                  <Switch checked={enabledKitIds.has(entry.id)} disabled={actionPending}
                    label={`${entry.label} ${t('enableInChat')}`}
                    onChange={(enabled) => { void setEnabled(entry.id, enabled) }} />
                </div>}
              </li>)}</ul>
            </section>))}
        </div>
        {actionError && selectedId === undefined && <p className={css.catalogError} role="alert">{t('enableFailed')}</p>}
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
          actionPending={actionPending} actionError={actionError} enabled={enabledKitIds.has(selected.id)}
          onEnabledChange={(enabled) => { void setEnabled(selected.id, enabled) }}
          onUse={(command) => { void useProduct(selected, command) }} t={t} />}
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

function CatalogDetail({ actionError, actionPending, catalog, detail: product, enabled, onEnabledChange,
  onUse, t }: {
  readonly catalog: Catalog
  readonly detail: ProductDetail
  readonly enabled: boolean
  readonly onEnabledChange: (enabled: boolean) => void
  readonly onUse: (command?: CommandDetail) => void
  readonly actionPending: boolean
  readonly actionError: boolean
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const skill = catalog === 'skills'
  const Icon = skill ? IconSkillOutlineRegular : IconAgentPresetOutlineRegular
  const markdownLabels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied'), toolbarLabels: {
      codeLabel: t('code'), wrapLabel: t('wrap'), unwrapLabel: t('unwrap'),
    } }, footnotes: t('footnotes'),
  }), [t])
  return <article className={css.detailContent}>
    <header className={css.detailHeader}>
      <div className={css.detailLead}>
        <div className={css.detailArtwork}><Icon size={28} /></div>
        <div className={css.detailIdentity}>
          <div className={css.detailTitleLine}><h1>{product.name}</h1></div>
          <div className={css.detailMeta}>
            {product.version !== undefined && <span>{t('versionPrefix')}{product.version}</span>}
            {product.category !== undefined && <span>{product.category}</span>}
            {product.author !== undefined && <span>{product.author}</span>}
          </div>
        </div>
      </div>
      {skill
        ? <Button variant="primary" size="sm" disabled={actionPending} onClick={() => { onUse() }}>
          {actionPending ? t('starting') : t('useSkill')}
        </Button>
        : <div className={css.enablement}>
          <div><strong>{t('enableInChat')}</strong><span>{t(enabled ? 'enabled' : 'disabled')}</span></div>
          <Switch checked={enabled} disabled={actionPending} label={t('enableInChat')} onChange={onEnabledChange} />
        </div>}
    </header>
    {actionPending && !skill && <p className={css.enablementHint} role="status">{t('saving')}</p>}
    {actionError && <p className={css.catalogError} role="alert">{t(skill ? 'useFailed' : 'enableFailed')}</p>}
    {product.summary !== undefined && <p className={css.detailSummary}>{product.summary}</p>}
    {skill
      ? <section className={css.sourcePanel} aria-label={t('skillSource')}>
        <p>{t('skillSource')}</p><div className={css.sourceRule} />
        {!product.sourceAvailable ? <span>{t('sourceUnavailable')}</span>
          : product.readme === '' ? <span>{t('noGuide')}</span> : <pre>{product.readme}</pre>}
      </section>
      : <>
        <section className={css.detailSection}>
          <h2>{t('quickCommands')} <span>{product.commandDetails.length}</span></h2>
          {product.commandDetails.length === 0 ? <p className={css.catalogStatus}>{t('empty')}</p>
            : <div className={css.commandList}>{product.commandDetails.map(command =>
              <button className={css.commandRow} disabled={actionPending || !enabled} key={command.id}
                title={enabled ? undefined : t('enableCommandHint')}
                type="button" onClick={() => { onUse(command) }}>
                <span className={css.commandCopy}><strong>/ {command.name}</strong><span>{command.description}</span></span>
                <IconChevronRightOutlineRegular size={16} />
              </button>)}</div>}
        </section>
        {!enabled && <p className={css.enablementHint}>{t('enableCommandHint')}</p>}
        <section className={css.detailSection}>
          <h2>{t('kitGuide')}</h2>
          {!product.sourceAvailable ? <p className={css.catalogStatus}>{t('sourceUnavailable')}</p>
            : product.readme === '' ? <p className={css.catalogStatus}>{t('noGuide')}</p>
              : <div className={css.markdown}><MarkdownText text={product.readme} labels={markdownLabels} /></div>}
        </section>
      </>}
  </article>
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
