/** Library materials and exact-scope retrieval in the product catalog. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { type ProductDetail, knowledgeScopeLabel } from './catalog-shared.tsx'
import { KnowledgeDocuments } from './KnowledgeDocuments.tsx'
import { KnowledgeDocumentReader } from './KnowledgeDocumentReader.tsx'
import { isKnowledgeAccessDenied, knowledgeSearchResults, useKnowledgeRequests, type KnowledgeSearchResult } from './knowledge-data.ts'
import { productErrorMessage } from './product-errors.ts'

/** Browse materials separately from retrieval without changing a conversation.
 * @param props Library metadata and localized labels.
 * @returns Materials table, retrieval form, and source reader.
 */
export function KnowledgeDetail({ product, renderFactorySlot, t }: PropsRenderFactories & {
  readonly product: ProductDetail
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [tab, setTab] = useState<'materials' | 'search'>('materials')
  return <section className={css.knowledgeDetail}>
    <p className={css.knowledgeOwnership}>{product.scope && knowledgeScopeLabel(product.scope, t)}
      {product.ownerName && <span>{product.ownerName}</span>}</p>
    <div className={css.catalogTabs} role="tablist" aria-label={t('knowledge')}>
      {(['materials', 'search'] as const).map((value, index) => <button key={value} type="button" role="tab"
        id={`knowledge-${product.id}-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
        aria-controls={`knowledge-${product.id}-panel`} onClick={() => { setTab(value) }} onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 'materials' : event.key === 'End' ? 'search' : index === 0 ? 'search' : 'materials'
          setTab(next)
          document.getElementById(`knowledge-${product.id}-${next}`)?.focus()
        }}>{t(value === 'materials' ? 'knowledgeMaterials' : 'knowledgeRetrieval')}</button>)}
    </div>
    <div role="tabpanel" id={`knowledge-${product.id}-panel`} aria-labelledby={`knowledge-${product.id}-${tab}`}>
      {tab === 'materials' ? <KnowledgeDocuments key={product.id} product={product} renderFactorySlot={renderFactorySlot} t={t} />
        : <KnowledgeSearch key={product.id} knowledgeBaseId={product.id} renderFactorySlot={renderFactorySlot} t={t} />}
    </div>
  </section>
}

function KnowledgeSearch({ knowledgeBaseId, renderFactorySlot, t }: PropsRenderFactories & {
  readonly knowledgeBaseId: string
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<readonly KnowledgeSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [searched, setSearched] = useState(false)
  const [source, setSource] = useState<KnowledgeSearchResult>()
  const operation = useRef<AbortController>()
  useEffect(() => () => { operation.current?.abort() }, [])
  const readAccessDenied = useCallback((failure: unknown) => {
    operation.current?.abort()
    setResults([]); setSource(undefined); setSearched(false); setSearching(false)
    setError(productErrorMessage(failure, t, 'knowledgeReadFailed'))
  }, [t])
  const search = async (): Promise<void> => {
    if (query.trim() === '' || searching) return
    operation.current?.abort()
    const controller = new AbortController()
    operation.current = controller
    setSearching(true); setError(''); setSearched(false); setResults([]); setSource(undefined)
    try {
      const response = await request('knowledge.search', {
        query: query.trim(), knowledgeBaseIds: [knowledgeBaseId], knowledgeBaseRefs: [], restrictToKnowledgeBaseRefs: true, limit: 8,
      }, controller.signal)
      if (!controller.signal.aborted) { setResults(knowledgeSearchResults(response)); setSearched(true) }
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (isKnowledgeAccessDenied(failure)) readAccessDenied(failure)
        else setError(productErrorMessage(failure, t, 'searchFailed'))
      }
    } finally { if (!controller.signal.aborted) setSearching(false) }
  }
  return <>
    <form className={css.knowledgeSearch} onSubmit={(event) => { event.preventDefault(); void search() }}>
      <label className={css.searchField}><IconSearchOutlineRegular size={16} />
        <span className={css.visuallyHidden}>{t('knowledgeSearch')}</span>
        <input value={query} onChange={(event) => { setQuery(event.currentTarget.value) }}
          placeholder={t('knowledgeSearchPlaceholder')} type="search" maxLength={2_000} /></label>
      <Button variant="primary" size="sm" disabled={searching || query.trim() === ''} type="submit">
        {t(searching ? 'searching' : 'search')}</Button>
    </form>
    {error && <p className={css.catalogError} role="alert">{error}</p>}
    {results.length > 0 && <div className={css.knowledgeResults} aria-label={t('searchResults')}>
      {results.map((result, index) => <article className={css.knowledgeResult} key={`${result.sourceId}-${String(index)}`}>
        <button className={css.knowledgeSourceLink} type="button" disabled={result.sourceId === undefined}
          onClick={() => { setSource(result) }}>{result.filename ?? result.knowledgeBaseName ?? t('knowledge')}</button>
        {result.locator && <span>{result.locator}</span>}
        <p>{result.content.trim() ? result.content : t('knowledgeNoContent')}</p>
      </article>)}
    </div>}
    {searched && !searching && !error && results.length === 0 && <p className={css.catalogStatus}>{t('noSearchResults')}</p>}
    {source?.sourceId && <KnowledgeDocumentReader sourceId={source.sourceId}
      title={source.filename ?? t('knowledgeSource')} knowledgeBaseId={knowledgeBaseId}
      renderFactorySlot={renderFactorySlot} onAccessDenied={readAccessDenied} onClose={() => { setSource(undefined) }} t={t} />}
  </>
}
