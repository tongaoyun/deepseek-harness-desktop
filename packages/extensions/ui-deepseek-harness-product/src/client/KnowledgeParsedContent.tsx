/** Paginated indexed passages from the existing knowledge document API. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { isKnowledgeResourceId } from '@deepseek-harness/product/protocol'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { markdownLabels } from './catalog-shared.tsx'
import { knowledgePage, isKnowledgeAccessDenied, useKnowledgeRequests, type KnowledgePage } from './knowledge-data.ts'
import { productErrorMessage } from './product-errors.ts'
import { ProductLoading } from './ProductLoading.tsx'
import { usePendingPageLayout } from './usePendingPageLayout.ts'
import { useResultFocus } from './useResultFocus.ts'

interface Fragment { readonly id: string; readonly documentId: string; readonly content: string; readonly locator: string }
function fragment(value: unknown): Fragment {
  if (typeof value !== 'object' || value === null || !('id' in value) || !isKnowledgeResourceId(value.id)
    || !('documentId' in value) || !isKnowledgeResourceId(value.documentId) || !('content' in value) || typeof value.content !== 'string'
    || !('locator' in value) || typeof value.locator !== 'string') throw new Error('Invalid indexed passage')
  return { id: value.id, documentId: value.documentId, content: value.content, locator: value.locator }
}

/** Read indexed text, retaining same-page passages during refresh and confirmed totals across pages.
 * Read results retain surviving controls' focus and return removed controls' focus to the content region without scrolling.
 * @param props Authorized document identity, current readiness, refresh, and access-revocation callback.
 * @returns One page of passages with cancellation, empty, and retry states.
 */
export function KnowledgeParsedContent({ knowledgeBaseId, documentId, ready, refreshRevision, onAccessDenied, t }: {
  readonly knowledgeBaseId: string
  readonly documentId: string
  readonly ready: boolean
  readonly refreshRevision: number
  readonly onAccessDenied: (failure: unknown) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const [page, setPage] = useState(1)
  const documentKey = JSON.stringify([knowledgeBaseId, documentId])
  const selection = JSON.stringify([knowledgeBaseId, documentId, page])
  const [snapshot, setSnapshot] = useState<{ selection: string; value: KnowledgePage<Fragment> }>()
  const [pagination, setPagination] = useState<{ documentKey: string; total: number; page: number }>()
  const data = snapshot?.selection === selection ? snapshot.value : undefined
  const total = pagination?.documentKey === documentKey ? pagination.total : 0
  const pages = Math.max(1, Math.ceil(total / 20))
  const [error, setError] = useState<unknown>()
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const content = useRef<HTMLElement>(null)
  const preserveReadFocus = useResultFocus(content, content)
  const pageLayout = usePendingPageLayout(documentKey, loading || error !== undefined)
  useEffect(() => { setError(undefined) }, [selection, ready])
  useEffect(() => {
    if (!ready) { setSnapshot(undefined); return }
    const controller = new AbortController()
    setLoading(true)
    void request('knowledge.documents.read', { knowledgeBaseId, documentId, page, size: 20 }, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      const result = knowledgePage(value, fragment)
      if (result.page !== page || result.size !== 20 || result.items.some(item => item.documentId !== documentId)
        || new Set(result.items.map(item => item.id)).size !== result.items.length) throw new Error('Mismatched indexed passages')
      preserveReadFocus()
      setPagination({ documentKey, total: result.total, page })
      if (page > 1 && (page - 1) * 20 >= result.total) { setPage(Math.max(1, Math.ceil(result.total / 20))); return }
      setSnapshot({ selection, value: result })
      setError(undefined)
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return
      preserveReadFocus()
      setSnapshot(undefined); setError(failure)
      if (isKnowledgeAccessDenied(failure)) onAccessDenied(failure)
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [request, knowledgeBaseId, documentId, documentKey, page, ready, revision, refreshRevision,
    onAccessDenied, selection, preserveReadFocus])
  return <section ref={content} tabIndex={-1} className={css.knowledgeParsedContent} aria-label={t('knowledgeParsedContent')} aria-busy={ready && loading}>
    <p className={css.knowledgeLocator}>{t(ready ? 'knowledgeParsedContentHint' : 'knowledgeContentNotReady')}</p>
    {ready && <><div ref={pageLayout.area} style={pageLayout.style} className={css.knowledgePageBody}>
      {loading && data === undefined && error === undefined && pageLayout.style === undefined && <ProductLoading label={t('loading')} />}
      {error !== undefined && <div role="alert" className={css.knowledgeDirectoryError}><p>{productErrorMessage(error, t, 'knowledgeReadFailed')}</p><Button variant="outline" size="sm"
        aria-disabled={loading} aria-busy={loading} className={loading ? 'product-control-pending' : undefined}
        onClick={() => {
          if (loading) return
          setLoading(true); setRevision(value => value === revision ? revision + 1 : value)
        }}>{t('retry')}</Button></div>}
      {data?.items.length === 0 && <p role="status">{t('knowledgeNoContent')}</p>}
      {data?.items.map((item, index) => <article key={item.id} className={css.knowledgeParsedPassage}>
        <h2>{t('knowledgeFragmentNumber').replace('{number}', String((page - 1) * 20 + index + 1))}
          {item.locator && <span>{item.locator}</span>}</h2>
        <div className={css.markdown}><MarkdownText text={item.content} labels={markdownLabels(t)} /></div>
      </article>)}
    </div>
    {total > 20 && <nav className={css.knowledgePagination} aria-label={t('knowledgeParsedContent')} aria-busy={loading}>
      <span>{t('itemCount').replace('{count}', String(total))}</span><div>
        <Button variant="ghost" size="sm" className={loading && pagination && pagination.page > 1 ? 'product-control-pending' : undefined} aria-disabled={loading || page <= 1} aria-label={t('previousPage')}
          onClick={() => {
            if (loading || page <= 1) return
            pageLayout.reserve()
            setLoading(true); setPage(current => current === page ? page - 1 : current)
          }}><IconChevronLeftOutlineRegular size={16} /></Button>
        <span>{t('knowledgePageCount').replace('{page}', String(page)).replace('{pages}', String(pages))}</span>
        <Button variant="ghost" size="sm" className={loading && pagination && pagination.page < pages ? 'product-control-pending' : undefined} aria-disabled={loading || page >= pages} aria-label={t('nextPage')}
          onClick={() => {
            if (loading || page >= pages) return
            pageLayout.reserve()
            setLoading(true); setPage(current => current === page ? page + 1 : current)
          }}><IconChevronRightOutlineRegular size={16} /></Button>
      </div></nav>}
    </>}
  </section>
}
