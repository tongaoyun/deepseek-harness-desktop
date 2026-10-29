import { ProductLoading } from './ProductLoading.tsx'
/** Personal MCP configuration, with write-only local secrets. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { Button, IconCloseOutlineRegular, IconDeliverDocRegular, IconPlusOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { ConnectorEditorSnapshotSchema, ConnectorDraftSchema, ConnectorSaveResultSchema, type ConnectorDraft } from '@deepseek-harness/product/connector-draft'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { CATEGORY_KEYS, items, type ProductItem } from './catalog-shared.tsx'
import { invokeProduct, productApi } from './product-api.ts'
import { productErrorMessage } from './product-errors.ts'
import { connectorCommand, connectorCommandText, connectorConfigurations, connectorVariables } from './connector-configuration.ts'
import { useEditorCloseGuard } from './useEditorCloseGuard.ts'

type Pair = { key: string; value: string }
const pairs = (value: Record<string, string>): Pair[] => Object.entries(value).map(([key, value]) => ({ key, value }))
const configuration = (rows: readonly Pair[]): Record<string, string> => {
  const active = rows.filter(row => row.key.trim() || row.value)
  const keys = active.map(row => row.key.trim())
  if (keys.some(key => !key) || new Set(keys).size !== keys.length) throw new Error('Invalid configuration keys')
  return Object.fromEntries(active.map(row => [row.key.trim(), row.value]))
}

/** Configure HTTP or stdio with guarded drafts; saving only discovers tools. */
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
  const [environment, setEnvironment] = useState<Pair[]>([{ key: '', value: '' }])
  const [command, setCommand] = useState('')
  const [timeout, setTimeout] = useState('60')
  const [providers, setProviders] = useState<readonly ProductItem[]>([])
  const [parsed, setParsed] = useState<readonly ConnectorDraft[]>([])
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const [loading, setLoading] = useState(editing !== undefined)
  const [ready, setReady] = useState(editing === undefined)
  const values = JSON.stringify([draft, headers, environment, command, timeout, json])
  const baseline = useRef(values)
  const close = useEditorCloseGuard(values !== baseline.current, pending, onClose)
  const inputs = [draft, headers, environment, command, timeout, json, mode, pending, close.confirming]
  const clipboardInputs = useRef<readonly unknown[]>(inputs)
  if (inputs.some((value, index) => value !== clipboardInputs.current[index])) clipboardInputs.current = inputs
  const clipboardRequest = useRef(0)
  const lifecycle = useRef(new AbortController())
  const invoke = async (method: string, payload: unknown, timeoutMs?: number, signal = lifecycle.current.signal): Promise<unknown> => {
    signal.throwIfAborted()
    const api = productApi()
    if (!api) throw new Error(t('unavailable'))
    return invokeProduct(api, method, payload, signal, timeoutMs)
  }
  const load = async (signal = lifecycle.current.signal): Promise<void> => {
    if (!editing) return
    setLoading(true); setError(undefined)
    try {
      const value = await invoke('extensions.connector.read', editing, undefined, signal)
      signal.throwIfAborted()
      const result = ConnectorEditorSnapshotSchema.parse(value)
      if (result.draft.id !== editing.id) throw new Error(t('loadFailed'))
      applyJson(result.draft, true)
      if (result.savePending) setError(t('connectorSavePending'))
      setReady(true)
    } catch (error) { if (!signal.aborted) setError(productErrorMessage(error, t, 'loadFailed')) }
    finally { if (!signal.aborted) setLoading(false) }
  }
  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    void load(controller.signal)
    void invoke('connectors.list', {}, undefined, controller.signal).then((value) => {
      if (!controller.signal.aborted) setProviders(items(value).filter(entry => entry.authMode === 'oauth' && entry.visibility !== 'PERSONAL'))
    }).catch(() => undefined)
    return () => { controller.abort() }
  }, [])
  const update = <K extends keyof ConnectorDraft>(key: K, value: ConnectorDraft[K]): void => {
    setDraft(previous => ({ ...previous, [key]: value }))
  }
  const applyJson = (value: ConnectorDraft, loaded = false): void => {
    const nextDraft = editing && !loaded ? { ...value, id: editing.id, version: draft.version } : value
    const nextHeaders = pairs(value.headers), nextEnvironment = pairs(value.environment).length ? pairs(value.environment) : [{ key: '', value: '' }]
    const nextCommand = connectorCommandText(value), nextTimeout = String(value.timeoutSeconds)
    if (loaded) baseline.current = JSON.stringify([nextDraft, nextHeaders, nextEnvironment, nextCommand, nextTimeout, json])
    setDraft(nextDraft); setHeaders(nextHeaders); setEnvironment(nextEnvironment)
    setCommand(nextCommand); setTimeout(nextTimeout); setMode('manual'); setError(undefined)
  }
  const parse = (): void => {
    try {
      const values = connectorConfigurations(json, draft)
      setParsed(values); setSelected(0); setError(undefined)
      if (values.length === 1 && values[0]) applyJson(values[0])
    } catch { setError(t('connectorJsonInvalid')); setParsed([]) }
  }
  const save = async (): Promise<void> => {
    if (pending || !ready) return
    const signal = lifecycle.current.signal
    setError(undefined)
    let privateValues: { headers: Record<string, string>; environment: Record<string, string> }
    try { privateValues = { headers: configuration(headers), environment: configuration(environment) } }
    catch { setError(t('configurationKeysInvalid')); return }
    let executable = {}
    try { if (draft.transport === 'stdio') executable = connectorCommand(command) }
    catch { setError(t('connectorCommandInvalid')); return }
    const timeoutSeconds = draft.oauthProviderId || timeout.trim() === '' ? 60 : Number(timeout)
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) { setError(t('connectorTimeoutInvalid')); return }
    const checked = ConnectorDraftSchema.safeParse({ ...draft, summary: draft.summary.trim()
      || t(draft.transport === 'stdio' ? 'transportStdio' : 'transportStreamableHttp'), ...privateValues, ...executable, timeoutSeconds })
    if (!checked.success) { setError(t('connectorFieldsInvalid')); return }
    setPending(true)
    try {
      const receipt = ConnectorSaveResultSchema.parse(await invoke(editing ? 'extensions.connector.update' : 'extensions.save',
        editing ? { ...editing, draft: checked.data } : checked.data, timeoutSeconds * 2000 + 60_000, signal))
      if (receipt.id !== checked.data.id || receipt.version !== checked.data.version) {
        throw new Error(t('saveFailed'))
      }
      signal.throwIfAborted()
      onSaved()
    }
    catch (error) { if (!signal.aborted) setError(productErrorMessage(error, t, 'saveFailed')) }
    finally { if (!signal.aborted) setPending(false) }
  }
  const field = (key: 'name' | 'url', label: DeepSeekHarnessProductKey, placeholder?: string, required = false): ReactNode =>
    <label className={css.editorField}><span>{t(label)}{required && <span className={css.requiredMark} aria-hidden="true">*</span>}</span><input aria-label={t(label)} required={required} disabled={pending} value={draft[key] ?? ''}
      placeholder={placeholder} onChange={(event) => { update(key, event.currentTarget.value) }} /></label>
  const paste = async (set: (rows: Pair[]) => void, rows: Pair[]): Promise<void> => {
    const signal = lifecycle.current.signal
    const captured = clipboardInputs.current, request = ++clipboardRequest.current
    const current = () => !signal.aborted && request === clipboardRequest.current && captured === clipboardInputs.current
    try {
      const text = await navigator.clipboard.readText()
      if (!current()) return
      const value = connectorVariables(text)
      set(pairs({ ...configuration(rows), ...value })); setError(undefined)
    } catch { if (current()) setError(t('connectorPasteFailed')) }
  }
  const privateRows = (rows: Pair[], set: (rows: Pair[]) => void, label: DeepSeekHarnessProductKey): ReactNode =>
    <section className={css.configurationSection} aria-label={t(label)}>
      <div className={css.configurationHeading}><h3>{t(label)} <span>{t('optionalField')}</span></h3>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => { void paste(set, rows) }}>
          <IconDeliverDocRegular size={14} />{t('pasteConfiguration')}</Button></div>
      {rows.map((row, index) => <div className={css.configurationRow} key={index}>
        <input aria-label={`${t('configurationKey')} ${index + 1}`} placeholder={t('configurationKey')} disabled={pending} value={row.key}
          onChange={(event) => { set(rows.map((value, current) =>
            current === index ? { ...value, key: event.currentTarget.value } : value)) }} />
        <input aria-label={`${t('configurationValue')} ${index + 1}`} placeholder={t(editing && Object.hasOwn(label === 'privateEnvironment' ? draft.environment : draft.headers, row.key)
          ? 'privateValueRetained' : 'configurationValue')} disabled={pending} type="password" autoComplete="off" value={row.value}
        onChange={(event) => { set(rows.map((value, current) =>
          current === index ? { ...value, value: event.currentTarget.value } : value)) }} />
        <Tooltip label={t('remove')}><button className={css.iconButton} type="button" aria-label={`${t('remove')} ${index + 1}`} disabled={pending}
          onClick={() => { set(rows.filter((_, current) => current !== index)) }}><IconCloseOutlineRegular size={16} /></button></Tooltip>
      </div>)}
      <Button className={css.addVariable} variant="ghost" size="sm" disabled={pending} onClick={() => { set([...rows, { key: '', value: '' }]) }}>
        <IconPlusOutlineRegular size={14} />{t(label === 'privateEnvironment' ? 'addVariable' : 'addConfigurationEntry')}</Button>
    </section>
  return <Modal open onClose={close.requestClose} title={t(editing ? 'editConnector' : 'addMcpServer')} closeLabel={t('close')} className={css.connectorEditorModal as string}
    contentClassName={css.connectorEditorContent as string} footer={<div className={css.connectorFooter}>
      {close.confirming ? <><Button variant="ghost" onClick={close.keepEditing}>{t('knowledgeKeepEditing')}</Button>
        <Button variant="primary" onClick={close.discard}>{t('knowledgeDiscardDraft')}</Button></> : <Button variant="primary" disabled={pending || !ready} onClick={() => {
        if (mode === 'manual') void save()
        else if (parsed.length > 1 && parsed[selected]) applyJson(parsed[selected])
        else parse()
      }}>{pending ? t('connectingConnector') : mode === 'json' ? t('applyConfiguration') : t(editing ? 'saveConnector' : 'addMcp')}</Button>}</div>}>
    {close.confirming ? <p>{t('knowledgeDiscardDraftConfirmation')}</p> : <>
      {loading && <ProductLoading label={t('loading')} />}
      {error && <p role="alert" className={css.catalogError}>{error}</p>}
      {!loading && !ready && <Button variant="outline" onClick={() => { void load() }}>{t('retry')}</Button>}
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
          <label className={css.editorField}><span>{t('mcpServerType')}</span><select aria-label={t('mcpServerType')} value={draft.transport} disabled={pending}
            onChange={(event) => {
              const value = event.currentTarget.value === 'stdio' ? 'stdio' : 'streamable-http'
              setHeaders([]); setEnvironment([{ key: '', value: '' }]); setCommand(''); setError(undefined)
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
            {providers.length > 0 && <label className={css.editorField}><span>{t('authentication')}</span><select aria-label={t('authentication')}
              value={draft.oauthProviderId ?? ''} disabled={pending} onChange={(event) => {
                const id = event.currentTarget.value; setHeaders([]); setEnvironment([])
                setDraft(({ oauthProviderId: _oauthProviderId, ...previous }) => ({ ...previous, ...(id ? { oauthProviderId: id } : {}) }))
              }}><option value="">{t('localAuthentication')}</option>{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label} · {t('oauthAuthentication')}</option>)}</select></label>}
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
    </>}
  </Modal>
}
