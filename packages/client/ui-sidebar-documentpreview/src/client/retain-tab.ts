import { useEffect } from 'react'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'

/** Keep tab-scoped document state alive until the owning tab record is disposed.
 * @param retainTab - Registers the tab with the document preview store.
 * @param tabId - Identifier of the tab that owns the preview.
 * @param signal - Abort signal for the tab lifecycle.
 */
export function useRetainedTab(
  retainTab: (tabId: TabId, signal: AbortSignal) => void,
  tabId: TabId,
  signal: AbortSignal,
): void {
  useEffect(() => { retainTab(tabId, signal) }, [retainTab, tabId, signal])
}
