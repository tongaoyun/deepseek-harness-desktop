import type { ReactNode } from 'react'
import css from '../DeepSeekHarnessProduct.module.css'

/** Reserve localized action labels so progress and retry cannot move adjacent controls.
 * @param props Normal and progress labels, with only the current label exposed to assistive technology.
 * @returns Overlapping labels sized to their widest content.
 */
export function ProductActionLabel({ pending, label, pendingLabel, reserveLabels }: {
  readonly pending: boolean
  readonly label: string
  readonly pendingLabel: string
  readonly reserveLabels?: readonly string[]
}): ReactNode {
  return <span className={css.editorActionLabel}>
    <span aria-hidden={pending}>{label}</span>
    <span aria-hidden={!pending}>{pendingLabel}</span>
    {reserveLabels?.filter(text => text !== label && text !== pendingLabel)
      .map(text => <span key={text} aria-hidden="true">{text}</span>)}
  </span>
}
