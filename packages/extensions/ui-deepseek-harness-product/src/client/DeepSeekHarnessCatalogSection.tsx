import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { PropsLocale, PropsRuntime, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconChevronDownOutlineRegular, IconLinkOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, Menu, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ConnectorRefreshResultSchema, ExtensionRemovalResultSchema, ExtensionSubmissionResultSchema } from '@deepseek-harness/product/connector-draft'
import { NS, type DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { productApi, type ProductApi } from './product-api.ts'
import { productErrorMessage } from './product-errors.ts'
import { type Catalog, type ProductItem, type ProductDetail, type DeepSeekHarnessCatalogActions, METHODS, CATEGORY_KEYS, AUTHORIZATION_TIMEOUT_MS, items, normalizedSearch, localizedCategory, itemMetadata, localDetail } from './catalog-shared.tsx'
import { ConnectorDetailModal } from './ConnectorView.tsx'
import { ConnectorEditor } from './ConnectorEditor.tsx'
import { ResourceActionsMenu } from './ResourceActionsMenu.tsx'
import { KnowledgeWorkspace } from './KnowledgeWorkspace.tsx'
import { isKnowledgeAccessDenied } from './knowledge-data.ts'
export type { DeepSeekHarnessCatalogActions } from './catalog-shared.tsx'
type CatalogSectionProps = PropsRuntime<'main'> & PropsLocale<typeof NS> & PropsRenderFactories & DeepSeekHarnessCatalogActions & {
  readonly catalog: Catalog
  readonly labelKey: DeepSeekHarnessProductKey
}
interface ReadScope {
  generation: number
  readonly requests: Map<string, ProductApi>
}

/** Employee catalogs retain drafts and never mutate the active conversation. */
export function DeepSeekHarnessCatalogSection(props: CatalogSectionProps): ReactNode {
  const { catalog, labelKey } = props
  const t = useCallback((key: DeepSeekHarnessProductKey): string => props.t(key), [props.t])
  const [entries, setEntries] = useState<readonly ProductItem[]>([])
  const [knowledgeRevision, setKnowledgeRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [authRequired, setAuthRequired] = useState(false)
  const [authPending, setAuthPending] = useState(false)
  const [authError, setAuthError] = useState(false)
  const [error, setError] = useState<string>()
  const [unavailableConnectorIds, setUnavailableConnectorIds] = useState<readonly string[]>([])
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [connectorFilter, setConnectorFilter] = useState<'market' | 'mine'>('market')
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)
  const [selected, setSelected] = useState<ProductDetail>()
  const [editor, setEditor] = useState<{ connector?: { id: string; version: string } }>()
  const [confirmation, setConfirmation] = useState<{ action: 'submit' | 'delete'; id: string; version: string; name: string }>()
  const [managementPending, setManagementPending] = useState(false)
  const [managementError, setManagementError] = useState<string>()
  const catalogReads = useRef<ReadScope>({ generation: 0, requests: new Map() })
  const detailReads = useRef<ReadScope>({ generation: 0, requests: new Map() })
  const writes = useRef(new Map<string, ProductApi>())
  const managementLifetime = useRef(0)
  const employee = useRef<string | undefined>(undefined)
  const [identityRevision, setIdentityRevision] = useState(0)
  const cancelReads = (scope: ReadScope = detailReads.current): number => {
    scope.generation += 1
    for (const [requestId, api] of scope.requests) api.cancel(requestId)
    scope.requests.clear()
    return scope.generation
  }

  const synchronizeIdentity = (session: Awaited<ReturnType<ProductApi['getSession']>>): void => {
    const identity = session.authenticated === true ? session.employeeId ?? '' : undefined
    if (employee.current === identity) return
    employee.current = identity
    cancelReads()
    managementLifetime.current += 1
    for (const [requestId, api] of writes.current) api.cancel(requestId)
    writes.current.clear()
    setIdentityRevision(value => value + 1)
    setEntries([])
    setCatalogLoaded(false)
    setUnavailableConnectorIds([])
    setSelected(undefined)
    setEditor(undefined); setConfirmation(undefined)
    setManagementPending(false); setManagementError(undefined)
  }

  const read = async (api: ProductApi, method: string, payload?: unknown, timeoutMs?: number,
    scope: ReadScope = detailReads.current): Promise<unknown> => {
    const requestId = randomUUID()
    scope.requests.set(requestId, api)
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
      scope.requests.delete(requestId)
    }
  }

  const refresh = async (reconnect = false): Promise<void> => {
    const scope = catalogReads.current
    const currentGeneration = cancelReads(scope)
    const api = productApi()
    if (api === undefined) {
      setError(t('unavailable'))
      setLoading(false)
      return
    }
    setLoading(true)
    setError(undefined)
    if (reconnect) setUnavailableConnectorIds([])
    setAuthError(false)
    try {
      const session = await api.getSession()
      if (currentGeneration !== scope.generation) return
      synchronizeIdentity(session)
      if (session.authenticated !== true) {
        setAuthRequired(true)
        setEntries([])
        return
      }
      setAuthRequired(false)
      if (currentGeneration !== scope.generation) return
      const reconnected = reconnect && catalog === 'connectors'
        ? ConnectorRefreshResultSchema.parse(await read(api, 'connectors.refresh', {}, undefined, scope)) : undefined
      if (currentGeneration !== scope.generation) return
      const catalogValue = await read(api, METHODS[catalog], undefined, undefined, scope)
      if (currentGeneration !== scope.generation) return
      setEntries(items(catalogValue))
      setCatalogLoaded(true)
      if (reconnected) setUnavailableConnectorIds(reconnected.unavailableIds)
      if (catalog === 'knowledge') setKnowledgeRevision(value => value + 1)
    } catch (error: unknown) {
      if (currentGeneration !== scope.generation) return
      const session = await api.getSession().catch(() => undefined)
      if (currentGeneration !== scope.generation) return
      if (session !== undefined) synchronizeIdentity(session)
      if (session?.authenticated === false) {
        setAuthRequired(true)
        setEntries([])
        setError(undefined)
      } else {
        if (catalog === 'knowledge' && isKnowledgeAccessDenied(error)) setEntries([])
        setError(productErrorMessage(error, t, 'loadFailed'))
      }
    } finally {
      if (currentGeneration === scope.generation) setLoading(false)
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
    setCatalogLoaded(false)
    setQuery('')
    setCategoryFilter('all')
    setConnectorFilter('market')
    setEditor(undefined)
    setCategoryMenuOpen(false)
    setUnavailableConnectorIds([])
    setSelected(undefined)
    setConfirmation(undefined)
    setManagementPending(false)
    setManagementError(undefined)
    void refresh()
    return () => {
      cancelReads(catalogReads.current)
      cancelReads()
      managementLifetime.current += 1
      for (const [requestId, api] of writes.current) api.cancel(requestId)
      writes.current.clear()
    }
  }, [catalog])

  useEffect(() => {
    const api = productApi()
    if (api?.subscribe === undefined) return
    return api.subscribe((event) => {
      if (event.type === 'session.changed' && typeof event.payload === 'object' && event.payload !== null
        && 'authenticated' in event.payload && typeof event.payload.authenticated === 'boolean') {
        synchronizeIdentity({ authenticated: event.payload.authenticated,
          ...'employeeId' in event.payload && typeof event.payload.employeeId === 'string' ? { employeeId: event.payload.employeeId } : {} })
      }
      if (event.type === 'catalog.changed' || event.type === 'session.changed') void refresh()
    })
  }, [catalog])


  const scopeEntries = useMemo(() => entries.filter(entry => connectorFilter === 'market'
    ? entry.reviewStatus === 'PUBLISHED' : entry.canEdit === true), [entries, connectorFilter])
  const filteredEntries = useMemo(() => scopeEntries.filter(entry =>
    (categoryFilter === 'all' || connectorCategory(entry) === categoryFilter)
    && `${normalizedSearch(entry)}\n${localizedCategory(connectorCategory(entry), t)}`.toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())), [scopeEntries, categoryFilter, query, t])
  const categories = Object.keys(CATEGORY_KEYS)
  const groupedEntries = categories.map(category => [localizedCategory(category, t),
    filteredEntries.filter(entry => connectorCategory(entry) === category)] as const).filter(([, rows]) => rows.length > 0)
  const selectConnectorFilter = (filter: 'market' | 'mine') => {
    setConnectorFilter(filter); setCategoryFilter('all'); setCategoryMenuOpen(false)
  }
  const closeDetail = () => { cancelReads(); setSelected(undefined) }
  const refreshConnectorDetails = async (): Promise<void> => {
    const api = productApi()
    if (!api) throw new Error(t('unavailable'))
    const id = selected?.id
    if (id === undefined) return
    const lifetime = managementLifetime.current
    const generation = detailReads.current.generation
    const values = await read(api, 'connectors.list')
    if (lifetime !== managementLifetime.current || generation !== detailReads.current.generation) return
    const connectors = items(values)
    const item = connectors.find(entry => entry.id === id)
    if (!item) throw new Error(t('referenceUnauthorized'))
    if (catalog === 'connectors') {
      setEntries(connectors)
      setSelected(previous => previous?.id === id ? localDetail(item) : previous)
      setError(undefined)
    }
  }

  const confirmManagement = (action: 'submit' | 'delete', entry: ProductItem | ProductDetail) => {
    if (!entry.version || (action === 'submit' ? !entry.canSubmit : !entry.canDelete)) return
    setManagementError(undefined)
    setConfirmation({ action, id: entry.id, version: entry.version, name: 'label' in entry ? entry.label : entry.name })
  }
  const manageResource = async () => {
    const api = productApi()
    if (!api || !confirmation || managementPending) return
    const target = confirmation
    const lifetime = managementLifetime.current
    const requestId = randomUUID()
    writes.current.set(requestId, api)
    setManagementPending(true); setManagementError(undefined)
    try {
      const value = await api.invoke(target.action === 'submit' ? 'extensions.submit' : 'extensions.connector.delete',
        { kind: 'connector', id: target.id, version: target.version }, requestId)
      if (lifetime !== managementLifetime.current) return
      const receipt = (target.action === 'submit' ? ExtensionSubmissionResultSchema : ExtensionRemovalResultSchema).parse(value)
      if (receipt.id !== target.id || ('version' in receipt && receipt.version !== target.version)) throw new Error('Connector receipt mismatch')
      setConfirmation(undefined)
      if (target.action === 'delete') { closeDetail(); setEntries(previous => previous.filter(entry => entry.id !== target.id)) }
      else setSelected(previous => previous?.id === target.id ? { ...previous, canSubmit: false, reviewStatus: 'SUBMITTED' } : previous)
      await refresh()
    } catch (error) {
      if (lifetime === managementLifetime.current) setManagementError(productErrorMessage(error, t, target.action === 'delete' ? 'deleteFailed' : 'saveFailed'))
    } finally {
      writes.current.delete(requestId)
      if (lifetime === managementLifetime.current) setManagementPending(false)
    }
  }
  const managementActions = (resource: ProductItem | ProductDetail) => <ResourceActionsMenu resource={resource} pending={managementPending}
    onEdit={() => { if (resource.version) { closeDetail(); setEditor({ connector: { id: resource.id, version: resource.version } }) } }}
    onSubmit={() => { confirmManagement('submit', resource) }} onDelete={() => { confirmManagement('delete', resource) }} t={t} />
  if (catalog === 'knowledge') return <KnowledgeWorkspace key={identityRevision} entries={entries} loading={loading} refreshRevision={knowledgeRevision}
    {...error === undefined ? {} : { error }} renderFactorySlot={props.renderFactorySlot}
    authRequired={authRequired} authPending={authPending} authError={authError} t={t}
    onRefresh={() => { void refresh() }} onSignIn={() => { void signIn() }} />
  const Icon = IconLinkOutlineRegular
  return <section className={css.catalogPage} aria-label={t(labelKey)}>
    <div className={css.catalogScroll}><div className={css.catalogContent}>
      <header className={css.catalogHeader}><div><h1>{t(labelKey)}</h1><p>{t('connectorsDescription')}</p></div>
        {!authRequired && <Button variant="primary" onClick={() => { setEditor({}) }}><IconPlusOutlineRegular size={16} />{t('addExtension')}</Button>}
      </header>
      {!authRequired && error === undefined && <div className={css.catalogTabs}
        role="tablist" aria-label={t('connectorFilter')}>
        {(['market', 'mine'] as const).map((id, index, tabs) => <button key={id} type="button" role="tab"
          id={`product-connectors-tab-${id}`} aria-selected={connectorFilter === id}
          aria-controls="deepseek-harness-catalog-results" tabIndex={(connectorFilter === id) ? 0 : -1}
          onClick={() => { selectConnectorFilter(id) }} onKeyDown={(event) => {
            const next = event.key === 'Home' ? 'market' : event.key === 'End' ? 'mine'
              : event.key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length]
                : event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : undefined
            if (next === undefined) return
            event.preventDefault()
            selectConnectorFilter(next)
            event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#product-connectors-tab-${next}`)?.focus()
          }}>
          {t(id === 'market' ? 'extensionMarket' : 'mineExtensions')}
        </button>)}
      </div>}
      {!authRequired && <div className={css.catalogToolbar}>
        <label className={css.searchField}><IconSearchOutlineRegular size={16} /><input aria-label={t('search')} type="search"
          value={query} placeholder={t('searchPlaceholder')} onChange={(event) => { setQuery(event.currentTarget.value) }} /></label>
        <Menu open={categoryMenuOpen} items={[{ id: 'all', label: t('allCategories') }, ...categories.map(id => ({ id, label: localizedCategory(id, t) }))]}
          selectedId={categoryFilter} portal onSelect={(id) => { setCategoryFilter(id); setCategoryMenuOpen(false) }}
          onClose={() => { setCategoryMenuOpen(false) }}
          anchor={<button className={css.categoryButton} type="button" aria-label={t('categoryFilter')} aria-haspopup="menu" aria-expanded={categoryMenuOpen}
            onClick={() => { setCategoryMenuOpen(value => !value) }}>
            {categoryFilter === 'all' ? t('allCategories') : localizedCategory(categoryFilter, t)}<IconChevronDownOutlineRegular size={14} /></button>} />
        <Button variant="ghost" aria-label={t('refresh')} aria-busy={loading} disabled={loading} onClick={() => { void refresh(true) }}>
          {loading ? <span role="status" aria-label={t('loading')}><StateDot state="ongoing" size={16} /></span> : <IconRefreshOutlineRegular size={16} />}
        </Button>
      </div>}
      {authRequired && <Button variant="primary" disabled={authPending} onClick={() => { void signIn() }}>{t('signIn')}</Button>}
      {authError && <p role="alert">{t('loadFailed')}</p>}
      {error && <p className={css.catalogError} role="alert">{error}</p>}
      {!authRequired && !error && unavailableConnectorIds.length > 0 && <p className={css.catalogWarning} role="alert">
        {t('connectorPartialRefreshFailed').replace('{names}', unavailableConnectorIds
          .map(id => entries.find(entry => entry.id === id)?.label ?? id).join('、'))}</p>}
      {catalogLoaded && !authRequired && !error && <div id="deepseek-harness-catalog-results" role="tabpanel" aria-busy={loading}
        aria-labelledby={`product-connectors-tab-${connectorFilter}`}>
        {filteredEntries.length === 0 && <div className={css.catalogStatus}>
          <p>{t(query.trim() || categoryFilter !== 'all' ? 'noSearchResults' : connectorFilter === 'mine' ? 'noPersonalConnectors' : 'noConnectors')}</p>
          {(query.trim() || categoryFilter !== 'all') && <Button variant="ghost" size="sm"
            onClick={() => { setQuery(''); setCategoryFilter('all') }}>{t('clearConnectorFilters')}</Button>}
        </div>}
        {groupedEntries.map(([group, rows]) => <section className={css.catalogGroup} aria-label={group} key={group}>
          <h2 className={css.groupTitle}>{group}<span>{rows.length}</span></h2>
          <ul className={css.catalogGrid} data-catalog="connectors">
            {rows.map(entry => <li key={entry.id} className={css.catalogCard} data-catalog="connectors">
              <button type="button" className={css.cardBody} onClick={() => { setSelected(localDetail(entry)) }}>
                <span className={css.cardIdentity}><span className={css.catalogArtwork} aria-hidden="true"><Icon size={20} /></span>
                  <span className={css.catalogItemCopy}><span className={css.itemTitle}>{entry.label}</span>
                    {entry.description && <span className={css.itemDescription}>{entry.description}</span>}</span>
                </span>
              </button>
              <div className={css.cardFooter}><span className={css.cardFacts}><span className={css.itemMetadata}>
                {itemMetadata(entry, t).map(value => <span key={value}>{value}</span>)}
              </span></span>{managementActions(entry)}</div>
            </li>)}
          </ul>
        </section>)}
      </div>}
      <ConnectorDetailModal detail={selected}
        onClose={closeDetail} onCatalogChanged={refreshConnectorDetails}
        managementActions={selected && managementActions(selected)} t={t} />
      {editor && <ConnectorEditor key={identityRevision} editing={editor.connector} onClose={() => { setEditor(undefined) }}
        onSaved={() => { setEditor(undefined); selectConnectorFilter('mine'); void refresh() }}
        t={t} />}
      <Modal open={confirmation !== undefined} onClose={() => { if (!managementPending) setConfirmation(undefined) }}
        title={confirmation?.action === 'delete' ? t('resourceDeleteTitle').replace('{name}', confirmation.name) : t('submitResourceTitle')} closeLabel={t('close')}
        footer={<div className={css.detailActions}><Button variant="outline" disabled={managementPending} onClick={() => { setConfirmation(undefined) }}>{t('cancel')}</Button>
          <Button variant="primary" disabled={managementPending} onClick={() => { void manageResource() }}>{t(confirmation?.action === 'delete' ? managementPending ? 'deletingResource' : 'deleteResource' : 'submitShared')}</Button></div>}>
        {managementError && <p role="alert">{managementError}</p>}
        <p>{t(confirmation?.action === 'delete' ? 'resourceDeleteConfirmation' : 'submitResourceConfirmation').replace('{name}', confirmation?.name ?? '')}</p>
      </Modal>
    </div></div></section>
}
export function ConnectorsPanel(props: Omit<CatalogSectionProps, 'catalog' | 'labelKey'>): ReactNode {
  return <DeepSeekHarnessCatalogSection {...props} catalog="connectors" labelKey="connectors" />
}
export function KnowledgePanel(props: Omit<CatalogSectionProps, 'catalog' | 'labelKey'>): ReactNode {
  return <DeepSeekHarnessCatalogSection {...props} catalog="knowledge" labelKey="knowledge" />
}

function connectorCategory(item: ProductItem): string {
  const category = item.category?.toLocaleLowerCase()
  return category !== undefined && Object.hasOwn(CATEGORY_KEYS, category) ? category : 'other'
}
