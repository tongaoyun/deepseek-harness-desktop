import type { ReactNode } from 'react'
import {
  IconAgentPresetOutlineRegular,
  IconApiOutlineRegular,
  IconDeliverDocRegular,
  IconDatabaseOutlineRegular,
  IconSparkleRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { CompanyContentSubmission } from './CompanyContentSubmission.tsx'

export const CAPABILITY_PANELS = [
  { id: 'deepseek-harness-connectors' as MainPanelId, labelKey: 'connectors', icon: IconApiOutlineRegular },
  { id: 'deepseek-harness-knowledge' as MainPanelId, labelKey: 'knowledge', icon: IconDatabaseOutlineRegular },
] as const

export type CapabilityPanel = typeof CAPABILITY_PANELS[number]

export const EXTENSION_PANELS = [
  { id: 'deepseek-harness-experts' as MainPanelId, labelKey: 'expertKits', icon: IconAgentPresetOutlineRegular },
  { id: 'deepseek-harness-skills' as MainPanelId, labelKey: 'skills', icon: IconDeliverDocRegular },
] as const

/** Label the extension panels without adding an interactive navigation layer. */
export function CapabilitiesHeading({ wide, t }:
PropsRuntime<'sidebar.panelheading'> & PropsLocale<typeof NS>): ReactNode {
  return <><CompanyContentSubmission t={t} />{wide && <div className={css.capabilitiesHeading}>
    <IconSparkleRegular size={16} />
    <span>{t('capabilities')}</span>
  </div>}</>
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
