/** Personal MCP configuration, with write-only local secrets. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { Button, IconCloseOutlineRegular, IconDeliverDocRegular, IconPlusOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { ExtensionDraftSchema, type ExtensionDraft } from '@deepseek-harness/product/extension-draft'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import css from '../DeepSeekHarnessProduct.module.css'
import { items, nextProductRequestId, type ProductItem } from './catalog-shared.tsx'
import { productApi } from './product-api.ts'
import { productErrorMessage } from './product-errors.ts'
import { connectorCommand, connectorCommandText, connectorConfigurations, connectorVariables } from './connector-configuration.ts'

type Pair = { key: string; value: string }
const pairs = (value: Record<string, string>): Pair[] => Object.entries(value).map(([key, value]) => ({ key, value }))
const configuration = (rows: readonly Pair[]): Record<string, string> => {
  const active = rows.filter(row => row.key.trim() || row.value)
  const keys = active.map(row => row.key.trim())
  if (keys.some(key => !key) || new Set(keys).size !== keys.length) throw new Error('Invalid configuration keys')
  return Object.fromEntries(active.map(row => [row.key.trim(), row.value]))
}

/** Configure HTTP or stdio manually or from standard MCP JSON; saving only discovers tools. */
export function ConnectorEditor({ onClose, onSaved, editing, t }: {
  readonly editing?: { readonly id: string; readonly version: string } | undefined
  readonly onClose: () => void
  readonly onSaved: () => void
  readonly t: (key: DeepSeekHarnessProductKey) => string
}): ReactNode {
  const [draft, setDraft] = useState<ExtensionDraft>(() => ({
    kind: 'connector', id: `connector-${randomUUID().slice(0, 8)}`, version: '1.0.0', name: '', summary: '', category: 'other',
    body: '', triggers: [], minimumDesktopVersion: '0.1.0', connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [], skills: [],
    commonTasks: [], transport: 'stdio', url: '', arguments: [], headers: {}, environment: {}, timeoutSeconds: 60,
  }))
  const [mode, setMode] = useState<'manual' | 'json'>('manual')
  const [json, setJson] = useState('')
  const [headers, setHeaders] = useState<Pair[]>([])
  const [environment, setEnvironment] = useState<Pair[]>([{ key: '', value: '' }])
  const [command, setCommand] = useState('')
  const [timeout, setTimeout] = useState('60')
  const [providers, setProviders] = useState<readonly ProductItem[]>([])
  const [parsed, setParsed] = useState<readonly ExtensionDraft[]>([])
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const [loading, setLoading] = useState(editing !== undefined)
  const [ready, setReady] = useState(editing === undefined)
  const lifecycle = useRef({ closed: false, requests: new Set<string>() })
  const invoke = async (method: string, payload: unknown, timeoutMs?: number): Promise<unknown> => {
    const api = productApi()
    if (!api) throw new Error(t('unavailable'))
    const request = nextProductRequestId(); lifecycle.current.requests.add(request)
    try { return await api.invoke(method, payload, request, timeoutMs) }
    finally { lifecycle.current.requests.delete(request) }
  }
  const load = async (): Promise<void> => {
    if (!editing) return
    setLoading(true); setError(undefined)
    try {
      const value = await invoke('extensions.connector.read', editing)
      if (lifecycle.current.closed) return
      const result = value as { draft: unknown; savePending?: boolean }
      applyJson(ExtensionDraftSchema.parse(result.draft), true)
      if (result.savePending) setError(t('connectorSavePending'))
      setReady(true)
    } catch (error) { if (!lifecycle.current.closed) setError(productErrorMessage(error, t, 'loadFailed')) }
    finally { if (!lifecycle.current.closed) setLoading(false) }
  }
  useEffect(() => {
    lifecycle.current.closed = false
    void load()
    void invoke('connectors.list', {}).then((value) => {
      if (!lifecycle.current.closed) setProviders(items(value).filter(entry => entry.authMode === 'oauth' && entry.visibility !== 'PERSONAL'))
    }).catch(() => undefined)
    return () => {
      lifecycle.current.closed = true
      for (const request of lifecycle.current.requests) productApi()?.cancel(request)
    }
  }, [])
  const update = <K extends keyof ExtensionDraft>(key: K, value: ExtensionDraft[K]): void => {
    setDraft(previous => ({ ...previous, [key]: value }))
  }
  const applyJson = (value: ExtensionDraft, loaded = false): void => {
    setDraft(editing && !loaded ? { ...value, id: editing.id, version: draft.version } : value); setHeaders(pairs(value.headers)); setEnvironment(pairs(value.environment).length ? pairs(value.environment) : [{ key: '', value: '' }])
    setCommand(connectorCommandText(value)); setTimeout(String(value.timeoutSeconds)); setMode('manual'); setError(undefined)
  }
  const parse = (): void => {
    try {
      const values = connectorConfigurations(json, draft)
      setParsed(values); setSelected(0); setError(undefined)
      if (values.length === 1 && values[0]) applyJson(values[0])
    } catch { setError(t('connectorJsonInvalid')); setParsed([]) }
  }
  const save = async (): Promise<void> => {
    setError(undefined)
    let privateValues: { headers: Record<string, string>; environment: Record<string, string> }
    try { privateValues = { headers: configuration(headers), environment: configuration(environment) } }
    catch { setError(t('configurationKeysInvalid')); return }
    let executable = {}
    try { if (draft.transport === 'stdio') executable = connectorCommand(command) }
    catch { setError(t('connectorCommandInvalid')); return }
    const timeoutSeconds = draft.oauthProviderId || timeout.trim() === '' ? 60 : Number(timeout)
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) { setError(t('connectorTimeoutInvalid')); return }
    const checked = ExtensionDraftSchema.safeParse({ ...draft, summary: draft.summary.trim()
      || t(draft.transport === 'stdio' ? 'transportStdio' : 'transportStreamableHttp'), ...privateValues, ...executable, timeoutSeconds })
    if (!checked.success) { setError(t('connectorFieldsInvalid')); return }
    setPending(true)
    try {
      await invoke(editing ? 'extensions.connector.update' : 'extensions.save',
        editing ? { ...editing, draft: checked.data } : checked.data, timeoutSeconds * 2000 + 60_000)
      if (!lifecycle.current.closed) onSaved()
    }
    catch (error) { if (!lifecycle.current.closed) setError(productErrorMessage(error, t, 'saveFailed')) }
    finally { if (!lifecycle.current.closed) setPending(false) }
  }
  const field = (key: 'name' | 'url', label: DeepSeekHarnessProductKey, placeholder?: string, required = false): ReactNode =>
    <label className={css.editorField}><span>{t(label)}{required && <span className={css.requiredMark} aria-hidden="true">*</span>}</span><input aria-label={t(label)} required={required} disabled={pending} value={draft[key] ?? ''}
      placeholder={placeholder} onChange={(event) => { update(key, event.currentTarget.value) }} /></label>
  const paste = async (set: (rows: Pair[]) => void, rows: Pair[]): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText()
      const value = connectorVariables(text)
      if (!lifecycle.current.closed) { set(pairs({ ...configuration(rows), ...value })); setError(undefined) }
    } catch { if (!lifecycle.current.closed) setError(t('connectorPasteFailed')) }
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
  return <Modal open onClose={onClose} title={t(editing ? 'editConnector' : 'addMcpServer')} closeLabel={t('close')} className={css.connectorEditorModal as string}
    contentClassName={css.connectorEditorContent as string} footer={<div className={css.connectorFooter}>
      <Button variant="primary" disabled={pending || !ready} onClick={() => {
        if (mode === 'manual') void save()
        else if (parsed.length > 1 && parsed[selected]) applyJson(parsed[selected])
        else parse()
      }}>{pending ? t('connectingConnector') : mode === 'json' ? t('applyConfiguration') : t(editing ? 'saveConnector' : 'addMcp')}</Button></div>}>
    {loading && <p role="status">{t('loading')}</p>}
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
  </Modal>
}
