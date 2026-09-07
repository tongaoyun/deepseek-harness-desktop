import { useEffect, useRef, type RefObject } from 'react'

/** Keep keyboard navigation in the current dialog and restore its opener. */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, key: string, onClose: () => void) {
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose }, [onClose])
  useEffect(() => {
    const dialog = ref.current
    if (!key || !dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const controls = () => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')].filter((item) => !item.closest('[hidden]') && (!item.closest('details:not([open])') || item.tagName === 'SUMMARY'))
    controls()[0]?.focus()
    const keydown = (event: KeyboardEvent) => {
      // A confirmation can be stacked above the owning dialog.
      if ([...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].at(-1) !== dialog) return
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation()
        const popover = dialog.querySelector<HTMLDetailsElement>('details[data-popover][open]')
        if (popover) { popover.open = false; popover.querySelector('summary')?.focus(); return }
        close.current(); return
      }
      if (event.key !== 'Tab') return
      const elements = controls()
      const first = elements[0]
      const last = elements.at(-1)
      if (!first || !last) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown, true)
    return () => { document.removeEventListener('keydown', keydown, true); if (opener?.isConnected) opener.focus() }
  }, [key, ref])
}
