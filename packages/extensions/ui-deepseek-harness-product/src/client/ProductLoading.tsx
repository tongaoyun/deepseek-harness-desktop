import type { ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import css from '../DeepSeekHarnessProduct.module.css'

/** Reserve indicator space and announce pending reads; short reads keep the spinner hidden.
 * @param props Localized loading label for assistive technology.
 * @returns The native loading indicator with an accessible status name.
 */
export function ProductLoading({ label }: { readonly label: string }): ReactNode {
  return <span role="status" aria-label={label} className={css.loadingIndicator}>
    <StateDot state="ongoing" size={14} className="product-read-indicator" />
  </span>
}
