/** An enterprise directory's shortcut to the shared employee login dialog. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'

/** Explain why the directory is unavailable and open the global login entry.
 * @param props Login navigation and localized copy.
 * @returns A compact directory notice without a separate authorization flow.
 */
export function ProductSignIn({ onSignIn, t }: {
  readonly onSignIn: () => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}) {
  return <div className={css.authEmptyState}>
    <p>{t('authRequired')}</p>
    <Button variant="outline" size="sm" onClick={onSignIn}>{t('signIn')}</Button>
  </div>
}
