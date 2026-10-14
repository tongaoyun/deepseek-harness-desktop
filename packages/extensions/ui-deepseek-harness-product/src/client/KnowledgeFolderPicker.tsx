/** Paginated destination browsing owns its reads rather than borrowing the sidebar cache. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconFolderOpenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { knowledgeFolder, knowledgePage, useKnowledgeRequests, type KnowledgeFolder, type KnowledgePage } from './knowledge-data.ts'
import { useKnowledgeFolderLocation } from './knowledge-folder-location.ts'
import { productErrorMessage } from './product-errors.ts'

/** Browse any authorized folder page and select its exact path.
 * @param props Library, selected destination, readiness, and localized labels.
 * @returns An inline directory browser with root and ancestor navigation.
 */
export function KnowledgeFolderPicker({ knowledgeBaseId, label, value, disabled, onChange, onReady, t }: {
  readonly knowledgeBaseId: string
  readonly label: string
  readonly value: string | null
  readonly disabled: boolean
  readonly onChange: (id: string | null) => void
  readonly onReady: (ready: boolean) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const request = useKnowledgeRequests()
  const [page, setPage] = useState({ parentId: value, number: 1 })
  const currentPage = page.parentId === value ? page.number : 1
  const [retry, setRetry] = useState(0)
  const location = useKnowledgeFolderLocation(knowledgeBaseId, value, String(retry))
  const key = JSON.stringify([knowledgeBaseId, value, currentPage, retry])
  const [result, setResult] = useState<{ key: string; data?: KnowledgePage<KnowledgeFolder>; failure?: unknown }>()
  const current = result?.key === key ? result : undefined
  useEffect(() => {
    const controller = new AbortController()
    void request('knowledge.folders.list', { knowledgeBaseId, parentId: value, page: currentPage, size: 20 }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return
        const data = knowledgePage(response, knowledgeFolder)
        if (data.items.some(folder => folder.parentId !== value || folder.id === value)) throw new Error('Invalid knowledge folder branch')
        const last = Math.max(1, Math.ceil(data.total / data.size))
        if (currentPage > last) { setPage({ parentId: value, number: last }); return }
        setResult({ key, data })
      }).catch((failure: unknown) => { if (!controller.signal.aborted) setResult({ key, failure }) })
    return () => { controller.abort() }
  }, [request, knowledgeBaseId, value, currentPage, key])
  const ready = location.trail !== undefined && current?.data !== undefined
  useEffect(() => { onReady(ready); return () => { onReady(false) } }, [ready, onReady])
  const failure = location.failure ?? current?.failure
  const pages = Math.max(1, Math.ceil((current?.data?.total ?? 0) / 20))
  return <fieldset className={css.knowledgeFolderPicker} disabled={disabled} aria-label={label}>
    <legend>{label}</legend>
    <nav className={css.knowledgeWorkspaceBreadcrumb} aria-label={label}>
      <button type="button" disabled={value === null} aria-current={value === null ? 'page' : undefined} onClick={() => { onChange(null) }}>{t('knowledgeRootFolder')}</button>
      {location.trail?.map(folder => <span key={folder.id} className={css.knowledgeBreadcrumbPart}>
        <IconChevronRightOutlineRegular size={14} /><button type="button" disabled={folder.id === value} aria-current={folder.id === value ? 'page' : undefined}
          onClick={() => { onChange(folder.id) }}>{folder.name}</button></span>)}
    </nav>
    {failure !== undefined ? <p role="alert" className={css.catalogError}>{productErrorMessage(failure, t, 'knowledgeFoldersFailed')}
      <Button size="sm" onClick={() => { setRetry(number => number + 1) }}>{t('retry')}</Button></p>
      : !current || location.loading ? <p role="status">{t('loading')}</p> : <>
        <div className={css.knowledgeFolderPickerRows}>{current.data?.items.map(folder => <button type="button" key={folder.id}
          className={css.knowledgeWorkspaceTreeRow} onClick={() => { onChange(folder.id) }}>
          <IconFolderOpenOutlineRegular size={16} /><span className={css.knowledgeWorkspaceTreeLabel}>{folder.name}</span>
          <IconChevronRightOutlineRegular size={14} /></button>)}</div>
        {pages > 1 && <div className={css.knowledgePagination}>
          <Button size="sm" disabled={currentPage === 1} aria-label={t('previousPage')} onClick={() => { setPage({ parentId: value, number: currentPage - 1 }) }}><IconChevronLeftOutlineRegular size={14} /></Button>
          <span>{currentPage} / {pages}</span>
          <Button size="sm" disabled={currentPage >= pages} aria-label={t('nextPage')} onClick={() => { setPage({ parentId: value, number: currentPage + 1 }) }}><IconChevronRightOutlineRegular size={14} /></Button>
        </div>}
      </>}
  </fieldset>
}
