/** Conversation-owned knowledge selection, committed once through task preparation. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useEffect, useRef, useState } from 'react'
import { productFailure, type ProductFailure } from '@deepseek-harness/product/errors'
import type { ProductTaskCapabilities } from '@deepseek-harness/product/protocol'
import { Button, Checkbox, IconCloseOutlineRegular, IconDatabaseOutlineRegular, IconSearchOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import type { ProductItem } from './catalog-shared.tsx'
import type { TaskModeActions } from './harness-actions.ts'
import { productErrorMessage } from './product-errors.ts'
import { ProductLoading } from './ProductLoading.tsx'
import { useResultFocus } from './useResultFocus.ts'
import css from '../DeepSeekHarnessProduct.module.css'

/** Select optional knowledge while preserving failed drafts.
 * Catalog regrouping retains each knowledge base's checkbox, focus, and staged selection.
 * Removed catalog retries or options return their owned focus to search without scrolling.
 * @param props Current task scope, catalog access, and serialized preparation actions.
 * @returns Referenced knowledge tags and a staged multi-selection dialog opened by the Add menu.
 */
export function TaskKnowledgeSelector({
  sessionId, recoverCapabilities, retryCapabilities, capabilities, readKnowledgeCatalog, setKnowledgeSelection,
  openCatalog, onApplied, subscribeOpen, refreshRevision = 0, t,
}: {
  readonly sessionId?: SessionId | undefined
  readonly recoverCapabilities: TaskModeActions['recoverCapabilities']
  readonly retryCapabilities: TaskModeActions['retryCapabilities']
  readonly capabilities: ProductTaskCapabilities | undefined
  readonly readKnowledgeCatalog: TaskModeActions['readKnowledgeCatalog']
  readonly setKnowledgeSelection: TaskModeActions['setKnowledgeSelection']
  readonly openCatalog: TaskModeActions['openCatalog']
  readonly onApplied: () => void
  readonly subscribeOpen: (listener: () => void) => () => void
  readonly refreshRevision?: number
  readonly t: (key: DeepSeekHarnessProductKey, params?: Record<string, unknown>) => string
}) {
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<readonly ProductItem[]>()
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<ProductFailure>()
  const [pending, setPending] = useState(false)
  const preparation = useRef<Promise<void>>()
  const [failed, setFailed] = useState<ProductFailure>()
  const [selected, setSelected] = useState<readonly string[]>([])
  const [query, setQuery] = useState('')
  const catalogControls = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const preserveReadFocus = useResultFocus(catalogControls, search)
  const [revision, setRevision] = useState(0)
  const [openRequests, setOpenRequests] = useState(0)
  const consumedRequests = useRef(0)
  const loadFailed = loadError !== undefined
  const failureMessage = failed === undefined ? undefined
    : `${productErrorMessage(failed, t, 'knowledgeSelectionFailed')} ${failed.resources.map(row => row.id).join(', ')}`.trim()
  const ids = capabilities?.knowledgeBaseIds ?? []
  const identity = ids.join('\n')
  const selectionKey = JSON.stringify([
    sessionId, capabilities?.basePresetId, ids,
  ])
  const activeKey = useRef(selectionKey)
  activeKey.current = selectionKey
  useEffect(() => () => { activeKey.current = ''; preparation.current = undefined }, [])
  useEffect(() => {
    consumedRequests.current = openRequests
  }, [sessionId])
  useEffect(() => {
    preparation.current = undefined
    setOpen(false)
    setFailed(undefined)
    setLoadError(undefined)
    setPending(false)
  }, [selectionKey])
  useEffect(() => {
    return subscribeOpen(() => {
      if (preparation.current !== undefined) return
      setOpenRequests(value => value + 1)
    })
  }, [subscribeOpen])
  useEffect(() => {
    if (capabilities === undefined || consumedRequests.current === openRequests || pending) return
    consumedRequests.current = openRequests
    setSelected([...ids]); setQuery(''); setFailed(undefined); setLoading(true); setOpen(true)
  }, [openRequests, selectionKey, capabilities === undefined, pending])
  useEffect(() => {
    if (!open && identity === '') return
    let active = true
    const controller = new AbortController()
    setLoading(true)
    void readKnowledgeCatalog(controller.signal).then((value) => { if (active) {
      preserveReadFocus()
      setCatalog(value)
      setLoadError(undefined)
    } })
      .catch((error: unknown) => { if (active) {
        preserveReadFocus()
        setCatalog(undefined)
        setLoadError(productFailure(error))
      } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [open, identity, readKnowledgeCatalog, revision, refreshRevision, preserveReadFocus])
  const options: readonly (Partial<ProductItem> & Pick<ProductItem, 'id' | 'label'>)[] = [
    ...catalog ?? [], ...[...new Set([...ids, ...selected])]
      .filter(id => !catalog?.some(row => row.id === id)).map(id => ({ id, label: id })),
  ]
  const unavailable = catalog !== undefined && !loadFailed && ids.some(id => !catalog.some(row => row.id === id))
  const changed = selected.length !== ids.length || selected.some(id => !ids.includes(id))
  const filtered = options.filter(row => `${row.label} ${row.description ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const sections = [...new Set(filtered.map(row => row.scope === 'DEPARTMENT' ? `DEPARTMENT:${row.ownerDepartmentId}` : row.scope ?? 'UNAVAILABLE'))]
    .sort((left, right) => ['PERSONAL', 'DEPARTMENT', 'COMPANY', 'UNAVAILABLE'].indexOf(left.split(':')[0] ?? '')
      - ['PERSONAL', 'DEPARTMENT', 'COMPANY', 'UNAVAILABLE'].indexOf(right.split(':')[0] ?? ''))
    .map(key => ({ key, rows: filtered.filter(row => (row.scope === 'DEPARTMENT' ? `DEPARTMENT:${row.ownerDepartmentId}` : row.scope ?? 'UNAVAILABLE') === key) }))
  const apply = (run: () => Promise<void>) => {
    if (preparation.current !== undefined) return
    const captured = selectionKey
    const operation = Promise.resolve().then(() => {
      if (preparation.current === operation && activeKey.current === captured) return run()
    })
    preparation.current = operation
    const current = () => preparation.current === operation && activeKey.current === captured
    setPending(true)
    void operation.then(() => { if (current()) { setFailed(undefined); setOpen(false); onApplied() } })
      .catch((error: unknown) => { if (current()) {
        setFailed(productFailure(error))
      } }).finally(() => { if (current()) { preparation.current = undefined; setPending(false) } })
  }
  return <>
    {ids.length > 0 && <div className={css.taskKnowledgeReferences} role="group" aria-label={t('taskKnowledge')} aria-busy={pending}>
      {ids.map((id) => {
        const label = catalog?.find(row => row.id === id)?.label ?? id
        return <span className={css.taskKnowledgeReference} key={id}>
          <Tooltip label={label} side="top"><button className={`${css.knowledgeReferenceName}${pending ? ' product-control-pending' : ''}`} type="button"
            aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-disabled={pending}
            onClick={() => { if (preparation.current === undefined) { setSelected([...ids]); setQuery(''); setFailed(undefined); setLoading(true); setOpen(true) } }}>
            <IconDatabaseOutlineRegular size={14} /><span>{label}</span>
          </button></Tooltip>
          {<Tooltip label={t('removeKnowledgeReference', { name: label })} side="top">
            <button className={`${css.knowledgeReferenceRemove}${pending ? ' product-control-pending' : ''}`} type="button" aria-disabled={pending}
              aria-label={t('removeKnowledgeReference', { name: label })} onClick={() => {
                apply(() => setKnowledgeSelection(ids.filter(value => value !== id), sessionId))
              }}><IconCloseOutlineRegular size={12} /></button>
          </Tooltip>}
        </span>
      })}
    </div>}
    {!open && failureMessage !== undefined && <span role="alert" className={css.catalogError}>{failureMessage}</span>}
    <Modal open={open} onClose={() => { if (preparation.current === undefined) setOpen(false) }} title={t('taskKnowledge')}
      closeLabel={t('close')} className={`${css.detailModal} ${css.knowledgeSelectionModal}`} contentClassName={css.detailModalContent as string}>
      <label className={`${css.searchField} ${css.knowledgeSelectionSearch}`}>
        <IconSearchOutlineRegular size={16} /><span className={css.visuallyHidden}>{t('knowledgeSelectionSearch')}</span>
        <input ref={search} type="search" placeholder={t('knowledgeSelectionSearch')} value={query} onChange={(event) => { setQuery(event.currentTarget.value) }} />
      </label>
      <div ref={catalogControls} className={css.knowledgeSelectionList} aria-busy={loading}>
        {loadFailed ? <div className={css.knowledgeSelectionError}><p role="alert" className={css.catalogError}>{productErrorMessage(loadError, t, 'loadFailed')}</p>
          <Button variant="outline" size="sm" className={loading ? 'product-control-pending' : undefined} aria-disabled={loading}
            aria-busy={loading} onClick={() => {
              if (loading) return
              setLoading(true); setRevision(value => value === revision ? revision + 1 : value)
            }}>{t('retry')}</Button></div>
          : loading && catalog === undefined ? <ProductLoading label={t('loading')} />
            : filtered.length === 0 ? <p className={css.catalogStatus}>{t(query.trim() === '' ? 'empty' : 'noSearchResults')}</p>
              : sections.flatMap(({ key, rows }) => [
                <h3 className={css.knowledgeSelectionGroup} key={`group:${key}`}>{key.startsWith('DEPARTMENT:')
                  ? `${t('scopeDepartment')} · ${rows[0]?.ownerName ?? ''} (${rows[0]?.ownerDepartmentId ?? ''})`
                  : key === 'PERSONAL' ? t('scopePersonal') : key === 'COMPANY' ? t('scopeCompany') : t('otherKnowledge')}</h3>,
                ...rows.map(row => <div className={css.knowledgeSelectionRow} key={`knowledge:${row.id}`}>
                  <Checkbox className={css.knowledgeSelectionCheckbox} label={row.label} checked={selected.includes(row.id)}
                    disabled={pending} onChange={(checked) => {
                      if (preparation.current !== undefined) return
                      preserveReadFocus()
                      setFailed(undefined)
                      setSelected(value => checked ? [...value, row.id] : value.filter(id => id !== row.id))
                    }} />
                  {!catalog?.some(item => item.id === row.id) && <span className={css.knowledgeSelectionMeta}>{t('statusUnavailable')}</span>}
                </div>),
              ])}
      </div>
      {(unavailable || capabilities?.unavailable !== undefined) && !loadFailed && <Button variant="outline" size="sm"
        className={pending || loading ? 'product-control-pending' : undefined} aria-disabled={pending || loading} aria-busy={pending} onClick={() => {
          if (!loading) apply(() => capabilities?.unavailable?.retryable ? retryCapabilities(sessionId) : recoverCapabilities(sessionId))
        }}>{t(capabilities?.unavailable?.retryable ? 'retry' : capabilities?.unavailable === undefined ? 'knowledgeRecovery' : 'taskRecovery')}</Button>}
      {failureMessage !== undefined && <p role="alert" className={css.catalogError}>{failureMessage}</p>}
      <div className={css.knowledgeSelectionFooter}>
        <Button variant="ghost" size="sm" className={pending ? 'product-control-pending' : undefined} aria-disabled={pending} onClick={() => { if (preparation.current === undefined) { setOpen(false); openCatalog('knowledge') } }}>{t('knowledgeDirectory')}</Button>
        <div><Button variant="ghost" size="sm" className={pending ? 'product-control-pending' : undefined} aria-disabled={pending} onClick={() => { if (preparation.current === undefined) setOpen(false) }}>{t('cancel')}</Button>
          <Button variant="primary" size="sm" className={capabilities !== undefined && !loadFailed && changed && (pending || loading) ? 'product-control-pending' : undefined}
            disabled={capabilities === undefined || loadFailed || !changed}
            aria-disabled={capabilities === undefined || pending || loading || loadFailed || !changed} aria-busy={pending} onClick={() => {
              if (capabilities !== undefined && !loading && !loadFailed && changed) apply(() => setKnowledgeSelection(selected, sessionId))
            }}>{t(pending ? 'applyingKnowledge' : 'applyKnowledge')}</Button></div>
      </div>
    </Modal>
  </>
}
