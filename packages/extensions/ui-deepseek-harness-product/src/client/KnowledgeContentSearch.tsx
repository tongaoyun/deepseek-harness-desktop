/** Library-wide body search reuses authorized hybrid retrieval and source reading. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronLeftOutlineRegular, IconSearchOutlineRegular, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { isKnowledgeAccessDenied, knowledgePassage, useKnowledgeRequests, type KnowledgePassage } from './knowledge-data.ts'
import { productErrorMessage } from './product-errors.ts'
import { KnowledgeDocumentReader } from './KnowledgeDocumentReader.tsx'
import { ProductLoading } from './ProductLoading.tsx'
import { useResultFocus } from './useResultFocus.ts'

function passages(value: unknown, knowledgeBaseId: string): readonly KnowledgePassage[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error('Invalid content search results')
  const sources = new Set<string>()
  return value.map((row: unknown) => {
    const passage = knowledgePassage(row, { knowledgeBaseId })
    if (sources.has(passage.sourceId)) throw new Error('Duplicate content search source')
    sources.add(passage.sourceId)
    return passage
  })
}

/** Search all folders in a library, then reauthorize each selected passage before reading.
 * Directory refresh revalidates submitted searches and the selected reader in place.
 * Moved results retain focus; removed results and completed retries return their owned focus to the search field without scrolling.
 * @param props Authorized library identity, native reader factory, return and access-revocation callbacks.
 * @returns A bounded result list or its selected source reader; no agent task or generated answer is created.
 */
export function KnowledgeContentSearch({ knowledgeBaseId, onBack, onAccessDenied, refreshRevision, renderFactorySlot, t,
}: PropsRenderFactories & {
  readonly knowledgeBaseId: string
  readonly onBack: () => void
  readonly onAccessDenied: (failure: unknown) => void
  readonly refreshRevision: number
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<readonly KnowledgePassage[]>()
  const [selected, setSelected] = useState<KnowledgePassage>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>()
  const input = useRef<HTMLInputElement>(null)
  const resultButton = useRef<HTMLButtonElement>()
  const resultArea = useRef<HTMLDivElement>(null)
  const preserveResultFocus = useResultFocus(resultArea, input)
  const back = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const target = selected ? back.current : resultButton.current?.isConnected ? resultButton.current : input.current
    if (target) focusWithoutRing(target)
  }, [selected])
  const operation = useRef<AbortController>()
  useEffect(() => () => { operation.current?.abort() }, [])
  useEffect(() => {
    const searched = operation.current !== undefined && !operation.current.signal.aborted
      || results !== undefined || error !== undefined
    operation.current?.abort()
    if (searched) void search()
  }, [refreshRevision])
  const search = async () => {
    if (!query.trim() || operation.current && !operation.current.signal.aborted) return
    const controller = new AbortController()
    operation.current = controller
    setLoading(true)
    try {
      const value = await request('knowledge.search', { knowledgeBaseIds: [knowledgeBaseId], knowledgeBaseRefs: [], restrictToKnowledgeBaseRefs: true, query: query.trim(), limit: 12 }, controller.signal)
      if (!controller.signal.aborted) {
        const next = passages(value, knowledgeBaseId)
        preserveResultFocus()
        setResults(next)
        setError(undefined)
      }
    } catch (failure) {
      if (controller.signal.aborted) return
      preserveResultFocus()
      setResults(undefined); setError(failure)
      if (isKnowledgeAccessDenied(failure)) onAccessDenied(failure)
    } finally {
      if (operation.current === controller) {
        operation.current = undefined
        if (!controller.signal.aborted) setLoading(false)
      }
    }
  }
  return <section className={css.knowledgeContentSearch} aria-label={t('knowledgeContentSearch')}>
    <div className={css.knowledgeContentSearchHeading}><h2>{selected ? selected.filename : t('knowledgeContentSearch')}</h2>
      <Button ref={back} variant="ghost" size="sm" onClick={() => { if (selected) setSelected(undefined); else onBack() }}>
        <IconChevronLeftOutlineRegular size={16} />{t(selected ? 'knowledgeBackToSearch' : 'knowledgeBackToMaterials')}</Button></div>
    {selected ? <KnowledgeDocumentReader key={selected.sourceId} knowledgeBaseId={knowledgeBaseId} sourceId={selected.sourceId}
      expectedDocumentId={selected.documentId} title={selected.filename} inline refreshRevision={refreshRevision}
      renderFactorySlot={renderFactorySlot} onAccessDenied={onAccessDenied} onClose={() => { setSelected(undefined) }} t={t} /> : null}
    <div hidden={selected !== undefined}>
      <p className={css.knowledgeLocator}>{t('knowledgeContentSearchHint')}</p>
      <form className={css.knowledgeFilterSearch} onSubmit={(event) => { event.preventDefault(); void search() }}>
        <label className={css.searchField}><IconSearchOutlineRegular size={16} /><span className={css.visuallyHidden}>{t('knowledgeContentSearch')}</span>
          <input ref={input} type="search" value={query} maxLength={2000} placeholder={t('knowledgeContentSearchPlaceholder')}
            onChange={(event) => {
              operation.current?.abort(); setLoading(false); setQuery(event.currentTarget.value); setResults(undefined); setError(undefined)
            }} /></label>
        <Button variant="outline" size="sm" type="submit" className={loading && query.trim() ? 'product-control-pending' : undefined}
          disabled={!query.trim()} aria-disabled={loading || !query.trim()} aria-busy={loading}>{t('search')}</Button>
      </form>
      <div ref={resultArea} aria-live="polite" aria-busy={loading}>
        {loading && results === undefined && error === undefined && <ProductLoading label={t('loading')} />}
        {error !== undefined && <div role="alert" className={css.knowledgeDirectoryError}><p>{productErrorMessage(error, t, 'knowledgeSearchFailed')}</p><Button variant="outline" size="sm"
          aria-disabled={loading} aria-busy={loading} className={loading ? 'product-control-pending' : undefined} onClick={() => { void search() }}>{t('retry')}</Button></div>}
        {error === undefined && !results?.length && (results !== undefined || !loading) && <p className={css.catalogStatus}>{t(results ? 'knowledgeContentSearchEmpty' : 'knowledgeContentSearchStart')}</p>}
        {results && results.length > 0 && <><p className={css.knowledgeLocator}>{t('itemCount').replace('{count}', String(results.length))}</p>
          <ul className={css.knowledgeSearchResults}>{results.map(result => <li key={result.sourceId}>
            <button type="button" onClick={(event) => { resultButton.current = event.currentTarget; setSelected(result) }}><strong>{result.filename}</strong>
              {result.locator && <span className={css.knowledgeLocator}>{result.locator}</span>}
              <span className={css.knowledgeSearchExcerpt}>{result.content}</span></button>
          </li>)}</ul></>}
      </div>
    </div>
  </section>
}
