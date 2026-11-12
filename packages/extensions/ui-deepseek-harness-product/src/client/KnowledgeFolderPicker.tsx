/** Paginated destination browsing owns its reads rather than borrowing the sidebar cache. */
import { ProductLoading } from './ProductLoading.tsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconFolderOpenOutlineRegular, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { knowledgeFolder, knowledgePage, useKnowledgeRequests, type KnowledgeFolder, type KnowledgePage } from './knowledge-data.ts'
import { useKnowledgeFolderLocation } from './knowledge-folder-location.ts'
import { productErrorMessage } from './product-errors.ts'
import { usePendingPageLayout } from './usePendingPageLayout.ts'
import { useResultFocus } from './useResultFocus.ts'

/** Browse verified destinations; pending saves preserve control appearance, while locked destinations retain disabled styling.
 * Directory navigation and removed retry or pagination controls hand their owned focus to the picker without scrolling.
 * @param props Library, selected destination, readiness, and localized labels.
 * @returns An inline directory browser with root and ancestor navigation.
 */
export function KnowledgeFolderPicker({ knowledgeBaseId, label, value, disabled, pending, onChange, onReady, t }: {
  readonly knowledgeBaseId: string
  readonly label: string
  readonly value: string | null
  readonly disabled: boolean
  readonly pending: boolean
  readonly onChange: (id: string | null) => void
  readonly onReady: (ready: boolean) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const picker = useRef<HTMLFieldSetElement>(null)
  const preserveReadFocus = useResultFocus(picker, picker)
  const [page, setPage] = useState({ parentId: value, number: 1 })
  const currentPage = page.parentId === value ? page.number : 1
  const [retry, setRetry] = useState(0)
  const scope = JSON.stringify([knowledgeBaseId, value])
  const [pagination, setPagination] = useState<{ scope: string; total: number; page: number }>()
  const location = useKnowledgeFolderLocation(knowledgeBaseId, value, String(retry), preserveReadFocus)
  const selection = JSON.stringify([knowledgeBaseId, value, currentPage])
  const key = JSON.stringify([selection, retry])
  const [result, setResult] = useState<{ key: string; selection: string; data?: KnowledgePage<KnowledgeFolder>; failure?: unknown }>()
  const current = result?.key === key ? result : undefined
  useEffect(() => {
    const controller = new AbortController()
    void request('knowledge.folders.list', { knowledgeBaseId, parentId: value, page: currentPage, size: 20 }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return
        const data = knowledgePage(response, knowledgeFolder)
        if (data.page !== currentPage || data.size !== 20 || new Set(data.items.map(folder => folder.id)).size !== data.items.length) {
          throw new Error('Invalid knowledge folder page')
        }
        if (data.items.some(folder => folder.parentId !== value || folder.id === value)) throw new Error('Invalid knowledge folder branch')
        preserveReadFocus()
        setPagination({ scope, total: data.total, page: currentPage })
        const last = Math.max(1, Math.ceil(data.total / data.size))
        if (currentPage > last) { setPage({ parentId: value, number: last }); return }
        setResult(previous => ({ key, selection, data,
          ...previous?.selection === selection && previous.failure !== undefined ? { failure: previous.failure } : {} }))
      }).catch((failure: unknown) => {
        if (!controller.signal.aborted) { preserveReadFocus(); setResult({ key, selection, failure }) }
      })
    return () => { controller.abort() }
  }, [request, knowledgeBaseId, value, currentPage, key, selection, scope, preserveReadFocus])
  const loading = current === undefined || location.loading
  const ready = !loading && location.trail !== undefined && current.data !== undefined
  useEffect(() => { onReady(ready); return () => { onReady(false) } }, [ready, onReady])
  const failure = ready ? undefined : location.failure ?? (result?.selection === selection ? result.failure : undefined)
  const total = pagination?.scope === scope ? pagination.total : 0
  const pages = Math.max(1, Math.ceil(total / 20))
  const pageLayout = usePendingPageLayout(scope, loading || failure !== undefined)
  const navigate = (id: string | null, trigger: HTMLButtonElement): void => {
    if (disabled || pending || id === value) return
    if (picker.current && trigger.ownerDocument.activeElement === trigger) {
      focusWithoutRing(picker.current, { preventScroll: true })
    }
    onChange(id)
  }
  return <fieldset ref={picker} tabIndex={-1} className={`${css.knowledgeFolderPicker}${pending && !disabled ? ` ${css.knowledgeFolderPickerPending}` : ''}`}
    disabled={disabled || pending} aria-label={label} aria-busy={loading || pending}>
    <legend>{label}</legend>
    <nav className={css.knowledgeWorkspaceBreadcrumb} aria-label={label}>
      <button type="button" disabled={value === null} aria-current={value === null ? 'page' : undefined} onClick={(event) => { navigate(null, event.currentTarget) }}>{t('knowledgeRootFolder')}</button>
      {location.trail?.map(folder => <span key={folder.id} className={css.knowledgeBreadcrumbPart}>
        <IconChevronRightOutlineRegular size={14} /><button type="button" disabled={folder.id === value} aria-current={folder.id === value ? 'page' : undefined}
          onClick={(event) => { navigate(folder.id, event.currentTarget) }}>{folder.name}</button></span>)}
    </nav>
    <div ref={pageLayout.area} style={pageLayout.style} className={css.knowledgePageBody}>
      {failure !== undefined ? <p role="alert" className={css.catalogError}>{productErrorMessage(failure, t, 'knowledgeFoldersFailed')}
        <Button size="sm" aria-disabled={loading} aria-busy={loading} className={loading ? 'product-control-pending' : undefined}
          onClick={() => {
            if (disabled || pending || loading) return
            setRetry(number => number === retry ? retry + 1 : number)
          }}>{t('retry')}</Button></p>
        : !current || location.loading ? pageLayout.style === undefined && <ProductLoading label={t('loading')} /> : <>
          <div className={css.knowledgeFolderPickerRows}>{current.data?.items.map(folder => <Button variant="ghost" key={folder.id}
            className={css.knowledgeFolderPickerRow} onClick={(event) => { navigate(folder.id, event.currentTarget) }}>
            <IconFolderOpenOutlineRegular size={16} /><span className={css.knowledgeFolderPickerLabel}>{folder.name}</span>
            <IconChevronRightOutlineRegular size={14} /></Button>)}</div>
        </>}
    </div>
    {pages > 1 && <div className={css.knowledgePagination} aria-busy={loading}>
      <Button size="sm" className={loading && pagination && pagination.page > 1 ? 'product-control-pending' : undefined}
        aria-disabled={loading || currentPage === 1} aria-label={t('previousPage')} onClick={() => {
          if (disabled || pending || loading || currentPage === 1) return
          pageLayout.reserve()
          setPage(current => current === page ? { parentId: value, number: currentPage - 1 } : current)
        }}><IconChevronLeftOutlineRegular size={14} /></Button>
      <span>{currentPage} / {pages}</span>
      <Button size="sm" className={loading && pagination && pagination.page < pages ? 'product-control-pending' : undefined}
        aria-disabled={loading || currentPage >= pages} aria-label={t('nextPage')} onClick={() => {
          if (disabled || pending || loading || currentPage >= pages) return
          pageLayout.reserve()
          setPage(current => current === page ? { parentId: value, number: currentPage + 1 } : current)
        }}><IconChevronRightOutlineRegular size={14} /></Button>
    </div>}
  </fieldset>
}
