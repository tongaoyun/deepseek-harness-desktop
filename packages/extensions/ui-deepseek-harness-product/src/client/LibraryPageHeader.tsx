/** Library title and native page actions share one responsive header. */
import type { ReactNode } from 'react'
import { Button, IconUploadOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LibraryText } from './LibraryBrowser.tsx'
import css from '../DeepSeekHarnessProduct.module.css'

/**
 * @param props Localized heading and available file actions.
 * @returns A page heading with optional authenticated actions.
 */
export function LibraryPageHeader({ t, busy = false, onCreateFolder, onUpload, onGenerate, title }: {
  readonly t: LibraryText
  readonly title?: string
  readonly busy?: boolean
  readonly onCreateFolder?: () => void
  readonly onUpload?: () => void
  readonly onGenerate?: () => void
}): ReactNode {
  return <header className={css.libraryPageHeader}>
    <div className={css.libraryPageIntro}>
      {title ? <h2 className={css.libraryPageTitle}>{title}</h2> : <h1 className={css.libraryPageTitle}>{t('library')}</h1>}
      {!title && <p className={css.libraryPageDescription}>{t('libraryHint')}</p>}
    </div>
    {(onUpload || onGenerate || onCreateFolder) && <div className={css.libraryPageActions}>
      {onCreateFolder && <Button variant="ghost" aria-disabled={busy} onClick={onCreateFolder}>{t('libraryNewFolder')}</Button>}
      {onGenerate && <Button variant="outline" onClick={onGenerate}>{t('libraryGenerate')}</Button>}
      {onUpload && <Button variant="primary" aria-disabled={busy} onClick={onUpload}>
        <IconUploadOutlineRegular size={16} />{t('libraryUpload')}
      </Button>}
    </div>}
  </header>
}
