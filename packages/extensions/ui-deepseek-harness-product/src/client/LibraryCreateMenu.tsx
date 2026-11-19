import { useRef, useState, type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular, Menu, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LibraryText } from './LibraryBrowser.tsx'
import css from '../DeepSeekHarnessProduct.module.css'

/** Add files and folders directly to the directory that owns the trigger.
 * @param props Accessible directory label and target-bound creation callback.
 * @returns Native menu with stable hover and keyboard controls.
 */
export function LibraryCreateMenu({ t, label, onCreate }: {
  readonly t: LibraryText
  readonly label: string
  readonly onCreate: (kind: 'upload' | 'folder') => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return <Menu portal align="end" open={open} onClose={() => { setOpen(false) }} items={[
    { id: 'upload', label: t('libraryUpload') }, { id: 'folder', label: t('libraryNewFolder') },
  ]} onSelect={(id) => {
    if (trigger.current) focusWithoutRing(trigger.current)
    setOpen(false)
    if (id === 'upload' || id === 'folder') onCreate(id)
  }} anchor={<Button ref={trigger} variant="ghost" size="sm"
    className={css.libraryAddAction} aria-label={label} aria-haspopup="menu" aria-expanded={open}
    onClick={() => { setOpen(value => !value) }}><IconPlusOutlineRegular size={16} /></Button>} />
}
