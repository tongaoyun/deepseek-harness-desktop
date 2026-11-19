/** Library title and native page actions share one responsive header. */
import type { ReactNode } from 'react'
import { Button, IconUsersOutlineRegular, IconUploadOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LibraryText } from './LibraryBrowser.tsx'
import css from '../DeepSeekHarnessProduct.module.css'

/**
 * @param props Localized heading and available file actions.
 * @returns A page heading with optional authenticated actions.
 */
export function LibraryPageHeader({ t, busy = false, onUpload, onGenerate, onMembers, onRename, title, icon }: {
  readonly t: LibraryText
  readonly title?: string
  readonly icon?: ReactNode
  readonly busy?: boolean
  readonly onMembers?: () => void
  readonly onRename?: () => void
  readonly onUpload?: () => void
  readonly onGenerate?: () => void
}): ReactNode {
  return <header className={css.libraryPageHeader}>
    <div className={css.libraryPageIntro}>
      {icon && <span className={css.libraryTitleIcon} aria-hidden="true">{icon}</span>}
      {title ? <h2 className={css.libraryPageTitle} aria-label={title}>{onRename
        ? <Button variant="ghost" className={css.libraryRenameTitle} aria-label={`${t('libraryRename')}: ${title}`}
          aria-disabled={busy} onClick={() => { if (!busy) onRename() }}>{title}</Button>
        : title}</h2> : <h1 className={css.libraryPageTitle}>{t('library')}</h1>}
      {!title && <p className={css.libraryPageDescription}>{t('libraryHint')}</p>}
    </div>
    {(onUpload || onGenerate || onMembers) && <div className={css.libraryPageActions}>
      {onMembers && <Button variant="ghost" onClick={onMembers}><IconUsersOutlineRegular size={16} />{t('libraryMemberList')}</Button>}
      {onGenerate && <Button variant="outline" onClick={onGenerate}>{t('libraryGenerate')}</Button>}
      {onUpload && <Button variant="primary" aria-disabled={busy} onClick={onUpload}>
        <IconUploadOutlineRegular size={16} />{t('libraryUpload')}
      </Button>}
    </div>}
  </header>
}
