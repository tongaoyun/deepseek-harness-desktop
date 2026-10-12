/** Conversation-owned knowledge selection, committed once through task preparation. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useEffect, useRef, useState } from 'react'
import { productFailure } from '@deepseek-harness/product/errors'
import type { ProductTaskCapabilities } from '@deepseek-harness/product/protocol'
import { Button, Checkbox, IconCloseOutlineRegular, IconDatabaseOutlineRegular, IconSearchOutlineRegular, IconSparkleRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import type { ProductItem } from './catalog-shared.tsx'
import type { TaskModeActions } from './harness-actions.ts'
import { productErrorMessage } from './product-errors.ts'
import css from '../DeepSeekHarnessProduct.module.css'

/** Select optional knowledge while keeping kit dependencies locked and failed drafts intact.
 * @param props Current task scope, catalog access, and serialized preparation actions.
 * @returns Referenced knowledge tags and a staged multi-selection dialog opened by the Add menu.
 */
export function TaskKnowledgeSelector({
  sessionId, recoverCapabilities, capabilities, readKnowledgeCatalog, setKnowledgeSelection,
  openCatalog, onApplied, onPendingChange, subscribeOpen, t, disabled = false,
}: {
  readonly sessionId?: SessionId | undefined
  readonly recoverCapabilities: TaskModeActions['recoverCapabilities']
  readonly capabilities: ProductTaskCapabilities | undefined
  readonly readKnowledgeCatalog: TaskModeActions['readKnowledgeCatalog']
  readonly setKnowledgeSelection: TaskModeActions['setKnowledgeSelection']
  readonly openCatalog: TaskModeActions['openCatalog']
  readonly onApplied: () => void
  readonly onPendingChange: (pending: boolean) => void
  readonly subscribeOpen: (listener: () => void) => () => void
  readonly t: (key: DeepSeekHarnessProductKey, params?: Record<string, unknown>) => string
  readonly disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<readonly ProductItem[]>()
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState('')
  const [selected, setSelected] = useState<readonly string[]>([])
  const [query, setQuery] = useState('')
  const [revision, setRevision] = useState(0)
  const [openRequests, setOpenRequests] = useState(0)
  const consumedRequests = useRef(0)
  const loadFailed = loadError !== ''
  const ids = capabilities?.knowledgeBaseIds ?? []
  const identity = ids.join('\n')
  const selectionKey = JSON.stringify([
    sessionId, capabilities?.basePresetId, capabilities?.expertKit, ids, capabilities?.requiredKnowledgeBaseIds,
  ])
  const activeKey = useRef(selectionKey)
  activeKey.current = selectionKey
  useEffect(() => () => { activeKey.current = '' }, [])
  useEffect(() => {
    consumedRequests.current = openRequests
  }, [sessionId])
  useEffect(() => {
    setOpen(false)
    setFailed('')
    setPending(false)
  }, [selectionKey])
  useEffect(() => {
    return subscribeOpen(() => {
      if (disabled || pending) return
      setOpenRequests(value => value + 1)
    })
  }, [subscribeOpen, disabled, pending])
  useEffect(() => {
    if (capabilities === undefined || consumedRequests.current === openRequests || disabled || pending) return
    consumedRequests.current = openRequests
    setSelected([...ids]); setQuery(''); setFailed(''); setOpen(true)
  }, [openRequests, selectionKey, capabilities === undefined, disabled, pending])
  useEffect(() => {
    if (!open && identity === '') return
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setLoadError('')
    void readKnowledgeCatalog(controller.signal).then((value) => { if (active) setCatalog(value) })
      .catch((error: unknown) => { if (active) {
        setLoadError(productErrorMessage(error, t, 'loadFailed'))
      } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [open, identity, readKnowledgeCatalog, revision])
  const options: readonly (Partial<ProductItem> & Pick<ProductItem, 'id' | 'label'>)[] = [
    ...catalog ?? [], ...ids.filter(id => !catalog?.some(row => row.id === id)).map(id => ({ id, label: id })),
  ]
  const required = (row: Pick<ProductItem, 'id' | 'referenceKey' | 'reference'>) =>
    capabilities?.requiredKnowledgeBaseIds.includes(row.id) ?? false
  const unavailable = catalog !== undefined && !loadFailed && ids.some(id => !catalog.some(row => row.id === id))
  const changed = selected.length !== ids.length || selected.some(id => !ids.includes(id))
  const filtered = options.filter(row => `${row.label} ${row.description ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const sections = [...new Set(filtered.map(row => row.scope === 'DEPARTMENT' ? `DEPARTMENT:${row.ownerDepartmentId}` : row.scope ?? 'UNAVAILABLE'))]
    .sort((left, right) => ['PERSONAL', 'DEPARTMENT', 'COMPANY', 'UNAVAILABLE'].indexOf(left.split(':')[0] ?? '')
      - ['PERSONAL', 'DEPARTMENT', 'COMPANY', 'UNAVAILABLE'].indexOf(right.split(':')[0] ?? ''))
    .map(key => ({ key, rows: filtered.filter(row => (row.scope === 'DEPARTMENT' ? `DEPARTMENT:${row.ownerDepartmentId}` : row.scope ?? 'UNAVAILABLE') === key) }))
  const apply = (operation: Promise<void>) => {
    const captured = selectionKey
    setPending(true); setFailed(''); onPendingChange(true)
    void operation.then(() => { if (activeKey.current === captured) { setOpen(false); onApplied() } })
      .catch((error: unknown) => { if (activeKey.current === captured) {
        const failure = productFailure(error)
        setFailed(`${productErrorMessage(error, t, 'knowledgeSelectionFailed')} ${failure.resources.map(row => row.id).join(', ')}`.trim())
      } }).finally(() => { if (activeKey.current === captured) { setPending(false); onPendingChange(false) } })
  }
  return <>
    {ids.length > 0 && <div className={css.taskKnowledgeReferences} role="group" aria-label={t('taskKnowledge')}>
      {ids.map((id) => {
        const label = catalog?.find(row => row.id === id)?.label ?? id
        const locked = capabilities?.requiredKnowledgeBaseIds.includes(id) ?? false
        return <span className={css.taskKnowledgeReference} key={id}>
          <Tooltip label={label} side="top"><button className={css.knowledgeReferenceName} type="button"
            aria-label={label} aria-haspopup="dialog" aria-expanded={open} disabled={disabled || pending}
            onClick={() => { setSelected([...ids]); setQuery(''); setFailed(''); setOpen(true) }}>
            <IconDatabaseOutlineRegular size={14} /><span>{label}</span>
          </button></Tooltip>
          {locked ? <Tooltip label={t('kitRequiredKnowledge')} side="top">
            <span className={css.knowledgeReferenceRequired} aria-label={t('kitRequiredKnowledge')}><IconSparkleRegular size={13} /></span>
          </Tooltip> : <Tooltip label={t('removeKnowledgeReference', { name: label })} side="top">
            <button className={css.knowledgeReferenceRemove} type="button" disabled={disabled || pending}
              aria-label={t('removeKnowledgeReference', { name: label })} onClick={() => {
                apply(setKnowledgeSelection(ids.filter(value => value !== id), sessionId))
              }}><IconCloseOutlineRegular size={12} /></button>
          </Tooltip>}
        </span>
      })}
    </div>}
    {!open && failed && <span role="alert" className={css.catalogError}>{failed}</span>}
    <Modal open={open} onClose={() => { if (!pending) setOpen(false) }} title={t('taskKnowledge')}
      closeLabel={t('close')} className={`${css.detailModal} ${css.knowledgeSelectionModal}`} contentClassName={css.detailModalContent as string}>
      <label className={`${css.searchField} ${css.knowledgeSelectionSearch}`}>
        <IconSearchOutlineRegular size={16} /><span className={css.visuallyHidden}>{t('knowledgeSelectionSearch')}</span>
        <input type="search" placeholder={t('knowledgeSelectionSearch')} value={query} onChange={(event) => { setQuery(event.currentTarget.value) }} />
      </label>
      <div className={css.knowledgeSelectionList} aria-busy={loading}>
        {loading ? <p className={css.catalogStatus}>{t('loading')}</p>
          : loadFailed ? <div className={css.knowledgeSelectionError}><p role="alert" className={css.catalogError}>{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => { setRevision(value => value + 1) }}>{t('retry')}</Button></div>
            : filtered.length === 0 ? <p className={css.catalogStatus}>{t(query.trim() === '' ? 'empty' : 'noSearchResults')}</p>
              : sections.map(({ key, rows }) => <section className={css.knowledgeSelectionGroup} key={key}>
                <h3>{key.startsWith('DEPARTMENT:')
                  ? `${t('scopeDepartment')} · ${rows[0]?.ownerName ?? ''} (${rows[0]?.ownerDepartmentId ?? ''})`
                  : key === 'PERSONAL' ? t('scopePersonal') : key === 'COMPANY' ? t('scopeCompany') : t('otherKnowledge')}</h3>
                {rows.map(row => <div className={css.knowledgeSelectionRow} key={row.id}>
                  <Checkbox className={css.knowledgeSelectionCheckbox} label={row.label} checked={selected.includes(row.id)}
                    disabled={pending || required(row)} onChange={(checked) => {
                      setFailed('')
                      setSelected(value => checked ? [...value, row.id] : value.filter(id => id !== row.id))
                    }} />
                  {required(row) ? <span className={css.knowledgeSelectionMeta}>{t('kitRequiredKnowledge')}</span>
                    : !catalog?.some(item => item.id === row.id) && <span className={css.knowledgeSelectionMeta}>{t('statusUnavailable')}</span>}
                </div>)}</section>)}
      </div>
      {(unavailable || capabilities?.unavailable !== undefined) && !loadFailed && <Button variant="outline" size="sm" disabled={pending || loading} onClick={() => {
        apply(recoverCapabilities(sessionId))
      }}>{t(capabilities?.unavailable === undefined ? 'knowledgeRecovery' : 'taskRecovery')}</Button>}
      {failed && <p role="alert" className={css.catalogError}>{failed}</p>}
      <div className={css.knowledgeSelectionFooter}>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => { setOpen(false); openCatalog('knowledge') }}>{t('knowledgeDirectory')}</Button>
        <div><Button variant="ghost" size="sm" disabled={pending} onClick={() => { setOpen(false) }}>{t('cancel')}</Button>
          <Button variant="primary" size="sm" disabled={disabled || capabilities === undefined || pending || loading || loadFailed || !changed} onClick={() => {
            apply(setKnowledgeSelection(selected, sessionId))
          }}>{t(pending ? 'applyingKnowledge' : 'applyKnowledge')}</Button></div>
      </div>
    </Modal>
  </>
}
