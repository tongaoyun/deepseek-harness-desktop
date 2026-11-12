import { ProductLoading } from './ProductLoading.tsx'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Button, IconLinkOutlineRegular, Modal, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseConnectorAuthorization, parseConnectorAuthorizationLaunch, ConnectorDraftFields, ConnectorConfigurationSaveResultSchema, ConnectorDeviceConfigurationSchema, type ConnectorDeviceConfigurationSnapshot } from '@deepseek-harness/product/connector-draft'
import { type DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { invokeProduct, productApi, type ProductApi } from './product-api.ts'
import { productErrorMessage, type ProductFailureReport } from './product-errors.ts'
import { type ProductDetail, AUTHORIZATION_TIMEOUT_MS, AUTHORIZATION_POLL_INTERVAL_MS, abortableDelay, DetailIdentity } from './catalog-shared.tsx'
import { ConnectorTools } from './ConnectorTools.tsx'
import { useEditorCloseGuard } from './useEditorCloseGuard.ts'
import { useResultFocus } from './useResultFocus.ts'

export function ConnectorDetailModal({ detail: product, onCatalogChanged, managementActions, onClose, t }: {
  readonly managementActions?: ReactNode
  readonly detail: ProductDetail | undefined
  readonly onClose: () => void
  readonly onCatalogChanged: (beforeCommit: () => void) => Promise<void>
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
      <ConnectorDetail key={`${product.id}:${product.version}`} product={product} onCatalogChanged={onCatalogChanged} t={t} />
    </>}
  </Modal>
}

/** Refresh connector authorization and capabilities without losing retained browsing state or focus.
 * @param props Product version, catalog refresh action and localized labels;
 * the refresh action calls beforeCommit before replacing confirmed details.
 * @returns Authorization, device configuration and searchable capabilities for this version.
 */
export function ConnectorDetail({ product, onCatalogChanged, t }: {
  readonly product: ProductDetail
  readonly onCatalogChanged: (beforeCommit: () => void) => Promise<void>
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [authorizationPending, setAuthorizationPending] = useState(false)
  const [authorizationError, setAuthorizationError] = useState(false)
  const [refreshState, setRefreshState] = useState<'idle' | 'pending' | 'failed' | 'retrying'>('idle')
  const refreshing = refreshState === 'pending' || refreshState === 'retrying'
  const refreshFailed = refreshState === 'failed' || refreshState === 'retrying'
  const [configuring, setConfiguring] = useState(false)
  const authorizationOperation = useRef(false)
  const refreshOperation = useRef(false)
  const configurationArea = useRef<HTMLElement>(null)
  const configurationAction = useRef<HTMLButtonElement>(null)
  const preserveRefreshFocus = useResultFocus(configurationArea, configurationAction)
  const toolsArea = useRef<HTMLElement>(null)
  const toolsHeading = useRef<HTMLHeadingElement>(null)
  const preserveToolsFocus = useResultFocus(toolsArea, () => {
    const search = toolsArea.current?.querySelector<HTMLInputElement>('input[type="search"]')
    const target = toolsArea.current?.hidden ? configurationAction.current
      : search && !search.closest('[hidden]') ? search : toolsHeading.current ?? configurationAction.current
    if (target) focusWithoutRing(target, { preventScroll: true })
  })
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
    if (refreshOperation.current) return
    refreshOperation.current = true
    setRefreshState(current => current === 'failed' ? 'retrying' : 'pending')
    try {
      signal.throwIfAborted()
      await onCatalogChanged(() => { preserveRefreshFocus(); preserveToolsFocus() })
      signal.throwIfAborted()
      preserveRefreshFocus()
      preserveToolsFocus()
      setRefreshState('idle')
    } catch {
      if (!signal.aborted) { preserveRefreshFocus(); preserveToolsFocus(); setRefreshState('failed') }
    } finally { refreshOperation.current = false }
  }
  const authorize = async (): Promise<void> => {
    const api = productApi()
    if (api === undefined || authorizationOperation.current || refreshOperation.current || refreshState !== 'idle') return
    const lifetime = lifecycle.current.signal
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(AUTHORIZATION_TIMEOUT_MS)])
    authorizationOperation.current = true
    setAuthorizationPending(true)
    try {
      const launch = await invoke(api, 'connectors.authorization.begin', signal)
      signal.throwIfAborted()
      parseConnectorAuthorizationLaunch(launch, product.id)
      while (true) {
        await abortableDelay(AUTHORIZATION_POLL_INTERVAL_MS, signal)
        const value = await invoke(api, 'connectors.authorization.status', signal)
        signal.throwIfAborted()
        const { status } = parseConnectorAuthorization(value, product.id)
        if (status === 'AUTHORIZED') { setAuthorizationError(false); await refreshCatalog(); return }
        if (status === 'EXPIRED' || status === 'REQUIRED') break
      }
      throw new Error('connector authorization did not complete')
    } catch {
      if (!lifetime.aborted) setAuthorizationError(true)
    } finally {
      authorizationOperation.current = false
      if (!lifetime.aborted) setAuthorizationPending(false)
    }
  }
  const revoke = async (): Promise<void> => {
    const api = productApi()
    if (api === undefined || authorizationOperation.current || refreshOperation.current || refreshState !== 'idle') return
    const signal = lifecycle.current.signal
    authorizationOperation.current = true
    setAuthorizationPending(true)
    try {
      const result = await invoke(api, 'connectors.authorization.revoke', signal)
      signal.throwIfAborted()
      if (parseConnectorAuthorization(result, product.id).status !== 'REQUIRED') throw new Error('Connector revocation was not confirmed')
      setAuthorizationError(false)
      await refreshCatalog()
    } catch {
      if (!signal.aborted) setAuthorizationError(true)
    } finally {
      authorizationOperation.current = false
      if (!signal.aborted) setAuthorizationPending(false)
    }
  }
  return <>
    {(managedAuthorization || product.canConfigure === true) && <section ref={configurationArea}
      className={css.connectorSection} aria-busy={refreshing}>
      <h2>{t('connectorConfiguration')}</h2>
      {refreshFailed && <div className={css.detailActions}>
        <span className={css.catalogError} role="alert">{t('connectorRefreshFailed')}</span>
        <Button ref={configurationAction} variant="outline" size="sm" aria-disabled={refreshing} aria-busy={refreshing}
          className={refreshing ? 'product-control-pending' : undefined} onClick={() => { void refreshCatalog() }}>{t('refresh')}</Button>
      </div>}
      {managedAuthorization && !refreshFailed && <div className={css.detailActions}>
        {product.authorizationStatus === 'AUTHORIZED'
          ? <Button ref={configurationAction} variant="outline" size="sm" className={authorizationPending || refreshing ? 'product-control-pending' : undefined}
            aria-disabled={authorizationPending || refreshing} aria-busy={authorizationPending || refreshing}
            onClick={() => { void revoke() }}>
            {authorizationPending ? t('authorizationWorking') : t('revokeAuthorization')}
          </Button>
          : <Button ref={configurationAction} variant="primary" size="sm" className={authorizationPending || refreshing ? 'product-control-pending' : undefined}
            aria-disabled={authorizationPending || refreshing} aria-busy={authorizationPending || refreshing}
            onClick={() => { void authorize() }}>
            {authorizationPending ? t('authorizationWaiting')
              : product.authorizationStatus === 'EXPIRED' ? t('reauthorize') : t('authorize')}
          </Button>}
        {authorizationError && <span className={css.catalogError} role="alert">{t('authorizationFailed')}</span>}
      </div>}
      {product.canConfigure === true && !refreshFailed && <div className={css.detailActions}>
        <Button ref={managedAuthorization ? undefined : configurationAction} variant="outline" size="sm" className={refreshing ? 'product-control-pending' : undefined}
          disabled={refreshing} onClick={() => { setConfiguring(true) }}><IconLinkOutlineRegular size={14} />{t('configureDevice')}</Button>
      </div>}
    </section>}
    {configuring && <ConnectorDeviceConfiguration product={product} onClose={() => { setConfiguring(false) }}
      onSaved={async () => {
        const signal = lifecycle.current.signal
        await refreshCatalog()
        if (!signal.aborted) setConfiguring(false)
      }} t={t} />}
    <section ref={toolsArea} hidden={refreshFailed} className={css.connectorSection} aria-busy={refreshing}>
      <h2 ref={toolsHeading} tabIndex={-1}>{t('connectorTools')}</h2>
      {product.tools.length > 0 && <div className={css.toolSummary}>
        <span>{t('readCapabilityCount').replace('{count}', String(readTools.length))}</span>
        {writeTools.length > 0
          && <span>{t('writeCapabilityCount').replace('{count}', String(writeTools.length))}</span>}
      </div>}
      {product.tools.length === 0 && <p className={css.catalogStatus}>{t('empty')}</p>}
      <div hidden={product.tools.length === 0}>
        <ConnectorTools key={`${product.id}:${product.version}`} tools={product.tools} t={t} />
      </div>
    </section>
  </>
}

/** A removed read retry returns its owned focus to the timeout field without scrolling. */
function ConnectorDeviceConfiguration({ product, onClose, onSaved, t }: {
  readonly product: ProductDetail
  readonly onClose: () => void
  readonly onSaved: () => Promise<void>
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [configuration, setConfiguration] = useState<ConnectorDeviceConfigurationSnapshot>()
  const [loading, setLoading] = useState(true)
  const [headers, setHeaders] = useState<Record<string, string>>({})
  const [environment, setEnvironment] = useState<Record<string, string>>({})
  const [timeout, setTimeout] = useState(60)
  const [error, setError] = useState<DeepSeekHarnessProductKey | ProductFailureReport>()
  const [pending, setPending] = useState(false)
  const saving = useRef(false)
  const dirty = Object.values(headers).some(value => value !== '') || Object.values(environment).some(value => value !== '')
    || configuration !== undefined && timeout !== configuration.timeoutSeconds
  const close = useEditorCloseGuard(dirty, () => saving.current, onClose)
  const timeoutField = useRef<HTMLInputElement>(null)
  const preserveReadFocus = useResultFocus(close.editorProps.ref, timeoutField)
  const lifecycle = useRef(new AbortController())
  const configurationRead = useRef<AbortSignal>()
  const invoke = async (method: string, input: unknown, signal: AbortSignal): Promise<unknown> => {
    const api = productApi()
    if (!api) throw new Error('Product transport unavailable')
    return invokeProduct(api, method, input, signal, timeout * 2000 + 60_000)
  }
  const load = async (signal = lifecycle.current.signal): Promise<void> => {
    if (configurationRead.current === signal) return
    configurationRead.current = signal
    try {
      signal.throwIfAborted()
      setLoading(true)
      const value = ConnectorDeviceConfigurationSchema.parse(await invoke('extensions.connector.configuration.read',
        { id: product.id, version: product.version }, signal))
      if (value.id !== product.id || value.version !== product.version) throw new Error('Connector configuration identity does not match')
      preserveReadFocus()
      setConfiguration(value); setTimeout(value.timeoutSeconds)
      setError(undefined)
    } catch (error) { if (!signal.aborted) { preserveReadFocus(); setError({ failure: error, fallback: 'loadFailed' }) } }
    finally {
      if (configurationRead.current === signal) configurationRead.current = undefined
      if (!signal.aborted) setLoading(false)
    }
  }
  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    void load(controller.signal)
    return () => { controller.abort() }
  }, [])
  const save = async (): Promise<void> => {
    if (!configuration || saving.current) return
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) { setError('connectorTimeoutInvalid'); return }
    if (!ConnectorDraftFields.shape.headers.safeParse(headers).success) { setError('connectorHeadersInvalid'); return }
    if (!ConnectorDraftFields.shape.environment.safeParse(environment).success) { setError('connectorEnvironmentInvalid'); return }
    const signal = lifecycle.current.signal
    saving.current = true
    setPending(true)
    try {
      const receipt = ConnectorConfigurationSaveResultSchema.parse(await invoke('extensions.connector.configuration.save',
        { id: product.id, version: product.version, configuration: { headers, environment, timeoutSeconds: timeout } }, signal))
      if (receipt.id !== product.id || receipt.version !== product.version) throw new Error('Connector configuration receipt does not match')
      if (!signal.aborted) { setError(undefined); await onSaved() }
    } catch (error) { if (!signal.aborted) setError({ failure: error, fallback: 'saveFailed' }) }
    finally { saving.current = false; if (!signal.aborted) setPending(false) }
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
    footer={<div className={css.connectorFooter}>
      {!close.confirming && error && <p className={css.catalogError} role="alert">{typeof error === 'string' ? t(error)
        : productErrorMessage(error.failure, t, error.fallback)}</p>}
      {close.confirming ? <><Button ref={close.keepEditingRef} variant="ghost" onClick={close.keepEditing}>{t('knowledgeKeepEditing')}</Button>
        <Button variant="primary" onClick={close.discard}>{t('knowledgeDiscardDraft')}</Button></>
        : <Button variant="primary" disabled={!configuration} aria-disabled={!configuration || pending} aria-busy={pending}
          className={pending && configuration ? 'product-control-pending' : undefined} onClick={() => { void save() }}>
          {pending ? t('connectingConnector') : t('saveConnector')}</Button>}</div>}>
    {close.confirming && <p>{t('knowledgeDiscardDraftConfirmation')}</p>}
    <div hidden={close.confirming} {...close.editorProps}>
      {close.blocked && pending && <p role="status" className={css.catalogStatus}>{t('knowledgeWaitForSave')}</p>}
      {!configuration && (error ? <Button variant="outline" aria-disabled={loading} aria-busy={loading}
        className={loading ? 'product-control-pending' : undefined} onClick={() => { void load() }}>{t('retry')}</Button> : <ProductLoading label={t('loading')} />)}
      {configuration && <div className={`${css.editorForm} ${css.connectorForm}`}>
        <label className={css.editorField}><span>{t(configuration.transport === 'stdio' ? 'connectorExecutable' : 'connectorEndpoint')}</span>
          <input readOnly value={configuration.transport === 'stdio'
            ? [configuration.command, ...configuration.arguments].join(' ') : configuration.url} /></label>
        {fields(configuration.headers, headers, setHeaders, 'privateHeaders')}
        {fields(configuration.environment, environment, setEnvironment, 'privateEnvironment')}
        <label className={css.editorField}><span>{t('connectorTimeout')}</span>
          <input ref={timeoutField} type="number" min={1} max={600} aria-label={t('connectorTimeout')} disabled={pending} value={timeout}
            onChange={(event) => { setTimeout(Number(event.currentTarget.value)) }} /></label>
      </div>}
    </div>
  </Modal>
}
