import { ProductLoading } from './ProductLoading.tsx'
/** Personal MCP configuration, with write-only local secrets. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { Button, IconCloseOutlineRegular, IconDeliverDocRegular, IconPlusOutlineRegular, Modal, Tooltip, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import { ConnectorEditorSnapshotSchema, ConnectorDraftSchema, ConnectorSaveResultSchema, connectorTargetMatches, type ConnectorDraft } from '@deepseek-harness/product/connector-draft'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { CATEGORY_KEYS, items, type ProductItem } from './catalog-shared.tsx'
import { invokeProduct, productApi } from './product-api.ts'
import { productErrorMessage, type ProductFailureReport } from './product-errors.ts'
import { connectorCommand, connectorCommandText, connectorConfigurations, connectorVariables } from './connector-configuration.ts'
import { useEditorCloseGuard } from './useEditorCloseGuard.ts'
import { useResultFocus } from './useResultFocus.ts'

type Pair = { readonly id: string; key: string; value: string }
type Providers = { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly items: readonly ProductItem[] }
  | { readonly status: 'failed' | 'retrying'; readonly error: unknown }
const pair = (key = '', value = ''): Pair => ({ id: randomUUID(), key, value })
const pairs = (value: Record<string, string>): Pair[] => Object.entries(value).map(([key, value]) => pair(key, value))
const pairValues = (rows: readonly Pair[]) => rows.map(({ key, value }) => ({ key, value }))
const configuration = (rows: readonly Pair[]): Record<string, string> => {
  const active = rows.filter(row => row.key.trim() || row.value)
  const keys = active.map(row => row.key.trim())
  if (keys.some(key => !key) || new Set(keys).size !== keys.length) throw new Error('Invalid configuration keys')
  return Object.fromEntries(active.map(row => [row.key.trim(), row.value]))
}

/** Configure HTTP or stdio with guarded drafts; saving only discovers tools.
 * Removed read retries return their owned focus to the transport selector without scrolling.
 */
export function ConnectorEditor({ onClose, onSaved, editing, t }: {
  readonly editing?: { readonly id: string; readonly version: string } | undefined
  readonly onClose: () => void
  readonly onSaved: () => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [draft, setDraft] = useState<ConnectorDraft>(() => ({
    kind: 'connector', id: `connector-${randomUUID().slice(0, 8)}`, version: '1.0.0', name: '', summary: '', category: 'other',
    transport: 'stdio', url: '', arguments: [], headers: {}, environment: {}, timeoutSeconds: 60,
  }))
  const [mode, setMode] = useState<'manual' | 'json'>('manual')
  const [json, setJson] = useState('')
  const [headers, setHeaders] = useState<Pair[]>([])
  const [environment, setEnvironment] = useState<Pair[]>(() => [pair()])
  const configurationKeys = useRef(new Map<string, HTMLInputElement>())
  const configurationAdd = useRef(new Map<DeepSeekHarnessProductKey, HTMLButtonElement>())
  const addedRow = useRef<string>()
  useLayoutEffect(() => {
    const id = addedRow.current
    addedRow.current = undefined
    const field = id === undefined ? undefined : configurationKeys.current.get(id)
    if (field) focusWithoutRing(field)
  }, [headers, environment])
  const [command, setCommand] = useState('')
  const [timeout, setTimeout] = useState('60')
  const [providers, setProviders] = useState<Providers>({ status: 'loading' })
  const [parsed, setParsed] = useState<readonly ConnectorDraft[]>([])
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState<DeepSeekHarnessProductKey | ProductFailureReport>()
  const [pending, setPending] = useState(false)
  const saving = useRef(false)
  const [loading, setLoading] = useState(editing !== undefined)
  const [ready, setReady] = useState(editing === undefined)
  const savedConfiguration = useRef<ConnectorDraft>()
  const values = JSON.stringify([draft, pairValues(headers), pairValues(environment), command, timeout, json])
  const baseline = useRef(values)
  const close = useEditorCloseGuard(values !== baseline.current, () => saving.current, onClose)
  const transportField = useRef<HTMLSelectElement>(null)
  const preserveReadFocus = useResultFocus(close.editorProps.ref, transportField)
  const feedback = useRef<HTMLDivElement>(null)
  const preserveFeedbackFocus = useResultFocus(feedback, transportField)
  const clipboardInputs = useRef<readonly unknown[]>([])
  useLayoutEffect(() => {
    clipboardInputs.current = [draft, headers, environment, command, timeout, json, mode, pending, close.confirming]
  }, [draft, headers, environment, command, timeout, json, mode, pending, close.confirming])
  const clipboardRequest = useRef(0)
  const lifecycle = useRef(new AbortController())
  const editorRead = useRef<AbortSignal>()
  const providerRead = useRef<AbortSignal>()
  const invoke = async (method: string, payload: unknown, timeoutMs?: number, signal = lifecycle.current.signal): Promise<unknown> => {
    signal.throwIfAborted()
    const api = productApi()
    if (!api) throw new Error('Product transport unavailable')
    return invokeProduct(api, method, payload, signal, timeoutMs)
  }
  const load = async (signal = lifecycle.current.signal): Promise<void> => {
    if (!editing || editorRead.current === signal) return
    editorRead.current = signal
    try {
      signal.throwIfAborted()
      setLoading(true)
      const value = await invoke('extensions.connector.read', editing, undefined, signal)
      signal.throwIfAborted()
      const result = ConnectorEditorSnapshotSchema.parse(value)
      if (result.draft.id !== editing.id) throw new Error('Connector editing identity does not match')
      preserveReadFocus()
      preserveFeedbackFocus()
      savedConfiguration.current = result.configured ? result.draft : undefined
      applyJson(result.draft, true)
      if (result.savePending) setError('connectorSavePending')
      setReady(true)
    } catch (error) { if (!signal.aborted) { preserveReadFocus(); setError({ failure: error, fallback: 'loadFailed' }) } }
    finally {
      if (editorRead.current === signal) editorRead.current = undefined
      if (!signal.aborted) setLoading(false)
    }
  }
  const loadProviders = async (signal = lifecycle.current.signal): Promise<void> => {
    if (providerRead.current === signal) return
    providerRead.current = signal
    try {
      signal.throwIfAborted()
      setProviders(current => current.status === 'failed' ? { status: 'retrying', error: current.error } : { status: 'loading' })
      const value = await invoke('connectors.list', {}, undefined, signal)
      const candidates = items(value).filter(entry => entry.authMode === 'oauth' && entry.visibility !== 'PERSONAL')
      if (!signal.aborted) { preserveReadFocus(); setProviders({ status: 'ready', items: candidates }) }
    } catch (error) { if (!signal.aborted) { preserveReadFocus(); setProviders({ status: 'failed', error }) } }
    finally { if (providerRead.current === signal) providerRead.current = undefined }
  }
  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    void load(controller.signal)
    void loadProviders(controller.signal)
    return () => { controller.abort() }
  }, [])
  const update = <K extends keyof ConnectorDraft>(key: K, value: ConnectorDraft[K]): void => {
    setDraft(previous => ({ ...previous, [key]: value }))
  }
  const applyJson = (value: ConnectorDraft, loaded = false): void => {
    const nextDraft = editing && !loaded ? { ...value, id: editing.id, version: draft.version } : value
    const nextHeaders = pairs(value.headers), environmentRows = pairs(value.environment)
    const nextEnvironment = environmentRows.length ? environmentRows : [pair()]
    const nextCommand = connectorCommandText(value), nextTimeout = String(value.timeoutSeconds)
    if (loaded) baseline.current = JSON.stringify([
      nextDraft, pairValues(nextHeaders), pairValues(nextEnvironment), nextCommand, nextTimeout, json,
    ])
    setDraft(nextDraft); setHeaders(nextHeaders); setEnvironment(nextEnvironment)
    setCommand(nextCommand); setTimeout(nextTimeout); setMode('manual'); setError(undefined)
  }
  const parse = (): void => {
    try {
      const values = connectorConfigurations(json, draft)
      setParsed(values); setSelected(0); setError(undefined)
      if (values.length === 1 && values[0]) applyJson(values[0])
    } catch { setError('connectorJsonInvalid'); setParsed([]) }
  }
  const executable = () => {
    if (draft.transport !== 'stdio') return {}
    return draft.command && command === connectorCommandText(draft)
      ? { command: draft.command, arguments: draft.arguments } : connectorCommand(command)
  }
  const retainsPrivateValue = (key: string, environment: boolean): boolean => {
    const saved = savedConfiguration.current
    if (!saved || draft.oauthProviderId) return false
    let sameTarget: boolean
    try { sameTarget = connectorTargetMatches({ ...draft, ...executable() }, saved) }
    catch { return false }
    if (!sameTarget) return false
    return environment ? Object.hasOwn(saved.environment, key.trim())
      : Object.keys(saved.headers).some(name => name.toLowerCase() === key.trim().toLowerCase())
  }
  const save = async (): Promise<void> => {
    if (saving.current || !ready) return
    const signal = lifecycle.current.signal
    let privateValues: { headers: Record<string, string>; environment: Record<string, string> }
    try { privateValues = { headers: configuration(headers), environment: configuration(environment) } }
    catch { setError('configurationKeysInvalid'); return }
    let commandFields = {}
    try { commandFields = executable() }
    catch { setError('connectorCommandInvalid'); return }
    const timeoutSeconds = draft.oauthProviderId || timeout.trim() === '' ? 60 : Number(timeout)
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) { setError('connectorTimeoutInvalid'); return }
    const checked = ConnectorDraftSchema.safeParse({ ...draft, summary: draft.summary.trim()
      || t(draft.transport === 'stdio' ? 'transportStdio' : 'transportStreamableHttp'), ...privateValues, ...commandFields, timeoutSeconds })
    if (!checked.success) {
      const fields = checked.error.issues.map(issue => issue.path[0])
      setError(fields.includes('headers') ? 'connectorHeadersInvalid' : fields.includes('environment') ? 'connectorEnvironmentInvalid' : 'connectorFieldsInvalid')
      return
    }
    close.clearBlocked()
    saving.current = true
    setPending(true)
    try {
      const receipt = ConnectorSaveResultSchema.parse(await invoke(editing ? 'extensions.connector.update' : 'extensions.save',
        editing ? { ...editing, draft: checked.data } : checked.data, timeoutSeconds * 2000 + 60_000, signal))
      if (receipt.id !== checked.data.id || receipt.version !== checked.data.version) {
        throw new Error('Connector save receipt does not match')
      }
      signal.throwIfAborted()
      setError(undefined)
      onSaved()
    }
    catch (error) { if (!signal.aborted) setError({ failure: error, fallback: 'saveFailed' }) }
    finally { saving.current = false; if (!signal.aborted) setPending(false) }
  }
  const field = (key: 'name' | 'url', label: DeepSeekHarnessProductKey, placeholder?: string, required = false): ReactNode =>
    <label className={css.editorField}><span>{t(label)}{required && <span className={css.requiredMark} aria-hidden="true">*</span>}</span><input aria-label={t(label)} required={required} disabled={pending} value={draft[key] ?? ''}
      placeholder={placeholder} onChange={(event) => { update(key, event.currentTarget.value) }} /></label>
  const paste = async (set: (rows: Pair[]) => void, rows: Pair[], caseInsensitive: boolean): Promise<void> => {
    const signal = lifecycle.current.signal
    const captured = clipboardInputs.current, request = ++clipboardRequest.current
    const current = () => !signal.aborted && request === clipboardRequest.current && captured === clipboardInputs.current
    try {
      const text = await navigator.clipboard.readText()
      if (!current()) return
      const value = connectorVariables(text)
      const normalizedKey = (key: string) => caseInsensitive ? key.trim().toLowerCase() : key.trim()
      const existing = Object.keys(configuration(rows)).map(normalizedKey)
      const entries = Object.entries(value)
      const remaining = new Map(entries.map(([key, value]) => [normalizedKey(key), { key: key.trim(), value }]))
      if (new Set(existing).size !== existing.length || remaining.size !== entries.length) throw new Error('Duplicate configuration keys')
      const merged = rows.map((row) => {
        const key = normalizedKey(row.key), value = remaining.get(key)
        remaining.delete(key)
        return value === undefined ? row : { ...row, value: value.value }
      })
      for (const { key, value } of remaining.values()) {
        const index = merged.findIndex(row => !row.key.trim() && !row.value)
        const empty = merged[index]
        if (empty) merged[index] = { ...empty, key, value }
        else merged.push(pair(key, value))
      }
      set(merged); setError(undefined)
    } catch { if (current()) setError('connectorPasteFailed') }
  }
  const privateRows = (rows: Pair[], set: (rows: Pair[]) => void, label: DeepSeekHarnessProductKey): ReactNode =>
    <section className={css.configurationSection} aria-label={t(label)}>
      <div className={css.configurationHeading}><h3>{t(label)} <span>{t('optionalField')}</span></h3>
        <Button variant="ghost" size="sm" disabled={pending} className={pending ? 'product-control-pending' : undefined}
          onClick={() => { void paste(set, rows, label === 'privateHeaders') }}>
          <IconDeliverDocRegular size={14} />{t('pasteConfiguration')}</Button></div>
      {rows.map((row, index) => <div className={css.configurationRow} key={row.id}>
        <input ref={(node) => { if (node) configurationKeys.current.set(row.id, node); else configurationKeys.current.delete(row.id) }}
          aria-label={`${t('configurationKey')} ${index + 1}`} placeholder={t('configurationKey')} disabled={pending} value={row.key}
          onChange={(event) => { set(rows.map((value, current) =>
            current === index ? { ...value, key: event.currentTarget.value } : value)) }} />
        <input aria-label={`${t('configurationValue')} ${index + 1}`} placeholder={t(retainsPrivateValue(row.key, label === 'privateEnvironment')
          ? 'privateValueRetained' : 'configurationValue')} disabled={pending} type="password" autoComplete="off" value={row.value}
        onChange={(event) => { set(rows.map((value, current) =>
          current === index ? { ...value, value: event.currentTarget.value } : value)) }} />
        <Tooltip label={t('remove')}><button className={`${css.iconButton}${pending ? ' product-control-pending' : ''}`} type="button" aria-label={`${t('remove')} ${index + 1}`} disabled={pending}
          onClick={() => {
            const adjacent = rows[index + 1] ?? rows[index - 1]
            const target = adjacent ? configurationKeys.current.get(adjacent.id) : configurationAdd.current.get(label)
            const removed = configurationKeys.current.get(row.id)?.parentElement
            if (target && removed?.contains(removed.ownerDocument.activeElement)) focusWithoutRing(target, { preventScroll: true })
            set(rows.filter((_, current) => current !== index))
          }}><IconCloseOutlineRegular size={16} /></button></Tooltip>
      </div>)}
      <Button ref={(node) => { if (node) configurationAdd.current.set(label, node); else configurationAdd.current.delete(label) }}
        className={`${css.addVariable}${pending ? ' product-control-pending' : ''}`} variant="ghost" size="sm" disabled={pending} onClick={() => {
          const row = pair()
          addedRow.current = row.id
          set([...rows, row])
        }}>
        <IconPlusOutlineRegular size={14} />{t(label === 'privateEnvironment' ? 'addVariable' : 'addConfigurationEntry')}</Button>
    </section>
  const oauthProviders = providers.status === 'ready' ? providers.items : []
  return <Modal open onClose={close.requestClose} title={t(editing ? 'editConnector' : 'addMcpServer')} closeLabel={t('close')} className={css.connectorEditorModal as string}
    contentClassName={css.detailModalContent as string} footer={<div className={css.connectorFooter}>
      {!close.confirming && <><div className={css.feedbackResult}>
        <span aria-hidden="true">{t('libraryWait')}</span>
        {close.blocked && pending && <p role="status" className={css.catalogStatus}>{t('libraryWait')}</p>}
      </div><div ref={feedback} className={css.feedbackResult}>
        <span aria-hidden="true">{t('connectorDiscoveryFailed')}</span>
        {error && <p role="alert" tabIndex={0} className={css.catalogError}>{typeof error === 'string' ? t(error)
          : productErrorMessage(error.failure, t, error.fallback)}</p>}
      </div></>}
      {close.confirming ? <><Button ref={close.keepEditingRef} variant="ghost" onClick={close.keepEditing}>{t('libraryKeepEditing')}</Button>
        <Button variant="primary" onClick={close.discard}>{t('libraryDiscard')}</Button></> : <Button variant="primary" disabled={!ready} aria-disabled={pending || !ready}
        aria-busy={pending} className={pending && ready ? 'product-control-pending' : undefined} onClick={() => {
          if (saving.current || !ready) return
          if (mode === 'manual') void save()
          else if (parsed.length > 1 && parsed[selected]) applyJson(parsed[selected])
          else parse()
        }}>{pending ? t('connectingConnector') : mode === 'json' ? t('applyConfiguration') : t(editing ? 'saveConnector' : 'addMcp')}</Button>}</div>}>
    {close.confirming && <p>{t('libraryDiscardConfirm')}</p>}
    <div hidden={close.confirming} {...close.editorProps}>
      {loading && !error && <ProductLoading label={t('loading')} />}
      {!ready && error && <Button variant="outline" aria-disabled={loading} aria-busy={loading}
        className={loading ? 'product-control-pending' : undefined} onClick={() => { void load() }}>{t('retry')}</Button>}
      {ready && <>
        <div className={css.editorTabs} role="tablist" aria-label={t('createConnector')}>
          {(['manual', 'json'] as const).map(value => <button type="button" role="tab" aria-selected={mode === value} key={value}
            disabled={pending || loading} onClick={() => { setMode(value); setError(undefined) }}>{t(value === 'manual' ? 'manualConfiguration' : 'jsonConfiguration')}</button>)}
        </div>
        {mode === 'json' ? <div className={`${css.editorForm} ${css.connectorForm}`}>
          <label className={css.editorField}><span>{t('mcpJsonConfiguration')}</span><textarea aria-label={t('mcpJsonConfiguration')}
            className={css.codeInput} rows={12} value={json} onChange={(event) => { setJson(event.currentTarget.value); setParsed([]) }}
            placeholder={t('mcpJsonPlaceholder')} /></label>
          {parsed.length > 1 && <label className={css.editorField}><span>{t('selectMcpServer')}</span><select aria-label={t('selectMcpServer')}
            value={selected} onChange={(event) => { setSelected(Number(event.currentTarget.value)) }}>
            {parsed.map((value, index) => <option key={index} value={index}>{value.name}</option>)}</select></label>}
        </div> : <div className={`${css.editorForm} ${css.connectorForm}`}>
          <label className={css.editorField}><span>{t('mcpServerType')}</span><select ref={transportField} aria-label={t('mcpServerType')} value={draft.transport} disabled={pending}
            onChange={(event) => {
              const value = event.currentTarget.value === 'stdio' ? 'stdio' : 'streamable-http'
              setHeaders([]); setEnvironment([pair()]); setCommand(''); setError(undefined)
              setDraft(({ oauthProviderId: _oauthProviderId, ...previous }) => ({ ...previous, transport: value, url: '', command: '', arguments: [] }))
            }}><option value="stdio">{t('stdioTransport')}</option><option value="streamable-http">{t('httpTransport')}</option></select></label>
          {field('name', 'mcpServerName', t('connectorNamePlaceholder'), true)}
          <label className={css.editorField}><span>{t('connectorSummary')} <span className={css.optionalMark}>{t('optionalField')}</span></span>
            <textarea aria-label={t('connectorSummary')} maxLength={300} rows={2} disabled={pending}
              placeholder={t('connectorSummaryPlaceholder')} value={draft.summary}
              onChange={(event) => { update('summary', event.currentTarget.value) }} /></label>
          <label className={css.editorField}><span>{t('connectorCategory')}</span><select aria-label={t('connectorCategory')}
            value={draft.category} disabled={pending} onChange={(event) => { update('category', event.currentTarget.value) }}>
            {Object.entries(CATEGORY_KEYS).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
          </select></label>
          {draft.transport === 'streamable-http' ? <>
            {providers.status === 'loading' && <ProductLoading label={t('loading')} />}
            {(providers.status === 'failed' || providers.status === 'retrying') && <div>
              <p role="alert" className={css.catalogError}>{productErrorMessage(providers.error, t, 'connectorProvidersFailed')}</p>
              <Button variant="outline" disabled={pending} aria-disabled={pending || providers.status === 'retrying'} aria-busy={providers.status === 'retrying'}
                className={pending || providers.status === 'retrying' ? 'product-control-pending' : undefined}
                onClick={() => { if (!saving.current) void loadProviders() }}>{t('retry')}</Button>
            </div>}
            {(draft.oauthProviderId || oauthProviders.length > 0) && <label className={css.editorField}><span>{t('authentication')}</span><select aria-label={t('authentication')}
              value={draft.oauthProviderId ?? ''} disabled={pending} onChange={(event) => {
                const id = event.currentTarget.value; setHeaders([]); setEnvironment([])
                setDraft(({ oauthProviderId: _oauthProviderId, ...previous }) => ({ ...previous, ...(id ? { oauthProviderId: id } : {}) }))
              }}><option value="">{t('localAuthentication')}</option>
              {draft.oauthProviderId && !oauthProviders.some(provider => provider.id === draft.oauthProviderId) &&
                <option value={draft.oauthProviderId} disabled>
                  {t('savedOAuthProvider')}{providers.status === 'ready' ? ` · ${t('statusUnavailable')}` : ''}</option>}
              {oauthProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.label} · {t('oauthAuthentication')}</option>)}</select></label>}
            {!draft.oauthProviderId && <>{field('url', 'connectorEndpoint', 'https://example.com/mcp', true)}{privateRows(headers, setHeaders, 'privateHeaders')}</>}
          </> : <>
            <label className={css.editorField}><span>{t('mcpCommand')}<span className={css.requiredMark} aria-hidden="true">*</span></span>
              <textarea aria-label={t('mcpCommand')} required className={css.codeInput} disabled={pending} rows={3}
                placeholder={t('mcpCommandPlaceholder')} value={command}
                onChange={(event) => { setCommand(event.currentTarget.value) }} /></label>
            {privateRows(environment, setEnvironment, 'privateEnvironment')}
          </>}
          {!draft.oauthProviderId && <label className={css.editorField}><span>{t('connectorTimeout')} <span className={css.optionalMark}>{t('optionalField')}</span></span>
            <div className={css.timeoutInput}><input aria-label={t('connectorTimeout')} type="number" min={1} max={600} step={1} placeholder="60"
              disabled={pending} value={timeout} onChange={(event) => { setTimeout(event.currentTarget.value) }} /><span>{t('seconds')}</span></div>
          </label>}
        </div>}
      </>}
    </div>
  </Modal>
}
