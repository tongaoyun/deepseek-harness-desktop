/** Organization libraries and their materials share one navigation and reading surface. */
import { useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconDatabaseOutlineRegular, IconEllipsisOutlineRegular, IconFolderOpenOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular, Menu, Modal, Tooltip, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { localDetail, localizedMetadata, type ProductItem } from './catalog-shared.tsx'
import { KnowledgeDocuments } from './KnowledgeDocuments.tsx'
import { KnowledgeBaseEditor } from './KnowledgeBaseEditor.tsx'
import { useKnowledgeRequests } from './knowledge-data.ts'
import { productErrorMessage } from './product-errors.ts'

/** Browse authorized library trees and read materials without opening a task.
 * @param props The authenticated catalog state and directory refresh commands.
 * @returns A grouped navigation tree beside the selected library's materials.
 */
export function KnowledgeWorkspace({ entries, loading, refreshRevision = 0, error,
  authRequired, authPending, authError, onRefresh, onSignIn, renderFactorySlot, t }: PropsRenderFactories & {
    readonly entries: readonly ProductItem[]
    readonly loading: boolean
    readonly refreshRevision?: number
    readonly error?: string
    readonly authRequired: boolean
    readonly authPending: boolean
    readonly authError: boolean
    readonly onRefresh: () => void
    readonly onSignIn: () => void
    readonly t: (key: DeepSeekHarnessProductKey) => string
  }): ReactNode {
  const [selectedId, setSelectedId] = useState<string>()
  const [navigationVisible, setNavigationVisible] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<ProductItem>()
  const [deletePending, setDeletePending] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const currentEntries = useRef(entries)
  currentEntries.current = entries
  const request = useKnowledgeRequests()
  const selected = entries.find(entry => entry.id === selectedId)
    ?? entries.find(entry => entry.scope === 'PERSONAL') ?? entries[0]
  const scopes = ['PERSONAL', 'DEPARTMENT', 'COMPANY',
    ...(entries.some(entry => !['PERSONAL', 'DEPARTMENT', 'COMPANY'].includes(entry.scope ?? '')) ? ['OTHER'] : [])]
  const selectLibrary = (id: string): void => { setSelectedId(id); setNavigationVisible(false) }
  const renderLibrary = (entry: ProductItem, children: ReactNode): ReactNode => <div key={entry.id} className={css.knowledgeLibraryBranch}>
    <div className={css.knowledgeLibraryHeading}>
      <button type="button" className={css.knowledgeLibraryRow} aria-current={selected?.id === entry.id ? 'page' : undefined}
        aria-expanded={selected?.id === entry.id} onClick={() => { selectLibrary(entry.id) }} title={entry.label}>
        {selected?.id === entry.id ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
        <IconDatabaseOutlineRegular size={17} /><span>{entry.label}</span>
      </button>
      {entry.scope === 'PERSONAL' && entry.canManage === true && <KnowledgeLibraryActions entry={entry} disabled={deletePending}
        onDelete={() => { setDeleteError(''); setDeleting(entry) }} t={t} />}
    </div>
    {selected?.id === entry.id && <div className={css.knowledgeLibraryMaterials}>{children}</div>}
  </div>
  const navigation = (children: ReactNode): ReactNode => <>
    <header className={css.knowledgeLibraryHeader}>
      <h1>{t('knowledge')}</h1>
      <Tooltip label={t('refresh')}><button type="button" className={css.iconButton} aria-label={t('refresh')}
        disabled={loading} onClick={onRefresh}><IconRefreshOutlineRegular size={16} /></button></Tooltip>
    </header>
    {selected && !authRequired && error !== undefined && <div role="alert" className={css.catalogError}>
      <p>{error}</p><Button variant="outline" size="sm" disabled={loading} onClick={onRefresh}>{t('retry')}</Button>
    </div>}
    <nav className={css.knowledgeLibraryGroups} aria-label={t('knowledge')} aria-busy={loading}>
      {scopes.map((scope) => {
        const values = entries.filter(entry => scope === 'OTHER'
          ? !['PERSONAL', 'DEPARTMENT', 'COMPANY'].includes(entry.scope ?? '') : entry.scope === scope)
        const groups = new Map<string, ProductItem[]>()
        for (const entry of values) {
          const duplicateName = new Set(values.filter(value => value.ownerName === entry.ownerName)
            .map(value => value.ownerDepartmentId)).size > 1
          const department = scope === 'DEPARTMENT' ? `${entry.ownerName ?? t('scopeDepartment')}${duplicateName ? ` (${entry.ownerDepartmentId ?? ''})` : ''}` : ''
          groups.set(department, [...groups.get(department) ?? [], entry])
        }
        return <section className={css.knowledgeLibraryGroup} key={scope} aria-label={scope === 'OTHER' ? t('otherKnowledge') : localizedMetadata(scope, t)}>
          <h2 className={css.knowledgeLibraryGroupHeading}><button type="button" aria-expanded={!collapsed.has(scope)} onClick={() => {
            setCollapsed((previous) => {
              const next = new Set(previous)
              if (next.has(scope)) next.delete(scope)
              else next.add(scope)
              return next
            })
          }}><span>{scope === 'OTHER' ? t('otherKnowledge') : localizedMetadata(scope, t)}</span>
            {collapsed.has(scope) ? <IconChevronRightOutlineRegular size={12} /> : <IconChevronDownOutlineRegular size={12} />}
          </button>{scope === 'PERSONAL' && !authRequired && error === undefined && <Tooltip label={t('knowledgeCreatePersonalBase')}>
            <button type="button" className={css.iconButton} aria-label={t('knowledgeCreatePersonalBase')} disabled={loading}
              onClick={() => { setCreating(true) }}><IconPlusOutlineRegular size={15} /></button></Tooltip>}</h2>
          {!collapsed.has(scope) && (values.length === 0 ? <p className={css.knowledgeLibraryEmpty}>{loading ? t('loading') : t('empty')}</p>
            : [...groups].map(([name, group]) => <div key={name}>
              {name && <h3 className={css.knowledgeDepartmentHeading}>{name}</h3>}
              {group.map(entry => renderLibrary(entry, children))}
            </div>))}
        </section>
      })}
    </nav>
  </>
  const confirmDelete = async (): Promise<void> => {
    if (deleting === undefined || deletePending) return
    setDeletePending(true); setDeleteError('')
    try {
      await request('knowledge.bases.delete', { knowledgeBaseId: deleting.id })
      setDeleting(undefined)
      setSelectedId((current) => {
        const latest = currentEntries.current
        const selected = latest.find(entry => entry.id === current)
          ?? latest.find(entry => entry.scope === 'PERSONAL') ?? latest[0]
        return selected?.id === deleting.id ? latest.find(entry => entry.id !== deleting.id)?.id : current
      })
      onRefresh()
    } catch (failure) {
      setDeleteError(productErrorMessage(failure, t, 'knowledgeDeleteBaseFailed'))
    } finally { setDeletePending(false) }
  }
  return <><section className={css.knowledgeWorkspacePage} data-knowledge-workspace data-navigation-visible={String(navigationVisible)} aria-label={t('knowledge')}>
    <header className={css.knowledgeWorkspaceMobileHeader}>
      <Tooltip label={t('knowledgeBrowse')}><button type="button" className={css.iconButton} aria-label={t('knowledgeBrowse')}
        aria-controls="knowledge-workspace-navigation" aria-expanded={navigationVisible}
        onClick={() => { setNavigationVisible(value => !value) }}><IconFolderOpenOutlineRegular size={18} /></button></Tooltip>
      <span>{selected?.label ?? t('knowledge')}</span>
    </header>
    {!authRequired && selected ? <KnowledgeDocuments key={selected.id} product={localDetail(selected)} t={t}
      refreshRevision={refreshRevision} renderFactorySlot={renderFactorySlot}
      renderNavigation={navigation} onNavigate={() => { setNavigationVisible(false) }} />
      : <div className={css.knowledgeWorkspace}>
        <aside className={css.knowledgeWorkspaceNavigation} id="knowledge-workspace-navigation" data-knowledge-navigation>{navigation(null)}</aside>
        <main className={css.knowledgeWorkspaceMain} data-knowledge-content>
          <div className={css.knowledgeWorkspaceEmpty}>
            {loading ? <p role="status">{t('loading')}</p>
              : authRequired ? <div className={css.authEmptyState} role="status" aria-live="polite">
                <div className={css.authEmptyCopy}><strong>{authPending ? t('authWaiting') : authError ? t('authFailedTitle') : t('authTitle')}</strong>
                  <span>{t('authRequired')}</span>{authError && <span role="alert">{t('signInFailed')}</span>}</div>
                <Button variant="primary" size="sm" disabled={authPending} onClick={onSignIn}>{t(authPending ? 'signingIn' : 'signIn')}</Button>
              </div> : error ? <><p role="alert" className={css.catalogError}>{error}</p>
                <Button variant="outline" size="sm" onClick={onRefresh}>{t('retry')}</Button></> : <p>{t('empty')}</p>}
          </div>
        </main>
      </div>}
  </section>{creating && <KnowledgeBaseEditor t={t} onClose={() => { setCreating(false) }} onCreated={(id) => {
    setCreating(false); setSelectedId(id); setNavigationVisible(false); onRefresh()
    setCollapsed((previous) => { const next = new Set(previous); next.delete('PERSONAL'); return next })
  }} />}{deleting && <Modal open title={t('knowledgeDeleteBase')} closeLabel={t('close')} onClose={() => { if (!deletePending) { setDeleting(undefined); setDeleteError('') } }} footer={<>
    <Button variant="ghost" size="sm" disabled={deletePending} onClick={() => { setDeleting(undefined); setDeleteError('') }}>{t('cancel')}</Button>
    <Button variant="primary" className={css.knowledgeDanger} size="sm" disabled={deletePending} onClick={() => { void confirmDelete() }}>
      {t(deletePending ? 'deletingResource' : 'deleteResource')}
    </Button>
  </>}><p className={css.knowledgeConfirmation}>{t('knowledgeDeleteBaseConfirmation').replace('{name}', deleting.label)}</p>
    {deleteError && <p role="alert" className={css.catalogError}>{deleteError}</p>}
  </Modal>}</>
}

function KnowledgeLibraryActions({ entry, disabled, onDelete, t }: {
  readonly entry: ProductItem
  readonly disabled: boolean
  readonly onDelete: () => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const items: MenuEntry[] = [{ id: 'delete', label: t('knowledgeDeleteBase'), icon: <IconTrashOutlineRegular size={16} />, danger: true }]
  return <Menu open={open && !disabled} onClose={() => { setOpen(false) }} portal align="end" items={items}
    onSelect={(id) => { setOpen(false); if (id === 'delete') onDelete() }} anchor={<Tooltip label={t('knowledgeLibraryActions').replace('{name}', entry.label)}>
      <button type="button" className={css.iconButton} disabled={disabled} aria-label={t('knowledgeLibraryActions').replace('{name}', entry.label)}
        aria-haspopup="menu" aria-expanded={open} onClick={(event) => { event.stopPropagation(); setOpen(!open) }}><IconEllipsisOutlineRegular size={16} /></button>
    </Tooltip>} />
}
