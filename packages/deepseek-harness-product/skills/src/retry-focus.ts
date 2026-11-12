/** Focus recovery for skill read retries removed by a confirmed result. */
import { useCallback, useLayoutEffect, useRef, type RefCallback } from 'react'
import { focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'

/** Hand a removed retry's focus to its current result without scrolling or taking another control's focus.
 * @param getTarget Resolve the focus destination after React commits the result.
 * @returns Stable ref for the retry button; retained buttons keep their focus.
 */
export function useRetryFocus(getTarget: () => HTMLElement | null | undefined): RefCallback<HTMLButtonElement> {
  const retry = useRef<HTMLButtonElement | null>(null)
  const removed = useRef<HTMLButtonElement>()
  const ref = useCallback((node: HTMLButtonElement | null) => {
    const previous = retry.current
    if (!node && previous && previous.ownerDocument.activeElement === previous) removed.current = previous
    retry.current = node
  }, [])
  useLayoutEffect(() => {
    const previous = removed.current
    removed.current = undefined
    if (!previous || previous.ownerDocument.activeElement !== previous.ownerDocument.body) return
    const target = getTarget()
    if (target) focusWithoutRing(target, { preventScroll: true })
  })
  return ref
}
