/** Close protection for unsaved knowledge drafts and unresolved save operations. */
import { useEffect, useState } from 'react'

/** Guard every modal dismissal and document unload while a knowledge edit is unresolved.
 * @param dirty Whether the current values differ from the loaded document.
 * @param saving Whether a save is pending or its outcome is unconfirmed.
 * @param onClose Dismiss the editor after an explicit discard or an unchanged edit.
 * @returns Confirmation state and guarded close commands.
 */
export function useKnowledgeEditorClose(dirty: boolean, saving: boolean, onClose: () => void): {
  readonly confirming: boolean
  readonly blocked: boolean
  readonly requestClose: () => void
  readonly keepEditing: () => void
  readonly discard: () => void
} {
  const [confirming, setConfirming] = useState(false)
  const [blocked, setBlocked] = useState(false)
  useEffect(() => {
    if (!dirty && !saving) return
    const preventUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', preventUnload)
    return () => { window.removeEventListener('beforeunload', preventUnload) }
  }, [dirty, saving])
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
