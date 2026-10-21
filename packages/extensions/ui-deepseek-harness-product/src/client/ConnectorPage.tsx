/** One navigation destination for the bundled MCP plugin and employee-authorized company catalog. */
import { useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { ConnectorsPanel, type DeepSeekHarnessCatalogActions } from './DeepSeekHarnessCatalogSection.tsx'

/** The plugin registration is observed through the public slot registry. */
export interface ConnectorPageInjected extends DeepSeekHarnessCatalogActions {
  readonly close: () => void
  readonly hooks: { available: HostObservable<boolean> }
}

/** Keep the active conversation untouched while opening either connector source.
 * @param props Public settings factory, catalog actions, and plugin availability.
 * @returns A single connector page with explicit MCP and company sources.
 */
export function ConnectorPage(props: PropsRuntime<'main'> & PropsRenderFactories & PropsLocale<typeof NS>
  & InjectFace<ConnectorPageInjected>) {
  const [source, setSource] = useState<'mcp' | 'company'>('mcp')
  const available = props.useAvailable(value => value)
  return <section className={css.connectorPage} aria-label={props.t('connectors')}>
    <div className={css.connectorSources} role="tablist" aria-label={props.t('connectorSources')}>
      {(['mcp', 'company'] as const).map((id, index, ids) => <button key={id} type="button" role="tab"
        id={`connector-source-${id}`} aria-selected={source === id} aria-controls={`connector-page-${id}`}
        tabIndex={source === id ? 0 : -1} onClick={() => { setSource(id) }} onKeyDown={(event) => {
          const next = event.key === 'Home' ? 'mcp' : event.key === 'End' ? 'company'
            : event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? ids[(index + 1) % ids.length] : undefined
          if (next === undefined) return
          event.preventDefault()
          setSource(next)
          event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#connector-source-${next}`)?.focus()
        }}>{props.t(id === 'mcp' ? 'mcpConnectors' : 'companyConnectors')}</button>)}
    </div>
    <div id={`connector-page-${source}`} className={css.connectorSourceContent} role="tabpanel" aria-labelledby={`connector-source-${source}`}>
      {source === 'company' ? <ConnectorsPanel {...props} /> : available
        ? props.renderFactorySlot('settings.section-view', { sectionId: 'mcp-connector', close: props.close, presentation: 'embedded' })
        : <p role="alert" className={css.extensionPageError}>{props.t('extensionUnavailable')}</p>}
    </div>
  </section>
}
