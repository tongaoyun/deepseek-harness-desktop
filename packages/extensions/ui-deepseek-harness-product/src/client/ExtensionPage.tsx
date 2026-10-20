/** Application-panel host for an installed plugin's shared settings page. */
import type { HostObservable, InjectFace, PropsLocale, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { NS } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'

/** Plugin availability and navigation supplied by the product adapter. */
export interface ExtensionPageInjected {
  /** Registered plugin settings page. */
  sectionId: string
  /** Leave this panel without changing the active conversation. */
  close: () => void
  /** Tracks the real plugin registration across Loader changes. */
  hooks: { available: HostObservable<boolean> }
}

/** Render the registered page in the main area without changing the active conversation.
 * @param props - Public settings factory, availability hook, and page ID.
 * @returns The shared page or an actionable unavailable message.
 */
export function ExtensionPage({ sectionId, close, useAvailable, renderFactorySlot, t }:
InjectFace<ExtensionPageInjected> & PropsRenderFactories & PropsLocale<typeof NS>) {
  const available = useAvailable(value => value)
  return <div className={css.extensionPage} data-extension-page={sectionId}>
    <div className={css.extensionPageContent}>{available
      ? renderFactorySlot('settings.section-view', { sectionId, close, presentation: 'embedded' })
      : <div role="alert" className={css.extensionPageError}>{t('extensionUnavailable')}</div>}</div>
  </div>
}
