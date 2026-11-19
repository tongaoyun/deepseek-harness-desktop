import type { ReactNode } from 'react'
import css from '../DeepSeekHarnessProduct.module.css'

/** Static list placeholders shared by library pages and directory pickers.
 * @param props Localized accessible loading label.
 * @returns Reserved file rows without animation.
 */
export function LibraryLoading({ label }: { readonly label: string }): ReactNode {
  return <div role="status" aria-label={label} className={css.libraryPending}>
    <span /><span /><span />
  </div>
}
