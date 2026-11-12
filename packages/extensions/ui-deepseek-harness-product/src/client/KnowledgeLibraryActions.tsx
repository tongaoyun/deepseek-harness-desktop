/** Permission-controlled actions shared by the library directory and materials header. */
import { useRef, useState, type ReactNode } from 'react'
import { IconEditOutlineRegular, IconEllipsisOutlineRegular, IconTrashOutlineRegular, Menu, Tooltip, focusWithoutRing, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'

/** Render management actions with dialog return focus; mutation locks preserve appearance and close the menu until reopened.
 * @param props Library display name, mutation state, delete callback, and locale.
 * @returns The native library action menu.
 */
export function KnowledgeLibraryActions({ name, disabled, onEdit, onDelete, t }: {
  readonly name: string
  readonly disabled: boolean
  readonly onEdit?: (() => void) | undefined
  readonly onDelete?: (() => void) | undefined
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const trigger = useRef<HTMLButtonElement>(null)
  const [requestedOpen, setOpen] = useState(false)
  const open = requestedOpen && !disabled
  if (requestedOpen && disabled) setOpen(false)
  const items: MenuEntry[] = []
  if (onEdit) items.push({ id: 'edit', label: t('knowledgeEditBase'), icon: <IconEditOutlineRegular size={16} /> })
  if (onDelete) items.push({ id: 'delete', label: t('knowledgeDeleteBase'), icon: <IconTrashOutlineRegular size={16} />, danger: true })
  return <Menu open={open} onClose={() => { setOpen(false) }} portal align="end" items={items}
    onSelect={(id) => {
      if (disabled) return
      if (trigger.current) focusWithoutRing(trigger.current)
      setOpen(false)
      if (id === 'edit') onEdit?.()
      if (id === 'delete') onDelete?.()
    }} anchor={<Tooltip label={t('resourceActions')}
      side="bottom" align="end" gap={2} portal delayMs={350} disabled={open || disabled}>
      <button ref={trigger} type="button" className={`${css.iconButton}${disabled ? ' product-control-pending' : ''}`} aria-disabled={disabled} aria-label={t('knowledgeLibraryActions').replace('{name}', name)}
        aria-haspopup="menu" aria-expanded={open} onClick={(event) => { event.stopPropagation(); if (!disabled) setOpen(!open) }}><IconEllipsisOutlineRegular size={16} /></button>
    </Tooltip>} />
}
