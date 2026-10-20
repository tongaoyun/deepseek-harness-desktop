import { useState, type ReactNode } from 'react'
import {
  IconAgentPresetOutlineRegular,
  IconApiOutlineRegular,
  IconDeliverDocRegular,
  Tooltip,
  IconDatabaseOutlineRegular,
  IconSparkleRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'

export const CAPABILITY_PANELS = [
  { id: 'deepseek-harness-connectors' as MainPanelId, labelKey: 'connectors', icon: IconApiOutlineRegular },
  { id: 'deepseek-harness-knowledge' as MainPanelId, labelKey: 'knowledge', icon: IconDatabaseOutlineRegular },
] as const

export type CapabilityPanel = typeof CAPABILITY_PANELS[number]

const EXTENSION_PAGES = [
  { id: 'agency-agents', labelKey: 'expertKits', icon: IconAgentPresetOutlineRegular },
  { id: 'skills-manager', labelKey: 'skills', icon: IconDeliverDocRegular },
] as const

/** Shortcuts share the plugin pages already contributed to Settings. */
export function CapabilitiesHeading({ wide, t, openExtension }:
PropsRuntime<'sidebar.panelheading'> & PropsLocale<typeof NS> & {
  readonly openExtension: (sectionId: string) => boolean
}): ReactNode {
  const [unavailable, setUnavailable] = useState(false)
  return <div className={css.extensionNavigation} data-extension-navigation>
    {wide && <div className={css.capabilitiesHeading}>
      <IconSparkleRegular size={16} />
      <span>{t('capabilities')}</span>
    </div>}
    {EXTENSION_PAGES.map(({ id, labelKey, icon: Icon }) => <Tooltip key={id} label={t(labelKey)} disabled={wide}>
      <button type="button" className={wide ? css.extensionShortcut : css.extensionShortcutCollapsed}
        aria-label={t(labelKey)} onClick={() => { setUnavailable(!openExtension(id)) }}>
        <span className={css.capabilityChildIcon}>{!wide && <Icon size={16} />}</span>
        {wide && <span>{t(labelKey)}</span>}
      </button>
    </Tooltip>)}
    {unavailable && <div role="alert" className={css.extensionNavigationError}>{t('extensionUnavailable')}</div>}
  </div>
}

/** Keep child labels aligned when wide and expose their own icon in the collapsed rail. */
export function CapabilityChildIcon({ size, wide, icon: Icon }:
PropsRuntime<'sidebar.panellist'> & { readonly icon: CapabilityPanel['icon'] }): ReactNode {
  return <span className={css.capabilityChildIcon}>
    {!wide && <Icon size={size} />}
  </span>
}

/** Bind one capability icon to the official sidebar panel-icon contract. */
export function createCapabilityChildIcon(icon: CapabilityPanel['icon']) {
  return function BoundCapabilityChildIcon(props: PropsRuntime<'sidebar.panellist'>): ReactNode {
    return <CapabilityChildIcon {...props} icon={icon} />
  }
}
