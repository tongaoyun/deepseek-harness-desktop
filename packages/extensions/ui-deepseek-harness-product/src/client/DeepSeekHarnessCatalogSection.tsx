import type { PropsLocale, PropsRuntime, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconChevronDownOutlineRegular, IconLinkOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, Menu, Modal, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import { ConnectorRefreshResultSchema, ExtensionRemovalResultSchema, ExtensionSubmissionResultSchema } from '@deepseek-harness/product/connector-draft'
import { NS, type DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { invokeProduct, productApi, type ProductApi } from './product-api.ts'
import { productErrorMessage, type ProductFailureReport } from './product-errors.ts'
import { productFailure } from '@deepseek-harness/product/errors'
import { type Catalog, type ProductItem, type ProductDetail, METHODS, CATEGORY_KEYS, items, normalizedSearch, localizedCategory, itemMetadata, localDetail } from './catalog-shared.tsx'
import { ConnectorDetailModal } from './ConnectorView.tsx'
import { ConnectorEditor } from './ConnectorEditor.tsx'
import { ResourceActionsMenu } from './ResourceActionsMenu.tsx'
import { ProductSignIn } from './ProductSignIn.tsx'
import { ProductLoading } from './ProductLoading.tsx'
import { ProductActionLabel } from './ProductActionLabel.tsx'
import { useResultFocus } from './useResultFocus.ts'
import type { EmployeeSignInActions } from './employee-sign-in.ts'
type CatalogSectionProps = PropsRuntime<'main'> & PropsLocale<typeof NS> & PropsRenderFactories
  & Pick<EmployeeSignInActions, 'openEmployeeSignIn'> & {
    readonly catalog: Catalog
    readonly labelKey: DeepSeekHarnessProductKey
  }
interface ReadScope {
  generation: number
  readonly requests: Set<AbortController>
}

/** Employee catalogs retain confirmed results on read failures, invalidate them on authority loss and recover removed controls in place. */
export function DeepSeekHarnessCatalogSection(props: CatalogSectionProps): ReactNode {
  const { catalog, labelKey } = props
  const t = useCallback((key: DeepSeekHarnessProductKey): string => props.t(key), [props.t])
  const [entries, setEntries] = useState<readonly ProductItem[]>([])
  const [loading, setLoading] = useState(true)
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [authRequired, setAuthRequired] = useState<boolean>()
  const [error, setError] = useState<ProductFailureReport>()
  const [unavailableConnectorIds, setUnavailableConnectorIds] = useState<readonly string[]>([])
  const [query, setQuery] = useState('')
  const catalogRoot = useRef<HTMLElement>(null)
  const captureReadFocus = useResultFocus(catalogRoot, catalogRoot)
  const search = useRef<HTMLInputElement>(null)
  const openEmployeeSignIn = () => { props.openEmployeeSignIn(() => {
    if (catalogRoot.current) focusWithoutRing(catalogRoot.current, { preventScroll: true })
  }) }
  const managementFocusArea = useRef<HTMLElement | null>(null)
  const managementClose = useRef<HTMLButtonElement>(null)
  const captureManagementFocus = useResultFocus(managementFocusArea, () => {
    const target = managementClose.current ?? search.current ?? catalogRoot.current
    if (target) focusWithoutRing(target, { preventScroll: true })
  })
  const preserveManagementFocus = () => {
    // Native dialog return and entry removal can displace focus anywhere on the page.
    managementFocusArea.current = catalogRoot.current?.ownerDocument.body ?? null
    captureManagementFocus()
  }
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [connectorFilter, setConnectorFilter] = useState<'market' | 'mine'>('market')
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)
  const [selected, setSelected] = useState<ProductDetail>()
  const [editor, setEditor] = useState<{ connector?: { id: string; version: string } }>()
  const [confirmation, setConfirmation] = useState<{ action: 'submit' | 'delete'; id: string; version: string; name: string }>()
  const [managementPending, setManagementPending] = useState(false)
  const [managementError, setManagementError] = useState<ProductFailureReport>()
  const deletionCommitted = managementError !== undefined
    && productFailure(managementError.failure).code === 'CONNECTOR_DELETE_CLEANUP_FAILED'
  const catalogReads = useRef<ReadScope & { pending: boolean }>({ generation: 0, requests: new Set(), pending: false })
  const detailReads = useRef<ReadScope>({ generation: 0, requests: new Set() })
  const writes = useRef(new Set<AbortController>())
  const managementLifetime = useRef(0)
  const employee = useRef<string | undefined>(undefined)
  const cancelReads = (scope: ReadScope = detailReads.current): number => {
    scope.generation += 1
    for (const controller of scope.requests) controller.abort()
    scope.requests.clear()
    return scope.generation
  }

  const cancelWrites = (): void => {
    for (const controller of writes.current) controller.abort()
    writes.current.clear()
  }

  const synchronizeIdentity = (session: Awaited<ReturnType<ProductApi['getSession']>>, activeScope?: ReadScope): void => {
    captureReadFocus()
    setAuthRequired(session.authenticated !== true)
    const identity = session.authenticated === true ? session.employeeId ?? '' : undefined
    if (employee.current === identity) return
    employee.current = identity
    if (activeScope !== catalogReads.current) cancelReads(catalogReads.current)
    if (activeScope !== detailReads.current) cancelReads()
    managementLifetime.current += 1
    cancelWrites()
    setEntries([])
    setError(undefined)
    setCatalogLoaded(false)
    setUnavailableConnectorIds([])
    setSelected(undefined)
    setEditor(undefined); setConfirmation(undefined)
    setManagementPending(false); setManagementError(undefined)
  }

  const read = async (api: ProductApi, method: string, payload?: unknown,
    scope: ReadScope = detailReads.current): Promise<unknown> => {
    const controller = new AbortController()
    scope.requests.add(controller)
    try {
      return await invokeProduct(api, method, payload, controller.signal)
    } finally {
      scope.requests.delete(controller)
    }
  }

  const refresh = async (reconnect = false): Promise<void> => {
    const scope = catalogReads.current
    const currentGeneration = cancelReads(scope)
    scope.pending = true
    const api = productApi()
    if (api === undefined) {
      captureReadFocus()
      setError({ failure: undefined, fallback: 'unavailable' })
      scope.pending = false
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const session = await api.getSession()
      if (currentGeneration !== scope.generation) return
      synchronizeIdentity(session, scope)
      if (session.authenticated !== true) {
        setAuthRequired(true)
        setEntries([])
        return
      }
      setAuthRequired(false)
      if (currentGeneration !== scope.generation) return
      const reconnected = reconnect
        ? ConnectorRefreshResultSchema.parse(await read(api, 'connectors.refresh', {}, scope)) : undefined
      if (currentGeneration !== scope.generation) return
      const catalogValue = await read(api, METHODS[catalog], undefined, scope)
      if (currentGeneration !== scope.generation) return
      const catalogEntries = items(catalogValue)
      captureReadFocus()
      setEntries(catalogEntries)
      setError(undefined)
      setCatalogLoaded(true)
      if (reconnected) setUnavailableConnectorIds(reconnected.unavailableIds)
    } catch (error: unknown) {
      if (currentGeneration !== scope.generation) return
      const session = await api.getSession().catch(() => undefined)
      if (currentGeneration !== scope.generation) return
      captureReadFocus()
      if (session !== undefined) synchronizeIdentity(session, scope)
      if (session?.authenticated === false || productFailure(error).code === 'EMPLOYEE_UNAUTHORIZED') {
        synchronizeIdentity({ authenticated: false }, scope)
        setEntries([])
        setCatalogLoaded(false)
        setError(undefined)
      } else {
        const { code } = productFailure(error)
        if (code.startsWith('ORGANIZATION_') || code === 'PRODUCT_HOST_IDENTITY_CHANGED') setCatalogLoaded(false)
        setError({ failure: error, fallback: 'loadFailed' })
      }
    } finally {
      if (currentGeneration === scope.generation) { scope.pending = false; setLoading(false) }
    }
  }

  const refreshFromControl = (reconnect = false): void => {
    if (!catalogReads.current.pending) void refresh(reconnect)
  }

  useEffect(() => {
    setCatalogLoaded(false)
    setError(undefined)
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
      cancelWrites()
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
  const closeDetail = () => { preserveManagementFocus(); cancelReads(); setSelected(undefined) }
  const closeEditor = () => { preserveManagementFocus(); setEditor(undefined) }
  const refreshConnectorDetails = async (beforeCommit: () => void): Promise<void> => {
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
    beforeCommit()
    setEntries(connectors)
    setSelected(previous => previous?.id === id ? localDetail(item) : previous)
    setError(undefined)
  }

  const confirmManagement = (action: 'submit' | 'delete', entry: ProductItem | ProductDetail) => {
    if (writes.current.size > 0 || !entry.version || (action === 'submit' ? !entry.canSubmit : !entry.canDelete)) return
    setManagementError(undefined)
    setConfirmation({ action, id: entry.id, version: entry.version, name: 'label' in entry ? entry.label : entry.name })
  }
  const closeManagement = () => {
    if (writes.current.size > 0) return
    preserveManagementFocus()
    setConfirmation(undefined)
  }
  const manageResource = async () => {
    const api = productApi()
    if (!api || !confirmation || writes.current.size > 0 || deletionCommitted) return
    const target = confirmation
    const lifetime = managementLifetime.current
    const controller = new AbortController()
    writes.current.add(controller)
    setManagementPending(true)
    try {
      const value = await invokeProduct(api, target.action === 'submit' ? 'extensions.submit' : 'extensions.connector.delete',
        { kind: 'connector', id: target.id, version: target.version }, controller.signal)
      if (lifetime !== managementLifetime.current) return
      const receipt = (target.action === 'submit' ? ExtensionSubmissionResultSchema : ExtensionRemovalResultSchema).parse(value)
      if (receipt.id !== target.id || ('version' in receipt && receipt.version !== target.version)) throw new Error('Connector receipt mismatch')
      preserveManagementFocus()
      setManagementError(undefined)
      setConfirmation(undefined)
      if (target.action === 'delete') { closeDetail(); setEntries(previous => previous.filter(entry => entry.id !== target.id)) }
      else setSelected(previous => previous?.id === target.id ? { ...previous, canSubmit: false, reviewStatus: 'SUBMITTED' } : previous)
      await refresh()
    } catch (error) {
      if (lifetime === managementLifetime.current) {
        const removed = target.action === 'delete' && productFailure(error).code === 'CONNECTOR_DELETE_CLEANUP_FAILED'
        if (removed) {
          preserveManagementFocus()
          closeDetail()
          setEntries(previous => previous.filter(entry => entry.id !== target.id))
        }
        setManagementError({ failure: error, fallback: target.action === 'delete' ? 'deleteFailed' : 'saveFailed' })
        if (removed) await refresh()
      }
    } finally {
      writes.current.delete(controller)
      if (lifetime === managementLifetime.current) setManagementPending(false)
    }
  }
  const managementActions = (resource: ProductItem | ProductDetail) => <ResourceActionsMenu resource={resource} pending={managementPending}
    onEdit={() => { if (resource.version) { closeDetail(); setEditor({ connector: { id: resource.id, version: resource.version } }) } }}
    onSubmit={() => { confirmManagement('submit', resource) }} onDelete={() => { confirmManagement('delete', resource) }} t={t} />
  if (authRequired === undefined) return <section ref={catalogRoot} tabIndex={-1} className={css.catalogPage} aria-label={t(labelKey)}>
    <div className={css.catalogScroll}><div className="product-capability-content">
      <header className={`${css.catalogHeader} product-capability-header`}>
        <div className="product-capability-heading">
          <h1 className="product-capability-title">{t(labelKey)}</h1>
          <p className="product-capability-description">{t('connectorsDescription')}</p>
        </div>
      </header>
      {error ? <div role="alert" className={css.catalogStatus}>
        <p>{productErrorMessage(error.failure, t, error.fallback)}</p>
        <Button variant="outline" size="sm" aria-disabled={loading} aria-busy={loading}
          className={loading ? 'product-control-pending' : undefined} onClick={() => { refreshFromControl() }}>{t('retry')}</Button>
      </div> : loading && <div className="product-capability-pending"><ProductLoading label={t('loading')} /></div>}
    </div></div>
  </section>
  const Icon = IconLinkOutlineRegular
  return <section ref={catalogRoot} tabIndex={-1} className={css.catalogPage} aria-label={t(labelKey)}>
    <div className={css.catalogScroll}><div className="product-capability-content">
      <header className={`${css.catalogHeader} product-capability-header`}>
        <div className="product-capability-heading">
          <h1 className="product-capability-title">{t(labelKey)}</h1>
          <p className="product-capability-description">{t('connectorsDescription')}</p>
        </div>
        {!authRequired && <Button variant="primary" onClick={() => { setEditor({}) }}><IconPlusOutlineRegular size={16} />{t('addExtension')}</Button>}
      </header>
      {!authRequired && (error === undefined || catalogLoaded) && <div className={css.catalogTabs}
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
        <label className={css.searchField}><IconSearchOutlineRegular size={16} /><input ref={search} aria-label={t('search')} type="search"
          value={query} placeholder={t('searchPlaceholder')} onChange={(event) => { setQuery(event.currentTarget.value) }} /></label>
        <Menu open={categoryMenuOpen} items={[{ id: 'all', label: t('allCategories') }, ...categories.map(id => ({ id, label: localizedCategory(id, t) }))]}
          selectedId={categoryFilter} portal onSelect={(id) => { setCategoryFilter(id); setCategoryMenuOpen(false) }}
          onClose={() => { setCategoryMenuOpen(false) }}
          anchor={<button className={css.categoryButton} type="button" aria-label={t('categoryFilter')} aria-haspopup="menu" aria-expanded={categoryMenuOpen}
            onClick={() => { setCategoryMenuOpen(value => !value) }}>
            {categoryFilter === 'all' ? t('allCategories') : localizedCategory(categoryFilter, t)}<IconChevronDownOutlineRegular size={14} /></button>} />
        <Button variant="ghost" className={loading ? 'product-control-pending' : undefined} aria-label={t('refresh')} aria-busy={loading} aria-disabled={loading} onClick={() => { refreshFromControl(true) }}>
          <IconRefreshOutlineRegular size={16} />
          {loading && <span className={css.visuallyHidden} role="status" aria-label={t('loading')} />}
        </Button>
      </div>}
      {authRequired && <ProductSignIn onSignIn={openEmployeeSignIn} t={t} />}
      {!authRequired && <div className={css.feedbackResult}>
        <span aria-hidden="true">{t('loadFailed')}</span>
        {error && <div className={css.catalogError} role="region" aria-label={t('loadFailed')} tabIndex={0}>
          <p role="alert">{productErrorMessage(error.failure, t, error.fallback)}</p>
        </div>}
      </div>}
      {!authRequired && catalogLoaded && unavailableConnectorIds.length > 0 && <p className={css.catalogWarning} role="alert">
        {t('connectorPartialRefreshFailed').replace('{names}', unavailableConnectorIds
          .map(id => entries.find(entry => entry.id === id)?.label ?? id).join('、'))}</p>}
      {!catalogLoaded && !authRequired && !error && <div className="product-capability-pending"><ProductLoading label={t('loading')} /></div>}
      {catalogLoaded && !authRequired && <div id="deepseek-harness-catalog-results" role="tabpanel" aria-busy={loading}
        aria-labelledby={`product-connectors-tab-${connectorFilter}`}>
        {filteredEntries.length === 0 && <div className="product-capability-empty">
          <p>{t(query.trim() || categoryFilter !== 'all' ? 'noSearchResults' : connectorFilter === 'mine' ? 'noPersonalConnectors' : 'noConnectors')}</p>
          {(query.trim() || categoryFilter !== 'all') && <Button variant="ghost" size="sm"
            onClick={() => {
              setQuery(''); setCategoryFilter('all')
              if (search.current) focusWithoutRing(search.current)
            }}>{t('clearConnectorFilters')}</Button>}
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
      {editor && <ConnectorEditor editing={editor.connector} onClose={closeEditor}
        onSaved={() => { closeEditor(); selectConnectorFilter('mine'); void refresh() }}
        t={t} />}
      <Modal open={confirmation !== undefined} onClose={closeManagement}
        className={`${css.boundedModal} ${css.resourceConfirmation}`} contentClassName={css.detailModalContent as string}
        title={confirmation?.action === 'delete' ? t('resourceDeleteTitle').replace('{name}', confirmation.name) : t('submitResourceTitle')} closeLabel={t('close')}
        footer={<div className={css.detailActions}><Button ref={managementClose} variant="outline" aria-disabled={managementPending}
          className={managementPending ? 'product-control-pending' : undefined}
          onClick={closeManagement}>{t(deletionCommitted ? 'close' : 'cancel')}</Button>
        {!deletionCommitted && <Button variant="primary" aria-disabled={managementPending} aria-busy={managementPending}
          className={managementPending ? 'product-control-pending' : undefined}
          onClick={() => { void manageResource() }}>{confirmation?.action === 'delete'
            ? <ProductActionLabel pending={managementPending} label={t('deleteResource')} pendingLabel={t('deletingResource')} />
            : t('submitShared')}</Button>}</div>}>
        {managementError && <p role="alert">{productErrorMessage(managementError.failure, t, managementError.fallback)}</p>}
        {!deletionCommitted && <p>{t(confirmation?.action === 'delete' ? 'resourceDeleteConfirmation' : 'submitResourceConfirmation').replace('{name}', confirmation?.name ?? '')}</p>}
      </Modal>
    </div></div></section>
}
export function ConnectorsPanel(props: Omit<CatalogSectionProps, 'catalog' | 'labelKey'>): ReactNode {
  return <DeepSeekHarnessCatalogSection {...props} catalog="connectors" labelKey="connectors" />
}


function connectorCategory(item: ProductItem): string {
  const category = item.category?.toLocaleLowerCase()
  return category !== undefined && Object.hasOwn(CATEGORY_KEYS, category) ? category : 'other'
}
