import type { ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import css from '../DeepSeekHarnessProduct.module.css'

/** Keep transient loading copy out of the layout while announcing pending reads.
 * @param props Localized loading label for assistive technology.
 * @returns The native loading indicator with an accessible status name.
 */
export function ProductLoading({ label }: { readonly label: string }): ReactNode {
  return <span role="status" aria-label={label} className={css.loadingIndicator}>
    <StateDot state="ongoing" size={14} />
  </span>
}
