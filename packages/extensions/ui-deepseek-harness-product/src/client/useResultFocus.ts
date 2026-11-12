/** Recover focus after a confirmed asynchronous result replaces its owned controls. */
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import { focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'

/** Capture owned focus immediately before committing an asynchronous result.
 * Retained controls keep focus; body, removed, hidden, or disabled targets use the fallback without scrolling.
 * Focus already moved to another usable control remains there.
 * @param area Controls whose focus may be affected by the result.
 * @param fallback Stable destination or native focus action when the focused control is removed.
 * @returns Capture action to call after validation and before updating rendered results or errors.
 */
export function useResultFocus(area: RefObject<HTMLElement>, fallback: RefObject<HTMLElement> | (() => void)): () => void {
  const pending = useRef<HTMLElement>()
  useLayoutEffect(() => {
    const focused = pending.current
    pending.current = undefined
    if (!focused) return
    const hidden = focused.closest('[hidden]') !== null
    const active = focused.ownerDocument.activeElement
    if (active !== focused.ownerDocument.body && !(hidden && active === focused) && !active?.matches(':disabled')) return
    const target = focused !== focused.ownerDocument.body && focused.isConnected && !hidden && !focused.matches(':disabled') ? focused
      : typeof fallback === 'function' ? fallback : fallback.current
    if (typeof target === 'function') target()
    else if (target) focusWithoutRing(target, { preventScroll: true })
  })
  return useCallback(() => {
    const owner = area.current
    const focused = owner?.ownerDocument.activeElement
    pending.current = focused instanceof HTMLElement && owner?.contains(focused) ? focused : undefined
  }, [area])
}
