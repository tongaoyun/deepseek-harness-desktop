import { ProductLoading } from './ProductLoading.tsx'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Button, IconLinkOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseConnectorAuthorization, parseConnectorAuthorizationLaunch, ConnectorConfigurationSaveResultSchema, ConnectorDeviceConfigurationSchema, type ConnectorDeviceConfigurationSnapshot } from '@deepseek-harness/product/connector-draft'
import { type DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { invokeProduct, productApi, type ProductApi } from './product-api.ts'
import { productErrorMessage } from './product-errors.ts'
import { type ProductDetail, AUTHORIZATION_TIMEOUT_MS, AUTHORIZATION_POLL_INTERVAL_MS, abortableDelay, DetailIdentity } from './catalog-shared.tsx'
import { ConnectorTools } from './ConnectorTools.tsx'
import { useEditorCloseGuard } from './useEditorCloseGuard.ts'

export function ConnectorDetailModal({ detail: product, onCatalogChanged, managementActions, onClose, t }: {
  readonly managementActions?: ReactNode
  readonly detail: ProductDetail | undefined
  readonly onClose: () => void
  readonly onCatalogChanged: () => Promise<void>
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  return <Modal open={product !== undefined} onClose={onClose} title={t('connectorDetails')}
    closeLabel={t('close')} className={`${css.detailModal} ${css.connectorModal}`}
    contentClassName={css.detailModalContent as string}
    footer={managementActions ? <div className={css.detailActions}>{managementActions}</div> : undefined}>
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
  const [refreshState, setRefreshState] = useState<'idle' | 'pending' | 'failed'>('idle')
  const [configuring, setConfiguring] = useState(false)
  const lifecycle = useRef<AbortController>(new AbortController())
  const managedAuthorization = product.authMode === 'oauth'
  const readTools = product.tools.filter(tool => tool.access === 'READ')
  const writeTools = product.tools.filter(tool => tool.access === 'WRITE')
  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    return () => { controller.abort() }
  }, [])
  const invoke = async (api: ProductApi, method: string, signal: AbortSignal): Promise<unknown> => {
    return invokeProduct(api, method, { id: product.id }, signal)
  }
  const refreshCatalog = async (): Promise<void> => {
    const signal = lifecycle.current.signal
    if (refreshState === 'pending') return
    setRefreshState('pending')
    try {
      signal.throwIfAborted()
      await onCatalogChanged()
      signal.throwIfAborted()
      setRefreshState('idle')
    } catch {
      if (!signal.aborted) setRefreshState('failed')
    }
  }
  const authorize = async (): Promise<void> => {
    const api = productApi()
    if (api === undefined || authorizationPending || refreshState !== 'idle') return
    const lifetime = lifecycle.current.signal
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(AUTHORIZATION_TIMEOUT_MS)])
    setAuthorizationPending(true)
    setAuthorizationError(false)
    try {
      const launch = await invoke(api, 'connectors.authorization.begin', signal)
      signal.throwIfAborted()
      parseConnectorAuthorizationLaunch(launch, product.id)
      while (true) {
        await abortableDelay(AUTHORIZATION_POLL_INTERVAL_MS, signal)
        const value = await invoke(api, 'connectors.authorization.status', signal)
        signal.throwIfAborted()
        const { status } = parseConnectorAuthorization(value, product.id)
        if (status === 'AUTHORIZED') { await refreshCatalog(); return }
        if (status === 'EXPIRED' || status === 'REQUIRED') break
      }
      throw new Error('connector authorization did not complete')
    } catch {
      if (!lifetime.aborted) setAuthorizationError(true)
    } finally {
      if (!lifetime.aborted) setAuthorizationPending(false)
    }
  }
  const revoke = async (): Promise<void> => {
    const api = productApi()
    if (api === undefined || authorizationPending || refreshState !== 'idle') return
    const signal = lifecycle.current.signal
    setAuthorizationPending(true)
    setAuthorizationError(false)
    try {
      const result = await invoke(api, 'connectors.authorization.revoke', signal)
      signal.throwIfAborted()
      if (parseConnectorAuthorization(result, product.id).status !== 'REQUIRED') throw new Error('Connector revocation was not confirmed')
      await refreshCatalog()
    } catch {
      if (!signal.aborted) setAuthorizationError(true)
    } finally {
      if (!signal.aborted) setAuthorizationPending(false)
    }
  }
  return <>
    {(managedAuthorization || product.canConfigure === true) && <section className={css.connectorSection}>
      <h2>{t('connectorConfiguration')}</h2>
      {refreshState === 'pending' && <ProductLoading label={t('loading')} />}
      {refreshState === 'failed' && <div className={css.detailActions}>
        <span className={css.catalogError} role="alert">{t('connectorRefreshFailed')}</span>
        <Button variant="outline" size="sm" onClick={() => { void refreshCatalog() }}>{t('refresh')}</Button>
      </div>}
      {managedAuthorization && refreshState === 'idle' && <div className={css.detailActions}>
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
      {product.canConfigure === true && refreshState === 'idle' && <div className={css.detailActions}>
        <Button variant="outline" size="sm" onClick={() => { setConfiguring(true) }}><IconLinkOutlineRegular size={14} />{t('configureDevice')}</Button>
      </div>}
    </section>}
    {configuring && <ConnectorDeviceConfiguration product={product} onClose={() => { setConfiguring(false) }}
      onSaved={async () => {
        const signal = lifecycle.current.signal
        await refreshCatalog()
        if (!signal.aborted) setConfiguring(false)
      }} t={t} />}
    {refreshState === 'idle' && <section className={css.connectorSection}>
      <h2>{t('connectorTools')}</h2>
      {product.tools.length > 0 && <div className={css.toolSummary}>
        <span>{t('readCapabilityCount').replace('{count}', String(readTools.length))}</span>
        {writeTools.length > 0
          && <span>{t('writeCapabilityCount').replace('{count}', String(writeTools.length))}</span>}
      </div>}
      {product.tools.length === 0 ? <p className={css.catalogStatus}>{t('empty')}</p>
        : <ConnectorTools key={`${product.id}:${product.version}`} tools={product.tools} t={t} />}
    </section>}
  </>
}

function ConnectorDeviceConfiguration({ product, onClose, onSaved, t }: {
  readonly product: ProductDetail
  readonly onClose: () => void
  readonly onSaved: () => Promise<void>
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [configuration, setConfiguration] = useState<ConnectorDeviceConfigurationSnapshot>()
  const [headers, setHeaders] = useState<Record<string, string>>({})
  const [environment, setEnvironment] = useState<Record<string, string>>({})
  const [timeout, setTimeout] = useState(60)
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const dirty = Object.values(headers).some(value => value !== '') || Object.values(environment).some(value => value !== '')
    || configuration !== undefined && timeout !== configuration.timeoutSeconds
  const close = useEditorCloseGuard(dirty, pending, onClose)
  const lifecycle = useRef(new AbortController())
  const invoke = async (method: string, input: unknown, signal: AbortSignal): Promise<unknown> => {
    const api = productApi()
    if (!api) throw new Error('Product transport unavailable')
    return invokeProduct(api, method, input, signal, timeout * 2000 + 60_000)
  }
  const load = async (signal = lifecycle.current.signal): Promise<void> => {
    setError(undefined)
    try {
      const value = ConnectorDeviceConfigurationSchema.parse(await invoke('extensions.connector.configuration.read',
        { id: product.id, version: product.version }, signal))
      if (value.id !== product.id || value.version !== product.version) throw new Error(t('loadFailed'))
      setConfiguration(value); setTimeout(value.timeoutSeconds)
    } catch (error) { if (!signal.aborted) setError(productErrorMessage(error, t, 'loadFailed')) }
  }
  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    void load(controller.signal)
    return () => { controller.abort() }
  }, [])
  const save = async (): Promise<void> => {
    if (!configuration || pending) return
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) { setError(t('connectorTimeoutInvalid')); return }
    const signal = lifecycle.current.signal
    setPending(true); setError(undefined)
    try {
      const receipt = ConnectorConfigurationSaveResultSchema.parse(await invoke('extensions.connector.configuration.save',
        { id: product.id, version: product.version, configuration: { headers, environment, timeoutSeconds: timeout } }, signal))
      if (receipt.id !== product.id || receipt.version !== product.version) throw new Error(t('saveFailed'))
      if (!signal.aborted) await onSaved()
    } catch (error) { if (!signal.aborted) setError(productErrorMessage(error, t, 'saveFailed')) }
    finally { if (!signal.aborted) setPending(false) }
  }
  const fields = (keys: readonly string[], values: Record<string, string>, set: (values: Record<string, string>) => void,
    label: DeepSeekHarnessProductKey): ReactNode => keys.length > 0 && <section className={css.configurationSection}>
    <h3>{t(label)}</h3>
    {keys.map(key => <label key={key} className={css.editorField}><span>{key}</span>
      <input type="password" autoComplete="off" aria-label={key} disabled={pending} value={values[key] ?? ''}
        placeholder={t(configuration?.configured ? 'privateValueRetained' : 'configurationValue')}
        onChange={(event) => { set({ ...values, [key]: event.currentTarget.value }) }} /></label>)}
  </section>
  return <Modal open onClose={close.requestClose} title={t('configureDevice')} closeLabel={t('close')}
    className={css.connectorDeviceModal as string} contentClassName={css.connectorEditorContent as string}
    footer={close.confirming ? <><Button variant="ghost" onClick={close.keepEditing}>{t('knowledgeKeepEditing')}</Button>
      <Button variant="primary" onClick={close.discard}>{t('knowledgeDiscardDraft')}</Button></>
      : <Button variant="primary" disabled={!configuration || pending} onClick={() => { void save() }}>
        {pending ? t('connectingConnector') : t('saveConnector')}</Button>}>
    {close.confirming ? <p>{t('knowledgeDiscardDraftConfirmation')}</p> : <>
      {error && <p className={css.catalogError} role="alert">{error}</p>}
      {!configuration && (error ? <Button variant="outline" onClick={() => { void load() }}>{t('retry')}</Button> : <ProductLoading label={t('loading')} />)}
      {configuration && <div className={`${css.editorForm} ${css.connectorForm}`}>
        <label className={css.editorField}><span>{t(configuration.transport === 'stdio' ? 'connectorExecutable' : 'connectorEndpoint')}</span>
          <input readOnly value={configuration.transport === 'stdio'
            ? [configuration.command, ...configuration.arguments].join(' ') : configuration.url} /></label>
        {fields(configuration.headers, headers, setHeaders, 'privateHeaders')}
        {fields(configuration.environment, environment, setEnvironment, 'privateEnvironment')}
        <label className={css.editorField}><span>{t('connectorTimeout')}</span>
          <input type="number" min={1} max={600} aria-label={t('connectorTimeout')} disabled={pending} value={timeout}
            onChange={(event) => { setTimeout(Number(event.currentTarget.value)) }} /></label>
      </div>}
    </>}
  </Modal>
}
