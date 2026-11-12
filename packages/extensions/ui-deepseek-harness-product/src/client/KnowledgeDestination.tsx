/** Resolve captured write destinations without changing the pending operation. */
import type { ReactNode } from 'react'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { useKnowledgeFolderLocation } from './knowledge-folder-location.ts'

/** Display the library and exact folder of a pending write.
 * @param props Captured destination and localized labels.
 * @returns A readable path, loading text, or an explicit unavailable destination.
 */
export function KnowledgeDestination({ knowledgeBaseId, libraryName, folderId, t }: {
  readonly knowledgeBaseId: string
  readonly libraryName?: string | undefined
  readonly folderId: string | null | undefined
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const location = useKnowledgeFolderLocation(knowledgeBaseId, folderId)
  return <p className={css.knowledgeDestination}>
    <span>{t('knowledgeSaveDestination')}</span>
    <span>{libraryName ?? t('knowledge')}{' / '}{location.failure !== undefined ? t('knowledgeDestinationUnavailable')
      : location.loading ? t('loading') : location.trail?.map(folder => folder.name).join(' / ') || t('knowledgeRootFolder')}</span>
  </p>
}
