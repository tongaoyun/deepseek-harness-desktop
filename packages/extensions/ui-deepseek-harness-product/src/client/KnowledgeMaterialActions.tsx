/** Native material menus retain their trigger as the return focus for dialogs. */
import { useRef, useState, type ReactNode } from 'react'
import { Button, IconDownloadOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular, IconFolderOpenOutlineRegular, IconLinkOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconStopFillRegular, IconTrashOutlineRegular, Menu, Tooltip, focusWithoutRing, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import type { KnowledgeDocument, KnowledgeFolder } from './knowledge-data.ts'

/** Add materials through the native menu; disabling clears its open request.
 * @param props Material identity, availability, actions, and localized labels.
 * @returns The native menu and its labeled trigger.
 */
export function KnowledgeAddMenu({ disabled, pending = false, uploadDisabled, onUpload, onSelect, t }: {
  readonly disabled: boolean
  readonly pending?: boolean
  readonly uploadDisabled: boolean
  readonly onUpload: () => void
  readonly onSelect: (kind: 'markdown' | 'url' | 'folder') => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const trigger = useRef<HTMLButtonElement>(null)
  const [requestedOpen, setOpen] = useState(false)
  const open = requestedOpen && !disabled && !pending
  if (requestedOpen && (disabled || pending)) setOpen(false)
  return <Menu open={open} onClose={() => { setOpen(false) }} portal align="end" items={[
    { id: 'upload', label: t('knowledgeUpload'), disabled: uploadDisabled, icon: <IconPlusOutlineRegular size={16} /> },
    { id: 'url', label: t('knowledgeImportUrl'), icon: <IconLinkOutlineRegular size={16} /> },
    { id: 'markdown', label: t('knowledgeNewDocument'), icon: <IconEditOutlineRegular size={16} /> },
    { type: 'separator', id: 'folders' }, { id: 'folder', label: t('knowledgeCreateFolder'), icon: <IconFolderOpenOutlineRegular size={16} /> },
  ]} onSelect={(id) => {
    if (disabled || pending) return
    if (trigger.current) focusWithoutRing(trigger.current)
    setOpen(false)
    if (id === 'upload') onUpload()
    else if (id === 'markdown' || id === 'url' || id === 'folder') onSelect(id)
  }}
  anchor={<Button ref={trigger} variant="primary" size="sm" className={pending && !disabled ? 'product-control-pending' : undefined}
    disabled={disabled} aria-disabled={disabled || pending} aria-haspopup="menu" aria-expanded={open}
    onClick={() => { if (!disabled && !pending) setOpen(!open) }}><IconPlusOutlineRegular size={14} />{t('knowledgeAddMaterial')}</Button>} />
}

/** Expose authorized document actions; disabling requires an explicit reopen.
 * @param props Material identity, availability, actions, and localized labels.
 * @returns The native menu and its labeled trigger.
 */
export function KnowledgeDocumentActions({ document, disabled, pending = false, canManage, canOpenExternal, onSelect, t }: {
  readonly document: KnowledgeDocument
  readonly disabled: boolean
  readonly pending?: boolean
  readonly canManage: boolean
  readonly canOpenExternal: boolean
  readonly onSelect: (id: string) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const trigger = useRef<HTMLButtonElement>(null)
  const [requestedOpen, setOpen] = useState(false)
  const open = requestedOpen && !disabled && !pending
  if (requestedOpen && (disabled || pending)) setOpen(false)
  const processing = ['QUEUED', 'PROCESSING', 'FINALIZING'].includes(document.status)
  const items: MenuEntry[] = [{ id: 'read', label: t('knowledgeReadDocument'), disabled: document.status === 'DELETING' }]
  items.push({ id: 'locate', label: t('knowledgeShowInFolder'), icon: <IconFolderOpenOutlineRegular size={16} /> })
  items.push({ id: 'parsed', label: t('knowledgeParsedContent'), disabled: document.status !== 'READY' })
  items.push({ id: 'processing', label: t('knowledgeProcessingDetails'), disabled: document.status === 'DELETING' })
  items.push({ id: 'download', label: t('knowledgeDownloadOriginal'), icon: <IconDownloadOutlineRegular size={16} /> })
  if (canOpenExternal) items.push({ id: 'openExternal', label: t('knowledgeOpenExternal'), icon: <IconLinkOutlineRegular size={16} /> })
  if (canManage && document.sourceType === 'manual') items.push({ id: 'edit', label: t('modifyResource'), icon: <IconEditOutlineRegular size={16} />, disabled: processing })
  if (canManage && processing) items.push({ id: 'cancel', label: t('knowledgeStopProcessing'), icon: <IconStopFillRegular size={16} /> })
  if (canManage) items.push({ id: 'move', label: t('knowledgeMoveDocument'), icon: <IconFolderOpenOutlineRegular size={16} /> },
    { id: 'reindex', label: t('knowledgeReindex'), icon: <IconRefreshOutlineRegular size={16} />, disabled: processing },
    { type: 'separator', id: 'delete-separator' }, { id: 'delete', label: t('deleteResource'), icon: <IconTrashOutlineRegular size={16} />, danger: true })
  return <Menu open={open} items={items} portal align="end" onClose={() => { setOpen(false) }}
    onSelect={(id) => { if (disabled || pending) return; if (trigger.current) focusWithoutRing(trigger.current); setOpen(false); onSelect(id) }} anchor={<Tooltip label={t('resourceActions')}
      side="bottom" align="end" gap={2} portal delayMs={350} disabled={open || disabled || pending}>
      <button ref={trigger} type="button" disabled={disabled} aria-disabled={disabled || pending} className={`${css.iconButton}${pending && !disabled ? ' product-control-pending' : ''}`} aria-label={t('knowledgeDocumentActions').replace('{name}', document.filename)}
        aria-haspopup="menu" aria-expanded={open} onClick={() => { if (!disabled && !pending) setOpen(!open) }}><IconEllipsisOutlineRegular size={16} /></button></Tooltip>} />
}

/** Manage the selected folder without reopening after a pending operation.
 * @param props Material identity, availability, actions, and localized labels.
 * @returns The native menu and its labeled trigger.
 */
export function KnowledgeFolderActions({ folder, disabled, pending = false, current = false, onSelect, t }: {
  readonly folder: KnowledgeFolder
  readonly disabled: boolean
  readonly pending?: boolean
  readonly current?: boolean
  readonly onSelect: (id: string) => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const trigger = useRef<HTMLButtonElement>(null)
  const [requestedOpen, setOpen] = useState(false)
  const open = requestedOpen && !disabled && !pending
  if (requestedOpen && (disabled || pending)) setOpen(false)
  const items: MenuEntry[] = current ? [] : [
    { id: 'create', label: t('knowledgeCreateSubfolder'), icon: <IconPlusOutlineRegular size={16} /> },
    { id: 'upload', label: t('knowledgeUploadToFolder'), icon: <IconDownloadOutlineRegular size={16} /> },
    { type: 'separator', id: 'manage-folder' },
  ]
  items.push(
    { id: 'rename', label: t('knowledgeRenameFolder'), icon: <IconEditOutlineRegular size={16} /> },
    { id: 'delete', label: t('knowledgeDeleteFolder'), icon: <IconTrashOutlineRegular size={16} />, danger: true },
  )
  return <Menu open={open} portal align="end" onClose={() => { setOpen(false) }} items={items}
    onSelect={(id) => { if (disabled || pending) return; if (trigger.current) focusWithoutRing(trigger.current); setOpen(false); onSelect(id) }} anchor={<Tooltip label={t('resourceActions')}
      side="bottom" align="end" gap={2} portal delayMs={350} disabled={open || disabled || pending}>
      <button ref={trigger} type="button" className={`${css.iconButton}${pending && !disabled ? ' product-control-pending' : ''}`} disabled={disabled} aria-disabled={disabled || pending} aria-haspopup="menu" aria-expanded={open}
        aria-label={t('knowledgeFolderActions').replace('{name}', folder.name)} onClick={() => { if (!disabled && !pending) setOpen(!open) }}>
        <IconEllipsisOutlineRegular size={16} /></button></Tooltip>} />
}
