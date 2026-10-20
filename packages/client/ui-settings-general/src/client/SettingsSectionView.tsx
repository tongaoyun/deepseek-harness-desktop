/** Reuses settings contributions without transferring their slot ownership to callers. */
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/** Render one exact page, suspending embedded content underneath the settings dialog.
 * @param props - Factory input and shell-bound visibility hook.
 * @returns The registered page, or null while suspended or unavailable.
 */
export function SettingsSectionView({ sectionId, close, presentation, useDialogOpen, renderSlot }:
FactoryComponentPropsOf<'settings.section-view'>) {
  const dialogOpen = useDialogOpen(open => open)
  if (presentation === 'embedded' && dialogOpen) return null
  return renderSlot('settings.section', { close }, { only: sectionId })
}
