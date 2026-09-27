import {
  Blocks,
  CalendarDays,
  Check,
  CircleAlert,
  Code2,
  Database,
  FileStack,
  KeyRound,
  MapPinned,
  MessageSquareText,
  Palette,
  PlugZap,
  Plus,
  Pencil,
  RefreshCw,
  Trash2,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { connectorCategories } from './extensionCategories'
import { applyConnectorSecrets, missingConnectorSecretKeys, type ConnectorSecretStore, type ConnectorSecretValues } from './connectorSecrets'
import type { ConnectorCatalogEntry, ConnectorDiagnosticResult, ConnectorRuntimeDefinition } from './types'
import { CapabilityHero } from './CapabilityHero'
import { CatalogLoading } from './CatalogLoading'
import { useDialogFocus } from './useDialogFocus'
import { ConnectorAccount } from './ConnectorAccount'

interface ConnectorsPageProps {
  employeeId?: string
  onReauthorizeErp?: () => Promise<void>
  catalog: ConnectorCatalogEntry[]
  runtime: ConnectorRuntimeDefinition[]
  loading: boolean
  catalogError: string
  syncError: string
  query: string
  onToggle: (connectorId: string, enabled: boolean) => void
  personalIds: string[]
  onEdit: (connector: ConnectorCatalogEntry) => void
  onDelete: (connectorId: string) => Promise<void>
  secrets: ConnectorSecretStore
  onSaveSecrets: (connectorId: string, values: ConnectorSecretValues) => Promise<void>
  onDiagnose: (connectorId: string) => Promise<ConnectorDiagnosticResult | undefined>
}

export function ConnectorsPage({ employeeId, catalog, runtime, loading, catalogError, syncError, query, onToggle, personalIds, onEdit, onDelete, secrets, onSaveSecrets, onDiagnose, onReauthorizeErp }: ConnectorsPageProps) {
  const [authorizationRevision, setAuthorizationRevision] = useState<Record<string, number>>({})
  const [view, setView] = useState<'market' | 'connected'>('market')
  const [detailId, setDetailId] = useState('')
  const [configuring, setConfiguring] = useState<ConnectorCatalogEntry>()
  const [secretDraft, setSecretDraft] = useState<ConnectorSecretValues>({ environment: {}, headers: {} })
  const [enableAfterSave, setEnableAfterSave] = useState(false)
  const [secretError, setSecretError] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [deletingId, setDeletingId] = useState('')
  const [actionError, setActionError] = useState('')
  const detailDialog = useRef<HTMLElement>(null)
  const secretDialog = useRef<HTMLElement>(null)
  useDialogFocus(detailDialog, configuring ? '' : detailId, () => setDetailId(''))
  useDialogFocus(secretDialog, configuring?.id ?? '', () => { if (!savingRef.current) setConfiguring(undefined) })
  const visibleCatalog = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    return catalog.filter((connector) => {
      const enabled = runtime.find((item) => item.id === connector.id)?.enabled === true
      return (view === 'market' || enabled || personalIds.includes(connector.id))
        && (!needle || `${connector.name} ${connector.summary} ${connector.id} ${connector.toolNames.join(' ')}`.toLocaleLowerCase('zh-CN').includes(needle))
    })
  }, [catalog, personalIds, query, runtime, view])
  const groupedCatalog = useMemo(() => connectorCategories.map((category) => ({
    ...category,
    connectors: visibleCatalog.filter((connector) => (connector.category ?? 'other') === category.id),
  })).filter((category) => category.connectors.length > 0), [visibleCatalog])
  const connectedCount = catalog.filter((item) => personalIds.includes(item.id) || runtime.some((entry) => entry.id === item.id && entry.enabled)).length


  function openSecretConfiguration(connector: ConnectorCatalogEntry, enableWhenSaved = false) {
    const configured = applyConnectorSecrets(connector, secrets[connector.id])
    setConfiguring(connector)
    setSecretDraft({ environment: { ...configured.environment }, headers: { ...configured.headers } })
    setEnableAfterSave(enableWhenSaved)
    setSecretError('')
  }

  async function saveSecretConfiguration(event: FormEvent) {
    event.preventDefault()
    if (!configuring || savingRef.current) return
    const missing = missingConnectorSecretKeys(configuring, secretDraft)
    if (missing.length > 0) { setSecretError(`请填写：${missing.join('、')}`); return }
    savingRef.current = true
    setSaving(true)
    try {
      await onSaveSecrets(configuring.id, secretDraft)
      if (enableAfterSave) onToggle(configuring.id, true)
      setConfiguring(undefined)
    } catch (reason) {
      setSecretError(reason instanceof Error ? reason.message : '保存失败，请重试')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  async function remove(connectorId: string) {
    if (deletingId) return
    setDeletingId(connectorId)
    setActionError('')
    try {
      await onDelete(connectorId)
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : '删除失败，请重试')
    } finally {
      setDeletingId('')
    }
  }

  return <>
    <CapabilityHero kind="connectors" />
    <div className="catalog-heading-row connector-heading-row"><div className="catalog-tabs" role="tablist"><button aria-selected={view === 'market'} className={view === 'market' ? 'active' : ''} onClick={() => setView('market')} role="tab" type="button">市场</button><button aria-selected={view === 'connected'} className={view === 'connected' ? 'active' : ''} onClick={() => setView('connected')} role="tab" type="button">已添加 <em>{connectedCount}</em></button></div></div>
    <p className="connector-session-note">配置变更用于新任务；正在执行的任务继续使用原有配置。</p>
    {loading && (visibleCatalog.length === 0 ? <CatalogLoading kind="connector" label="正在同步企业连接器…" /> : <p className="catalog-refresh-status" role="status">正在同步企业连接器…</p>)}
    {!loading && !catalogError && !syncError && catalog.length === 0 && <div className="kit-empty">控制中心尚未配置连接器</div>}
    {!loading && catalog.length > 0 && visibleCatalog.length === 0 && <div className="kit-empty">没有匹配的连接器</div>}
    {catalogError && <div className="kit-error">{catalogError}</div>}
    {syncError && <div className="kit-error">{syncError}</div>}
    {actionError && <div className="kit-error" role="alert">{actionError}</div>}
    <div className="connector-category-list">{groupedCatalog.map((category) => {
      const presentation = categoryPresentation(category.id)
      const CategoryIcon = presentation.icon
      return <section className={`connector-category-section ${presentation.theme}`} key={category.id}>
      <h2>{category.label}</h2><div className="kit-grid">{category.connectors.map((connector) => {
        const detailOpen = detailId === connector.id
        const enabled = runtime.find((item) => item.id === connector.id)?.enabled === true
        const runtimeConnector = runtime.find((item) => item.id === connector.id)
        const canEnable = (runtimeConnector?.status ?? connector.status) === 'ready'
          || (connector.status === 'ready' && runtimeConnector?.status === 'needs-configuration')
        const missingSecrets = missingConnectorSecretKeys(connector, secrets[connector.id])
        const hasSecretRequirements = Object.keys(connector.environment ?? {}).length + Object.keys(connector.headers ?? {}).length > 0
        return <article className={`connector-market-card ${presentation.theme}${enabled ? ' enabled' : ''}`} key={connector.id}>
          <span className="market-card-icon"><CategoryIcon size={20} /></span><div><h3><button className="connector-card-name" onClick={() => setDetailId(connector.id)} type="button">{connector.name}</button></h3><p>{connectorSummary(connector)}</p>
            <div className={detailOpen ? 'connector-detail-overlay' : 'connector-compact-status'} onMouseDown={(event) => { if (event.target === event.currentTarget && detailOpen) setDetailId('') }}>
            <section ref={detailOpen ? detailDialog : undefined} aria-label={detailOpen ? connector.name : undefined} aria-modal={detailOpen ? true : undefined} className={detailOpen ? 'connector-detail-dialog' : undefined} role={detailOpen ? 'dialog' : undefined}>
            {detailOpen && <><button aria-label="关闭连接器详情" className="expert-modal-close" onClick={() => setDetailId('')} type="button"><X size={17} /></button><span className="connector-detail-icon"><CategoryIcon size={28} /></span><h2>{connector.name}</h2><p className="connector-detail-description">{connector.summary}</p></>}
            <div className="connector-card-controls" hidden={!detailOpen}>
              {hasSecretRequirements && <button className="connector-inline-config" onClick={() => openSecretConfiguration(connector)} type="button"><KeyRound size={12} />{missingSecrets.length > 0 ? '需要本机配置' : '修改本机配置'}</button>}
              {personalIds.includes(connector.id) && <>
                <button aria-label={`编辑 ${connector.name}`} className="connector-inline-config" onClick={() => onEdit(connector)} type="button"><Pencil size={12} />编辑配置</button>
                <button aria-label={`删除 ${connector.name}`} className="connector-inline-config danger" disabled={Boolean(deletingId)} onClick={() => void remove(connector.id)} type="button"><Trash2 size={12} />{deletingId === connector.id ? '正在删除…' : '删除'}</button>
              </>}
            </div>
            {detailOpen && employeeId && runtimeConnector?.authMode === 'oauth' && <ConnectorAccount employeeId={employeeId} connector={runtimeConnector} onConnected={() => { onToggle(connector.id, true); setAuthorizationRevision(value => ({ ...value, [connector.id]: (value[connector.id] ?? 0) + 1 })) }} onDisconnected={() => { onToggle(connector.id, false); setAuthorizationRevision(value => ({ ...value, [connector.id]: (value[connector.id] ?? 0) + 1 })) }} />}
            <ConnectorHealth key={authorizationRevision[connector.id] ?? 0} connector={connector} enabled={enabled} missing={missingSecrets.length > 0} onDiagnose={onDiagnose} runtime={runtimeConnector}
              onAuthorize={(runtimeConnector?.authMode ?? connector.authMode) === 'oauth' ? undefined : (runtimeConnector?.authMode ?? connector.authMode) === 'erp-cookie' ? onReauthorizeErp : hasSecretRequirements ? async () => openSecretConfiguration(connector) : personalIds.includes(connector.id) ? async () => onEdit(connector) : undefined} />
            {detailOpen && runtimeConnector?.authMode !== 'oauth' && <button className="connector-detail-primary" disabled={!enabled && !canEnable} onClick={() => { if (!enabled && missingSecrets.length > 0) openSecretConfiguration(connector, true); else onToggle(connector.id, !enabled) }} type="button">{enabled ? '停用' : canEnable ? '连接并启用' : '当前不可用'}</button>}
            </section></div>
          </div>
          <button aria-label={enabled ? '关闭连接器' : canEnable ? '启用连接器' : '暂不可用'} aria-pressed={enabled} className={`connector-add ${enabled ? 'installed' : ''}`} disabled={!enabled && !canEnable} onClick={() => { if (!enabled && runtimeConnector?.authMode === 'oauth') setDetailId(connector.id); else if (!enabled && missingSecrets.length > 0) openSecretConfiguration(connector, true); else onToggle(connector.id, !enabled) }} type="button">{enabled ? <Check size={19} /> : <Plus size={22} />}<span className="sr-only">{enabled ? '已为我启用' : canEnable ? '为我启用' : '当前不可启用'}</span></button>
        </article>
      })}</div>
    </section>
    })}</div>
    {configuring && <div className="expert-modal-backdrop" onMouseDown={() => { if (!savingRef.current) setConfiguring(undefined) }} role="presentation"><section ref={secretDialog} aria-label={`配置 ${configuring.name}`} aria-modal="true" className="expert-kit-modal connector-secret-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog">
      <button aria-label="关闭" className="expert-modal-close" disabled={saving} onClick={() => setConfiguring(undefined)} type="button"><X size={16} /></button>
      <header><span><KeyRound size={20} /></span><div><h2>配置 {configuring.name}</h2><p>值只保存在当前员工的这台设备，不会上传到控制中心或 Nacos。</p></div></header>
      <form onSubmit={(event) => void saveSecretConfiguration(event)}>
        {configuring.id === 'github' && <div className="connector-local-config ready">GitHub PAT 请填写为：Bearer github_pat_…</div>}
        {Object.keys(configuring.environment ?? {}).map((key) => <label key={`env:${key}`}>环境变量 · {key}<input autoComplete="off" onChange={(event) => setSecretDraft((current) => ({ ...current, environment: { ...current.environment, [key]: event.target.value } }))} required type="password" value={secretDraft.environment[key] ?? ''} /></label>)}
        {Object.keys(configuring.headers ?? {}).map((key) => <label key={`header:${key}`}>Header · {key}<input autoComplete="off" onChange={(event) => setSecretDraft((current) => ({ ...current, headers: { ...current.headers, [key]: event.target.value } }))} required type="password" value={secretDraft.headers[key] ?? ''} /></label>)}
        {secretError && <div className="kit-error">{secretError}</div>}
        <div className="expert-modal-actions"><button className="secondary" disabled={saving} onClick={() => setConfiguring(undefined)} type="button">取消</button><button disabled={saving} type="submit">{saving ? '正在保存…' : enableAfterSave ? '保存并启用' : '保存到本机'}</button></div>
      </form>
    </section></div>}
  </>
}

function ConnectorHealth({ connector, runtime, enabled, missing, onDiagnose, onAuthorize }: {
  connector: ConnectorCatalogEntry
  runtime?: ConnectorRuntimeDefinition
  enabled: boolean
  missing: boolean
  onDiagnose: ConnectorsPageProps['onDiagnose']
  onAuthorize?: () => Promise<void>
}) {
  const [authorizing, setAuthorizing] = useState(false)
  const [authorizationError, setAuthorizationError] = useState('')
  const [retry, setRetry] = useState(0)
  const [check, setCheck] = useState<{ key: string; result?: ConnectorDiagnosticResult; done: boolean }>()
  const latestDiagnose = useRef(onDiagnose)
  useEffect(() => { latestDiagnose.current = onDiagnose }, [onDiagnose])
  const available = (runtime?.status ?? connector.status) === 'ready'
  const canTest = enabled && !missing && available
  // Configuration changes invalidate old results, even when an earlier test finishes later.
  const key = JSON.stringify([runtime ?? connector, missing, retry])
  const current = check?.key === key ? check : undefined
  const result = current?.result
  const testing = canTest && !current?.done

  useEffect(() => {
    if (!canTest || result?.status !== 'authentication-required') return
    const recheck = () => { if (document.visibilityState !== 'hidden') setRetry(value => value + 1) }
    window.addEventListener('focus', recheck)
    return () => window.removeEventListener('focus', recheck)
  }, [canTest, result?.status])

  useEffect(() => {
    if (!canTest) return
    let disposed = false
    void (async () => {
      let result: ConnectorDiagnosticResult | undefined
      try { result = await latestDiagnose.current(connector.id) }
      catch (reason) {
        result = { id: connector.id, status: 'unavailable', latencyMs: 0, discoveredTools: [], missingTools: [], undeclaredTools: [], error: reason instanceof Error ? reason.message : '连接失败' }
      }
      if (!disposed) setCheck({ key, result, done: true })
    })()
    return () => { disposed = true }
  }, [key, canTest, connector.id])

  const state = !enabled ? 'closed' : missing ? 'configuration' : !available ? 'unavailable' : testing ? 'testing' : result?.status ?? 'unchecked'
  const label = !enabled ? '已关闭' : missing ? '待配置' : !available ? '当前不可用' : testing ? '正在连接…' : result?.status === 'ready' ? '连接正常' : result?.status === 'drift' ? '工具配置有变化' : result?.status === 'authentication-required' ? '待授权' : result?.status === 'access-denied' ? '无访问权限' : result?.status === 'unavailable' ? '连接失败' : '未检测 · 请在桌面客户端测试'
  const tools = result?.discoveredTools ?? connector.toolNames
  return <div className="connector-health-panel">
    <div className="connector-health-row">
      <span aria-live="polite" className={`connector-health ${state}`}>{testing ? <RefreshCw className="spin" size={11} /> : state === 'ready' ? <Check size={11} /> : <CircleAlert size={11} />}{label}{result && canTest && !testing ? ` · ${result.latencyMs} ms` : ''}</span>
      {canTest && <button className="connector-inline-config" disabled={testing} onClick={() => setRetry((value) => value + 1)} type="button">重新检测</button>}
      {result?.status === 'authentication-required' && onAuthorize && <button className="connector-inline-config" disabled={authorizing} onClick={() => {
        setAuthorizing(true); setAuthorizationError('')
        void onAuthorize().catch(reason => setAuthorizationError(reason instanceof Error ? reason.message : '无法打开授权入口')).finally(() => setAuthorizing(false))
      }} type="button"><KeyRound size={12} />{authorizing ? '正在打开…' : (runtime?.authMode ?? connector.authMode) === 'erp-cookie' ? '重新扫码登录' : '更新凭据'}</button>}
    </div>
    {result?.error && <p className="connector-diagnostic-error">{result.error}</p>}
    {authorizationError && <p className="connector-diagnostic-error" role="alert">{authorizationError}</p>}
    <details className="connector-tool-details"><summary>工具与配置 · {tools.length} 个{result ? '已发现工具' : '声明工具'}</summary>
      <p>{runtime?.transport ?? connector.transport} · {(runtime?.transport ?? connector.transport) === 'stdio' ? connector.command : connector.url}</p>
      <small>检测使用与任务相同的工具策略，结果对应本次配置，不代表持续在线状态。</small>
      <ul>{tools.map((tool) => <li key={tool}><code>{tool}</code></li>)}</ul>
      {!tools.length && <p>{result?.status === 'ready' || result?.status === 'drift' ? '服务没有返回工具' : '连接成功后显示工具列表'}</p>}
      {Boolean(result?.missingTools.length) && <p>缺少声明工具：{result!.missingTools.join('、')}</p>}
      {Boolean(result?.undeclaredTools.length) && <p>未登记工具：{result!.undeclaredTools.join('、')}</p>}
    </details>
  </div>
}

function categoryPresentation(category: string): { icon: LucideIcon; theme: string } {
  return ({
    'recommended-system': { icon: Blocks, theme: 'theme-green' },
    'communication-collaboration': { icon: MessageSquareText, theme: 'theme-blue' },
    'project-management': { icon: Workflow, theme: 'theme-orange' },
    'knowledge-documents': { icon: FileStack, theme: 'theme-cyan' },
    'developer-tools': { icon: Code2, theme: 'theme-violet' },
    'design-creative': { icon: Palette, theme: 'theme-pink' },
    'schedule-productivity': { icon: CalendarDays, theme: 'theme-amber' },
    'maps-travel': { icon: MapPinned, theme: 'theme-sky' },
    'industry-data': { icon: Database, theme: 'theme-indigo' },
    other: { icon: PlugZap, theme: 'theme-slate' },
  } as Record<string, { icon: LucideIcon; theme: string }>)[category] ?? { icon: PlugZap, theme: 'theme-slate' }
}

function connectorSummary(connector: ConnectorCatalogEntry): string {
  if (connector.id === 'erp-mcp') return '连接公司 ERP，查询订单、销售与库存等经营数据。'
  if (connector.id === 'local-office' || connector.id === 'desktop-local-files') return '读取和处理经你授权的本地文件与 Office 文档。'
  return connector.summary
}
