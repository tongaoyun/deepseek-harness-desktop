/** Library discovery stays separate from document requests and reading state. */
import { useId, useRef, type ReactNode } from 'react'
import { Button, IconDatabaseOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, SegmentedControl, Tooltip, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { knowledgeScopeLabel, type ProductItem } from './catalog-shared.tsx'
import { ProductLoading } from './ProductLoading.tsx'

/** Find an authorized library before requesting any of its contents.
 * @param props Directory data and owner-scoped navigation and management actions.
 * @returns Searchable library cards filtered by their permission scope.
 */
export function KnowledgeLibraryDirectory({ entries, hidden, loading, loaded, error, query, scope, onQueryChange, onScopeChange,
  onOpen, onCreate, onRefresh, renderActions, t }: {
  readonly entries: readonly ProductItem[]
  readonly hidden: boolean
  readonly loading: boolean
  readonly loaded: boolean
  readonly error: string | undefined
  readonly query: string
  readonly scope: string
  readonly onQueryChange: (query: string) => void
  readonly onScopeChange: (scope: string) => void
  readonly onOpen: (id: string) => void
  readonly onCreate: () => void
  readonly onRefresh: () => void
  readonly renderActions: (entry: ProductItem) => ReactNode
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const id = useId()
  const search = useRef<HTMLInputElement>(null)
  const term = query.trim().toLocaleLowerCase()
  const filtered = entries.filter(entry => (scope === 'all' || entry.scope === scope)
    && [entry.label, entry.description, entry.ownerName, knowledgeScopeLabel(entry.scope ?? '', t)]
      .some(value => value?.toLocaleLowerCase().includes(term)))
  const scopes = ['PERSONAL', 'DEPARTMENT', 'COMPANY']
  const activeFilters = term !== '' || scope !== 'all'
  return <div hidden={hidden} className={css.catalogScroll}><main className={`${css.knowledgeDirectory} product-capability-content`} data-knowledge-directory>
    <header className={`${css.knowledgeDirectoryHeader} product-capability-header`}>
      <div className="product-capability-heading"><h1 className="product-capability-title" tabIndex={-1}>{t('knowledge')}</h1>
        <p className="product-capability-description">{t('knowledgeDirectoryHint')}</p></div>
      <Button variant="primary" disabled={!loaded || error !== undefined} onClick={onCreate}>
        <IconPlusOutlineRegular size={16} />{t('knowledgeCreatePersonalBase')}
      </Button>
    </header>
    <div className={css.knowledgeDirectoryToolbar}>
      <SegmentedControl className={css.knowledgeDirectoryScopes} id={id} value={scope} label={t('knowledgeLibraryScope')} options={[
        { value: 'all', label: t('knowledgeAllLibraries') }, ...scopes.map(value => ({ value, label: knowledgeScopeLabel(value, t) })),
      ]} onChange={onScopeChange} />
      <div className={css.knowledgeDirectorySearch}>
        <label className={css.searchField}><IconSearchOutlineRegular size={16} />
          <span className={css.visuallyHidden}>{t('knowledgeSelectionSearch')}</span>
          <input ref={search} type="search" value={query} placeholder={t('knowledgeSelectionSearch')} maxLength={120}
            onChange={(event) => { onQueryChange(event.currentTarget.value) }} />
        </label>
        <Tooltip label={t('refresh')} side="bottom" align="end" gap={2} portal delayMs={350} disabled={loading}>
          <button type="button" className={`${css.iconButton}${loading ? ' product-control-pending' : ''}`} aria-label={t('refresh')} aria-busy={loading}
            aria-disabled={loading} onClick={() => { if (!loading) onRefresh() }}><IconRefreshOutlineRegular size={17} /></button></Tooltip>
      </div>
    </div>
    {error !== undefined && <div className={css.knowledgeDirectoryError} role="alert"><p>{error}</p>
      <Button variant="outline" size="sm" aria-disabled={loading} aria-busy={loading}
        className={loading ? 'product-control-pending' : undefined} onClick={() => { if (!loading) onRefresh() }}>{t('retry')}</Button></div>}
    <section role="tabpanel" id={`${id}-${scope}-panel`} aria-labelledby={`${id}-${scope}`} aria-busy={loading}>
      {loading && !loaded && error === undefined ? <div className={`${css.knowledgeDirectoryEmpty} product-capability-pending`}><ProductLoading label={t('loading')} /></div>
        : filtered.length > 0 ? <div className={css.knowledgeLibraryGrid}>
          {filtered.map(entry => <article className={css.knowledgeLibraryCard} key={entry.id}>
            <button type="button" className={css.knowledgeLibraryCardOpen} aria-label={entry.label} title={entry.label}
              data-knowledge-base={entry.id} data-scope={entry.scope} onClick={() => { onOpen(entry.id) }}>
              <span className={css.knowledgeLibraryCardIcon}><IconDatabaseOutlineRegular size={23} /></span>
              <h2>{entry.label}</h2>{entry.description && <p>{entry.description}</p>}
            </button>
            <footer><span>{knowledgeScopeLabel(entry.scope ?? '', t)}{entry.ownerName ? ` · ${entry.ownerName}` : ''}</span>
              <div className={css.knowledgeLibraryCardActions}>{renderActions(entry)}</div></footer>
          </article>)}
        </div> : error === undefined && <div className={`${css.knowledgeDirectoryEmpty} product-capability-empty`}>
          <IconDatabaseOutlineRegular size={36} /><h2>{t(activeFilters ? 'noSearchResults' : 'knowledgeNoLibraries')}</h2>
          <p>{t(activeFilters ? 'knowledgeLibraryFilterHint' : 'knowledgeDirectoryEmptyHint')}</p>
          {activeFilters && <Button variant="outline" size="sm" onClick={() => {
            onQueryChange(''); onScopeChange('all')
            if (search.current) focusWithoutRing(search.current)
          }}>{t('knowledgeClearFilters')}</Button>}
        </div>}
    </section>
  </main></div>
}
