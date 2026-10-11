import type { ReactNode } from 'react'
import { useState } from 'react'
import { IconEllipsisOutlineRegular, IconEditOutlineRegular, IconCloseOutlineRegular, IconShareOutlineRegular, IconTrashOutlineRegular, Menu, Tooltip, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import type { ProductDetail } from './catalog-shared.tsx'
import css from '../DeepSeekHarnessProduct.module.css'

type ResourceAccess = Pick<ProductDetail, 'canEdit' | 'canSubmit' | 'canDelete' | 'reviewStatus' | 'version'>

/** Device uninstall and owner actions shared by resource cards and details.
 * @param props - Resource permissions, mutation callbacks, pending state, and localized labels.
 * @returns Available device and owner actions, or nothing when no action applies.
 */
export function ResourceActionsMenu({ resource, pending = false, onEdit, onSubmit, onDelete, onUninstall, t }: {
  readonly resource: ResourceAccess
  readonly pending?: boolean
  readonly onEdit: () => void
  readonly onSubmit: () => void
  readonly onDelete: () => void
  readonly onUninstall?: () => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const owner = resource.canEdit === true && resource.version !== undefined
  if (!owner && onUninstall === undefined) return null
  const entries: MenuEntry[] = []
  if (owner) entries.push({ id: 'edit', label: t('modifyResource'), icon: <IconEditOutlineRegular size={16} /> })
  const reviewKey = resource.reviewStatus === 'SUBMITTED' ? 'reviewPending'
    : resource.reviewStatus === 'PUBLISHED' ? 'resourceShared'
      : resource.reviewStatus === 'CHANGES_REQUESTED' ? 'resourceChangesRequested'
        : resource.reviewStatus === 'REJECTED' ? 'resourceRejected' : undefined
  if (owner && reviewKey) entries.push({ type: 'label', id: 'review', text: t(reviewKey) })
  if (owner && resource.canSubmit) entries.push({ id: 'submit', label: t('submitShared'), icon: <IconShareOutlineRegular size={16} /> })
  if (onUninstall !== undefined) {
    if (owner) entries.push({ type: 'separator', id: 'device' })
    entries.push({ id: 'uninstall', label: t('uninstallResource'), icon: <IconCloseOutlineRegular size={16} /> })
  }
  if (owner) {
    entries.push({ type: 'separator', id: 'danger' },
      { id: 'delete', label: t('deleteResource'), icon: <IconTrashOutlineRegular size={16} />, danger: true, disabled: !resource.canDelete })
    if (!resource.canDelete) entries.push({ type: 'label', id: 'delete-unavailable', text: t('resourceDeleteShared') })
  }
  return <Menu open={open && !pending} items={entries} portal align="end"
    onClose={() => { setOpen(false) }} onSelect={(id) => {
      setOpen(false)
      if (id === 'edit') onEdit()
      else if (id === 'submit') onSubmit()
      else if (id === 'delete') onDelete()
      else if (id === 'uninstall') onUninstall?.()
    }} anchor={<Tooltip label={t('resourceActions')} side="top" portal>
      <button type="button" className={css.cardAction} disabled={pending} aria-label={t('resourceActions')}
        aria-haspopup="menu" aria-expanded={open && !pending} onClick={() => { setOpen(!open) }}>
        <IconEllipsisOutlineRegular size={16} />
      </button>
    </Tooltip>} />
}
