/** Close protection for unsaved editor drafts and unresolved save operations. */
import { useEffect, useLayoutEffect, useRef, useState, type FocusEventHandler, type RefObject } from 'react'
import { focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'

/** Guard every modal dismissal and document unload while an edit is unresolved.
 * @param dirty Whether the current values differ from the loaded form.
 * @param saving Whether a save or local suspension is pending; a reader also guards actions before React commits.
 * @param onClose Dismiss the editor after an explicit discard or an unchanged edit.
 * @param unconfirmed Protect window unload for an unsuspended write; omitted for confirmed edits.
 * @returns Confirmation state, persistent editor bindings, focus refs, and guarded close commands.
 */
export function useEditorCloseGuard(dirty: boolean, saving: boolean | (() => boolean), onClose: () => void, unconfirmed = false): {
  readonly confirming: boolean
  readonly blocked: boolean
  readonly requestClose: () => void
  readonly keepEditing: () => void
  readonly discard: () => void
  readonly editorProps: { readonly ref: RefObject<HTMLDivElement>; readonly onFocusCapture: FocusEventHandler<HTMLDivElement> }
  readonly keepEditingRef: RefObject<HTMLButtonElement>
} {
  const [confirming, setConfirming] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const editor = useRef<HTMLDivElement>(null)
  const keepEditing = useRef<HTMLButtonElement>(null)
  const lastField = useRef<HTMLElement>()
  const previousConfirming = useRef(false)
  useLayoutEffect(() => {
    const returning = previousConfirming.current && !confirming
    previousConfirming.current = confirming
    let target: HTMLElement | null | undefined
    if (confirming) target = keepEditing.current
    else if (returning) {
      target = lastField.current?.isConnected && !lastField.current.matches(':disabled') ? lastField.current
        : editor.current?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)')
          ?? editor.current?.closest('[role="dialog"]')?.querySelector<HTMLElement>('button:not(:disabled)')
    }
    if (target) focusWithoutRing(target)
  }, [confirming])
  const isSaving = (): boolean => typeof saving === 'function' ? saving() : saving
  const pending = isSaving()
  useEffect(() => {
    if (!dirty && !pending && !unconfirmed) return
    const preventUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', preventUnload)
    return () => { window.removeEventListener('beforeunload', preventUnload) }
  }, [dirty, pending, unconfirmed])
  return {
    confirming, blocked,
    editorProps: { ref: editor, onFocusCapture: (event) => {
      if (event.target instanceof HTMLElement) lastField.current = event.target
    } },
    keepEditingRef: keepEditing,
    requestClose: () => {
      if (isSaving()) { setBlocked(true); return }
      if (confirming) { setConfirming(false); return }
      if (dirty) setConfirming(true)
      else onClose()
    },
    keepEditing: () => { setConfirming(false) },
    discard: () => { if (!isSaving()) onClose() },
  }
}
