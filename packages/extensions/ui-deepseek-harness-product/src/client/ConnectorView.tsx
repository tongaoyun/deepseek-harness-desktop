import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Button, IconChevronRightOutlineRegular, IconLinkOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { type DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { productApi, type ProductApi } from './product-api.ts'
import { productErrorMessage } from './product-errors.ts'
import { type ProductDetail, AUTHORIZATION_TIMEOUT_MS, AUTHORIZATION_POLL_INTERVAL_MS, nextProductRequestId, abortableDelay, text, localizedMetadata, DetailIdentity } from './catalog-shared.tsx'

export function ConnectorDetailModal({ detail: product, error, loading, onCatalogChanged, managementActions, onClose, open, t }: {
  readonly managementActions?: ReactNode
  readonly open: boolean
  readonly detail: ProductDetail | undefined
  readonly loading: boolean
  readonly error: boolean
  readonly onClose: () => void
  readonly onCatalogChanged: () => Promise<void>
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  return <Modal open={open} onClose={onClose} title={t('connectorDetails')}
    closeLabel={t('close')} className={`${css.detailModal} ${css.connectorModal}`}
    contentClassName={css.detailModalContent as string}
    footer={managementActions ? <div className={css.detailActions}>{managementActions}</div> : undefined}>
    {loading && <p className={css.modalStatus} role="status">{t('loading')}</p>}
    {!loading && error && <p className={css.catalogError} role="alert">{t('detailFailed')}</p>}
    {product !== undefined && <>
      <div className={css.connectorOverview}>
        <DetailIdentity detail={product} icon={IconLinkOutlineRegular} t={t} />
        {product.summary !== undefined && <p className={css.detailSummary}>{product.summary}</p>}
      </div>
      <ConnectorDetail product={product} onCatalogChanged={onCatalogChanged} t={t} />
    </>}
  </Modal>
}

/* Connector authorization owns live polling and therefore remains isolated from catalog rendering. */
export function ConnectorDetail({ product, onCatalogChanged, t }: {
  readonly product: ProductDetail
  readonly onCatalogChanged: () => Promise<void>
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [authorizationPending, setAuthorizationPending] = useState(false)
  const [authorizationError, setAuthorizationError] = useState(false)
  const [configuring, setConfiguring] = useState(false)
  const mounted = useRef(true)
  const authorizationAbort = useRef<AbortController>()
  const activeRequests = useRef(new Map<string, ProductApi>())
  const managedAuthorization = product.authMode === 'oauth'
  const readTools = product.tools.filter(tool => tool.access === 'READ')
  const writeTools = product.tools.filter(tool => tool.access === 'WRITE')
  useEffect(() => () => {
    mounted.current = false
    authorizationAbort.current?.abort()
    for (const [requestId, api] of activeRequests.current) api.cancel(requestId)
    activeRequests.current.clear()
  }, [])
  const invoke = async (api: ProductApi, method: string): Promise<unknown> => {
    const requestId = nextProductRequestId()
    activeRequests.current.set(requestId, api)
    try {
      return await api.invoke(method, { id: product.id }, requestId)
    } finally {
      activeRequests.current.delete(requestId)
    }
  }
  const authorize = async (): Promise<void> => {
    const api = productApi()
    if (api === undefined || authorizationPending) return
    const controller = new AbortController()
    authorizationAbort.current = controller
    setAuthorizationPending(true)
    setAuthorizationError(false)
    try {
      await invoke(api, 'connectors.authorization.begin')
      const expiresAt = Date.now() + AUTHORIZATION_TIMEOUT_MS
      while (Date.now() < expiresAt) {
        await abortableDelay(AUTHORIZATION_POLL_INTERVAL_MS, controller.signal)
        const value = await invoke(api, 'connectors.authorization.status')
        const status = typeof value === 'object' && value !== null && !Array.isArray(value)
          ? text(value as Record<string, unknown>, 'status') : undefined
        if (status === 'AUTHORIZED') { await onCatalogChanged(); return }
        if (status === 'EXPIRED' || status === 'REQUIRED') break
      }
      throw new Error('connector authorization did not complete')
    } catch {
      if (!controller.signal.aborted && mounted.current) setAuthorizationError(true)
    } finally {
      if (authorizationAbort.current === controller) authorizationAbort.current = undefined
      if (mounted.current) setAuthorizationPending(false)
    }
  }
  const revoke = async (): Promise<void> => {
    const api = productApi()
    if (api === undefined || authorizationPending) return
    setAuthorizationPending(true)
    setAuthorizationError(false)
    try {
      await invoke(api, 'connectors.authorization.revoke')
      await onCatalogChanged()
    } catch {
      if (mounted.current) setAuthorizationError(true)
    } finally {
      if (mounted.current) setAuthorizationPending(false)
    }
  }
  return <>
    <section className={css.connectorSection}>
      <h2>{t('connectorConfiguration')}</h2>
      <div className={css.connectorConnection}>
        <dl className={css.connectorFacts}>
          {product.status !== undefined && <div><dt>{t('status')}</dt>
            <dd data-available={product.availabilityStatus === 'AVAILABLE'}>{localizedMetadata(product.status, t)}</dd></div>}
          {product.authorizationStatus !== undefined && <div><dt>{t('authorizationStatus')}</dt>
            <dd>{localizedMetadata(product.authorizationStatus, t)}</dd></div>}
          {product.scope !== undefined && <div><dt>{t('scope')}</dt>
            <dd>{localizedMetadata(product.scope, t)}</dd></div>}
          {product.transport !== undefined && <div><dt>{t('transport')}</dt>
            <dd>{localizedMetadata(product.transport, t)}</dd></div>}
          {product.authMode !== undefined && <div><dt>{t('authMode')}</dt>
            <dd>{localizedMetadata(product.authMode, t)}</dd></div>}
        </dl>
      </div>
      {managedAuthorization && <div className={css.detailActions}>
        {product.authorizationStatus === 'AUTHORIZED'
          ? <Button variant="outline" size="sm" disabled={authorizationPending} onClick={() => { void revoke() }}>
            {authorizationPending ? t('authorizationWorking') : t('revokeAuthorization')}
          </Button>
          : <Button variant="primary" size="sm" disabled={authorizationPending} onClick={() => { void authorize() }}>
            {authorizationPending ? t('authorizationWaiting')
              : product.authorizationStatus === 'EXPIRED' ? t('reauthorize') : t('authorize')}
          </Button>}
        {authorizationError && <span className={css.catalogError} role="alert">{t('authorizationFailed')}</span>}
      </div>}
      {product.canConfigure === true && <div className={css.detailActions}>
        <Button variant="outline" size="sm" onClick={() => { setConfiguring(true) }}><IconLinkOutlineRegular size={14} />{t('configureDevice')}</Button>
      </div>}
    </section>
    {configuring && <ConnectorDeviceConfiguration product={product} onClose={() => { setConfiguring(false) }}
      onSaved={async () => { await onCatalogChanged(); if (mounted.current) setConfiguring(false) }} t={t} />}
    <section className={css.connectorSection}>
      <h2>{t('connectorTools')}</h2>
      {product.tools.length > 0 && <div className={css.toolSummary}>
        <span>{t('readCapabilityCount').replace('{count}', String(readTools.length))}</span>
        {writeTools.length > 0
          && <span>{t('writeCapabilityCount').replace('{count}', String(writeTools.length))}</span>}
      </div>}
      {product.tools.length === 0 ? <p className={css.catalogStatus}>{t('empty')}</p>
        : <details className={css.detailDisclosure}>
          <summary><span>{t('viewConnectorTools').replace('{count}', String(product.tools.length))}</span>
            <IconChevronRightOutlineRegular size={14} /></summary>
          <div className={css.disclosureBody}><ul className={css.detailToolList}>{product.tools.map(tool =>
            <li key={tool.name}><div className={css.toolRow}>
              <span className={css.toolCopy}><strong>{tool.displayName}</strong>
                {tool.description !== undefined && <span>{tool.description}</span>}</span>
              <span className={css.toolPermission} data-access={tool.access}>
                {tool.access === 'READ' ? t('readOnlyLabel') : t('writeLabel')}
              </span>
            </div></li>)}</ul></div>
        </details>}
    </section>
  </>
}

type DeviceConfiguration = {
  readonly transport: string
  readonly url?: string
  readonly command?: string
  readonly arguments: readonly string[]
  readonly headers: readonly string[]
  readonly environment: readonly string[]
  readonly configured: boolean
  readonly timeoutSeconds: number
}

function ConnectorDeviceConfiguration({ product, onClose, onSaved, t }: {
  readonly product: ProductDetail
  readonly onClose: () => void
  readonly onSaved: () => Promise<void>
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [configuration, setConfiguration] = useState<DeviceConfiguration>()
  const [headers, setHeaders] = useState<Record<string, string>>({})
  const [environment, setEnvironment] = useState<Record<string, string>>({})
  const [timeout, setTimeout] = useState(60)
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const lifecycle = useRef({ closed: false, requests: new Map<string, ProductApi>() })
  const invoke = async (method: string, input: unknown): Promise<unknown> => {
    const api = productApi()
    if (!api) throw new Error('Product transport unavailable')
    const requestId = nextProductRequestId(); lifecycle.current.requests.set(requestId, api)
    try { return await api.invoke(method, input, requestId, timeout * 2000 + 60_000) }
    finally { lifecycle.current.requests.delete(requestId) }
  }
  const load = async (): Promise<void> => {
    setError(undefined)
    try {
      const value = await invoke('extensions.connector.configuration.read', { id: product.id, version: product.version }) as DeviceConfiguration
      if (!lifecycle.current.closed) { setConfiguration(value); setTimeout(value.timeoutSeconds) }
    } catch (error) { if (!lifecycle.current.closed) setError(productErrorMessage(error, t, 'loadFailed')) }
  }
  useEffect(() => {
    lifecycle.current.closed = false
    void load()
    return () => {
      lifecycle.current.closed = true
      for (const [id, api] of lifecycle.current.requests) api.cancel(id)
    }
  }, [])
  const save = async (): Promise<void> => {
    if (!configuration || pending) return
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) { setError(t('connectorTimeoutInvalid')); return }
    setPending(true); setError(undefined)
    try {
      await invoke('extensions.connector.configuration.save', { id: product.id, version: product.version,
        configuration: { headers, environment, timeoutSeconds: timeout } })
      if (!lifecycle.current.closed) await onSaved()
    } catch (error) { if (!lifecycle.current.closed) setError(productErrorMessage(error, t, 'saveFailed')) }
    finally { if (!lifecycle.current.closed) setPending(false) }
  }
  const fields = (keys: readonly string[], values: Record<string, string>, set: (values: Record<string, string>) => void,
    label: DeepSeekHarnessProductKey): ReactNode => keys.length > 0 && <section className={css.configurationSection}>
    <h3>{t(label)}</h3>
    {keys.map(key => <label key={key} className={css.editorField}><span>{key}</span>
      <input type="password" autoComplete="off" aria-label={key} disabled={pending} value={values[key] ?? ''}
        placeholder={t(configuration?.configured ? 'privateValueRetained' : 'configurationValue')}
        onChange={(event) => { set({ ...values, [key]: event.currentTarget.value }) }} /></label>)}
  </section>
  return <Modal open onClose={onClose} title={t('configureDevice')} closeLabel={t('close')}
    className={css.connectorDeviceModal as string} contentClassName={css.connectorEditorContent as string}
    footer={<Button variant="primary" disabled={!configuration || pending} onClick={() => { void save() }}>
      {pending ? t('connectingConnector') : t('saveConnector')}</Button>}>
    {error && <p className={css.catalogError} role="alert">{error}</p>}
    {!configuration && (error ? <Button variant="outline" onClick={() => { void load() }}>{t('retry')}</Button> : <p role="status">{t('loading')}</p>)}
    {configuration && <div className={`${css.editorForm} ${css.connectorForm}`}>
      <label className={css.editorField}><span>{t(configuration.transport === 'stdio' ? 'connectorExecutable' : 'connectorEndpoint')}</span>
        <input readOnly value={configuration.transport === 'stdio'
          ? [configuration.command, ...configuration.arguments].join(' ') : configuration.url ?? ''} /></label>
      {fields(configuration.headers, headers, setHeaders, 'privateHeaders')}
      {fields(configuration.environment, environment, setEnvironment, 'privateEnvironment')}
      <label className={css.editorField}><span>{t('connectorTimeout')}</span>
        <input type="number" min={1} max={600} aria-label={t('connectorTimeout')} disabled={pending} value={timeout}
          onChange={(event) => { setTimeout(Number(event.currentTarget.value)) }} /></label>
    </div>}
  </Modal>
}
