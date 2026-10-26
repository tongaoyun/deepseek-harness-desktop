/** Close protection for unsaved editor drafts and unresolved save operations. */
import { useEffect, useState } from 'react'

/** Guard every modal dismissal and document unload while an edit is unresolved.
 * @param dirty Whether the current values differ from the loaded form.
 * @param saving Whether a save or local suspension is pending.
 * @param onClose Dismiss the editor after an explicit discard or an unchanged edit.
 * @param unconfirmed Protect window unload for an unsuspended write; omitted for confirmed edits.
 * @returns Confirmation state and guarded close commands.
 */
export function useEditorCloseGuard(dirty: boolean, saving: boolean, onClose: () => void, unconfirmed = false): {
  readonly confirming: boolean
  readonly blocked: boolean
  readonly requestClose: () => void
  readonly keepEditing: () => void
  readonly discard: () => void
} {
  const [confirming, setConfirming] = useState(false)
  const [blocked, setBlocked] = useState(false)
  useEffect(() => {
    if (!dirty && !saving && !unconfirmed) return
    const preventUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', preventUnload)
    return () => { window.removeEventListener('beforeunload', preventUnload) }
  }, [dirty, saving, unconfirmed])
  return {
    confirming, blocked,
    requestClose: () => {
      if (saving) { setBlocked(true); return }
      if (confirming) { setConfirming(false); return }
      if (dirty) setConfirming(true)
      else onClose()
    },
    keepEditing: () => { setConfirming(false) },
    discard: () => { if (!saving) onClose() },
  }
}
