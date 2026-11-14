/** Stable file nodes shared by list and grid presentation. */
import { useRef, useState, type ReactNode } from 'react'
import { FileTypeIcon, IconEllipsisOutlineRegular, Menu, focusWithoutRing, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LibraryFile } from '@deepseek-harness/product/library'
import type { LibraryText } from './LibraryBrowser.tsx'
import css from '../DeepSeekHarnessProduct.module.css'
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
/** Native file icons, metadata and row menus retain identity across layout changes.
 * @param props Authorized files and owner actions.
 * @returns The same file list styled as rows or a grid.
 */
export function LibraryFileList({ files, layout, t, pending, onOpen, onSource, onFavorite, onEdit }: {
  readonly files: readonly LibraryFile[]
  readonly layout: 'list' | 'grid'
  readonly t: LibraryText
  readonly pending: boolean
  readonly onOpen: (file: LibraryFile) => void
  readonly onSource?: (sessionId: string) => void
  readonly onFavorite: (file: LibraryFile) => void
  readonly onEdit: (file: LibraryFile, kind: 'rename' | 'move' | 'delete') => void
}): ReactNode {
  if (files.length === 0) return null
  return (
    <div className={`${css.libraryFileTable} ${layout === 'grid' ? css.libraryFileGrid : ''}`}>
      <div className={css.libraryFileHead} aria-hidden="true"><span>{t('libraryName')}</span><span>{t('libraryAccessed')}</span><span>{t('librarySize')}</span><span>{t('librarySource')}</span><span /></div>
      <ul className={css.libraryFileRows} aria-label={t('libraryFiles')}>
        {files.map(file => <li key={file.entry.id} className={css.libraryFileRow}>
          <button type="button" className={css.libraryFileName} onClick={() => { onOpen(file) }}>
            <FileTypeIcon path={file.entry.name} size={32} />
            <span><strong>{file.entry.name}</strong><small>{file.libraryName}</small></span>
          </button>
          <time className={css.libraryFileDate} dateTime={file.lastAccessedAt ?? undefined}>
            {file.lastAccessedAt ? new Date(file.lastAccessedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—'}
          </time>
          <span className={css.libraryFileSize}>{fileSize(file.entry.sizeBytes)}</span>
          <span className={css.libraryFileSource}>{file.sourceSessionId && onSource
            ? <button type="button" onClick={() => { onSource(file.sourceSessionId as string) }}>{t('libraryFromConversation')}</button>
            : t(file.sourceKind === 'CONVERSATION' ? 'libraryFromConversation' : 'libraryFromUpload')}</span>
          <LibraryFileActions file={file} t={t} pending={pending} onFavorite={() => { onFavorite(file) }}
            onEdit={(kind) => { onEdit(file, kind) }} />
        </li>)}
      </ul>
    </div>
  )
}
function LibraryFileActions({ file, t, pending, onFavorite, onEdit }: {
  readonly file: LibraryFile
  readonly t: LibraryText
  readonly pending: boolean
  readonly onFavorite: () => void
  readonly onEdit: (kind: 'rename' | 'move' | 'delete') => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const items: MenuEntry[] = [{ id: 'favorite', label: t(file.entry.favorite ? 'libraryUnfavorite' : 'libraryFavorite') }]
  if (file.canManage) items.push({ id: 'rename', label: t('libraryRename') }, { id: 'move', label: t('libraryMove') }, { id: 'delete', label: t('deleteResource'), danger: true })
  return <div className={css.libraryFileActions}><Menu open={open && !pending} items={items} portal align="end" onClose={() => { setOpen(false) }}
    onSelect={(id) => {
      if (pending) return
      if (trigger.current) focusWithoutRing(trigger.current)
      setOpen(false)
      if (id === 'favorite') onFavorite()
      else if (file.canManage && (id === 'rename' || id === 'move' || id === 'delete')) onEdit(id)
    }} anchor={<button type="button" ref={trigger} className={css.cardAction} aria-label={`${t('resourceActions')} · ${file.entry.name}`}
      aria-disabled={pending} aria-haspopup="menu" aria-expanded={open && !pending} onClick={() => { if (!pending) setOpen(!open) }}>
      <IconEllipsisOutlineRegular size={18} />
    </button>} /></div>
}
