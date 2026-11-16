/** Employee-authenticated file libraries use the shared product navigation shell. */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from '../locales.ts'
import { LibraryHome, type LibraryNavigation } from './LibraryHome.tsx'
import css from '../DeepSeekHarnessProduct.module.css'

/** Render the directory after the product page composition verifies employee identity.
 * @param props Native main-panel locale, preview factory and library navigation.
 * @returns Library workspace; the shared employee gate owns authentication and retries.
 */
export function LibraryPanel(props: PropsLocale<typeof NS> & PropsRenderFactories & LibraryNavigation): ReactNode {
  return <section className={css.catalogPage} aria-label={props.t('library')}>
    <div className={css.catalogScroll}>
      <div className={`${css.libraryPageContent} ${css.libraryWorkspace}`}>
        <LibraryHome t={props.t} renderFactorySlot={props.renderFactorySlot}
          {...(props.startLibraryCreation ? { startLibraryCreation: props.startLibraryCreation } : {})}
          {...(props.openLibrarySource ? { openLibrarySource: props.openLibrarySource } : {})} />
      </div>
    </div>
  </section>
}
