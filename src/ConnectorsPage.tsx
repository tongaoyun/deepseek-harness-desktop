import { Check, CircleAlert, KeyRound, PlugZap, Plus, RefreshCw, X } from 'lucide-react'
import { type FormEvent, useMemo, useState } from 'react'
import { connectorCategories } from './extensionCategories'
import { applyConnectorSecrets, missingConnectorSecretKeys, type ConnectorSecretStore, type ConnectorSecretValues } from './connectorSecrets'
import type { ConnectorCatalogEntry, ConnectorDiagnosticResult, ConnectorRuntimeDefinition } from './types'
import { XiaoyinMascot } from './XiaoyinMascot'

interface ConnectorsPageProps {
  catalog: ConnectorCatalogEntry[]
  runtime: ConnectorRuntimeDefinition[]
  loading: boolean
  catalogError: string
  syncError: string
  query: string
  onToggle: (connectorId: string, enabled: boolean) => void
  secrets: ConnectorSecretStore
  onSaveSecrets: (connectorId: string, values: ConnectorSecretValues) => void
  onDiagnose: (connectorId: string) => Promise<ConnectorDiagnosticResult | undefined>
}

export function ConnectorsPage({ catalog, runtime, loading, catalogError, syncError, query, onToggle, secrets, onSaveSecrets, onDiagnose }: ConnectorsPageProps) {
  const [view, setView] = useState<'market' | 'connected'>('market')
  const [configuring, setConfiguring] = useState<ConnectorCatalogEntry>()
  const [secretDraft, setSecretDraft] = useState<ConnectorSecretValues>({ environment: {}, headers: {} })
  const [enableAfterSave, setEnableAfterSave] = useState(false)
  const [secretError, setSecretError] = useState('')
  const [diagnostics, setDiagnostics] = useState<Record<string, ConnectorDiagnosticResult>>({})
  const [testingId, setTestingId] = useState('')
  const visibleCatalog = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    return catalog.filter((connector) => {
      const enabled = runtime.find((item) => item.id === connector.id)?.enabled === true
      return (view === 'market' || enabled)
        && (!needle || `${connector.name} ${connector.summary} ${connector.id} ${connector.toolNames.join(' ')}`.toLocaleLowerCase('zh-CN').includes(needle))
    })
  }, [catalog, query, runtime, view])
  const groupedCatalog = useMemo(() => connectorCategories.map((category) => ({
    ...category,
    connectors: visibleCatalog.filter((connector) => (connector.category ?? 'other') === category.id),
  })).filter((category) => category.connectors.length > 0), [visibleCatalog])
  const connectedCount = runtime.filter((item) => item.enabled).length

  function openSecretConfiguration(connector: ConnectorCatalogEntry, enableWhenSaved = false) {
    const configured = applyConnectorSecrets(connector, secrets[connector.id])
    setConfiguring(connector)
    setSecretDraft({ environment: { ...configured.environment }, headers: { ...configured.headers } })
    setEnableAfterSave(enableWhenSaved)
    setSecretError('')
  }

  function saveSecretConfiguration(event: FormEvent) {
    event.preventDefault()
    if (!configuring) return
    const missing = missingConnectorSecretKeys(configuring, secretDraft)
    if (missing.length > 0) { setSecretError(`请填写：${missing.join('、')}`); return }
    onSaveSecrets(configuring.id, secretDraft)
    if (enableAfterSave) onToggle(configuring.id, true)
    setConfiguring(undefined)
  }

  async function diagnose(connectorId: string) {
    if (testingId) return
    setTestingId(connectorId)
    try {
      const result = await onDiagnose(connectorId)
      if (result) setDiagnostics((current) => ({ ...current, [connectorId]: result }))
    } catch (reason) {
      setDiagnostics((current) => ({ ...current, [connectorId]: {
        id: connectorId,
        status: 'unavailable',
        latencyMs: 0,
        discoveredTools: [],
        missingTools: [],
        undeclaredTools: [],
        error: reason instanceof Error ? reason.message : String(reason),
      } }))
    } finally {
      setTestingId('')
    }
  }

  return <>
    <section className="catalog-hero connectors"><div><strong>连接你的应用，释放生产力</strong><p>把企业服务、开发工具和日常应用接入小胤。</p></div><div className="connector-hero-art"><span><PlugZap size={31} /></span><XiaoyinMascot size={82} variant="hero" /></div></section>
    <div className="catalog-heading-row connector-heading-row"><div className="catalog-tabs" role="tablist"><button aria-selected={view === 'market'} className={view === 'market' ? 'active' : ''} onClick={() => setView('market')} role="tab" type="button">市场</button><button aria-selected={view === 'connected'} className={view === 'connected' ? 'active' : ''} onClick={() => setView('connected')} role="tab" type="button">已安装 <em>{connectedCount}</em></button></div></div>
    {loading && <div className="kit-empty">正在同步企业连接器…</div>}
    {!loading && catalog.length === 0 && <div className="kit-empty">控制中心尚未配置连接器</div>}
    {!loading && catalog.length > 0 && visibleCatalog.length === 0 && <div className="kit-empty">没有匹配的连接器</div>}
    {catalogError && <div className="kit-error">{catalogError}</div>}
    {syncError && <div className="kit-error">{syncError}</div>}
    <div className="connector-category-list">{groupedCatalog.map((category) => <section className="connector-category-section" key={category.id}>
      <h2>{category.label}</h2><div className="kit-grid">{category.connectors.map((connector) => {
        const enabled = runtime.find((item) => item.id === connector.id)?.enabled === true
        const canEnable = connector.status === 'ready'
        const missingSecrets = missingConnectorSecretKeys(connector, secrets[connector.id])
        const hasSecretRequirements = Object.keys(connector.environment ?? {}).length + Object.keys(connector.headers ?? {}).length > 0
        const diagnostic = diagnostics[connector.id]
        return <article className="connector-market-card" key={connector.id}>
          <span className="market-card-icon"><PlugZap size={18} /></span><div><h3>{connector.name}</h3><p>{connectorSummary(connector)}</p><div className="connector-card-controls">{hasSecretRequirements && <button className="connector-inline-config" onClick={() => openSecretConfiguration(connector)} type="button"><KeyRound size={12} />{missingSecrets.length > 0 ? '需要本机配置' : '修改本机配置'}</button>}{enabled && connector.transport !== 'desktop' && <button className="connector-inline-config" disabled={testingId === connector.id} onClick={() => void diagnose(connector.id)} type="button"><RefreshCw className={testingId === connector.id ? 'spin' : ''} size={12} />测试连接</button>}</div>{diagnostic && <small className={`connector-health ${diagnostic.status}`}>{diagnostic.status === 'ready' ? <Check size={11} /> : <CircleAlert size={11} />}{diagnostic.status === 'ready' ? `连接正常 · ${diagnostic.latencyMs} ms · ${diagnostic.discoveredTools.length} 个工具` : diagnostic.error || '连接器工具与配置不一致'}</small>}</div>
          <button aria-label={enabled ? '已安装' : canEnable ? '安装连接器' : '暂不可用'} className={`connector-add ${enabled ? 'installed' : ''}`} disabled={!canEnable} onClick={() => { if (!enabled && missingSecrets.length > 0) openSecretConfiguration(connector, true); else onToggle(connector.id, !enabled) }} type="button">{enabled ? <Check size={19} /> : <Plus size={22} />}<span className="sr-only">{enabled ? '已为我启用' : canEnable ? '为我启用' : '当前不可启用'}</span></button>
        </article>
      })}</div>
    </section>)}</div>
    {configuring && <div className="expert-modal-backdrop" onMouseDown={() => setConfiguring(undefined)} role="presentation"><section aria-modal="true" className="expert-kit-modal connector-secret-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog">
      <button aria-label="关闭" className="expert-modal-close" onClick={() => setConfiguring(undefined)} type="button"><X size={16} /></button>
      <header><span><KeyRound size={20} /></span><div><h2>配置 {configuring.name}</h2><p>值只保存在当前员工的这台设备，不会上传到控制中心或 Nacos。</p></div></header>
      <form onSubmit={saveSecretConfiguration}>
        {configuring.id === 'github' && <div className="connector-local-config ready">GitHub PAT 请填写为：Bearer github_pat_…</div>}
        {Object.keys(configuring.environment ?? {}).map((key) => <label key={`env:${key}`}>环境变量 · {key}<input autoComplete="off" onChange={(event) => setSecretDraft((current) => ({ ...current, environment: { ...current.environment, [key]: event.target.value } }))} required type="password" value={secretDraft.environment[key] ?? ''} /></label>)}
        {Object.keys(configuring.headers ?? {}).map((key) => <label key={`header:${key}`}>Header · {key}<input autoComplete="off" onChange={(event) => setSecretDraft((current) => ({ ...current, headers: { ...current.headers, [key]: event.target.value } }))} required type="password" value={secretDraft.headers[key] ?? ''} /></label>)}
        {secretError && <div className="kit-error">{secretError}</div>}
        <div className="expert-modal-actions"><button className="secondary" onClick={() => setConfiguring(undefined)} type="button">取消</button><button type="submit">{enableAfterSave ? '保存并启用' : '保存到本机'}</button></div>
      </form>
    </section></div>}
  </>
}

function connectorSummary(connector: ConnectorCatalogEntry): string {
  if (connector.id === 'erp-mcp') return '连接公司 ERP，查询订单、销售与库存等经营数据。'
  if (connector.id === 'local-office' || connector.id === 'desktop-local-files') return '读取和处理经你授权的本地文件与 Office 文档。'
  return connector.summary
}
